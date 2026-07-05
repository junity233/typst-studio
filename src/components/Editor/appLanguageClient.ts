import { Uri } from "vscode";
import type { LanguageClientOptions } from "vscode-languageclient/browser.js";
import { State } from "vscode-languageclient/browser.js";
import { MonacoLanguageClient } from "monaco-languageclient";
import {
  toSocket,
  WebSocketMessageReader,
  WebSocketMessageWriter,
} from "vscode-ws-jsonrpc";
import type { MessageTransports } from "vscode-languageclient/browser.js";
import { typstDocumentSelector } from "./documentUri";

/**
 * The `toSocket`-wrapped WebSocket. `IWebSocket extends Disposable`, and its
 * `dispose()` closes the underlying `WebSocket` (verified in
 * `node_modules/vscode-ws-jsonrpc/lib/connection.js`). We keep it on the
 * [`ClientHandle`](Self.ClientHandle) so `stopImpl` can close the raw socket —
 * `client.stop()` alone does NOT close the underlying WebSocket (the
 * `MessageTransports` built at start does not register a disposable the client
 * tears down), so without an explicit `dispose()` here the socket leaks across
 * `stop()`/restart.
 */
type WrappedWebSocket = ReturnType<typeof toSocket>;

/**
 * `AppLanguageClient` — module-level singleton managing the ONE Typst
 * `LanguageClient` for the whole app (spec §9.1, §9.2).
 *
 * Phase B (this module) lifts the `LanguageClient` lifecycle OUT of the
 * `MonacoEditor` React component. The component previously built a fresh client
 * config per mount and let `@typefox/monaco-editor-react`'s wrapper own it; that
 * tied LSP availability to editor mount/unmount and made recovery (a dropped
 * WebSocket) require a full editor remount. Here the client lives at module
 * scope: React components only SUBSCRIBE to its state (§4.1 — "LSP 生命周期脱离
 * React editor 组件").
 *
 * SCOPE: this module is the live LSP client. `MonacoEditor` calls
 * `appLanguageClient.start(...)` once the editor runtime + LSP endpoint are
 * ready, and subscribes to its snapshot for the status bar. The previous
 * `@typefox/monaco-editor-react` wrapper-driven client was removed (its
 * internal two-effect `performGlobalInit` raced and panicked with "Services
 * are already initialized"); this singleton is the sole LSP client now.
 *
 * Pure helpers (`buildLanguageClientOptions`, `mapStateChange`, `paramsEqual`)
 * are exported separately so the spec-critical logic is unit-testable without
 * touching real Monaco/WebSocket transports (which can't run under jsdom).
 */

/**
 * The lifecycle states surfaced to the UI (spec §16.1 前端状态). The singleton
 * always holds exactly one of these.
 *
 * - `Disabled`           — LSP turned off / tinymist unavailable (no wsUrl).
 * - `WaitingForEndpoint` — no wsUrl yet (transient; `start()` not called).
 * - `Connecting`         — WebSocket opening (`new WebSocket(url)` issued,
 *                          waiting for `onopen`).
 * - `Initializing`       — `initialize`/`initialized` in flight (client
 *                          constructed, `start()` called, not yet Running).
 * - `Replaying`          — client started; auto didOpen replay happening
 *                          (transient — see `mapStateChange` note: with the
 *                          current `vscode-languageclient` State surface we
 *                          cannot distinguish Replaying from Initializing, so
 *                          it is reserved on the public type for finer-grained
 *                          future surfacing and not emitted by `mapStateChange`).
 * - `Ready`              — `Running` (initialize + replay done; client usable).
 * - `Failed`             — connection/client failed.
 */
export type LspClientState =
  | "Disabled"
  | "WaitingForEndpoint"
  | "Connecting"
  | "Initializing"
  | "Replaying"
  | "Ready"
  | "Failed";

/**
 * Immutable snapshot subscribers receive. The snapshot object identity changes
 * on every transition, so subscribers can use reference equality to short-circuit.
 */
export interface AppLanguageClientSnapshot {
  state: LspClientState;
  /**
   * Bumped each time a NEW client instance is created (restart/reconnect with
   * changed params, per §9.4). Consumers drop stale per-generation data
   * (diagnostics keyed against an old generation). A clean `stop()` does NOT
   * bump generation — only a fresh `start()` that constructs a new client does.
   */
  generation: number;
  /** Last error message (populated when `state === "Failed"`). */
  error: string | null;
}

/**
 * Parameters for [`start`](Self.start). All three drive the idempotency check
 * (see [`paramsEqual`](Self.paramsEqual)).
 */
export interface StartParams {
  /**
   * WebSocket URL from the backend. Phase C will populate the
   * `/lsp/main/<gen>?token=` form; for Phase B it's the bare wsUrl from
   * `lspStore`.
   */
  wsUrl: string;
  /**
   * The main workspace root absolute path, or `null` when no workspace is open
   * (§7.1 / §7.2). `null` selects the §7.2 init (`rootUri: null`,
   * `workspaceFolders: null`); a set path selects §7.1 init via
   * `clientOptions.workspaceFolder`.
   */
  workspaceRootPath: string | null;
  /**
   * The main workspace display name (for `WorkspaceFolder.name`). `null` when
   * `workspaceRootPath` is `null`; when `workspaceRootPath` is set but this is
   * `null`, the basename of the root path is used.
   */
  workspaceName: string | null;
}

/** A live language client handle held by the singleton. */
interface ClientHandle {
  client: MonacoLanguageClient;
  /** The `toSocket` wrapper owning the raw WebSocket; `.dispose()` closes it. */
  iws: WrappedWebSocket;
  wsUrl: string;
  workspaceRootPath: string | null;
  workspaceName: string | null;
  /** Resolves when stop()/dispose() completes; coalesces concurrent stops. */
  stopped: Promise<void> | null;
}

/**
 * The three workspace-independent `initializationOptions` flags retained per
 * spec §7.3 (tinymist checks these to enable richer completion UX). NO `rootPath`
 * and NO `rootUri` EVER (§7.3 / §21 #13) — workspace rooting is expressed via
 * `clientOptions.workspaceFolder`, which `BaseLanguageClient` translates into
 * the wire `rootPath`/`rootUri`/`workspaceFolders` fields itself.
 */
interface TypstInitializationOptions {
  triggerSuggest: true;
  triggerParameterHints: true;
  supportHtmlInMarkdown: true;
}

/**
 * Build the `LanguageClientOptions` for the Typst client (spec §7.1 / §7.2 /
 * §7.3, §9.2). PURE: no side effects, no I/O — unit-tested directly.
 *
 * Workspace rooting rules:
 * - `workspaceRootPath !== null` → §7.1 init: a `workspaceFolder` is set, so
 *   `BaseLanguageClient.initialize()` derives BOTH `rootPath` and the
 *   `workspaceFolders` array on the wire from it.
 * - `workspaceRootPath === null` → §7.2 init: `workspaceFolder` is left
 *   `undefined`; with no vscode workspace folders either, the wire `rootPath`
 *   and `rootUri` are `null` and `workspaceFolders` is `null`.
 *
 * `initializationOptions` carries ONLY the three trigger flags — the global
 * `rootPath` override is forbidden (§7.3 / §21 #13).
 */
export function buildLanguageClientOptions(
  workspaceRootPath: string | null,
  workspaceName: string | null,
): LanguageClientOptions {
  const initializationOptions: TypstInitializationOptions = {
    triggerSuggest: true,
    triggerParameterHints: true,
    supportHtmlInMarkdown: true,
  };

  const options: LanguageClientOptions = {
    documentSelector: typstDocumentSelector(),
    initializationOptions,
  };

  if (workspaceRootPath !== null) {
    const uriPath = stripWindowsVerbatimPrefix(workspaceRootPath);
    const name = workspaceName ?? basename(uriPath);
    options.workspaceFolder = {
      uri: Uri.file(uriPath),
      name,
      index: 0,
    };
  }

  return options;
}

/**
 * Map a `vscode-languageclient` `State` transition (the `onDidChangeState`
 * payload) onto our public [`LspClientState`](Self.LspClientState). PURE.
 *
 * Transition table (mirrors §9.1 lifecycle + §9.4 重连):
 *
 *   vscode-languageclient State        → our LspClientState
 *   ─────────────────────────────────────────────────────────
 *   (any) → Starting(3)                = "Initializing"
 *   Starting(3) → Running(2)           = "Ready"
 *   * → Stopped(1), was Running        = "Failed"
 *   Stopped(1) → Stopped(1)            = null (no-op)
 *   Starting(3) → Stopped(1)           = "Failed" (never reached Ready)
 *   Running(2) → Starting(3)           = "Initializing" (reconnect/restart)
 *
 * A SELF-initiated stop (via `stopImpl`) is suppressed upstream by
 * [`selfStopGuard`](Self.selfStopGuard) before this helper is consulted, so a
 * clean `stop()` surfaces `Disabled` directly without a `Failed` flicker. Both
 * the pre-Ready initialize-failed stop and the connection-lost-after-Ready stop
 * map to `"Failed"` here — distinguishing them would require a `wasRunning`
 * flag, but the §9.4 recovery behavior (reconnect against a fresh endpoint) is
 * the same either way.
 *
 * NOTE on "Replaying": with the `State` enum surface alone we cannot tell the
 * auto didOpen replay window apart from generic Starting, so this helper never
 * emits "Replaying". That label stays on the public type for finer-grained
 * future surfacing (e.g. once the model-replay starts) but is not produced
 * here. The replay itself happens automatically inside `BaseLanguageClient`
 * when `DidOpenTextDocumentFeature.register()` runs at `start()` time against
 * the already-alive `monaco.editor.getModels()` (§9.3).
 *
 * Returns `null` when the transition is of no interest (no public state change).
 */
export function mapStateChange(
  oldState: State,
  newState: State,
): LspClientState | null {
  // No-op transitions: same state in/out (e.g. Stopped → Stopped during a
  // clean stop of a never-started client) carry no public information.
  if (oldState === newState) return null;
  switch (newState) {
    case State.Starting:
      return "Initializing";
    case State.Running:
      return "Ready";
    case State.Stopped:
      return "Failed";
    default:
      return null;
  }
}

/**
 * Idempotency check for [`start`](Self.start): two param sets are equal iff
 * their `wsUrl`, `workspaceRootPath`, and `workspaceName` all match. PURE.
 *
 * `start()` no-ops when the current client was started with equal params
 * (§9.2 — one client); any difference triggers a stop+fresh-start (§9.4).
 */
export function paramsEqual(a: StartParams, b: StartParams): boolean {
  return (
    a.wsUrl === b.wsUrl &&
    a.workspaceRootPath === b.workspaceRootPath &&
    a.workspaceName === b.workspaceName
  );
}

/** Extract the basename of a path cross-platform (used for WorkspaceFolder.name). */
function basename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

/**
 * Rust's canonicalize() returns verbatim paths on Windows (`\\?\C:\...`).
 * VS Code's Uri.file treats that prefix as a UNC authority named `?`, producing
 * an invalid `file://%3F/...` workspace URI. Convert it back to the regular
 * Win32 spelling before building the URI. Verbatim UNC paths need their
 * `UNC\server\share` tail restored to `\\server\share`.
 */
export function stripWindowsVerbatimPrefix(path: string): string {
  if (path.startsWith("\\\\?\\UNC\\")) {
    return `\\\\${path.slice(8)}`;
  }
  if (path.startsWith("\\\\?\\")) {
    return path.slice(4);
  }
  return path;
}

/**
 * The module-level singleton. NOT a React construct — components subscribe via
 * [`subscribe`](Self.subscribe) and read via [`getSnapshot`](Self.getSnapshot).
 */
class AppLanguageClient {
  private snapshot: AppLanguageClientSnapshot = {
    state: "Disabled",
    generation: 0,
    error: null,
  };
  private listeners = new Set<(snap: AppLanguageClientSnapshot) => void>();
  private handle: ClientHandle | null = null;

  /**
   * Single chained promise that SERIALIZES all `start`/`stop`/`resetForTest`
   * operations (§9.2 — one client). Without this, two concurrent fire-and-forget
   * `start()` calls could both pass the idempotency guard (the `await
   * stopInternal` suspends), both capture the SAME `currentGen`, both open a
   * WebSocket, and both construct a `MonacoLanguageClient` on their respective
   * `onopen` — orphaning the first client (never stopped). Chaining every
   * operation through `pending` makes start/stop strictly sequential: the second
   * `start()` cannot even READ `this.handle` until the first has fully resolved.
   *
   * The impl bodies never reject — they surface failure via the snapshot state
   * (`Failed`) — so a rejected operation never breaks the chain for the next
   * queued one.
   */
  private pending: Promise<void> = Promise.resolve();

  /**
   * Self-initiated-stop guard (§9.1, suppresses the Ready→Failed→Disabled
   * flicker on a clean `stop()`). `true` only between `stopImpl` calling
   * `client.stop()` and that call resolving. While set, a `→ Stopped`
   * `onDidChangeState` transition (which real `BaseLanguageClient.stop()` fires
   * synchronously before resolving) is mapped to `null` rather than `Failed`,
   * because WE initiated it — it is not a server crash / connection lost. The
   * stop path then sets `Disabled` directly. Without this guard subscribers see
   * `Ready → Failed → Disabled` on every clean stop.
   */
  private selfStopGuard = false;

  /** Current snapshot (immutable; identity changes on every transition). */
  getSnapshot(): AppLanguageClientSnapshot {
    return this.snapshot;
  }

  /**
   * Register a listener fired on every snapshot transition. Returns an
   * unsubscribe function. Listeners are stored in a `Set` and invoked
   * synchronously on transition.
   */
  subscribe(listener: (snap: AppLanguageClientSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Start (or restart) the client against the given endpoint + workspace (§9.1,
   * §9.4). Idempotent if a client is already `Running` with the SAME params
   * (§9.2); otherwise stops the old client, bumps generation, and starts a
   * fresh one.
   *
   * Flow:
   * 1. If running with equal params → no-op.
   * 2. Else stop the old client (await), bump generation, set `Connecting`.
   * 3. Open the WebSocket; on `onopen` set `Initializing`, build
   *    `messageTransports`, construct `MonacoLanguageClient`, register
   *    `onDidChangeState` (mapped via [`mapStateChange`](Self.mapStateChange)),
   *    and `await client.start()`. The auto didOpen replay (§9.3) runs during
   *    start as models are already alive in `monaco.editor.getModels()`.
   * 4. On `onerror`/`onclose` before Ready → `Failed`.
   * 5. Any construction throw → `Failed`.
   *
   * SERIALIZATION: `start`/`stop`/`resetForTest` are all serialized through the
   * single [`pending`](Self.pending) chain — see that field's doc for why.
   * `start` itself just enqueues [`startImpl`](Self.startImpl); the impl does
   * the real work and never rejects (failures surface via the `Failed` snapshot
   * state), so a failed start never poisons the chain for the next caller.
   */
  start(params: StartParams): Promise<void> {
    this.pending = this.pending.then(() => this.startImpl(params));
    return this.pending;
  }

  private async startImpl(params: StartParams): Promise<void> {
    // Idempotency: already running with identical params → no-op (§9.2).
    if (
      this.handle !== null &&
      this.handle.client.isRunning() &&
      paramsEqual(
        {
          wsUrl: this.handle.wsUrl,
          workspaceRootPath: this.handle.workspaceRootPath,
          workspaceName: this.handle.workspaceName,
        },
        params,
      )
    ) {
      return;
    }

    // Stop the old client (if any). Generation is bumped BEFORE we touch the
    // new transport so consumers can drop stale data the moment a new client is
    // coming up (§9.4 / §21 #14).
    await this.stopInternal({ bumpGeneration: true });

    this.setSnapshot({
      state: "Connecting",
      generation: this.snapshot.generation,
      error: null,
    });

    const currentGen = this.snapshot.generation;

    // Open the WebSocket. We resolve start() only once the client has fully
    // started (Running) or failed.
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };

      let ws: WebSocket;
      try {
        ws = new WebSocket(params.wsUrl);
      } catch (e) {
        this.setSnapshot({
          state: "Failed",
          generation: currentGen,
          error: errorMessage(e),
        });
        finish();
        return;
      }

      ws.onopen = () => {
        if (this.snapshot.generation !== currentGen) {
          // A newer start() superseded this one; abandon.
          finish();
          return;
        }
        try {
          const iws = toSocket(ws);
          const messageTransports: MessageTransports = {
            reader: new WebSocketMessageReader(iws),
            writer: new WebSocketMessageWriter(iws),
          };
          const client = new MonacoLanguageClient({
            id: "typst",
            name: "Typst Studio",
            clientOptions: buildLanguageClientOptions(
              params.workspaceRootPath,
              params.workspaceName,
            ),
            messageTransports,
          });

          // Track this client; map its state transitions onto our public state.
          // `iws` is held so `stopImpl` can dispose it (closing the raw socket).
          this.handle = {
            client,
            iws,
            wsUrl: params.wsUrl,
            workspaceRootPath: params.workspaceRootPath,
            workspaceName: params.workspaceName,
            stopped: null,
          };

          client.onDidChangeState(({ oldState, newState }) => {
            // §9.1 self-stop suppression: if WE initiated a stop(), a `→ Stopped`
            // transition is expected and must NOT surface as Failed — the stop
            // path sets Disabled directly. Only map it when not self-initiated.
            if (newState === State.Stopped && this.selfStopGuard) {
              return;
            }
            const mapped = mapStateChange(oldState, newState);
            if (mapped === null) return;
            if (this.snapshot.generation !== currentGen) return; // stale
            this.setSnapshot({
              state: mapped,
              generation: this.snapshot.generation,
              error:
                mapped === "Failed"
                  ? this.snapshot.error ?? "Language client stopped"
                  : null,
            });
            if (mapped === "Ready" || mapped === "Failed") finish();
          });

          // Set Initializing before start() — the Starting transition will
          // re-affirm it, but this surfaces progress immediately.
          this.setSnapshot({
            state: "Initializing",
            generation: currentGen,
            error: null,
          });

          // start() resolves once the client is Running; if it throws, fail.
          client.start().then(
            () => {
              // If the client reached Running, the onDidChangeState handler
              // already surfaced Ready and resolved us. If start() resolved
              // without a Running event (defensive), resolve anyway.
              finish();
            },
            (e) => {
              if (this.snapshot.generation !== currentGen) {
                finish();
                return;
              }
              this.setSnapshot({
                state: "Failed",
                generation: currentGen,
                error: errorMessage(e),
              });
              finish();
            },
          );
        } catch (e) {
          if (this.snapshot.generation !== currentGen) {
            finish();
            return;
          }
          this.setSnapshot({
            state: "Failed",
            generation: currentGen,
            error: errorMessage(e),
          });
          finish();
        }
      };

      ws.onerror = () => {
        if (this.snapshot.generation !== currentGen) {
          finish();
          return;
        }
        this.setSnapshot({
          state: "Failed",
          generation: currentGen,
          error: "WebSocket connection error",
        });
        finish();
      };

      ws.onclose = () => {
        if (this.snapshot.generation !== currentGen) return;
        // Only treat close-before-Ready as a failure. Post-Ready closes are
        // surfaced via the client's onDidChangeState (Stopped → Failed).
        if (this.snapshot.state !== "Ready") {
          this.setSnapshot({
            state: "Failed",
            generation: currentGen,
            error: "WebSocket closed before the language client was ready",
          });
          finish();
        }
      };
    });
  }

  /**
   * Stop and dispose the current client (if any). State → `Disabled`. Does NOT
   * bump generation — a clean shutdown is not a reconnect (§9.4 distinguishes
   * the two; only `start()`-of-a-new-client bumps).
   *
   * SERIALIZED through [`pending`](Self.pending) (same chain as `start`), so a
   * `stop()` racing a `start()` cannot tear: the second waits for the first.
   */
  stop(): Promise<void> {
    this.pending = this.pending.then(() => this.stopImpl());
    return this.pending;
  }

  private async stopImpl(): Promise<void> {
    await this.stopInternal({ bumpGeneration: false });
    this.setSnapshot({
      state: "Disabled",
      generation: this.snapshot.generation,
      error: null,
    });
  }

  /**
   * Internal stop shared by `stop()` (no bump) and `start()` (bump). Disposes
   * the current client AND the underlying WebSocket (via `iws.dispose()` —
   * `client.stop()` alone does NOT close the raw socket). Never throws.
   *
   * Sets [`selfStopGuard`](Self.selfStopGuard) for the duration of
   * `client.stop()` so the Stopped transition real `BaseLanguageClient.stop()`
   * fires is NOT mapped to `Failed` (it is self-initiated, not a crash).
   */
  private async stopInternal(opts: {
    bumpGeneration: boolean;
  }): Promise<void> {
    const handle = this.handle;
    this.handle = null;
    if (handle === null) {
      if (opts.bumpGeneration) this.bumpGeneration();
      return;
    }
    // Coalesce concurrent stops of the same handle.
    if (handle.stopped === null) {
      handle.stopped = (async () => {
        this.selfStopGuard = true;
        try {
          await handle.client.stop();
        } catch {
          // Best-effort; a failing stop must not block a fresh start.
        } finally {
          // Close the raw WebSocket. toSocket's dispose() calls
          // webSocket.close() (verified in vscode-ws-jsonrpc/lib/connection.js).
          // May throw if already disposed/closed — swallow.
          try {
            handle.iws.dispose();
          } catch {
            // Already disposed — nothing to do.
          }
          this.selfStopGuard = false;
        }
      })();
    }
    await handle.stopped;
    if (opts.bumpGeneration) this.bumpGeneration();
  }

  /** True iff a client exists and `isRunning()`. */
  isRunning(): boolean {
    return this.handle?.client.isRunning() ?? false;
  }

  /** Current generation (for diagnostics/event consumers to drop stale data). */
  getGeneration(): number {
    return this.snapshot.generation;
  }

  /**
   * TEST/diagnostic ONLY: reset all state (stop any client, clear listeners,
   * reset generation to 0, state to `Disabled`). Not part of the production
   * surface.
   *
   * Goes through the [`pending`](Self.pending) chain so any in-flight
   * start/stop completes (and tears down its client) before the reset, and the
   * returned promise resolves only once the singleton is quiescent. The impl
   * body never rejects so a fresh chain starts clean for the next test.
   */
  resetForTest(): Promise<void> {
    this.pending = this.pending.then(
      () => this.resetForTestImpl(),
      () => this.resetForTestImpl(),
    );
    return this.pending;
  }

  private async resetForTestImpl(): Promise<void> {
    await this.stopInternal({ bumpGeneration: false });
    this.listeners.clear();
    this.snapshot = { state: "Disabled", generation: 0, error: null };
  }

  private bumpGeneration(): void {
    this.snapshot = {
      ...this.snapshot,
      generation: this.snapshot.generation + 1,
    };
  }

  private setSnapshot(next: AppLanguageClientSnapshot): void {
    this.snapshot = next;
    for (const l of this.listeners) l(next);
  }
}

/** Coerce a thrown value (often `unknown`) into a human-readable message. */
function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

/** The app-wide singleton. Import this; never construct `AppLanguageClient`. */
export const appLanguageClient = new AppLanguageClient();
