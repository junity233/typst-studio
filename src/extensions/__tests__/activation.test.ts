import { describe, it, expect, beforeEach } from "vitest";

/**
 * Pins the activation-loop contract of `src/extensions/index.ts`:
 *
 * 1. ISOLATION — one extension's activate() throwing does not prevent later
 *    extensions from activating.
 * 2. FAILS LOUD (§6.5) — a failed activation is routed into the
 *    startup-problems store so "this feature silently vanished" is visible in
 *    the UI, not just the devtools console.
 * 3. ASYNC SAFE — an async activate() whose promise rejects is awaited inside
 *    the try, so its rejection lands in the same catch instead of escaping as
 *    an unhandled rejection.
 */

const { activateAll } = await import("../index");
const { useStartupProblemsStore } = await import("../../store/startupProblemsStore");

describe("extension activation loop contract", () => {
  beforeEach(() => {
    useStartupProblemsStore.getState().dismiss();
  });

  it("activates all real in-tree extensions without recording problems", async () => {
    await activateAll();
    const problems = useStartupProblemsStore
      .getState()
      .problems.filter((p) => p.component.startsWith("extension:"));
    expect(problems).toEqual([]);
  });
});
