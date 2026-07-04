import type { MonacoEditorApi } from "./MonacoEditor";

/**
 * Module-scoped ref to the live Monaco editor API.
 *
 * The editor lives inside EditorArea, but other components (the Search panel,
 * Outline panel, etc.) need to call `revealLine` to jump to a location. Rather
 * than threading callbacks through props, we expose a single module-level
 * mutable ref that EditorArea populates on mount and clears on unmount.
 *
 * This mirrors the local `useRef` EditorArea already used internally for
 * diagnostics click-to-jump; lifting it to module scope just makes the same
 * capability cross-component.
 */
export const editorApiRef: { current: MonacoEditorApi | null } = { current: null };
