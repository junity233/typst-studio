import type { ComponentType } from "react";
import type { LucideIcon } from "lucide-react";
import type { HostApi } from "./api";

/** View contribution — a sidebar view registered to the Activity Bar. */
export interface ViewContribution {
  /** Globally unique id, e.g. "workbench.explorer" */
  readonly id: string;
  /** Hover tooltip / header title */
  readonly title: string;
  /** lucide icon component */
  readonly icon: LucideIcon;
  /** Lazy-loaded view component factory (Vite code-split). */
  readonly component: () => Promise<{ default: ComponentType<{ viewId: string }> }>;
  /** Sort weight — smaller is higher. */
  readonly order?: number;
  /** Activation gate: workspace = only when a folder is open; always = always available. */
  readonly when?: "workspace" | "always";
}

/** Command contribution — an action callable via palette/menu/keybinding. */
export interface CommandContribution {
  readonly id: string;
  readonly title: string;
  readonly category?: string;
  readonly keybinding?: string;
  readonly handler: (api: HostApi) => void | Promise<void>;
  readonly enablement?: (api: HostApi) => boolean;
}

/** Menu contribution — injects a command into a menu location. */
export interface MenuItemContribution {
  readonly command: string;
  readonly location:
    | "editor/context"
    | "explorer/context"
    | "commandPalette"
    | "view/title";
  readonly group?: string;
  readonly order?: number;
}

type Listener = () => void;

/**
 * A minimal observable registry. Items are keyed by a string id extracted via
 * `keyOf` (defaults to the `id` property). `MenuItemContribution` has no `id`
 * field, so its registry keys by `command` instead — hence the unconstrained
 * generic plus a key extractor rather than `T extends { id: string }`.
 */
class Registry<T> {
  private items = new Map<string, T>();
  private listeners = new Set<Listener>();
  private readonly keyOf: (item: T) => string;
  /** Cached sorted snapshot — invalidated on register/unregister so
   * useSyncExternalStore (which uses Object.is) sees a stable reference. */
  private snapshot: T[] | null = null;

  constructor(keyOf: (item: T) => string = (item) => (item as { id: string }).id) {
    this.keyOf = keyOf;
  }

  register(item: T): void {
    const key = this.keyOf(item);
    if (this.items.has(key)) {
      console.warn(`[extensions] duplicate id "${key}", ignored`);
      return;
    }
    this.items.set(key, item);
    this.snapshot = null;
    this.emit();
  }

  unregister(id: string): void {
    if (this.items.delete(id)) {
      this.snapshot = null;
      this.emit();
    }
  }

  get(id: string): T | undefined {
    return this.items.get(id);
  }

  has(id: string): boolean {
    return this.items.has(id);
  }

  /** Returns all items sorted by `order` ascending (missing order = 100).
   * The result is cached and reused across calls until the next mutation. */
  all(): T[] {
    if (this.snapshot === null) {
      this.snapshot = [...this.items.values()].sort((a, b) => {
        const ao =
          (a != null && typeof a === "object" && "order" in a
            ? (a as { order?: number }).order
            : undefined) ?? 100;
        const bo =
          (b != null && typeof b === "object" && "order" in b
            ? (b as { order?: number }).order
            : undefined) ?? 100;
        return ao - bo;
      });
    }
    return this.snapshot;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}

export const viewRegistry = new Registry<ViewContribution>();
export const commandRegistry = new Registry<CommandContribution>();
export const menuItemRegistry = new Registry<MenuItemContribution>((m) => m.command);
