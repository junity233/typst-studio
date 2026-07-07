import type { MonacoEditorApi } from "./MonacoEditor";

/**
 * A pending `revealLine` stashed by a cross-component caller (e.g. the Search
 * panel clicking a hit in a file that isn't the active tab). `revealLine`
 * operates on whatever model is currently attached to the editor, so calling it
 * right after `openFile` would target the OLD model — the model swap to the
 * newly-activated doc happens later, in MonacoEditor's model-sync effect. The
 * caller stashes the target here; the model-sync effect flushes it once the
 * target docId's model is attached, then clears the slot.
 *
 * Contract:
 *   - Writers: cross-component callers (Search panel). They set it AFTER the
 *     tab-activation store update resolves. If the target is already the active
 *     doc, the caller may reveal immediately and leave this null (no model swap
 *     will follow to flush it).
 *   - Reader/flusher: MonacoEditor's model-sync effect, in the
 *     `plan.toActivate` branch. It checks `docId` matches the freshly-activated
 *     id before revealing, so a stale pending reveal for a different doc never
 *     misfires.
 *   - Single-slot: only the LATEST stash matters; an earlier un-flushed reveal
 *     is overwritten. This is correct — the latest click is always the user's
 *     current intent.
 */
export interface PendingReveal {
  docId: string;
  line: number;
  column: number;
}

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
 *
 * `pendingReveal` is the cross-component reveal-stash slot documented on
 * [`PendingReveal`](#PendingReveal).
 */
export const editorApiRef: {
  current: MonacoEditorApi | null;
  pendingReveal: PendingReveal | null;
} = { current: null, pendingReveal: null };
