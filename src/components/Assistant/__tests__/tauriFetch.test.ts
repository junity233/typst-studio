import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Mock streamAiProxy so we can drive fake proxy events into the fetch wrapper.
 * Each test builds an async iterable that emits a scripted sequence.
 */
vi.mock("../../../lib/aiProxy", () => ({
  streamAiProxy: vi.fn(),
}));

const { createTauriFetch } = await import("../tauriFetch");
const { streamAiProxy } = await import("../../../lib/aiProxy");

/** Build a fake async iterable emitting scripted ProxyEvent-like objects. */
function fakeProxy(
  events: Array<
    { event: "chunk"; data: number[] } | { event: "done" } | { event: "error"; message: string }
  >,
): AsyncIterable<unknown> {
  const queue = [...events];
  return {
    [Symbol.asyncIterator]() {
      return {
        next: async () => {
          if (queue.length === 0) return { done: true, value: undefined };
          const value = queue.shift()!;
          return { done: false, value };
        },
      };
    },
  };
}

describe("createTauriFetch", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns a Response whose body streams proxy chunks as concatenated bytes", async () => {
    (streamAiProxy as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      fakeProxy([
        { event: "chunk", data: [104, 105] }, // "hi"
        { event: "chunk", data: [33] }, // "!"
        { event: "done" },
      ]),
    );

    const fetch = createTauriFetch("bearer");
    const resp = await fetch("https://example.com/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ messages: [] }),
    });

    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toBe("text/event-stream");

    const reader = resp.body!.getReader();
    const chunks: number[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const b of value) chunks.push(b);
    }
    expect(chunks).toEqual([104, 105, 33]);
    expect(new TextDecoder().decode(new Uint8Array(chunks))).toBe("hi!");
  });

  it("calls streamAiProxy with url, body string, extraHeaders, and authScheme", async () => {
    (streamAiProxy as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      fakeProxy([{ event: "done" }]),
    );
    const fetch = createTauriFetch("x-api-key", {
      "anthropic-version": "2023-06-01",
    });
    await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: '{"model":"claude"}',
    });
    expect(streamAiProxy).toHaveBeenCalledWith({
      url: "https://api.anthropic.com/v1/messages",
      body: '{"model":"claude"}',
      extraHeaders: { "anthropic-version": "2023-06-01" },
      authScheme: "x-api-key",
    });
  });

  it("aborts the body reader when the proxy errors", async () => {
    (streamAiProxy as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async function* () {
        throw new Error("401 unauthorized");
      },
    );
    const fetch = createTauriFetch("bearer");
    const resp = await fetch("x", { method: "POST", body: "{}" });
    const reader = resp.body!.getReader();
    await expect(reader.read()).rejects.toThrow(/401 unauthorized/);
  });

  it("rejects non-string bodies with a clear error", async () => {
    (streamAiProxy as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      fakeProxy([{ event: "done" }]),
    );
    const fetch = createTauriFetch("bearer");
    await expect(
      fetch("x", { method: "POST", body: new ArrayBuffer(4) }),
    ).rejects.toThrow(/string bodies/);
  });

  it("handles a URL object input (extracts string url)", async () => {
    (streamAiProxy as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      fakeProxy([{ event: "done" }]),
    );
    const fetch = createTauriFetch("bearer");
    await fetch(new URL("https://example.com/req"), {
      method: "POST",
      body: "{}",
    });
    expect(streamAiProxy).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://example.com/req" }),
    );
  });
});
