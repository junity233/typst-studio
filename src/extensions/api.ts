import type { ViewContribution, CommandContribution, MenuItemContribution } from "./registry";
import { viewRegistry, commandRegistry, menuItemRegistry } from "./registry";

/**
 * Host API exposed to in-tree extensions. Built-in extensions are same-origin
 * and fully trusted in the MVP — no permission enforcement. The interface
 * shape is designed so a permission-wrapping proxy can be layered in later
 * without breaking call sites.
 */
export interface HostApi {
  /** The extension's own id (injected by host). */
  readonly extensionId: string;

  // ---- Registration (write-only; called during activate) ----
  readonly registerView: (v: ViewContribution) => void;
  readonly registerCommand: (c: CommandContribution) => void;
  readonly registerMenuItem: (m: MenuItemContribution) => void;
}

/** Build a HostApi bound to a specific extension id. */
export function createHostApi(extensionId: string): HostApi {
  return {
    extensionId,
    registerView: (v) => viewRegistry.register(v),
    registerCommand: (c) => commandRegistry.register(c),
    registerMenuItem: (m) => menuItemRegistry.register(m),
  };
}
