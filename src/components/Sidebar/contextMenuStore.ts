import { create } from "zustand";
import type { ReactNode } from "react";

/**
 * A menu item is one of:
 *   - separator: a hairline divider.
 *   - action: a clickable row. Carries an optional lucide icon (rendered left
 *     of the label) and a `danger` flag (delete → red). `disabled` items render
 *     greyed out and are not clickable.
 *   - submenu: a row that opens a nested menu on hover/focus. Its children are
 *     themselves `MenuItem`s. An empty `children` array renders the parent row
 *     disabled (used for "no recent workspaces" placeholders).
 */
export type MenuItem =
  | { type: "separator" }
  | {
      type: "action";
      label: string;
      icon?: ReactNode;
      danger?: boolean;
      disabled?: boolean;
      onSelect: () => void;
    }
  | { type: "submenu"; label: string; children: MenuItem[] };

/**
 * Pending context-menu request, if any. A caller (e.g. a tree row's
 * `onContextMenu`) pushes `items` + click coordinates via `open`; the
 * `ContextMenu` component renders the menu at `(x, y)` and calls `close` on
 * dismiss. Only one menu is shown at a time.
 */
export interface ContextMenuRequest {
  items: MenuItem[];
  x: number;
  y: number;
}

export interface ContextMenuState {
  current: ContextMenuRequest | null;
  /** Show a menu at the given viewport coordinates. */
  open: (items: MenuItem[], x: number, y: number) => void;
  /** Dismiss the current menu (no item selected). */
  close: () => void;
}

export const useContextMenuStore = create<ContextMenuState>()((set) => ({
  current: null,
  open: (items, x, y) => set({ current: { items, x, y } }),
  close: () => set({ current: null }),
}));
