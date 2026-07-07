import { create } from "zustand";
import { Agent, type AgentEvent, type AgentMessage } from "@earendil-works/pi-agent-core";

import { readSetting } from "../hooks/useSetting";
import { resolveLanguage } from "../i18n";
import { useWorkspaceStore } from "./workspaceStore";
import { useTabsStore } from "./tabsStore";
import { useDocumentsStore } from "./documentsStore";
import { editorApiRef } from "../components/Editor/editorApiRef";
import { buildSystemPrompt } from "./assistantPrompt";
import { buildTools, type PendingApproval } from "./assistantTools";
import { buildModel, makeStreamFn } from "../components/Assistant/aiStream";

/**
 * Assistant UI + agent-loop state.
 *
 * The store owns the conversation transcript (UI-shaped messages), the
 * streaming accumulator, and the propose-approve gate. The agent loop itself
 * runs inside `pi-agent-core`'s `Agent` — we construct one per `sendMessage`,
 * subscribe to its lifecycle events, and translate them into store mutations.
 *
 * Edits require user approval (Strategy A in the spec): the tool's `execute`
 * handler awaits a Promise that is only resolved when the user clicks
 * Apply/Reject. Because pi-agent-core blocks on each tool result before
 * issuing the next turn, "waiting for approval" is structurally identical to
 * "waiting for tool result" — no provider-timeout risk.
 */
export type AssistantStatus =
  | "idle"
  | "streaming"
  | "awaiting-approval"
  | "stopped"
  | "error";

export interface AssistantMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  text?: string;
  thinking?: string;
  toolName?: string;
  toolCallId?: string;
  toolResult?: string;
  toolStatus?: "running" | "ok" | "error";
  /** Present on edit/write_file tool messages — drives the DiffCard UI. */
  approval?: PendingApproval & { verdict: "pending" | "applied" | "rejected" };
}

interface AssistantState {
  messages: AssistantMessage[];
  status: AssistantStatus;
  errorMessage: string | null;
  /** Live accumulator for the in-flight assistant text turn. */
  streamingText: string;
  /** Live accumulator for the in-flight assistant thinking content. */
  streamingThinking: string;
  /** The approval currently awaiting a user decision, if any. */
  pendingApproval: PendingApproval | null;

  sendMessage: (text: string) => Promise<void>;
  stop: () => void;
  clearConversation: () => void;
  approve: () => Promise<void>;
  reject: () => Promise<void>;
}

// --- module-scoped run state ---------------------------------------------

/**
 * The persistent agent — lives across turns so the conversation transcript
 * accumulates (multi-turn). Created lazily on first `sendMessage`, destroyed
 * on `clearConversation`. Held at module scope so `stop()` can abort it.
 */
let persistentAgent: Agent | null = null;
/** The approval gate resolver — the tool handler awaits this. */
let approvalGate: {
  approval: PendingApproval;
  resolve: (verdict: "approved" | "rejected") => void;
} | null = null;

function uid(): string {
  return crypto.randomUUID();
}

function currentWorkspaceContext() {
  const ws = useWorkspaceStore.getState();
  const { activeId } = useTabsStore.getState();
  const doc = activeId ? useDocumentsStore.getState().documents[activeId] : null;
  return {
    workspaceName: ws.name,
    activeFilePath: doc?.path ?? null,
  };
}

function currentUiLanguage(): "en" | "zh" {
  return resolveLanguage(readSetting<string>("appearance.language", "auto"));
}

// --- store ---------------------------------------------------------------

export const useAssistantStore = create<AssistantState>((set, get) => ({
  messages: [],
  status: "idle",
  errorMessage: null,
  streamingText: "",
  streamingThinking: "",
  pendingApproval: null,

  sendMessage: async (text) => {
    if (get().status === "streaming" || get().status === "awaiting-approval") {
      console.warn("[ai] sendMessage ignored — already busy");
      return;
    }
    console.log("[ai] sendMessage start:", JSON.stringify(text));
    set((s) => ({
      messages: [...s.messages, { id: uid(), role: "user", text }],
      status: "streaming",
      streamingText: "",
      streamingThinking: "",
      errorMessage: null,
    }));

    // The approval gate closure — captured by tool handlers via requestApproval.
    let localGate: {
      approval: PendingApproval;
      resolve: (verdict: "approved" | "rejected") => void;
    } | null = null;

    const requestApproval = (p: PendingApproval): Promise<string> =>
      new Promise<string>((resolve) => {
        console.log("[ai][approval] requestApproval invoked, awaiting user:", p.kind, p.path);
        set((s) => ({
          status: "awaiting-approval",
          pendingApproval: p,
          messages: [
            ...s.messages,
            {
              id: uid(),
              role: "tool",
              toolName: p.kind,
              approval: { ...p, verdict: "pending" },
              toolStatus: "running",
            },
          ],
        }));
        localGate = {
          approval: p,
          resolve: (verdict) => {
            console.log("[ai][approval] gate resolved with:", verdict);
            const cardVerdict: "applied" | "rejected" =
              verdict === "approved" ? "applied" : "rejected";
            set((s) => ({
              status: "streaming",
              pendingApproval: null,
              messages: s.messages.map((m) =>
                m.approval && m.approval === (p as PendingApproval & { verdict: string })
                  ? { ...m, approval: { ...m.approval, verdict: cardVerdict } }
                  : m,
              ),
            }));
            localGate = null;
            approvalGate = null;
            if (verdict === "approved") {
              void applyApproval(p);
              resolve("Edit applied.");
            } else {
              resolve("User rejected the edit.");
            }
          },
        };
        approvalGate = localGate;
      });

    // Create the persistent agent on first send, or reuse it for multi-turn
    // conversation. The Agent accumulates the transcript internally.
    if (!persistentAgent) {
      const systemPrompt = buildSystemPrompt({
        ...currentWorkspaceContext(),
        uiLanguage: currentUiLanguage(),
      });
      persistentAgent = new Agent({
        initialState: {
          systemPrompt,
          model: buildModel(),
          tools: buildTools({ requestApproval }),
        },
        streamFn: makeStreamFn(),
        // Edits block in the tool handler; run tools sequentially so an approval
        // gate doesn't stall a parallel batch.
        toolExecution: "sequential",
      });
      persistentAgent.subscribe((event) => handleAgentEvent(event, set, get));
      console.log("[ai] persistent agent created + subscribed");
    }
    const agent = persistentAgent;
    console.log("[ai] calling agent.prompt()");

    try {
      await agent.prompt(text);
      console.log("[ai] agent.prompt() resolved (turn complete)");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[ai] agent.prompt() rejected:", msg);
      set((s) => ({
        status: "error",
        errorMessage: msg,
        messages: [
          ...s.messages,
          { id: uid(), role: "assistant", text: "", toolStatus: "error", toolResult: msg },
        ],
      }));
    } finally {
      // Finalize: flush any accumulated streaming text + thinking into messages.
      set((s) => {
        const text2 = s.streamingText;
        const think = s.streamingThinking;
        const msgs = text2 || think
          ? [
              ...s.messages,
              {
                id: uid(),
                role: "assistant" as const,
                text: text2 || undefined,
                thinking: think || undefined,
              },
            ]
          : s.messages;
        return {
          messages: msgs,
          status:
            s.status === "error" || s.status === "stopped" ? s.status : "idle",
          streamingText: "",
          streamingThinking: "",
        };
      });
      approvalGate = null;
    }
  },

  stop: () => {
    persistentAgent?.abort();
    approvalGate?.resolve("rejected");
    set((s) => ({
      status: "stopped",
      // Flush streaming text as a partial assistant message.
      messages: s.streamingText || s.streamingThinking
        ? [
            ...s.messages,
            {
              id: uid(),
              role: "assistant" as const,
              text: s.streamingText || undefined,
              thinking: s.streamingThinking || undefined,
            },
          ]
        : s.messages,
      streamingText: "",
      streamingThinking: "",
      pendingApproval: null,
    }));
  },

  clearConversation: () => {
    persistentAgent?.abort();
    approvalGate?.resolve("rejected");
    persistentAgent = null;
    approvalGate = null;
    set({
      messages: [],
      status: "idle",
      streamingText: "",
      streamingThinking: "",
      pendingApproval: null,
      errorMessage: null,
    });
  },

  approve: async () => {
    approvalGate?.resolve("approved");
  },
  reject: async () => {
    approvalGate?.resolve("rejected");
  },
}));

// --- helpers --------------------------------------------------------------

/**
 * Apply an approved edit/write to the editor + store. For `edit` we go through
 * `editorApiRef.strReplace` (single undo step); the store follows via Monaco's
 * onChange → updateContent debounce. For `write_file`, we create the file via
 * the existing IPC and let the workspace watcher pick it up.
 */
async function applyApproval(p: PendingApproval): Promise<void> {
  if (p.kind === "edit") {
    const api = editorApiRef.current;
    if (api) {
      api.strReplace(p.old_string ?? "", p.new_string ?? "");
      return;
    }
    // No editor: update the active doc's content directly as a fallback.
    const { activeId } = useTabsStore.getState();
    if (activeId) {
      const doc = useDocumentsStore.getState().documents[activeId];
      if (doc) {
        const next = doc.content.replace(p.old_string ?? "", p.new_string ?? "");
        useDocumentsStore.getState().updateContent(activeId, next);
      }
    }
    return;
  }
  if (p.kind === "write_file") {
    // `create_entry` makes an EMPTY file (it takes no content) and expects a
    // workspace-RELATIVE path. After creating, open it as a tab and push the
    // content via updateText so it lands on disk + in the editor. Errors are
    // surfaced to the agent via the tool result so it can retry with `edit`.
    const { invoke } = await import("@tauri-apps/api/core");
    const root = useWorkspaceStore.getState().rootPath;
    // Relativize the absolute path against the workspace root.
    const rel = root && p.path.startsWith(root)
      ? p.path.slice(root.length).replace(/^[/\\]+/, "")
      : p.path;
    await invoke("create_entry", { rel, kind: "file" });
    // Open the new file as a tab, then set its content via the document pipeline.
    const { openFileByPath, updateText } = await import("../lib/tauri");
    const opened = await openFileByPath(p.path);
    if (p.after) {
      await updateText(opened.id, p.after, opened.revision);
    }
  }
}

/**
 * Translate agent lifecycle events into store mutations.
 *
 * `message_update` carries the raw `AssistantMessageEvent` from our streamFn;
 * we read its `delta` to accumulate streaming text. `tool_execution_*` events
 * drive the tool cards.
 */
type SetFn = (
  partial:
    | AssistantState
    | Partial<AssistantState>
    | ((s: AssistantState) => AssistantState | Partial<AssistantState>),
) => void;

function handleAgentEvent(
  event: AgentEvent,
  set: SetFn,
  get: () => AssistantState,
): void {
  // Trace every lifecycle event so a hang can be localized to the last event
  // that fired before the agent stopped making progress.
  console.log(
    "[ai][event]",
    event.type,
    "toolName" in event ? event.toolName : "",
    "toolCallId" in event ? event.toolCallId : "",
  );
  switch (event.type) {
    case "message_update": {
      const ev = event.assistantMessageEvent;
      if (ev.type === "text_delta") {
        set({ streamingText: get().streamingText + ev.delta });
      } else if (ev.type === "thinking_delta") {
        set({ streamingThinking: get().streamingThinking + ev.delta });
      }
      break;
    }
    case "tool_execution_start": {
      console.log("[ai][event] tool_execution_start args:", JSON.stringify((event as { args?: unknown }).args));
      set((s) => ({
        messages: [
          ...s.messages,
          {
            id: uid(),
            role: "tool",
            toolName: event.toolName,
            toolCallId: event.toolCallId,
            toolStatus: "running",
          },
        ],
      }));
      break;
    }
    case "tool_execution_end": {
      console.log(
        "[ai][event] tool_execution_end isError=",
        event.isError,
        "result=",
        JSON.stringify(event.result).slice(0, 200),
      );
      set((s) => ({
        messages: s.messages.map((m) =>
          m.toolCallId === event.toolCallId && !m.approval
            ? {
                ...m,
                toolStatus: event.isError ? "error" : "ok",
                toolResult: summarizeResult(event.result),
              }
            : m,
        ),
      }));
      break;
    }
    case "message_end": {
      // The assistant message finished. Flush accumulated streaming text +
      // thinking into the transcript so it persists between turns.
      const text = get().streamingText;
      const think = get().streamingThinking;
      set((s) => ({
        streamingText: "",
        streamingThinking: "",
        messages: text || think
          ? [
              ...s.messages,
              {
                id: uid(),
                role: "assistant" as const,
                text: text || undefined,
                thinking: think || undefined,
              },
            ]
          : s.messages,
      }));
      break;
    }
    case "agent_end":
    case "agent_start":
    case "turn_start":
    case "turn_end":
    case "message_start":
    case "tool_execution_update":
    default:
      break;
  }
}

/** Flatten an AgentToolResult into a short preview string for the UI card. */
function summarizeResult(result: unknown): string {
  if (result == null) return "";
  if (typeof result === "string") return result;
  const r = result as { content?: Array<{ type: string; text?: string }> };
  if (Array.isArray(r.content)) {
    return r.content
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("");
  }
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

// Re-export the AgentMessage type for callers that need it.
export type { AgentMessage };
