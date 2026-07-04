import { create } from "zustand";
import type { StartupProblem } from "../lib/types";

/**
 * Non-fatal startup-problem collection (§6.5).
 *
 * The backend emits `startup_problems` once at end of setup when one or more
 * startup components degraded (config dir, settings, session). This store holds
 * them for a non-modal banner. The full problem-panel UI is a later batch
 * (S19); for now the store exists and a minimal banner/StatusBar entry can
 * render from it. `dismiss` clears the list so the user can acknowledge.
 */
export interface StartupProblemsState {
  /** Collected problems, newest-first by emission order. */
  problems: StartupProblem[];
  /** Replace the problem list (called on the `startup_problems` event). */
  setProblems: (problems: StartupProblem[]) => void;
  /** Append a single problem (defensive; the backend sends them all at once). */
  addProblem: (problem: StartupProblem) => void;
  /** Clear all problems (user dismissed the banner). */
  dismiss: () => void;
}

export const useStartupProblemsStore = create<StartupProblemsState>()((set) => ({
  problems: [],
  setProblems: (problems) => set({ problems }),
  addProblem: (problem) =>
    set((s) => ({ problems: [...s.problems, problem] })),
  dismiss: () => set({ problems: [] }),
}));
