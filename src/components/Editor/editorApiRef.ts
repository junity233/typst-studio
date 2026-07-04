import type { MonacoEditorApi } from "./MonacoEditor";

/**
 * Module-scoped ref to the live Monaco editor API.
 *
 * The editor lives inside EditorArea, but other components (the Search panel,
 * Outline panel, etc.) need to call `revealLine` to jump to a location. Rather
 * than threading callbacks through props, we expose a single module-level
 * mutable ref that EditorArea populates via `onReady` whenever a new editor
 * instance mounts.
 *
 * Staleness: `current` is NOT cleared on editor unmount — it is overwritten on
 * the next mount's `onReady`. Between unmount and the next `onReady` (e.g.
 * during a wsUrl-keyed recovery remount), `current` briefly references a dead
 * editor. This is safe because every `MonacoEditorApi` method routes through
 * `editorAppRef.current?.getEditor()` and no-ops when the underlying editor is
 * gone (returns `0`/`null`/`undefined` rather than throwing). So a stale ref
 * degrades to harmless no-ops, never to a use-after-free.
 *
 * This mirrors the local `useRef` EditorArea already used internally for
 * diagnostics click-to-jump; lifting it to module scope just makes the same
 * capability cross-component.
 */
export const editorApiRef: { current: MonacoEditorApi | null } = { current: null };
