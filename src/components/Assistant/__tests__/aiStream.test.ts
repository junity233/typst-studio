import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Mock the OpenAI + Anthropic SDKs. The SDK clients are constructed inside
 * makeStreamFn → driveStream; we capture the `create` call's return value so
 * tests can drive scripted chunks through it.
 *
 * Each SDK's `.chat.completions.create()` / `.messages.create()` is stubbed to
 * return an async iterable that yields the scripted `chunks` then ends.
 */
type OpenAIChunk = {
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
};

type AnthropicEvent =
  | { type: "message_start" }
  | {
      type: "content_block_start";
      index: number;
      content_block:
        | { type: "text"; text: string }
        | { type: "tool_use"; id: string; name: string };
    }
  | {
      type: "content_block_delta";
      index: number;
      delta:
        | { type: "text_delta"; text: string }
        | { type: "input_json_delta"; partial_json: string };
    }
  | { type: "content_block_stop"; index: number }
  | { type: "message_delta"; delta: { stop_reason?: string } }
  | { type: "message_stop" };

const openaiCreateMock = vi.fn();
const anthropicCreateMock = vi.fn();

vi.mock("openai", () => ({
  default: class FakeOpenAI {
    chat = {
      completions: {
        create: (...args: unknown[]) => openaiCreateMock(...args),
      },
    };
  },
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class FakeAnthropic {
    messages = { create: (...args: unknown[]) => anthropicCreateMock(...args) };
  },
}));

// Mock tauriFetch so no Tauri runtime is needed; the fetch impl is irrelevant
// here because we mock the SDK's create() entirely.
vi.mock("../tauriFetch", () => ({
  createTauriFetch: () => () =>
    Promise.resolve(new Response("")),
}));

// readSetting inside makeStreamFn is mocked directly. vi.hoisted returns a
// mutable holder that BOTH the hoisted vi.mock factory AND the test body
// reference — guaranteed same instance by vitest. Tests mutate
// `settingsHolder.values` per-case (e.g. flip ai.provider to anthropic).
const { settingsHolder } = vi.hoisted(() => ({
  settingsHolder: { values: {} as Record<string, unknown> },
}));

vi.mock("../../../hooks/useSetting", () => ({
  readSetting: (path: string, fallback: unknown): unknown =>
    settingsHolder.values[path] ?? fallback,
}));

// Seed defaults AFTER vi.mock registration (this assignment is reached at
// module-eval time, before any test runs).
settingsHolder.values = {
  "ai.provider": "openai",
  "ai.baseUrl": "",
  "ai.model": "gpt-4o-test",
  "ai.temperature": 0.3,
  "ai.maxTokens": 1024,
  "ai.openaiApi": "chat",
  "appearance.language": "en",
};

const { makeStreamFn } = await import("../aiStream");

/** Build an async iterable that yields the scripted chunks then completes. */
function asyncIter<T>(items: T[]): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        next: async (): Promise<IteratorResult<T>> => {
          if (i >= items.length) return { done: true, value: undefined };
          return { done: false, value: items[i++] };
        },
      };
    },
  };
}

/** Drain a streamFn's AssistantMessageEventStream into an array. */
async function drain(stream: AsyncIterable<unknown>): Promise<any[]> {
  const events: any[] = [];
  for await (const ev of stream) events.push(ev);
  return events;
}

/** Strip the verbose `partial`/`message` fields to make assertions readable. */
function summary(events: any[]): any[] {
  return events.map((e) => {
    if (e.type === "text_delta" || e.type === "toolcall_delta") {
      return { type: e.type, contentIndex: e.contentIndex, delta: e.delta };
    }
    if (e.type === "text_start" || e.type === "toolcall_start") {
      return { type: e.type, contentIndex: e.contentIndex, ...(e.toolCall ? { toolCall: e.toolCall } : {}) };
    }
    if (e.type === "text_end") {
      return { type: e.type, contentIndex: e.contentIndex, content: e.content };
    }
    if (e.type === "toolcall_end") {
      return { type: e.type, contentIndex: e.contentIndex, toolCall: e.toolCall };
    }
    if (e.type === "done") {
      return { type: "done", reason: e.reason };
    }
    if (e.type === "error") {
      return { type: "error", reason: e.reason, errorMessage: e.error?.errorMessage };
    }
    return { type: e.type };
  });
}

beforeEach(() => {
  openaiCreateMock.mockReset();
  anthropicCreateMock.mockReset();
  settingsHolder.values["ai.provider"] = "openai";
  settingsHolder.values["ai.model"] = "gpt-4o-test";
});

describe("aiStream — OpenAI Chat Completions", () => {
  it("emits start → text_start/delta/end → done for a plain-text reply", async () => {
    const chunks: OpenAIChunk[] = [
      { choices: [{ delta: { content: "Hel" } }] },
      { choices: [{ delta: { content: "lo" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ];
    openaiCreateMock.mockReturnValue(asyncIter(chunks));

    const streamFn = makeStreamFn();
    const events = summary(await drain(streamFn({} as any, { messages: [] } as any)));

    expect(events).toEqual([
      { type: "start" },
      { type: "text_start", contentIndex: 0 },
      { type: "text_delta", contentIndex: 0, delta: "Hel" },
      { type: "text_delta", contentIndex: 0, delta: "lo" },
      { type: "text_end", contentIndex: 0, content: "Hello" },
      { type: "done", reason: "stop" },
    ]);
  });

  it("accumulates text deltas on the partial AssistantMessage", async () => {
    const chunks: OpenAIChunk[] = [
      { choices: [{ delta: { content: "ab" } }] },
      { choices: [{ delta: { content: "cd" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ];
    openaiCreateMock.mockReturnValue(asyncIter(chunks));

    const streamFn = makeStreamFn();
    const events: any[] = [];
    for await (const ev of streamFn({} as any, { messages: [] } as any)) {
      events.push(ev);
    }
    // The text_end partial carries the final text; assert via the done message's content.
    const textEnd = events.find((e) => e.type === "text_end");
    expect(textEnd.content).toBe("abcd");
  });

  it("streams a tool call: start/delta/end with parsed args, stop reason 'toolUse'", async () => {
    const chunks: OpenAIChunk[] = [
      { choices: [{ delta: { content: "I'll edit." } }] },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "call_1", function: { name: "edit", arguments: '{"path":"a' } },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { arguments: '.typ"}' } }],
            },
          },
        ],
      },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ];
    openaiCreateMock.mockReturnValue(asyncIter(chunks));

    const streamFn = makeStreamFn();
    const events = summary(await drain(streamFn({} as any, { messages: [] } as any)));

    expect(events).toEqual([
      { type: "start" },
      { type: "text_start", contentIndex: 0 },
      { type: "text_delta", contentIndex: 0, delta: "I'll edit." },
      { type: "toolcall_start", contentIndex: 1 },
      { type: "toolcall_delta", contentIndex: 1, delta: '{"path":"a' },
      { type: "toolcall_delta", contentIndex: 1, delta: '.typ"}' },
      { type: "text_end", contentIndex: 0, content: "I'll edit." },
      {
        type: "toolcall_end",
        contentIndex: 1,
        toolCall: {
          type: "toolCall",
          id: "call_1",
          name: "edit",
          arguments: { path: "a.typ" },
        },
      },
      { type: "done", reason: "toolUse" },
    ]);
  });

  it("handles multiple tool calls in one stream", async () => {
    const chunks: OpenAIChunk[] = [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "c1", function: { name: "read_file", arguments: '{"path":"a"}' } },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 1, id: "c2", function: { name: "read_file", arguments: '{"path":"b"}' } },
              ],
            },
          },
        ],
      },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ];
    openaiCreateMock.mockReturnValue(asyncIter(chunks));

    const streamFn = makeStreamFn();
    const events = summary(await drain(streamFn({} as any, { messages: [] } as any)));

    const toolEnds = events.filter((e) => e.type === "toolcall_end");
    expect(toolEnds).toHaveLength(2);
    // No text block → first tool call is at contentIndex 0, second at 1.
    // (contentIndex must be the real position in partial.content — pi-ai contract.)
    expect(toolEnds[0]).toMatchObject({
      contentIndex: 0,
      toolCall: { id: "c1", arguments: { path: "a" } },
    });
    expect(toolEnds[1]).toMatchObject({
      contentIndex: 1,
      toolCall: { id: "c2", arguments: { path: "b" } },
    });
    expect(events[events.length - 1]).toMatchObject({ type: "done", reason: "toolUse" });
  });

  it("contentIndex always matches partial.content position (pi-ai contract)", async () => {
    // Text first, then a tool call: contentIndex should be 0 for text, 1 for tool.
    const chunks: OpenAIChunk[] = [
      { choices: [{ delta: { content: "Look:" } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "read_file", arguments: '{"path":"a"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ];
    openaiCreateMock.mockReturnValue(asyncIter(chunks));

    const streamFn = makeStreamFn();
    const events: any[] = [];
    for await (const ev of streamFn({} as any, { messages: [] } as any)) {
      events.push(ev);
    }

    // For every event that carries a contentIndex, verify partial.content[ci]
    // exists and has the expected type.
    for (const ev of events) {
      if ("contentIndex" in ev && ev.partial) {
        const ci = ev.contentIndex;
        const block = ev.partial.content?.[ci];
        expect(block).toBeDefined();
        if (ev.type.startsWith("text")) expect(block.type).toBe("text");
        if (ev.type.startsWith("toolcall")) expect(block.type).toBe("toolCall");
      }
    }

    // text at 0, tool at 1 (text block came first in the stream).
    const textStart = events.find((e) => e.type === "text_start");
    const toolStart = events.find((e) => e.type === "toolcall_start");
    expect(textStart.contentIndex).toBe(0);
    expect(toolStart.contentIndex).toBe(1);
  });

  it("maps null finish_reason with tool calls to 'toolUse' (Ollama-style)", async () => {
    const chunks: OpenAIChunk[] = [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "c1", function: { name: "edit", arguments: "{}" } },
              ],
            },
          },
        ],
      },
      { choices: [{ delta: {}, finish_reason: null }] },
    ];
    openaiCreateMock.mockReturnValue(asyncIter(chunks));

    const streamFn = makeStreamFn();
    const events = summary(await drain(streamFn({} as any, { messages: [] } as any)));

    expect(events[events.length - 1]).toMatchObject({ type: "done", reason: "toolUse" });
  });

  it("maps finish_reason 'length' to stop reason 'length'", async () => {
    const chunks: OpenAIChunk[] = [
      { choices: [{ delta: { content: "x" } }] },
      { choices: [{ delta: {}, finish_reason: "length" }] },
    ];
    openaiCreateMock.mockReturnValue(asyncIter(chunks));

    const streamFn = makeStreamFn();
    const events = summary(await drain(streamFn({} as any, { messages: [] } as any)));
    expect(events[events.length - 1]).toMatchObject({ type: "done", reason: "length" });
  });

  it("emits a terminal error event (no throw) when create() rejects", async () => {
    openaiCreateMock.mockRejectedValue(new Error("boom 500"));

    const streamFn = makeStreamFn();
    const events = summary(await drain(streamFn({} as any, { messages: [] } as any)));

    expect(events[events.length - 1]).toMatchObject({
      type: "error",
      reason: "error",
      errorMessage: "boom 500",
    });
  });

  it("does not emit a toolcall_end when no tool calls arrived (text-only)", async () => {
    const chunks: OpenAIChunk[] = [
      { choices: [{ delta: { content: "hi" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ];
    openaiCreateMock.mockReturnValue(asyncIter(chunks));

    const streamFn = makeStreamFn();
    const events = summary(await drain(streamFn({} as any, { messages: [] } as any)));
    expect(events.some((e) => e.type === "toolcall_end")).toBe(false);
  });
});

describe("aiStream — Anthropic Messages", () => {
  beforeEach(() => {
    settingsHolder.values["ai.provider"] = "anthropic";
    settingsHolder.values["ai.model"] = "claude-test";
  });

  it("emits the text sequence for an Anthropic text-only reply", async () => {
    const evs: AnthropicEvent[] = [
      { type: "message_start" },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" } },
      { type: "message_stop" },
    ];
    anthropicCreateMock.mockReturnValue(asyncIter(evs));

    const streamFn = makeStreamFn();
    const events = summary(await drain(streamFn({} as any, { messages: [] } as any)));

    expect(events).toEqual([
      { type: "start" },
      { type: "text_start", contentIndex: 0 },
      { type: "text_delta", contentIndex: 0, delta: "Hel" },
      { type: "text_delta", contentIndex: 0, delta: "lo" },
      { type: "text_end", contentIndex: 0, content: "Hello" },
      { type: "done", reason: "stop" },
    ]);
  });

  it("streams a tool_use block with accumulated JSON args and 'toolUse' reason", async () => {
    const evs: AnthropicEvent[] = [
      { type: "message_start" },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Editing." } },
      { type: "content_block_stop", index: 0 },
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "tu_1", name: "edit" },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"old_string":"' },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: 'foo"}' },
      },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "tool_use" } },
      { type: "message_stop" },
    ];
    anthropicCreateMock.mockReturnValue(asyncIter(evs));

    const streamFn = makeStreamFn();
    const events = summary(await drain(streamFn({} as any, { messages: [] } as any)));

    expect(events).toEqual([
      { type: "start" },
      { type: "text_start", contentIndex: 0 },
      { type: "text_delta", contentIndex: 0, delta: "Editing." },
      { type: "text_end", contentIndex: 0, content: "Editing." },
      { type: "toolcall_start", contentIndex: 1 },
      { type: "toolcall_delta", contentIndex: 1, delta: '{"old_string":"' },
      { type: "toolcall_delta", contentIndex: 1, delta: 'foo"}' },
      {
        type: "toolcall_end",
        contentIndex: 1,
        toolCall: {
          type: "toolCall",
          id: "tu_1",
          name: "edit",
          arguments: { old_string: "foo" },
        },
      },
      { type: "done", reason: "toolUse" },
    ]);
  });

  it("emits a terminal error event when create() rejects", async () => {
    anthropicCreateMock.mockRejectedValue(new Error("401 unauthorized"));

    const streamFn = makeStreamFn();
    const events = summary(await drain(streamFn({} as any, { messages: [] } as any)));
    expect(events[events.length - 1]).toMatchObject({
      type: "error",
      reason: "error",
      errorMessage: "401 unauthorized",
    });
  });
});
