/**
 * Custom `streamFn` for `@earendil-works/pi-agent-core`'s `Agent`.
 *
 * We do NOT use pi-ai's built-in provider adapters because they construct
 * their own SDK clients internally and call the provider directly from the
 * webview (CSP violation + key exposure). Instead, this streamFn:
 *
 *   1. Reads ai.* settings to pick the provider.
 *   2. Constructs an OpenAI or Anthropic SDK client with `tauriFetch` — our
 *      custom fetch that routes through the Rust proxy, which injects the API
 *      key. The key never reaches the webview on the call path.
 *   3. Drives the SDK's streaming API and translates its deltas into pi-ai's
 *      `AssistantMessageEvent` protocol, which pi-agent-core's loop consumes.
 *
 * The SDK still does the heavy lifting: request serialization, SSE parsing,
 * tool-call argument reconstruction. We translate the event vocabulary: the
 * SDK knows the provider dialect, pi-ai knows the agent-loop dialect.
 *
 * Contract (pi-ai StreamFn): must NOT throw for request/model/runtime
 * failures. Failures are encoded as a terminal `error` event carrying a final
 * AssistantMessage with stopReason "error".
 *
 * The `partial` AssistantMessage on every event is the ACCUMULATED state so
 * far (pi-agent-core reads it to update streamingMessage). `text_end` carries
 * the final text, `toolcall_end` carries the parsed ToolCall, `done` carries
 * the final message.
 */
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type Tool,
  type ToolCall,
} from "@earendil-works/pi-ai";
import { readSetting } from "../../hooks/useSetting";
import { createTauriFetch } from "./tauriFetch";

import type {
  ChatCompletionChunk,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";
import type {
  MessageParam as AnthropicMessageParam,
  MessageCreateParamsStreaming,
} from "@anthropic-ai/sdk/resources/messages";

/** Build a Model from settings (no MODELS catalog lookup needed). */
export function buildModel(): Model<any> {
  const provider = readSetting<string>("ai.provider", "openai");
  const baseUrl = readSetting<string>("ai.baseUrl", "");
  const modelId = readSetting<string>("ai.model", "gpt-4o");
  const maxTokens = readSetting<number>("ai.maxTokens", 4096);
  const api =
    provider === "anthropic" ? "anthropic-messages" : "openai-completions";
  return {
    id: modelId,
    name: modelId,
    api,
    provider,
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens,
  };
}

/** The custom streamFn handed to pi-agent-core's Agent. */
export function makeStreamFn() {
  return function streamTauri(
    _model: Model<any>,
    context: Context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream {
    const stream = createAssistantMessageEventStream();
    void driveStream(stream, context, options).catch((err) => {
      const errMsg = err instanceof Error ? err.message : String(err);
      stream.push({
        type: "error",
        reason: "error",
        error: finalMessage(errMsg, "error"),
      });
      stream.end();
    });
    return stream;
  };
}

async function driveStream(
  stream: AssistantMessageEventStream,
  context: Context,
  options?: SimpleStreamOptions,
): Promise<void> {
  const provider = readSetting<string>("ai.provider", "openai");
  const baseUrl = readSetting<string>("ai.baseUrl", "");
  const modelId = readSetting<string>("ai.model", "gpt-4o");
  const temperature = options?.temperature ?? readSetting<number>("ai.temperature", 0.3);
  const maxTokens = readSetting<number>("ai.maxTokens", 4096);

  if (provider === "anthropic") {
    const client = new Anthropic({
      apiKey: "injected-by-rust",
      ...(baseUrl ? { baseURL: baseUrl } : {}),
      fetch: createTauriFetch("x-api-key", { "anthropic-version": "2023-06-01" }),
      dangerouslyAllowBrowser: true,
    });
    await driveAnthropic(stream, client, context, modelId, temperature, maxTokens, options?.signal);
    return;
  }

  // OpenAI / compatible. v1 implements the Chat Completions adapter; the
  // Responses API path is tracked as a follow-up (the manifest's ai.openaiApi
  // select still exposes both options for forward-compat).
  const client = new OpenAI({
    apiKey: "injected-by-rust",
    baseURL: baseUrl || undefined,
    fetch: createTauriFetch("bearer"),
    dangerouslyAllowBrowser: true,
  });
  await driveOpenAIChat(stream, client, context, modelId, temperature, options?.signal);
}

/** Accumulator for the in-flight assistant message. */
interface AccState {
  /** Content blocks built up across deltas, in source order. */
  content: AssistantMessage["content"];
  /** The text-content block we're streaming (if any), by reference. */
  textBlock: { type: "text"; text: string } | null;
  /** Tool-call blocks keyed by their contentIndex in the partial. */
  toolBlocks: Map<number, ToolCall>;
  /** Raw tool-arg JSON accumulator per contentIndex (parsed on end). */
  toolArgJson: Map<number, string>;
}

function newAcc(): AccState {
  return { content: [], textBlock: null, toolBlocks: new Map(), toolArgJson: new Map() };
}

function partial(acc: AccState, model: string, provider: string): AssistantMessage {
  return {
    role: "assistant",
    content: [...acc.content],
    api: provider === "anthropic" ? "anthropic-messages" : "openai-completions",
    provider,
    model,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function finalMessage(errorMessage: string | null, stopReason: AssistantMessage["stopReason"], acc?: AccState, model = "", provider = "openai"): AssistantMessage {
  return {
    role: "assistant",
    content: acc ? [...acc.content] : [],
    api: provider === "anthropic" ? "anthropic-messages" : "openai-completions",
    provider,
    model,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason,
    ...(errorMessage !== null ? { errorMessage } : {}),
    timestamp: Date.now(),
  };
}

// --- OpenAI Chat Completions ---------------------------------------------

async function driveOpenAIChat(
  stream: AssistantMessageEventStream,
  client: OpenAI,
  context: Context,
  modelId: string,
  temperature: number,
  signal?: AbortSignal,
): Promise<void> {
  const acc = newAcc();
  const provider = "openai";

  stream.push({ type: "start", partial: partial(acc, modelId, provider) });

  const messages = convertMessagesForOpenAI(context);
  const tools = convertToolsForOpenAI(context.tools);

  const completion = await client.chat.completions.create(
    {
      model: modelId,
      messages,
      stream: true,
      temperature,
      ...(tools.length > 0 ? { tools, tool_choice: "auto" as const } : {}),
    },
    { signal },
  );

  // Map OpenAI's tool_call index → our contentIndex (text is always 0).
  const openaiToolIndexToContentIndex: Map<number, number> = new Map();
  let nextContentIndex = 1;
  let finishReason: string | null = null;

  for await (const chunk of completion as AsyncIterable<ChatCompletionChunk>) {
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta;

    if (delta?.content) {
      if (!acc.textBlock) {
        acc.textBlock = { type: "text", text: "" };
        acc.content.push(acc.textBlock);
        stream.push({ type: "text_start", contentIndex: 0, partial: partial(acc, modelId, provider) });
      }
      acc.textBlock.text += delta.content;
      stream.push({ type: "text_delta", contentIndex: 0, delta: delta.content, partial: partial(acc, modelId, provider) });
    }

    if (delta?.tool_calls) {
      for (const tc of delta.tool_calls) {
        let contentIdx = openaiToolIndexToContentIndex.get(tc.index);
        if (contentIdx === undefined) {
          contentIdx = nextContentIndex++;
          openaiToolIndexToContentIndex.set(tc.index, contentIdx);
          const id = tc.id ?? "";
          const name = tc.function?.name ?? "";
          const block: ToolCall = { type: "toolCall", id, name, arguments: {} };
          acc.toolBlocks.set(contentIdx, block);
          acc.toolArgJson.set(contentIdx, "");
          acc.content.push(block);
          stream.push({ type: "toolcall_start", contentIndex: contentIdx, partial: partial(acc, modelId, provider) });
        }
        if (tc.id) acc.toolBlocks.get(contentIdx)!.id = tc.id;
        if (tc.function?.name) acc.toolBlocks.get(contentIdx)!.name = tc.function.name;
        if (tc.function?.arguments) {
          const prev = acc.toolArgJson.get(contentIdx) ?? "";
          const next = prev + tc.function.arguments;
          acc.toolArgJson.set(contentIdx, next);
          stream.push({ type: "toolcall_delta", contentIndex: contentIdx, delta: tc.function.arguments, partial: partial(acc, modelId, provider) });
        }
      }
    }

    if (choice.finish_reason) finishReason = choice.finish_reason;
  }

  // Close out content blocks.
  if (acc.textBlock) {
    stream.push({ type: "text_end", contentIndex: 0, content: acc.textBlock.text, partial: partial(acc, modelId, provider) });
  }
  for (const [contentIdx, block] of acc.toolBlocks) {
    const raw = acc.toolArgJson.get(contentIdx) ?? "{}";
    try {
      block.arguments = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      block.arguments = {};
    }
    stream.push({ type: "toolcall_end", contentIndex: contentIdx, toolCall: block, partial: partial(acc, modelId, provider) });
  }

  // Some OpenAI-compatible endpoints (Ollama, etc.) never emit a non-null
  // finish_reason. When it's null, derive the stop reason from whether tool
  // calls were produced, so the loop's recorded stopReason is accurate.
  const hasTools = acc.toolBlocks.size > 0;
  const reason: AssistantMessage["stopReason"] =
    finishReason === "tool_calls" || (finishReason == null && hasTools)
      ? "toolUse"
      : finishReason === "length"
        ? "length"
        : "stop";
  const final = finalMessage(null, reason, acc, modelId, provider);
  stream.push({ type: "done", reason, message: final });
  stream.end();
}

function convertMessagesForOpenAI(context: Context): ChatCompletionMessageParam[] {
  const out: ChatCompletionMessageParam[] = [];
  for (const m of context.messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: typeof m.content === "string" ? m.content : "" });
    } else if (m.role === "assistant") {
      const text = m.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("");
      const toolCalls = m.content
        .filter((c): c is { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> } => c.type === "toolCall")
        .map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: JSON.stringify(c.arguments) } }));
      if (toolCalls.length > 0) {
        out.push({ role: "assistant", content: text || null, tool_calls: toolCalls });
      } else {
        out.push({ role: "assistant", content: text });
      }
    } else if (m.role === "toolResult") {
      const text = m.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("");
      out.push({ role: "tool", tool_call_id: m.toolCallId, content: text });
    }
  }
  return out;
}

function convertToolsForOpenAI(tools?: Tool[]): { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }[] {
  if (!tools || tools.length === 0) return [];
  return tools.map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.parameters as Record<string, unknown> },
  }));
}

// --- Anthropic Messages ---------------------------------------------------

async function driveAnthropic(
  stream: AssistantMessageEventStream,
  client: Anthropic,
  context: Context,
  modelId: string,
  temperature: number,
  maxTokens: number,
  signal?: AbortSignal,
): Promise<void> {
  const acc = newAcc();
  const provider = "anthropic";

  stream.push({ type: "start", partial: partial(acc, modelId, provider) });

  const { messages, system } = convertMessagesForAnthropic(context);
  const tools = convertToolsForAnthropic(context.tools);

  // Build the streaming params with a stable type so the `stream: true`
  // overload is selected unambiguously (TS can't pick across overloads when
  // fields like `tools` are conditionally spread).
  const params: MessageCreateParamsStreaming = {
    model: modelId,
    messages,
    ...(system ? { system } : {}),
    max_tokens: maxTokens,
    temperature,
    stream: true,
    ...(tools.length > 0 ? { tools } : {}),
  } as MessageCreateParamsStreaming;
  const response = await client.messages.create(params, { signal });

  // Anthropic content-block index → our contentIndex (text block is index 0).
  const anthropicIdxToContentIdx: Map<number, number> = new Map();
  let nextContentIndex = 0;
  let stopReason: string | null = null;

  for await (const ev of response) {
    if (ev.type === "content_block_start") {
      const block = ev.content_block;
      if (block.type === "text") {
        if (!acc.textBlock) {
          acc.textBlock = { type: "text", text: "" };
          acc.content.push(acc.textBlock);
          anthropicIdxToContentIdx.set(ev.index, 0);
          stream.push({ type: "text_start", contentIndex: 0, partial: partial(acc, modelId, provider) });
        }
      } else if (block.type === "tool_use") {
        const contentIdx = ++nextContentIndex; // tool calls start at 1
        anthropicIdxToContentIdx.set(ev.index, contentIdx);
        const tc: ToolCall = { type: "toolCall", id: block.id, name: block.name, arguments: {} };
        acc.toolBlocks.set(contentIdx, tc);
        acc.toolArgJson.set(contentIdx, "");
        acc.content.push(tc);
        stream.push({ type: "toolcall_start", contentIndex: contentIdx, partial: partial(acc, modelId, provider) });
      }
    } else if (ev.type === "content_block_delta") {
      const delta = ev.delta;
      const contentIdx = anthropicIdxToContentIdx.get(ev.index);
      if (delta.type === "text_delta" && contentIdx === 0 && acc.textBlock) {
        acc.textBlock.text += delta.text;
        stream.push({ type: "text_delta", contentIndex: 0, delta: delta.text, partial: partial(acc, modelId, provider) });
      } else if (delta.type === "input_json_delta" && contentIdx !== undefined && contentIdx > 0) {
        const prev = acc.toolArgJson.get(contentIdx) ?? "";
        const next = prev + delta.partial_json;
        acc.toolArgJson.set(contentIdx, next);
        stream.push({ type: "toolcall_delta", contentIndex: contentIdx, delta: delta.partial_json, partial: partial(acc, modelId, provider) });
      }
    } else if (ev.type === "content_block_stop") {
      const contentIdx = anthropicIdxToContentIdx.get(ev.index);
      if (contentIdx === 0 && acc.textBlock) {
        stream.push({ type: "text_end", contentIndex: 0, content: acc.textBlock.text, partial: partial(acc, modelId, provider) });
      } else if (contentIdx !== undefined && contentIdx > 0) {
        const block = acc.toolBlocks.get(contentIdx)!;
        try {
          block.arguments = JSON.parse(acc.toolArgJson.get(contentIdx) ?? "{}") as Record<string, unknown>;
        } catch {
          block.arguments = {};
        }
        stream.push({ type: "toolcall_end", contentIndex: contentIdx, toolCall: block, partial: partial(acc, modelId, provider) });
      }
    } else if (ev.type === "message_delta") {
      if (ev.delta.stop_reason) stopReason = ev.delta.stop_reason;
    }
  }

  const reason: AssistantMessage["stopReason"] =
    stopReason === "tool_use" ? "toolUse" : stopReason === "max_tokens" ? "length" : "stop";
  const final = finalMessage(null, reason, acc, modelId, provider);
  stream.push({ type: "done", reason, message: final });
  stream.end();
}

function convertMessagesForAnthropic(
  context: Context,
): { messages: AnthropicMessageParam[]; system: string | undefined } {
  const out: AnthropicMessageParam[] = [];
  for (const m of context.messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: typeof m.content === "string" ? m.content : "" });
    } else if (m.role === "assistant") {
      const text = m.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("");
      const toolUses = m.content
        .filter((c): c is { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> } => c.type === "toolCall")
        .map((c) => ({ type: "tool_use" as const, id: c.id, name: c.name, input: c.arguments }));
      const content: AnthropicMessageParam["content"] = [];
      if (text) content.push({ type: "text", text });
      for (const tu of toolUses) content.push(tu);
      out.push({ role: "assistant", content });
    } else if (m.role === "toolResult") {
      const text = m.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("");
      out.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: m.toolCallId, content: text, is_error: m.isError }],
      });
    }
  }
  return { messages: out, system: context.systemPrompt };
}

function convertToolsForAnthropic(tools?: Tool[]) {
  if (!tools || tools.length === 0) return [];
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters as Record<string, unknown>,
  }));
}
