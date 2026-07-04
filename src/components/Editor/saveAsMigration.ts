import type * as Monaco from "@codingame/monaco-vscode-editor-api";
import type { DocumentOrigin } from "../../lib/types";
import { monacoModelRegistry } from "./monacoModelRegistry";

/**
 * Spec §11 (Save As 与 URI 迁移) — Task 9: the model-replacement step wired into
 * the Save As flow.
 *
 * When `save_as` succeeds and the doc's origin actually changed (a true Save
 * As, not a re-save of the same path), the frontend must replace the Monaco
 * model: Monaco model URIs are immutable, so a Save As cannot keep the same
 * model and just swap its URI. Instead the registry's
 * [`migrateUri`](./monacoModelRegistry.ts) atomically swaps the URI map,
 * creates a new model at the new URI carrying the current text, and disposes
 * the old model (§11 steps 5/10 + the map swap). This module owns the
 * orchestration AROUND that primitive:
 *
 *   - capture the editor's current view state + selection (§11 step 4);
 *   - call `migrateUri` (§11 steps 5/10 + map swap);
 *   - if a live editor was passed (the doc is active), `editor.setModel` to
 *     the new model (§11 step 8) and restore selection + viewState (§11 step 9).
 *
 * ## LSP didClose / didOpen (§11 steps 6 / 7)
 *
 * This module does NOT itself emit LSP document-lifecycle notifications. They
 * fire IMPLICITLY from model create/dispose: the language client's
 * `DidOpenTextDocumentFeature` / `DidCloseTextDocumentFeature`
 * (vscode-languageclient) auto-sync from `monaco.editor.getModels()` — creating
 * a model publishes `didOpen`, disposing a model publishes `didClose`. This is
 * the same mechanism that auto-replays every open model on an LSP (re)start
 * (see `appLanguageClient.ts` §9.3 note). So a Save-As migration, by virtue of
 * creating + disposing models, automatically sequences the LSP `didClose(old)`
 * → `didOpen(new)` the spec calls for.
 *
 * ## Old-URI diagnostics (§11)
 *
 * The diagnostics bridge (Task 5) routes markers via
 * [`monacoModelRegistry.resolveDocumentId`](./monacoModelRegistry.ts), which
 * returns null for any URI no longer in the registry's uri→id map. After a
 * `migrateUri` the OLD uri is removed from that map, so any in-flight
 * diagnostics keyed on the stale uri are dropped automatically — no extra work
 * here. ASSUMPTION (verified by reading vscode-languageclient's
 * `DidOpenTextDocumentFeature.register`): the feature's model-sync hooks are
 * driven by Monaco's model-set, so a `createModel` + `dispose` pair produces
 * exactly one didOpen + one didClose.
 *
 * ## §11 constraints enforced here / by the registry
 *
 * - DocumentId UNCHANGED — `migrateUri` preserves it (Task 2).
 * - Backend revision UNCHANGED — `documentsStore.markSaved` doesn't bump
 *   revision (Task 1).
 * - New model's LSP document version from 1 — Monaco `createModel` starts at
 *   version 1 (automatic).
 * - URI→DocumentId map atomic — `migrateUri` (Task 2).
 * - Save As failure leaves the old model alone — `markSaved` only runs on
 *   success, so the doc's `origin` doesn't change on failure, so the
 *   origin-transition effect (the caller of this orchestration) doesn't fire.
 * - Undo/redo cleared — a new model starts with an empty undo stack. §11
 *   explicitly accepts this; body text, selection, scroll position, and view
 *   state are preserved (the orchestration restores them on the active doc).
 *
 * ## "Target already open" (§11 last constraint)
 *
 * If the Save As target path is ALREADY bound to an open doc, the backend's
 * `rebind_path` rejects with `AlreadyOpen` (see
 * `document_service.rs::rebind_path`), so the `save_as` IPC itself fails
 * BEFORE any model migration runs. The frontend's Save As error paths surface
 * that error (alert / conflict dialog) and never call `markSaved`, so the
 * origin never changes and this orchestration never fires. We do NOT add a
 * separate frontend redirect-to-existing-tab step: the backend's authoritative
 * dedup is the right seam, and the existing error surfacing is sufficient.
 */

/** Result of [`migrateModelForSaveAs`](Self.migrateModelForSaveAs). */
export interface MigrateResult {
  /** Whether the migration (or no-op) completed without throwing. */
  ok: boolean;
  /**
   * Why the result is what it is:
   * - `"not-open"`: the document has no registry entry (never opened / already
   *   closed). No migration attempted.
   * - `"no-op"`: `migrateUri` returned the SAME entry (the new origin produced
   *   the same uri — a re-save of the same path). The editor was left alone.
   * - `undefined`: a real migration happened (or a registry-only migration of
   *   a non-active doc).
   */
  reason?: "not-open" | "no-op";
}

/**
 * A stable string signature for a [`DocumentOrigin`]. Two origins with the same
 * signature produce the same canonical URI (via
 * [`originToUri`](./documentUri.ts)); two origins with different signatures
 * produce different URIs and therefore require a model migration.
 *
 * The signature embeds every field that could distinguish two origins even
 * when their canonical URI coincides: `kind`, and for the file variants the
 * `path` plus the distinguishing inner field (`workspace_id` for
 * `workspaceFile`, `root` for `looseFile`).
 *
 * NOTE: `originToUri` derives the URI from `origin.path` ALONE for both file
 * variants, so a `looseFile`↔`workspaceFile` transition at the SAME path (or
 * a `workspace_id`/`root` change at the same path) produces the SAME URI and
 * `migrateUri` no-ops. Such transitions are still DETECTED here (the signature
 * differs), and the orchestration's no-op branch leaves the editor alone — so
 * the over-reporting is safe. The signature is intentionally finer-grained
 * than the URI so a future URI-derivation change (e.g. embedding workspace
 * identity) doesn't silently miss a migration.
 *
 * PURE: no side effects, no I/O. Exported for unit testing.
 */
export function originSignature(origin: DocumentOrigin): string {
  switch (origin.kind) {
    case "untitled":
      return "untitled";
    case "workspaceFile":
      return `workspaceFile:${origin.workspace_id}:${origin.path}`;
    case "looseFile":
      return `looseFile:${origin.root}:${origin.path}`;
  }
}

/**
 * Structural equality for two [`DocumentOrigin`]s. `true` iff every field that
 * affects the canonical URI (and the LSP folder association) is identical.
 * PURE. Used by [`detectOriginTransition`](Self.detectOriginTransition) and as
 * the dedup guard inside the editor's origin-transition effect.
 */
export function originsEqual(
  a: DocumentOrigin,
  b: DocumentOrigin,
): boolean {
  return originSignature(a) === originSignature(b);
}

/**
 * Decide whether a document's origin ACTUALLY changed across a store
 * transition, and if so return the new origin (for the migration call); return
 * `null` otherwise (§11: a Save As only migrates when the path differs from
 * before — a re-save of the same path is a no-op).
 *
 * This is the pure seam the editor's origin-transition effect uses: it diffs
 * each open doc's previous origin against its current origin and invokes
 * [`migrateModelForSaveAs`](Self.migrateModelForSaveAs) only for the docs whose
 * origin actually transitioned. Returning the new origin (rather than a bare
 * boolean) lets the caller pass it straight through to the orchestration
 * without re-reading the store.
 *
 * PURE: no side effects, no I/O. Exported for unit testing.
 */
export function detectOriginTransition(
  prev: DocumentOrigin,
  current: DocumentOrigin,
): DocumentOrigin | null {
  return originsEqual(prev, current) ? null : current;
}

/**
 * Orchestrate the Save-As model replacement for one document (§11).
 *
 * Steps (matching §11 numbering where applicable):
 *
 *   1. (backend already did the atomic write + rebind before this is called.)
 *   2. (the new path is already on `documentsStore` via `markSaved`.)
 *   3. Pause edit forwarding — N/A in this architecture: the registry's
 *      `migrateUri` swaps the model atomically, and the editor's onChange
 *      handler reads the live model, so there is no per-doc forwarding flag to
 *      toggle. The controlled-replace anti-bounce-back
 *      ([`isSuppressingForward`](./monacoModelRegistry.ts)) is for backend
 *      reloads, not for Save-As model swaps.
 *   4. Save the editor's current view state onto the entry BEFORE migrating,
 *      so the new model inherits the CURRENT scroll/cursor (not the snapshot
 *      from the last tab switch). Selection is captured separately (it is NOT
 *      part of Monaco's `ICodeEditorViewState` round-trip on a model swap, so
 *      we restore it explicitly below).
 *   5/10. `migrateUri` creates the new model + swaps the maps + disposes the
 *      old model (Task 2 primitive).
 *   6/7. didClose(old) / didOpen(new) fire IMPLICITLY from the model
 *      create/dispose — see the module doc.
 *   8. If an editor was passed (the doc is active), `editor.setModel(new)`.
 *   9. Restore the viewState (from the entry) + the selection (captured above).
 *   11. Resume edit forwarding — N/A (see step 3).
 *
 * @param documentId  The doc whose origin just changed.
 * @param newOrigin   The new (post-Save-As) origin.
 * @param editor      OPTIONAL: the live editor instance. Pass it ONLY when the
 *   doc is the active tab (so its model swap + selection/viewState restore
 *   happen). Omit / pass null for a non-active doc (registry-only migration —
 *   the editor swap happens later if/when the doc becomes active, via the
 *   normal tab-switch `activate` path). Also safely null when no editor has
 *   started yet.
 * @returns `{ ok: true }` on a real migration or a no-op; `{ ok: true, reason:
 *   "no-op" }` when the new origin produced the same uri (re-save of the same
 *   path — the editor was left alone); `{ ok: false, reason: "not-open" }` when
 *   the doc has no registry entry; `{ ok: false }` (no reason) if the
 *   underlying `migrateUri` threw — the OLD model is left intact in that case
 *   (Task 2's `migrateUri` creates the new model before disposing the old, so
 *   a throw during dispose leaves the old model — and the maps — consistent).
 */
export function migrateModelForSaveAs(
  documentId: string,
  newOrigin: DocumentOrigin,
  editor?: Monaco.editor.IStandaloneCodeEditor | null,
): MigrateResult {
  const entry = monacoModelRegistry.getModel(documentId);
  if (entry === undefined) {
    // The doc isn't open in the registry (never opened, or already closed).
    // Nothing to migrate — defensive: the editor's effect shouldn't call us
    // for such an id, but bail cleanly if it does.
    return { ok: false, reason: "not-open" };
  }

  const oldModel = entry.model;

  // §11 step 4: freshen the entry's view state from the live editor BEFORE
  // migrating, so the new model inherits the CURRENT scroll/cursor (not the
  // stale snapshot from the last tab switch). Selection is captured separately
  // — it isn't part of the round-tripped viewState on a model swap. Only do
  // this when we have a live editor (non-active / no-editor-yet → skip).
  let selection: Monaco.Selection | null = null;
  if (editor) {
    monacoModelRegistry.saveViewState(documentId, editor);
    selection = editor.getSelection();
  }

  // §11 steps 5/10 + map swap. Task 2 primitive: atomic URI map swap + new
  // model + dispose old. LSP didClose(old)/didOpen(new) fire implicitly from
  // the model create/dispose (see module doc). Wrapped: a throw here (e.g.
  // dispose failure) surfaces as `{ ok: false }` rather than propagating —
  // the caller (the editor effect) logs it and moves on; the old model is the
  // registry's responsibility and is left consistent by Task 2's ordering.
  let newEntry;
  try {
    newEntry = monacoModelRegistry.migrateUri(documentId, newOrigin);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[saveAsMigration] migrateUri threw; leaving old model", e);
    return { ok: false };
  }

  if (newEntry.model === oldModel) {
    // The registry's same-uri no-op branch fired (re-save of the same path).
    // No model was replaced, so the editor MUST be left alone — no setModel,
    // no selection/viewState churn.
    return { ok: true, reason: "no-op" };
  }

  // §11 steps 8 / 9: only the ACTIVE doc (caller passed an editor) gets the
  // editor swap + selection/viewState restore. A non-active doc's migration is
  // registry-only; its model swap happens later, via the normal `activate`
  // path on the next tab switch.
  if (editor) {
    editor.setModel(newEntry.model);
    if (newEntry.viewState !== null) {
      editor.restoreViewState(newEntry.viewState);
    }
    if (selection !== null) {
      editor.setSelection(selection);
    }
  }

  return { ok: true };
}
