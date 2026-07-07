import { create } from "zustand";
import symbolData from "../assets/symbols/typst-symbols.json";

/**
 * One symbol in the Typst `sym` module subset surfaced by the Symbol Panel.
 * `name` is the Typst field path (e.g. `arrow.r`, `alpha`); `glyph` is the
 * Unicode preview; `keywords` are optional search aliases.
 */
export interface SymbolEntry {
  readonly name: string;
  readonly glyph: string;
  readonly keywords?: string[];
}

/**
 * A browsable group of symbols. `id` is the stable filter key; `name` is the
 * display label (also localized via the category's own id-free naming here —
 * the data file ships English names).
 */
export interface SymbolCategory {
  readonly id: string;
  readonly name: string;
  readonly symbols: SymbolEntry[];
}

export interface SymbolsState {
  /** The full category tree, loaded once at store creation from the JSON asset. */
  categories: SymbolCategory[];
  /** Current search query (debounced by the panel before being pushed here). */
  query: string;
  /** Active category filter; `null` means "all categories". */
  activeCategoryId: string | null;
  setQuery: (q: string) => void;
  setActiveCategory: (id: string | null) => void;
}

export const useSymbolsStore = create<SymbolsState>((set) => ({
  categories: symbolData.categories as SymbolCategory[],
  query: "",
  activeCategoryId: null,

  setQuery: (q) => set({ query: q }),
  setActiveCategory: (id) => set({ activeCategoryId: id }),
}));
