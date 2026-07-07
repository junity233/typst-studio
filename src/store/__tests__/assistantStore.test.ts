import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * assistantStore tests. We mock everything `sendMessage` touches:
 * - `@earendil-works/pi-agent-core`'s `Agent` — the FakeAgent fires scripted
 *   lifecycle events during `prompt()` so we can exercise `handleAgentEvent`.
 * - `aiStream`'s `makeStreamFn` + `buildModel` — stubs (no real SDK calls).
 * - `assistantTools`' `buildTools` — returns [].
 * - `assistantPrompt`'s `buildSystemPrompt` — deterministic string.
 * - stores + editorApiRef + i18n + useSetting — minimal stubs.
 *
 * The `Agent` mock captures the `subscribe` listener and replays events
 * synchronously inside `prompt()`, so the test author drives the full event
 * sequence declaratively.
 */

// The handle the FakeAgent populates each time `new Agent(...)` runs.
let captured: {
  fireEventsDuringPrompt: (agent: FakeAgent) => void;
} | null = null;

class FakeAgent {
  listener: ((event: any, signal: AbortSignal) => void) | null = null;
  abortController = new AbortController();
  abortCalled = false;
  prompt = vi.fn(async (_text: string): Promise<void> => {
    if (captured) await captured.fireEventsDuringPrompt(this);
  });
  subscribe = (cb: (event: any, signal: AbortSignal) => void) => {
    this.listener = cb;
    return () => {
      this.listener = null;
    };
  };
  abort = () => {
    this.abortCalled = true;
    this.abortController.abort();
  };
}

vi.mock("@earendil-works/pi-agent-core", () => ({ Agent: FakeAgent }));

vi.mock("../components/Assistant/aiStream", () => ({
  makeStreamFn: vi.fn(() => () => ({})),
  buildModel: vi.fn(() => ({ id: "m", api: "openai-completions", provider: "openai" })),
}));
vi.mock("./assistantTools", () => ({ buildTools: vi.fn(() => []) }));
vi.mock("./assistantPrompt", () => ({ buildSystemPrompt: vi.fn(() => "SYS") }));
vi.mock("./documentsStore", () => ({
  useDocumentsStore: { getState: () => ({ documents: {}, updateContent: vi.fn() }) },
}));
vi.mock("./tabsStore", () => ({
  useTabsStore: { getState: () => ({ activeId: null }) },
}));
vi.mock("./workspaceStore", () => ({
  useWorkspaceStore: { getState: () => ({ rootPath: "/ws", name: "ws" }) },
}));
vi.mock("../hooks/useSetting", () => ({
  readSetting: (_path: string, fallback: unknown) => fallback,
}));
vi.mock("../i18n", () => ({ resolveLanguage: () => "en" as const }));
vi.mock("../components/Editor/editorApiRef", () => ({
  editorApiRef: { current: null, pendingReveal: null },
}));

const { useAssistantStore } = await import("../assistantStore");

beforeEach(() => {
  captured = null;
  useAssistantStore.getState().clearConversation();
});

/** Configure the FakeAgent to fire the given events during prompt(). */
function withEvents(events: any[], opts: { rejectWith?: Error } = {}): void {
  captured = {
    fireEventsDuringPrompt: (agent: FakeAgent) => {
      if (opts.rejectWith) throw opts.rejectWith;
      for (const ev of events) {
        agent.listener!(ev, agent.abortController.signal);
      }
    },
  };
}

describe("assistantStore — sendMessage + handleAgentEvent", () => {
  it("pushes the user message and ends in idle status on a clean run", async () => {
    withEvents([]);
    await useAssistantStore.getState().sendMessage("hi");

    const state = useAssistantStore.getState();
    expect(state.messages.some((m) => m.role === "user" && m.text === "hi")).toBe(true);
    expect(state.streamingText).toBe("");
    expect(state.status).toBe("idle");
  });

  it("accumulates text_delta and flushes on message_end into an assistant message", async () => {
    withEvents([
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "He" } },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "llo" } },
      { type: "message_end", message: {} },
    ]);
    await useAssistantStore.getState().sendMessage("q");

    const state = useAssistantStore.getState();
    expect(state.streamingText).toBe("");
    const assistantMsg = state.messages.find(
      (m) => m.role === "assistant" && m.text === "Hello",
    );
    expect(assistantMsg).toBeTruthy();
  });

  it("adds a tool card on tool_execution_start and finalizes on tool_execution_end", async () => {
    withEvents([
      { type: "tool_execution_start", toolCallId: "tc1", toolName: "read_file", args: {} },
      {
        type: "tool_execution_end",
        toolCallId: "tc1",
        toolName: "read_file",
        result: { content: [{ type: "text", text: "file contents" }] },
        isError: false,
      },
    ]);
    await useAssistantStore.getState().sendMessage("read it");

    const toolMsg = useAssistantStore.getState().messages.find((m) => m.toolCallId === "tc1");
    expect(toolMsg?.toolStatus).toBe("ok");
    expect(toolMsg?.toolResult).toBe("file contents");
  });

  it("marks a tool card as error when tool_execution_end carries isError", async () => {
    withEvents([
      { type: "tool_execution_start", toolCallId: "tc1", toolName: "edit", args: {} },
      {
        type: "tool_execution_end",
        toolCallId: "tc1",
        toolName: "edit",
        result: { content: [{ type: "text", text: "old_string not found" }] },
        isError: true,
      },
    ]);
    await useAssistantStore.getState().sendMessage("edit");

    const toolMsg = useAssistantStore.getState().messages.find((m) => m.toolCallId === "tc1");
    expect(toolMsg?.toolStatus).toBe("error");
    expect(toolMsg?.toolResult).toContain("not found");
  });

  it("sets error status + errorMessage when prompt() rejects", async () => {
    withEvents([], { rejectWith: new Error("network down") });
    await useAssistantStore.getState().sendMessage("q");

    const state = useAssistantStore.getState();
    expect(state.status).toBe("error");
    expect(state.errorMessage).toBe("network down");
  });

  it("stop() aborts the agent and sets status to stopped", async () => {
    // Agent whose prompt never resolves until abort; use a deferred.
    let resolvePrompt: () => void = () => {};
    captured = {
      fireEventsDuringPrompt: () => {
        return new Promise<void>((r) => {
          resolvePrompt = r;
        }) as never;
      },
    };
    const sendPromise = useAssistantStore.getState().sendMessage("q");
    // Allow the prompt body to enter (it's awaiting our deferred).
    await Promise.resolve();
    useAssistantStore.getState().stop();
    resolvePrompt();
    await sendPromise;
    expect(useAssistantStore.getState().status).toBe("stopped");
  });

  it("clearConversation resets all state", async () => {
    withEvents([]);
    await useAssistantStore.getState().sendMessage("q");
    expect(useAssistantStore.getState().messages.length).toBeGreaterThan(0);
    useAssistantStore.getState().clearConversation();
    const state = useAssistantStore.getState();
    expect(state.messages).toEqual([]);
    expect(state.status).toBe("idle");
    expect(state.errorMessage).toBeNull();
    expect(state.streamingText).toBe("");
  });

  it("ignores sendMessage while a run is in flight (no concurrent runs)", async () => {
    let resolvePrompt: () => void = () => {};
    captured = {
      fireEventsDuringPrompt: () => new Promise<void>((r) => { resolvePrompt = r; }) as never,
    };
    const first = useAssistantStore.getState().sendMessage("first");
    await Promise.resolve();
    // Second send while the first is still running should no-op.
    const messagesBefore = useAssistantStore.getState().messages.length;
    await useAssistantStore.getState().sendMessage("second");
    expect(useAssistantStore.getState().messages.length).toBe(messagesBefore);
    resolvePrompt();
    await first;
  });
});
