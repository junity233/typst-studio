import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Mock @tauri-apps/api/core. Channel is reduced to an onmessage carrier: the
 * test captures the channel instance the SUT creates, then drives fake events
 * through `channel.onmessage(msg)` exactly as Rust would.
 */
const invokeMock = vi.fn();
let lastChannel: { onmessage: ((m: unknown) => void) | null } | null = null;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => invokeMock(cmd, args),
  Channel: class {
    onmessage: ((m: unknown) => void) | null = null;
    constructor() {
      // The SUT creates exactly one Channel per call; capture it.
      lastChannel = this;
    }
  },
}));

// Import the SUT AFTER the mock is registered.
const { streamAiProxy } = await import("../aiProxy");

describe("streamAiProxy", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
    lastChannel = null;
  });

  it("invokes ai_proxy_stream with url/body/extraHeaders/authScheme + a channel", async () => {
    const it = streamAiProxy({
      url: "https://example.com/v1/chat/completions",
      body: '{"hello":"world"}',
      extraHeaders: { "x-test": "1" },
      authScheme: "bearer",
    });
    // Drain (the test will close the channel via a `done` event below).
    const consume = (async () => {
      for await (const _ of it) {
        // drain
      }
    })();
    lastChannel!.onmessage!({ event: "done" });
    await consume;

    expect(invokeMock).toHaveBeenCalledWith("ai_proxy_stream", {
      opts: {
        url: "https://example.com/v1/chat/completions",
        body: '{"hello":"world"}',
        extraHeaders: { "x-test": "1" },
        authScheme: "bearer",
      },
      channel: expect.any(Object),
    });
  });

  it("yields chunk events in order, then ends on done", async () => {
    const it = streamAiProxy({
      url: "x",
      body: "{}",
      authScheme: "bearer",
    });
    const events: unknown[] = [];
    const consume = (async () => {
      for await (const ev of it) events.push(ev);
    })();

    // Let the invoke call settle so the channel is wired.
    await Promise.resolve();
    const ch = lastChannel!;
    ch.onmessage!({ event: "chunk", data: [104, 105] }); // "hi"
    ch.onmessage!({ event: "chunk", data: [33] }); // "!"
    ch.onmessage!({ event: "done" });

    await consume;
    expect(events).toEqual([
      { event: "chunk", data: [104, 105] },
      { event: "chunk", data: [33] },
    ]);
  });

  it("rejects the iterator when Rust sends an error event", async () => {
    const it = streamAiProxy({ url: "x", body: "{}", authScheme: "bearer" });
    const consume = (async () => {
      for await (const _ of it) {
        // drain
      }
    })();
    await Promise.resolve();
    lastChannel!.onmessage!({ event: "error", message: "401 unauthorized", status: 401 });

    await expect(consume).rejects.toThrow(/401 unauthorized/);
  });

  it("rejects when invoke itself rejects (e.g. key missing)", async () => {
    invokeMock.mockRejectedValue(new Error("ai.apiKey is not configured"));
    const it = streamAiProxy({ url: "x", body: "{}", authScheme: "bearer" });
    await expect(
      (async () => {
        for await (const _ of it) {
          // drain
        }
      })(),
    ).rejects.toThrow(/ai\.apiKey is not configured/);
  });

  it("stops cleanly after done without yielding further events", async () => {
    const it = streamAiProxy({ url: "x", body: "{}", authScheme: "bearer" });
    const seen: unknown[] = [];
    const consume = (async () => {
      for await (const ev of it) seen.push(ev);
    })();
    await Promise.resolve();
    lastChannel!.onmessage!({ event: "done" });
    // A late chunk after done should be ignored (the iterator has returned).
    lastChannel!.onmessage!({ event: "chunk", data: [1, 2, 3] });
    await consume;
    expect(seen).toEqual([]);
  });
});
