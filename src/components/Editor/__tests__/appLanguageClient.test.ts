import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * Spec §7 (Initialize 配置: 有/无主工作区; 禁止全局 rootPath 覆盖), §9
 * (AppLanguageClient: 生命周期, 唯一 client, 启动与 replay, 重连), §17 (前端模块
 * 调整: new `appLanguageClient.ts`, remove `rootPathRef`/initialize-time root 猜测),
 * §21 #13 (rootPath removed).
 *
 * The LSP connection (WebSocket + MonacoLanguageClient construction) is NOT unit-
 * testable under jsdom — real Monaco pulls widget CSS and a Constructable
 * StyleSheets polyfill that jsdom cannot run, and a live WebSocket can't be
 * opened. The spec-critical logic therefore lives in PURE helpers
 * (`buildLanguageClientOptions`, `mapStateChange`, `paramsEqual`) which we test
 * directly. The singleton lifecycle (`start`/`stop`/state transitions) is tested
 * with `monaco-languageclient` and `vscode-ws-jsonrpc` mocked so we exercise the
 * state machine without touching real transports.
 *
 * The `vscode` `Uri` helper cannot be imported under vitest+jsdom (same CSS
 * constraint documented in documentUri.test.ts). We mock it with a faithful
 * `Uri.file` re-implementation that mirrors VS Code's algorithm, so the
 * `workspaceFolder.uri.toString()` shape assertions are exact.
 */

// --- faithful vscode.Uri mock (mirrors monaco-vscode-api's fileUriToString) ---
vi.mock("vscode", () => {
  interface UriLike {
    readonly scheme: string;
    readonly authority: string;
    readonly path: string;
    readonly fsPath: string;
    toString(): string;
  }

  function toString(scheme: string, authority: string, path: string): string {
    let res = scheme + ":";
    if (authority.length > 0 || scheme === "file") {
      res += "//" + authority;
    }
    res += path;
    return res;
  }

  function file(path: string): UriLike {
    const hasDrive = /^[a-zA-Z]:/.test(path);
    const hasBackslash = path.includes("\\");
    const isWindows = hasDrive || hasBackslash;
    const normalized = path.replace(/\\/g, "/");
    let uriPath: string;
    if (isWindows) {
      uriPath = normalized.startsWith("/") ? normalized.slice(1) : normalized;
    } else {
      uriPath = normalized.startsWith("/") ? normalized : "/" + normalized;
    }
    return {
      scheme: "file",
      authority: "",
      path: isWindows ? "/" + uriPath : uriPath,
      fsPath: path,
      toString: () => toString("file", "", isWindows ? "/" + uriPath : uriPath),
    };
  }

  return { Uri: { file } };
});

// --- mock monaco-languageclient so we never construct a real BaseLanguageClient ---
// `MonacoLanguageClient` becomes a minimal stub recording construction; its
// `start`/`stop`/`onDidChangeState`/`state` surface is driven by the test via the
// captured instance handle. `vi.hoisted` runs the factory BEFORE imports (vi.mock
// is hoisted above imports but its factory cannot close over plain top-level
// decls), so we share the class + instance log through the hoisted bag.
const {
  MockClient,
  startedInstances,
  MockWebSocket,
  webSocketInstances,
  iwsInstances,
} = vi.hoisted(() => {
    const startedInstances: {
      state: number;
      clientOptions: unknown;
      messageTransports: unknown;
      start: () => Promise<void>;
      stop: () => Promise<void>;
      isRunning: () => boolean;
      onDidChangeState: (
        cb: (e: { oldState: number; newState: number }) => void,
      ) => { dispose: () => void };
      __stateCb:
        | ((e: { oldState: number; newState: number }) => void)
        | null;
    }[] = [];

    class MockClient {
      clientOptions: unknown;
      messageTransports: unknown;
      state = 1; // Stopped
      start = async () => {
        this.state = 3; // Starting; caller flips to Running via the state cb.
      };
      // M2: mirror real BaseLanguageClient.stop() — it FIRES the
      // `{oldState, newState: Stopped}` state-change callback synchronously
      // before resolving. This makes the I3 Ready→Failed→Disabled flicker
      // observable AND exercises the C1/C2 fixes.
      stop = async () => {
        const prev = this.state;
        if (this.__stateCb && prev !== 1) {
          this.__stateCb({ oldState: prev, newState: 1 });
        }
        this.state = 1; // Stopped
      };
      dispose = async () => {
        this.state = 1;
      };
      isRunning = () => this.state === 2;
      onDidChangeState = (
        cb: (e: { oldState: number; newState: number }) => void,
      ) => {
        this.__stateCb = cb;
        return { dispose: () => {} };
      };
      __stateCb:
        | ((e: { oldState: number; newState: number }) => void)
        | null = null;
      constructor(opts: { clientOptions: unknown; messageTransports: unknown }) {
        this.clientOptions = opts.clientOptions;
        this.messageTransports = opts.messageTransports;
        startedInstances.push(this);
      }
    }

    const webSocketInstances: {
      readyState: number;
      url: string;
      onopen: (() => void) | null;
      onerror: (() => void) | null;
      onclose: (() => void) | null;
      close: () => void;
      send: () => void;
      closed: boolean;
    }[] = [];

    class MockWebSocket {
      static OPEN = 1;
      static CLOSED = 3;
      readyState = 0;
      url: string;
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: (() => void) | null = null;
      closed = false;
      constructor(url: string) {
        this.url = url;
        webSocketInstances.push(this);
      }
      close() {
        this.readyState = 3;
        this.closed = true;
      }
      send() {}
    }

    // C2: per-iws dispose tracking. Each toSocket() result carries its own
    // `disposed` flag (set when dispose() is called) so tests can assert the
    // socket was torn down on stop() WITHOUT a parallel array that cross-test
    // resetForTest dispose() calls could corrupt. The toSocket results are
    // recorded here in construction order for indexed lookup.
    const iwsInstances: { disposed: boolean; dispose: () => void }[] = [];

    return {
      MockClient,
      startedInstances,
      MockWebSocket,
      webSocketInstances,
      iwsInstances,
    };
  });

vi.mock("monaco-languageclient", () => ({
  MonacoLanguageClient: MockClient,
}));

vi.mock("vscode-ws-jsonrpc", () => ({
  // C2: the real toSocket wrapper's dispose() calls webSocket.close(); the mock
  // mirrors that AND records the call on the per-instance `disposed` flag so
  // tests can assert the socket was torn down on stop().
  toSocket: (ws: { close: () => void }) => {
    const iws = {
      disposed: false,
      send: () => {},
      onMessage: () => {},
      onError: () => {},
      onClose: () => {},
      dispose: () => {
        iws.disposed = true;
        ws.close();
      },
    };
    iwsInstances.push(iws);
    return iws;
  },
  WebSocketMessageReader: class {},
  WebSocketMessageWriter: class {
    end() {}
  },
}));

// `vscode-languageclient` re-exports the State enum; the mock provides the same
// numeric values so mapStateChange is exercised against the real constants.
vi.mock("vscode-languageclient/browser.js", () => ({
  State: { Stopped: 1, Starting: 3, Running: 2 },
}));

import {
  buildLanguageClientOptions,
  mapStateChange,
  paramsEqual,
  appLanguageClient,
  type StartParams,
  type LspClientState,
} from "../appLanguageClient";

// Helper: drive the (mocked) MonacoLanguageClient through its state machine.
// Mirrors the real BaseLanguageClient transitions during start(): Stopped →
// Starting → Running.
type MockClientInstance = (typeof startedInstances)[number];
function runStart(instance: MockClientInstance): void {
  instance.__stateCb?.({ oldState: 1, newState: 3 });
  instance.state = 3;
  instance.__stateCb?.({ oldState: 3, newState: 2 });
  instance.state = 2;
}

beforeEach(() => {
  startedInstances.length = 0;
  webSocketInstances.length = 0;
  iwsInstances.length = 0;
  // Install our MockWebSocket as the global constructor the implementation
  // calls via `new WebSocket(url)`. jsdom ships a real (non-functional-in-node)
  // WebSocket; replacing it on the window lets each test capture the instance
  // and drive onopen/onerror/onclose.
  vi.stubGlobal("WebSocket", MockWebSocket);
  return appLanguageClient.resetForTest();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("buildLanguageClientOptions — §7.1 有主工作区", () => {
  it("populates workspaceFolder (uri + name + index 0)", () => {
    const opts = buildLanguageClientOptions("/home/me/proj", "my-proj");
    expect(opts.workspaceFolder).toBeDefined();
    expect(opts.workspaceFolder?.index).toBe(0);
    expect(opts.workspaceFolder?.name).toBe("my-proj");
    // Uri.file produced the file: form for the absolute root.
    expect(opts.workspaceFolder?.uri.toString()).toBe("file:///home/me/proj");
  });

  it("documentSelector covers both file and untitled schemes (§9.2)", () => {
    const opts = buildLanguageClientOptions("/home/me/proj", "my-proj");
    const schemes = (opts.documentSelector as Array<{ scheme: string }>).map(
      (d) => d.scheme,
    );
    expect(schemes).toEqual(expect.arrayContaining(["file", "untitled"]));
    expect(schemes.length).toBe(2);
    for (const entry of opts.documentSelector as Array<{ language: string }>) {
      expect(entry.language).toBe("typst");
    }
  });

  it("initializationOptions has EXACTLY the 3 trigger flags (§7.3 retained options)", () => {
    const opts = buildLanguageClientOptions("/home/me/proj", "my-proj");
    expect(opts.initializationOptions).toEqual({
      triggerSuggest: true,
      triggerParameterHints: true,
      supportHtmlInMarkdown: true,
    });
  });

  it("falls back to basename when workspaceName is null but rootPath set", () => {
    const opts = buildLanguageClientOptions("/home/me/proj", null);
    expect(opts.workspaceFolder?.name).toBe("proj");
  });

  it("strips a Windows verbatim prefix before creating the workspace URI", () => {
    const opts = buildLanguageClientOptions(
      "\\\\?\\D:\\code\\typst-studio",
      null,
    );
    expect(opts.workspaceFolder?.uri.toString()).toBe(
      "file:///D:/code/typst-studio",
    );
    expect(opts.workspaceFolder?.name).toBe("typst-studio");
  });
});

describe("buildLanguageClientOptions — §7.2 无主工作区", () => {
  it("leaves workspaceFolder undefined when rootPath is null", () => {
    const opts = buildLanguageClientOptions(null, null);
    expect(opts.workspaceFolder).toBeUndefined();
  });

  it("keeps initializationOptions unchanged (still the 3 flags)", () => {
    const opts = buildLanguageClientOptions(null, null);
    expect(opts.initializationOptions).toEqual({
      triggerSuggest: true,
      triggerParameterHints: true,
      supportHtmlInMarkdown: true,
    });
  });

  it("documentSelector still covers both schemes", () => {
    const opts = buildLanguageClientOptions(null, null);
    const schemes = (opts.documentSelector as Array<{ scheme: string }>).map(
      (d) => d.scheme,
    );
    expect(schemes).toEqual(expect.arrayContaining(["file", "untitled"]));
  });
});

describe("buildLanguageClientOptions — §7.3 / §21 #13 rootPath tripwire", () => {
  it("the serialized options contain NO 'rootPath' or 'rootUri' key", () => {
    const withWs = buildLanguageClientOptions("/home/me/proj", "my-proj");
    const withoutWs = buildLanguageClientOptions(null, null);
    // The serialized form must not carry the global root override anywhere —
    // not in initializationOptions, not as a stray clientOptions key. The
    // workspaceFolder's `uri` legitimately contains "/home/me/proj" but the
    // JSON KEY "rootPath"/"rootUri" must never appear.
    expect(JSON.stringify(withWs)).not.toContain('"rootPath"');
    expect(JSON.stringify(withWs)).not.toContain('"rootUri"');
    expect(JSON.stringify(withoutWs)).not.toContain('"rootPath"');
    expect(JSON.stringify(withoutWs)).not.toContain('"rootUri"');
  });
});

/**
 * mapStateChange transition table (mirrors the §9.1 lifecycle + §9.4 重连):
 *
 *   vscode-languageclient State → our LspClientState
 *   ─────────────────────────────────────────────────────
 *   (any) → Starting(3)            = "Initializing"
 *   Starting(3) → Running(2)       = "Ready"
 *   * → Stopped(1) when was Running= "Failed"
 *   Stopped(1) → Stopped(1)        = null (no-op)
 *   Running(2) → Starting(3)       = "Initializing" (reconnect/restart)
 *
 * The "Replaying" transient in the public type is folded into the
 * Starting→Running window here: didOpen replay happens during start() once the
 * client reaches Running. We surface Running as "Ready" because by that point
 * the auto-replay has completed (DidOpenTextDocumentFeature.register ran at
 * start time). The "Replaying" label is kept on the public type for future
 * finer-grained surfacing but mapStateChange does not emit it from State alone.
 */
describe("mapStateChange — State enum → LspClientState (§9.1)", () => {
  const Stopped = 1;
  const Running = 2;
  const Starting = 3;

  it("Stopped → Starting = Initializing", () => {
    expect(mapStateChange(Stopped, Starting)).toBe("Initializing");
  });

  it("Starting → Running = Ready", () => {
    expect(mapStateChange(Starting, Running)).toBe("Ready");
  });

  it("Running → Stopped (was Running) = Failed (§9.4 connection lost)", () => {
    expect(mapStateChange(Running, Stopped)).toBe("Failed");
  });

  it("Running → Starting = Initializing (restart / reconnect)", () => {
    expect(mapStateChange(Running, Starting)).toBe("Initializing");
  });

  it("Stopped → Stopped = null (no transition of interest)", () => {
    expect(mapStateChange(Stopped, Stopped)).toBeNull();
  });

  it("Starting → Stopped (never reached Running) = Failed", () => {
    expect(mapStateChange(Starting, Stopped)).toBe("Failed");
  });
});

describe("paramsEqual — start() idempotency (§9.2)", () => {
  const a: StartParams = {
    wsUrl: "ws://x/lsp",
    workspaceRootPath: "/home/me/proj",
    workspaceName: "my-proj",
  };

  it("identical params = true", () => {
    expect(paramsEqual(a, { ...a })).toBe(true);
  });

  it("differing wsUrl = false", () => {
    expect(paramsEqual(a, { ...a, wsUrl: "ws://y/lsp" })).toBe(false);
  });

  it("differing workspaceRootPath = false (incl. null vs set)", () => {
    expect(paramsEqual(a, { ...a, workspaceRootPath: "/other" })).toBe(false);
    expect(
      paramsEqual(a, { ...a, workspaceRootPath: null, workspaceName: null }),
    ).toBe(false);
  });

  it("differing workspaceName = false", () => {
    expect(paramsEqual(a, { ...a, workspaceName: "other" })).toBe(false);
  });

  it("both null workspaces with same wsUrl = true", () => {
    const n1: StartParams = {
      wsUrl: "ws://x/lsp",
      workspaceRootPath: null,
      workspaceName: null,
    };
    expect(paramsEqual(n1, { ...n1 })).toBe(true);
  });
});

describe("appLanguageClient — lifecycle (mocked transports)", () => {
  /**
   * Drive a `start()` call to Ready against the mocked transports:
   * 1. issue start() (returns the handshake promise),
   * 2. wait for the implementation to construct the WebSocket (it opens AFTER
   *    an await of stopInternal, so we poll rather than assert synchronously),
   * 3. fire onopen → the MonacoLanguageClient mock is constructed,
   * 4. run the mock client Stopped→Starting→Running so start() resolves Ready.
   */
  async function driveToReady(
    params: StartParams,
    wsIndex: number,
  ): Promise<void> {
    const p = appLanguageClient.start(params);
    await vi.waitFor(() => expect(webSocketInstances.length).toBe(wsIndex + 1));
    const ws = webSocketInstances[wsIndex]!;
    expect(ws.onopen).not.toBeNull();
    ws.onopen!();
    await vi.waitFor(() => expect(startedInstances.length).toBe(wsIndex + 1));
    runStart(startedInstances[wsIndex]!);
    await p;
  }

  it("start() drives Connecting → Initializing → Ready and bumps generation", async () => {
    const seen: LspClientState[] = [];
    appLanguageClient.subscribe((s) => seen.push(s.state));

    const gen0 = appLanguageClient.getGeneration();

    // Kick off start; the WS is constructed after an async stopInternal, so we
    // poll for it. Once present, Connecting has already been surfaced.
    const p = appLanguageClient.start({
      wsUrl: "ws://host/lsp",
      workspaceRootPath: null,
      workspaceName: null,
    });
    await vi.waitFor(() => expect(webSocketInstances).toHaveLength(1));
    expect(appLanguageClient.getSnapshot().state).toBe("Connecting");
    // Fire onopen → the client gets constructed and started.
    webSocketInstances[0]!.onopen!();
    await vi.waitFor(() => expect(startedInstances).toHaveLength(1));
    runStart(startedInstances[0]!);
    await p;

    expect(appLanguageClient.getSnapshot().state).toBe("Ready");
    expect(appLanguageClient.isRunning()).toBe(true);
    expect(appLanguageClient.getGeneration()).toBe(gen0 + 1);
    // Listeners saw at least: Connecting, Initializing, Ready.
    expect(seen).toContain("Connecting");
    expect(seen).toContain("Initializing");
    expect(seen).toContain("Ready");
  });

  it("start() with the SAME params is idempotent (no second generation bump)", async () => {
    const params: StartParams = {
      wsUrl: "ws://host/lsp",
      workspaceRootPath: null,
      workspaceName: null,
    };
    await driveToReady(params, 0);
    const genAfterFirst = appLanguageClient.getGeneration();
    const wsCount = webSocketInstances.length;
    const clientCount = startedInstances.length;

    // Second start with identical params must be a no-op: same generation, no
    // new WebSocket, no new client instance.
    await appLanguageClient.start(params);
    expect(appLanguageClient.getGeneration()).toBe(genAfterFirst);
    expect(webSocketInstances).toHaveLength(wsCount);
    expect(startedInstances).toHaveLength(clientCount);
    expect(appLanguageClient.getSnapshot().state).toBe("Ready");
  });

  it("start() with DIFFERENT params bumps generation again (§9.4 reconnect)", async () => {
    await driveToReady(
      {
        wsUrl: "ws://host/lsp",
        workspaceRootPath: null,
        workspaceName: null,
      },
      0,
    );
    const genAfterFirst = appLanguageClient.getGeneration();

    await driveToReady(
      {
        wsUrl: "ws://host/lsp/v2",
        workspaceRootPath: "/home/me/proj",
        workspaceName: "my-proj",
      },
      1,
    );

    expect(appLanguageClient.getGeneration()).toBe(genAfterFirst + 1);
    expect(appLanguageClient.getSnapshot().state).toBe("Ready");
  });

  it("stop() sets state away from Ready WITHOUT bumping generation", async () => {
    await driveToReady(
      {
        wsUrl: "ws://host/lsp",
        workspaceRootPath: null,
        workspaceName: null,
      },
      0,
    );
    const genBeforeStop = appLanguageClient.getGeneration();
    expect(appLanguageClient.getSnapshot().state).toBe("Ready");

    await appLanguageClient.stop();
    expect(appLanguageClient.getSnapshot().state).not.toBe("Ready");
    expect(appLanguageClient.isRunning()).toBe(false);
    // Clean shutdown does NOT bump generation (consumers may keep their
    // generation-scoped data; a bump only happens on a NEW client start).
    expect(appLanguageClient.getGeneration()).toBe(genBeforeStop);
  });

  it("WebSocket error before Ready transitions to Failed", async () => {
    const p = appLanguageClient.start({
      wsUrl: "ws://host/lsp",
      workspaceRootPath: null,
      workspaceName: null,
    });
    await vi.waitFor(() => expect(webSocketInstances).toHaveLength(1));
    // Fail before onopen ever fires.
    webSocketInstances[0]!.onerror!();
    await p;
    expect(appLanguageClient.getSnapshot().state).toBe("Failed");
    expect(appLanguageClient.getSnapshot().error).not.toBeNull();
    expect(appLanguageClient.isRunning()).toBe(false);
  });

  // C1: serialize start()/stop() so two concurrent fire-and-forget start()
  // calls cannot both open a WebSocket + construct a MonacoLanguageClient on
  // the SAME generation (orphaning the first client). The `pending` chain makes
  // start()/stop() strictly sequential: the second startImpl cannot run until
  // the first has fully resolved.
  it("C1 — concurrent start() calls are SERIALIZED: only one WS+client in flight at a time", async () => {
    // Fire two start()s back-to-back with DIFFERENT params. Neither is awaited.
    const pA = appLanguageClient.start({
      wsUrl: "ws://host/lsp",
      workspaceRootPath: null,
      workspaceName: null,
    });
    const pB = appLanguageClient.start({
      wsUrl: "ws://host/lsp/v2",
      workspaceRootPath: "/home/me/proj",
      workspaceName: "my-proj",
    });

    // Wait for A's WebSocket to be constructed (after its async stopInternal).
    await vi.waitFor(() => expect(webSocketInstances).toHaveLength(1));

    // A is now mid-handshake (waiting on onopen). Because B is QUEUED behind A
    // on the `pending` chain, B's startImpl has NOT run yet — so NO second
    // WebSocket and NO second client exist while A is in flight. (Before the
    // fix, both would pass the idempotency guard and both would have opened a
    // WebSocket by this point.)
    // Give the microtask/macrotask queue a chance to flush so a buggy impl
    // would have had time to open the second socket.
    await vi.waitFor(() => expect(startedInstances).toHaveLength(0));
    expect(webSocketInstances).toHaveLength(1);
    expect(startedInstances).toHaveLength(0);

    // Now drive A through onopen → Ready.
    webSocketInstances[0]!.onopen!();
    await vi.waitFor(() => expect(startedInstances).toHaveLength(1));
    runStart(startedInstances[0]!);
    await pA;
    // Exactly ONE client + ONE WS were constructed for A's handshake.
    expect(startedInstances).toHaveLength(1);
    expect(webSocketInstances).toHaveLength(1);

    // B's startImpl now runs (dequeued). It sees a Running client with DIFFERENT
    // params, stops A, and starts B — so a SECOND WS/client is constructed, but
    // ONLY after A fully resolved. This is the legal, sequential reconnect.
    await driveToReady(
      {
        wsUrl: "ws://host/lsp/v2",
        workspaceRootPath: "/home/me/proj",
        workspaceName: "my-proj",
      },
      1,
    );
    await pB;

    // Final tally: exactly TWO clients + TWO WebSockets total (one per start),
    // never two of either ALIVE at once. The orphaning race is impossible.
    expect(startedInstances).toHaveLength(2);
    expect(webSocketInstances).toHaveLength(2);
    expect(appLanguageClient.getSnapshot().state).toBe("Ready");
  });

  // C2: stop()/restart must close the underlying WebSocket. client.stop() alone
  // does NOT close the raw socket; the toSocket wrapper's dispose() does. We
  // hold the iws on the handle and dispose it in stopImpl.
  it("C2 — stop() disposes the WebSocket (iws.dispose + ws.close) — no socket leak", async () => {
    await driveToReady(
      {
        wsUrl: "ws://host/lsp",
        workspaceRootPath: null,
        workspaceName: null,
      },
      0,
    );
    expect(iwsInstances).toHaveLength(1);
    expect(iwsInstances[0]!.disposed).toBe(false);
    expect(webSocketInstances[0]!.closed).toBe(false);

    await appLanguageClient.stop();

    // The toSocket wrapper was disposed AND the underlying WebSocket closed.
    expect(iwsInstances[0]!.disposed).toBe(true);
    expect(webSocketInstances[0]!.closed).toBe(true);
    expect(appLanguageClient.getSnapshot().state).toBe("Disabled");
  });

  // I3: a clean stop() must NOT flicker Ready → Failed → Disabled. Real
  // BaseLanguageClient.stop() fires a {→ Stopped} onDidChangeState transition;
  // without the selfStopGuard that maps to Failed (§9.4 connection-lost). The
  // guard suppresses it for self-initiated stops, so subscribers go Ready →
  // Disabled directly.
  it("I3 — clean stop() goes Ready → Disabled directly (NO Failed flicker)", async () => {
    const seen: LspClientState[] = [];
    appLanguageClient.subscribe((s) => seen.push(s.state));

    await driveToReady(
      {
        wsUrl: "ws://host/lsp",
        workspaceRootPath: null,
        workspaceName: null,
      },
      0,
    );
    expect(appLanguageClient.getSnapshot().state).toBe("Ready");
    // Reset the recorded sequence so we observe ONLY the stop transition.
    seen.length = 0;

    await appLanguageClient.stop();

    expect(appLanguageClient.getSnapshot().state).toBe("Disabled");
    // The MockClient.stop() fires {Running → Stopped} (M2); the selfStopGuard
    // suppresses the Failed mapping, so the subscriber sequence is Ready →
    // Disabled with NO "Failed" in between.
    expect(seen).not.toContain("Failed");
    expect(seen).toContain("Disabled");
  });
});
