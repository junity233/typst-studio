import { Channel, invoke } from "@tauri-apps/api/core";

/** How Rust should authenticate the proxied request. */
export type AuthScheme = "bearer" | "x-api-key";

/** One event from the Rust proxy. Mirrors `ProxyEvent` in `ai_commands.rs`. */
export interface ProxyEvent {
  event: "chunk" | "done" | "error";
  /** Present when `event === "chunk"`. Raw bytes of the upstream response. */
  data?: number[];
  /** Present when `event === "error"`. Upstream error message (often the body). */
  message?: string;
  /** Present when `event === "error"`. HTTP status if known. */
  status?: number;
}

export interface StreamAiProxyArgs {
  /** Absolute provider URL. */
  url: string;
  /** Pre-serialized JSON body string (the SDK has already serialized it). */
  body: string;
  /** Non-secret extra headers (e.g. `anthropic-version`). Never the key. */
  extraHeaders?: Record<string, string>;
  /** Which auth scheme to use; Rust injects the key per this. */
  authScheme: AuthScheme;
}

/**
 * Stream an LLM request through the Rust proxy. Yields `ProxyEvent`s as Rust
 * sends them over a Tauri Channel. The API key never appears here — Rust
 * injects it from settings.
 *
 * Desktop-only: calls `@tauri-apps/api/core`'s `invoke` directly (NOT the
 * browser-fallback `invoke` in `tauri.ts`) because `Channel` cannot be
 * serialized through the browser fallback path. In a plain browser (no Tauri
 * runtime) this throws — AI features require the Rust proxy anyway.
 *
 * Backpressure: the iterator is pull-based. The caller drains events as fast
 * as it can; if Rust sends faster than the caller consumes, events queue in
 * `pending` (unbounded in practice — LLM token streams are slow).
 */
export async function* streamAiProxy(
  args: StreamAiProxyArgs,
): AsyncGenerator<ProxyEvent, void, void> {
  const pending: ProxyEvent[] = [];
  let resolveNext: (() => void) | null = null;
  let failure: Error | null = null;
  let done = false;

  const channel = new Channel<ProxyEvent>();
  channel.onmessage = (msg) => {
    console.log("[ai][proxy] channel msg:", msg.event, msg.event === "chunk" ? "" : "");
    if (msg.event === "error") {
      failure = new Error(msg.message ?? "proxy error");
      done = true;
    } else {
      pending.push(msg);
      if (msg.event === "done") done = true;
    }
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      r();
    }
  };

  // Fire the command; it fills the channel asynchronously. A rejection here
  // (e.g. missing Tauri runtime, command error) aborts the iterator.
  void invoke("ai_proxy_stream", {
    opts: {
      url: args.url,
      body: args.body,
      extraHeaders: args.extraHeaders ?? {},
      authScheme: args.authScheme,
    },
    channel,
  }).catch((e) => {
    failure = e instanceof Error ? e : new Error(String(e));
    done = true;
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      r();
    }
  });

  while (true) {
    // Drain any buffered events first.
    while (pending.length > 0) {
      const ev = pending.shift()!;
      if (ev.event === "done") return;
      yield ev;
    }
    if (failure) throw failure;
    if (done) return;
    // Wait for the next channel message to arrive.
    await new Promise<void>((resolve) => {
      resolveNext = resolve;
    });
  }
}
