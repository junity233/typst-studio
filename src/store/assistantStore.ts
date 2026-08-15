import { create } from "zustand";
import { Agent, type AgentEvent, type AgentMessage } from "@earendil-works/pi-agent-core";

import { aiLog } from "../lib/aiLog";
import { readSetting } from "../hooks/useSetting";
import { resolveLanguage } from "../i18n";
import { useWorkspaceStore } from "./workspaceStore";
import { useTabsStore } from "./tabsStore";
import { useDocumentsStore } from "./documentsStore";
import { useDiagnosticsStore, selectDiagnosticsForDoc } from "./diagnosticsStore";
import { editorApiRef } from "../components/Editor/editorApiRef";
import { buildSystemPrompt } from "./assistantPrompt";
import { buildTools, type PendingApproval } from "./assistantTools";
import { pathsEqual } from "../lib/assistantPath";
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
  /** Present on edit/write_file tool messages — drives the DiffCard UI.
   *  `id` uniquely identifies THIS approval (several edits can target the same
   *  path), so verdict updates touch exactly one card. */
  approval?: PendingApproval & {
    id: string;
    verdict: "pending" | "applied" | "rejected";
  };
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
  /** When true, edit/write_file approvals auto-accept without user interaction. */
  autoApprove: boolean;

  sendMessage: (text: string) => Promise<void>;
  stop: () => void;
  clearConversation: () => void;
  approve: () => Promise<void>;
  reject: () => Promise<void>;
  toggleAutoApprove: () => void;
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
  resolve: (verdict: "approved" | "rejected") => Promise<void>;
} | null = null;
/**
 * The toolCallId of the edit/write_file tool currently executing. Tools run
 * sequentially, so `tool_execution_start` (edit/write_file) → the tool's
 * `requestApproval` → `tool_execution_end` is a strict nesting; the id lets the
 * approval message correlate with its tool_execution_end so its running
 * spinner settles.
 */
let currentApprovalCallId: string | null = null;

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

/**
 * Collect editor context that should be auto-injected into the user's message:
 * the current text selection (if any) and the active document's compile
 * diagnostics (if there are errors/warnings). Returns a string block to
 * prepend, or null when there's nothing to add.
 *
 * This lets the agent "see" what the user is looking at and what's broken,
 * without the user having to manually copy-paste or describe it.
 */
function collectEditorContext(): string | null {
  const parts: string[] = [];
  const api = editorApiRef.current;
  const { activeId } = useTabsStore.getState();

  // Selection: only include if the user has actual text selected (not empty).
  const selection = api?.getSelectionText()?.trim();
  if (selection) {
    parts.push(`<selected_text>\n${selection}\n</selected_text>`);
  }

  // Diagnostics: errors + warnings from the active document.
  if (activeId) {
    const docDiags = useDiagnosticsStore.getState().byDoc[activeId];
    const diags = selectDiagnosticsForDoc(docDiags);
    if (diags.length > 0) {
      const summary = diags
        .map((d) => `Line ${d.range.start_line}: [${d.severity}] ${d.message}`)
        .join("\n");
      parts.push(`<diagnostics>\n${summary}\n</diagnostics>`);
    }
  }

  if (parts.length === 0) return null;
  return parts.join("\n\n");
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
  autoApprove: false,

  sendMessage: async (text) => {
    if (get().status === "streaming" || get().status === "awaiting-approval") {
      console.warn("[ai] sendMessage ignored — already busy");
      return;
    }
    aiLog("sendMessage start:", text);

    // Auto-inject editor context (selection + diagnostics) so the agent can
    // "see" what the user is looking at. Prepended as tagged blocks; the user's
    // actual message follows. Only the user's text is shown in the UI bubble.
    const editorCtx = collectEditorContext();
    const fullMessage = editorCtx ? `${editorCtx}\n\n${text}` : text;

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
      resolve: (verdict: "approved" | "rejected") => Promise<void>;
    } | null = null;

    const requestApproval = (p: PendingApproval): Promise<string> =>
      new Promise<string>((resolve) => {
        aiLog("[approval] requestApproval invoked, awaiting user:", p.kind, p.path);
        // A unique id for THIS approval — the verdict/status updates below must
        // touch exactly this card, never an earlier DiffCard for the same path.
        const approvalId = uid();
        const callId = currentApprovalCallId ?? undefined;

        // Auto-approve: skip the gate entirely, apply immediately.
        if (get().autoApprove) {
          aiLog("[approval] auto-approve ON — applying without user gate");
          set((s) => ({
            messages: [
              ...s.messages,
              {
                id: uid(),
                role: "tool",
                toolName: p.kind,
                toolCallId: callId,
                approval: { ...p, id: approvalId, verdict: "applied" },
                toolStatus: "running",
              },
            ],
          }));
          void applyApproval(p).then((result) => {
            set((s) => ({
              messages: s.messages.map((m) =>
                m.approval && m.approval.id === approvalId
                  ? { ...m, toolStatus: "ok" }
                  : m,
              ),
            }));
            resolve(result);
          });
          return;
        }

        set((s) => ({
          status: "awaiting-approval",
          pendingApproval: p,
          messages: [
            ...s.messages,
            {
              id: uid(),
              role: "tool",
              toolName: p.kind,
              toolCallId: callId,
              approval: { ...p, id: approvalId, verdict: "pending" },
              toolStatus: "running",
            },
          ],
        }));
        localGate = {
          approval: p,
          resolve: async (verdict) => {
            aiLog("[approval] gate resolved with:", verdict);
            const cardVerdict: "applied" | "rejected" =
              verdict === "approved" ? "applied" : "rejected";
            // Update ONLY this approval's card — matched by its unique id (a
            // later edit to the same file must not rewrite earlier cards'
            // verdicts).
            set((s) => ({
              status: "streaming",
              pendingApproval: null,
              messages: s.messages.map((m) =>
                m.approval && m.approval.id === approvalId
                  ? { ...m, approval: { ...m.approval, verdict: cardVerdict } }
                  : m,
              ),
            }));
            localGate = null;
            approvalGate = null;
            if (verdict === "approved") {
              // Await the actual edit/file-write so the tool result reflects
              // real success or failure. Previously this was fire-and-forget
              // (`void applyApproval(p)`), which reported "applied" even when
              // the write threw or strReplace returned false.
              const result = await applyApproval(p);
              resolve(result);
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
      aiLog("persistent agent created + subscribed");
    }
    const agent = persistentAgent;
    aiLog("calling agent.prompt()");

    try {
      await agent.prompt(fullMessage);
      aiLog("agent.prompt() resolved (turn complete)");
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
  toggleAutoApprove: () => {
    set((s) => ({ autoApprove: !s.autoApprove }));
  },
}));

// --- helpers --------------------------------------------------------------

/**
 * Apply an approved str-replace to a document that is NOT the active editor
 * target — an inactive tab, a soft-closed (hidden) doc, or a file opened
 * specially for this edit. The target's Monaco model isn't attached to the
 * editor (so `editorApiRef.strReplace` would hit the WRONG buffer), and the
 * editor's onChange only fires for the attached model. The edit is therefore
 * applied manually:
 *
 *  1. compute the new buffer from the doc's CURRENT content — the live Monaco
 *     model when one exists (keeping any unsaved edits intact), else the
 *     store's copy — with the same unique-first-occurrence semantics
 *     `editorApiRef.strReplace` enforces;
 *  2. push it into the store (`updateContent` bumps the revision + marks the
 *     doc dirty, exactly like the editor's onChange path);
 *  3. refresh the doc's Monaco model via the registry's controlled replace —
 *     the model-sync effect only seeds content when a model is FIRST opened,
 *     so a background model would otherwise keep the stale buffer forever;
 *  4. forward to the backend with the bumped revision (the same `updateText`
 *     the editor's debounced push uses).
 *
 * Returns false when old_string is missing or ambiguous in the current buffer
 * so the agent can re-read and retry.
 */
async function applyEditToDocument(
  docId: string,
  oldString: string,
  newString: string,
): Promise<boolean> {
  const { monacoModelRegistry } = await import(
    "../components/Editor/monacoModelRegistry"
  );
  const entry = monacoModelRegistry.getModel(docId);
  const doc = useDocumentsStore.getState().documents[docId];
  // The live model is the source of truth when it exists; otherwise fall back
  // to the store's copy (no editor mounted / model not opened yet).
  const source = entry !== undefined ? entry.model.getValue() : doc?.content;
  if (source === undefined) return false;
  const first = source.indexOf(oldString);
  if (first === -1) return false;
  if (source.indexOf(oldString, first + 1) !== -1) return false; // ambiguous
  // Literal splice (indexOf + slice): unlike String.replace with a string
  // replacement, no $-substitution patterns ($&, $', $$ …) are interpreted in
  // newString — the same literal semantics the DiffCard preview uses.
  const next =
    source.slice(0, first) + newString + source.slice(first + oldString.length);

  // Store first: updateContent bumps the revision + marks dirty, mirroring the
  // editor's onChange path. Read the revision back AFTER the bump (same as
  // MonacoEditor.handleTextChanged).
  useDocumentsStore.getState().updateContent(docId, next);
  const revision = useDocumentsStore.getState().documents[docId]?.revision;
  if (revision === undefined) return false; // doc vanished mid-apply

  if (entry !== undefined) {
    monacoModelRegistry.applyExternalContent(docId, next, revision);
  }
  const { updateText } = await import("../lib/tauri");
  // Fire-and-forget like the editor's debounced push: the local edit + store
  // update already succeeded, so a backend hiccup must not read as "edit
  // failed" (the agent would retry and double-apply).
  void updateText(docId, next, revision).catch((e) =>
    aiLog("[approval] edit updateText forward failed:", e),
  );
  return true;
}

/**
 * Apply an approved edit/write. Returns a result string fed back to the LLM as
 * the tool result — a real success/failure message, never a blind "applied".
 *
 * For `edit`, the target is the document at `p.path` (visible tab, soft-closed
 * doc, or a file opened on demand) — NOT whatever tab happens to be active
 * when the user clicks Apply. When the target IS the active doc, the edit goes
 * through `editorApiRef.strReplace` (single undo step). If the replacement
 * didn't land (old_string not found / not unique — e.g. the buffer changed
 * while waiting for approval), the agent is told so it can re-read and retry.
 *
 * For `write_file`, creates the file via IPC, opens it as a tab, and pushes
 * the content through the store + backend. Errors propagate as the tool result.
 */
async function applyApproval(p: PendingApproval): Promise<string> {
  try {
    if (p.kind === "edit") {
      const oldString = p.old_string ?? "";
      const newString = p.new_string ?? "";
      const notApplied =
        "Edit could not be applied — old_string was not found or was not unique in the target buffer (it may have changed while waiting for approval). Re-read the file and retry.";
      const { activeId } = useTabsStore.getState();

      // Resolve the edit target from p.path. The approval may name a file that
      // is NOT the active tab (the agent can edit any workspace file, and the
      // user may have switched tabs while the approval was pending) — applying
      // through the ACTIVE editor regardless of p.path would corrupt whatever
      // tab happens to be active. The documents map covers visible tabs AND
      // soft-closed (hidden) docs.
      const target = p.path
        ? Object.values(useDocumentsStore.getState().documents).find(
            (d) => d.path !== null && pathsEqual(d.path, p.path),
          )
        : undefined;

      // Active-doc fast path: p.path is absent (defaults to the active file)
      // or names it. The target model is attached to the editor, so
      // editorApiRef.strReplace applies the edit as one undo step and the
      // change flows through the editor's normal onChange → updateContent →
      // updateText sync. When p.path IS set but resolves to no open doc, this
      // must stay false — routing through the active editor would apply the
      // edit to whatever tab happens to be active (the exact corruption this
      // path guards against); the unresolved file is opened below instead.
      const isActiveTarget =
        target !== undefined
          ? target.id === activeId
          : !p.path && activeId !== null;
      if (isActiveTarget && editorApiRef.current) {
        const api = editorApiRef.current;
        return api.strReplace(oldString, newString) ? "Edit applied." : notApplied;
      }

      // A present p.path FULLY determines the target — never fall back to the
      // active tab when it resolves to no open doc (that would edit the wrong
      // buffer). Only a missing p.path defaults to the active tab.
      let targetId = target?.id ?? (!p.path ? activeId : null);
      if (targetId === null && p.path) {
        // p.path names a file not open on the frontend (no tab, not hidden):
        // open it as a tab first — openFileByPath MUST be paired with openPath
        // so the tab actually appears (mirrors lib/openFile.ts) — then edit
        // that doc.
        const { openFileByPath } = await import("../lib/tauri");
        const opened = await openFileByPath(p.path);
        useTabsStore.getState().openPath(opened);
        targetId = opened.id;
      }
      if (targetId === null) {
        return "Edit could not be applied — no active editor or document.";
      }
      return (await applyEditToDocument(targetId, oldString, newString))
        ? "Edit applied."
        : notApplied;
    }
    if (p.kind === "write_file") {
      // `create_entry` makes an EMPTY file (it takes no content) and expects a
      // workspace-RELATIVE path. After creating, open it as a tab and push the
      // content through the same store + backend pair an editor edit uses.
      const { invoke } = await import("@tauri-apps/api/core");
      const root = useWorkspaceStore.getState().rootPath;
      const rel = root && p.path.startsWith(root)
        ? p.path.slice(root.length).replace(/^[/\\]+/, "")
        : p.path;
      await invoke("create_entry", { rel, kind: "file" });
      const { openFileByPath, updateText } = await import("../lib/tauri");
      const opened = await openFileByPath(p.path);
      // openFileByPath must ALWAYS be paired with openPath (lib/openFile.ts,
      // useExternalFileRouting.ts) — without it the file is registered +
      // compiled backend-side but no tab appears in the UI.
      useTabsStore.getState().openPath(opened);
      if (p.after !== undefined) {
        // The content must land in the STORE too, not just the backend (the
        // Monaco model is created from doc.content): updateContent sets it,
        // bumps the revision, and marks the doc dirty (the file on disk is
        // still empty until the user saves). Then forward to the backend with
        // the bumped revision — the same pair the editor's edit path uses.
        useDocumentsStore.getState().updateContent(opened.id, p.after);
        const revision =
          useDocumentsStore.getState().documents[opened.id]?.revision;
        if (revision !== undefined) {
          await updateText(opened.id, p.after, revision);
        }
      }
      return "File created.";
    }
    return "Unknown approval kind.";
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return `Edit failed: ${msg}`;
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
  aiLog(
    "[event]",
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
      aiLog("[event] tool_execution_start args:", (event as { args?: unknown }).args);
      // Remember the callId of the approval-gated tools so requestApproval can
      // stamp it onto the approval message (see currentApprovalCallId).
      if (event.toolName === "edit" || event.toolName === "write_file") {
        currentApprovalCallId = event.toolCallId;
      }
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
      aiLog(
        "[event] tool_execution_end isError=",
        event.isError,
        "result=",
        event.result,
      );
      if (currentApprovalCallId === event.toolCallId) {
        currentApprovalCallId = null;
      }
      set((s) => ({
        messages: s.messages.map((m) =>
          // Includes the approval message (it carries the same toolCallId): its
          // running spinner must settle alongside the plain tool card. Its
          // verdict is owned by the approval gate, not this event.
          m.toolCallId === event.toolCallId
            ? {
                ...m,
                toolStatus: event.isError ? "error" : "ok",
                ...(m.approval ? {} : { toolResult: summarizeResult(event.result) }),
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
