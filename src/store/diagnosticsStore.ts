import { create } from "zustand";
import type { Diagnostic } from "../lib/types";

export interface DiagsState {
  byTab: Record<string, Diagnostic[]>;
  set: (id: string, diags: Diagnostic[]) => void;
  clear: (id: string) => void;
}

export const useDiagnosticsStore = create<DiagsState>()((set) => ({
  byTab: {},
  set: (id, diags) =>
    set((s) => ({ byTab: { ...s.byTab, [id]: diags } })),
  clear: (id) =>
    set((s) => {
      if (!(id in s.byTab)) return s;
      const next = { ...s.byTab };
      delete next[id];
      return { byTab: next };
    }),
}));
