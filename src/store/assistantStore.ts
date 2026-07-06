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
  /** The approval currently awaiting a user decision, if any. */
  pendingApproval: PendingApproval | null;

  sendMessage: (text: string) => Promise<void>;
  stop: () => void;
  clearConversation: () => void;
  approve: () => Promise<void>;
  reject: () => Promise<void>;
}

// --- module-scoped run state ---------------------------------------------

/** The current run's agent, if any. Held at module scope so `stop()` can abort. */
let currentAgent: Agent | null = null;
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
  pendingApproval: null,

  sendMessage: async (text) => {
    if (get().status === "streaming" || get().status === "awaiting-approval") {
      return;
    }
    set((s) => ({
      messages: [...s.messages, { id: uid(), role: "user", text }],
      status: "streaming",
      streamingText: "",
      errorMessage: null,
    }));

    // Each run gets its own agent + approval gate closure. The tools capture
    // the gate resolver via `requestApproval` below.
    let localGate: {
      approval: PendingApproval;
      resolve: (verdict: "approved" | "rejected") => void;
    } | null = null;

    const requestApproval = (p: PendingApproval): Promise<string> =>
      new Promise<string>((resolve) => {
        set((s) => ({
          status: "awaiting-approval",
          pendingApproval: p,
          // Surface the pending approval as a tool message so the DiffCard
          // renders in the transcript.
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
            // Mark the card's verdict and clear the gate.
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

    const systemPrompt = buildSystemPrompt({
      ...currentWorkspaceContext(),
      uiLanguage: currentUiLanguage(),
    });

    const agent = new Agent({
      initialState: {
        systemPrompt,
        model: buildModel(),
        tools: buildTools({
          requestApproval,
          abortSignal: new AbortController().signal,
        }),
      },
      streamFn: makeStreamFn(),
      // Edits block in the tool handler; run tools sequentially so an approval
      // gate doesn't stall a parallel batch.
      toolExecution: "sequential",
    });
    currentAgent = agent;

    agent.subscribe((event) => handleAgentEvent(event, set, get));

    try {
      await agent.prompt(text);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      set((s) => ({
        status: "error",
        errorMessage: msg,
        messages: [
          ...s.messages,
          { id: uid(), role: "assistant", text: "", toolStatus: "error", toolResult: msg },
        ],
      }));
    } finally {
      // Finalize: flush any accumulated streaming text into a message.
      set((s) => {
        const text2 = s.streamingText;
        const msgs = text2
          ? [...s.messages, { id: uid(), role: "assistant" as const, text: text2 }]
          : s.messages;
        return {
          messages: msgs,
          status: s.status === "error" ? s.status : "idle",
          streamingText: "",
        };
      });
      currentAgent = null;
      approvalGate = null;
    }
  },

  stop: () => {
    currentAgent?.abort();
    approvalGate?.resolve("rejected");
    set((s) => ({
      status: "stopped",
      // Flush streaming text as a partial assistant message.
      messages: s.streamingText
        ? [...s.messages, { id: uid(), role: "assistant", text: s.streamingText }]
        : s.messages,
      streamingText: "",
      pendingApproval: null,
    }));
  },

  clearConversation: () => {
    currentAgent?.abort();
    approvalGate?.resolve("rejected");
    currentAgent = null;
    approvalGate = null;
    set({
      messages: [],
      status: "idle",
      streamingText: "",
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
    // Create the file via IPC; the workspace watcher + open_file flow handle
    // the rest. Wrapped in try/catch — a failure here just means the file
    // wasn't created; the agent will see it via a subsequent read_file.
    const { invoke } = await import("@tauri-apps/api/core");
    try {
      await invoke("create_entry", {
        rel: p.path,
        kind: "file",
        content: p.after ?? "",
      });
    } catch {
      // Swallow; the agent's next read_file will reveal whether it landed.
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
  switch (event.type) {
    case "message_update": {
      const ev = event.assistantMessageEvent;
      if (ev.type === "text_delta") {
        set({ streamingText: get().streamingText + ev.delta });
      }
      break;
    }
    case "tool_execution_start": {
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
      // The assistant message finished. Flush accumulated streaming text into
      // the message that message_end represents, so it persists in the transcript.
      const text = get().streamingText;
      set((s) => ({
        streamingText: "",
        messages: text
          ? [...s.messages, { id: uid(), role: "assistant", text }]
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
