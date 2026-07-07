import { streamAiProxy, type AuthScheme } from "../../lib/aiProxy";

/**
 * A `fetch` replacement that routes an SDK's HTTP request through the Rust AI
 * proxy via {@link streamAiProxy}. Returns a standard `Response` whose body is
 * a `ReadableStream` fed by the proxy's byte chunks. The SDK parses SSE
 * itself; Rust just injects the API key and forwards bytes — neither side
 * re-implements the provider protocol.
 *
 * Usage: pass this as the `fetch` option when constructing the OpenAI or
 * Anthropic SDK client. The SDK serializes messages/tools/stream:true into a
 * JSON string body; we forward it verbatim to Rust as a string.
 *
 * Why a custom fetch and not a custom streamFn that calls the SDK directly:
 * both the OpenAI and Anthropic SDKs accept a `fetch` option and already
 * implement full SSE parsing + request serialization + retries + tool-call
 * delta reconstruction. Injecting our fetch lets us reuse ALL of that — we
 * only swap the network transport. The SDK's `response.body.getReader()`
 * reads from our `ReadableStream`, which is fed by the Tauri Channel.
 */
export function createTauriFetch(
  authScheme: AuthScheme,
  extraHeaders: Record<string, string> = {},
): typeof fetch {
  return async (
    input: RequestInfo | URL,
    init: RequestInit = {},
  ): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    // The SDK serializes its request body to a JSON string before calling
    // fetch. Reject non-string bodies defensively — the SDKs always send
    // strings, but a non-string here would mean we're routing the wrong thing.
    if (typeof init.body !== "string") {
      throw new Error(
        `tauriFetch only supports string bodies (SDK should send JSON); got ${
          init.body == null ? "null/undefined" : typeof init.body
        }`,
      );
    }

    const proxy = streamAiProxy({
      url,
      body: init.body,
      extraHeaders,
      authScheme,
    });

    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();

    // Drive the proxy in the background; the SDK reads `readable` via
    // `response.body.getReader()`. We don't await this — returning the
    // Response promptly lets the SDK start reading headers/body as chunks land.
    void (async () => {
      try {
        for await (const ev of proxy) {
          if (ev.event === "chunk" && ev.data) {
            // `ev.data` is a regular number array (serde serializes Vec<u8>
            // that way); convert to a Uint8Array for the stream.
            await writer.write(new Uint8Array(ev.data));
          } else if (ev.event === "done") {
            await writer.close();
            return;
          }
          // error events throw inside streamAiProxy and are caught below.
        }
      } catch (e) {
        await writer.abort(e);
      }
    })();

    return new Response(readable, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
}
