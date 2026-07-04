import { useSyncExternalStore } from "react";
import {
  viewRegistry,
  commandRegistry,
  type ViewContribution,
  type CommandContribution,
} from "./registry";

/** Subscribe to viewRegistry; returns views sorted by order. */
export function useViews(): ViewContribution[] {
  return useSyncExternalStore(
    viewRegistry.subscribe.bind(viewRegistry),
    () => viewRegistry.all(),
    () => viewRegistry.all(),
  );
}

/** Subscribe to commandRegistry; returns all commands. */
export function useCommands(): CommandContribution[] {
  return useSyncExternalStore(
    commandRegistry.subscribe.bind(commandRegistry),
    () => commandRegistry.all(),
    () => commandRegistry.all(),
  );
}
