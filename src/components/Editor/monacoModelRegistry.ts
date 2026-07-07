// Value import (NOT `import type`): we need the runtime `editor.createModel`.
// The namespace is only bound here — no Monaco API is CALLED at module load
// (only inside method bodies), so importing this module does not initialize
// Monaco and is safe under jsdom. `import type` would erase the namespace and
// leave `Monaco.editor.createModel` undefined at runtime.
import * as Monaco from "@codingame/monaco-vscode-editor-api";
import { Uri } from "vscode";
import { originToUri, parseUntitledUriId } from "./documentUri";
import type { DocumentId, DocumentOrigin } from "../../lib/types";

/**
 * Module-level registry owning every open Monaco model for the app's lifetime
 * (spec §8, §10). NOT a React construct: a model's life == the document's open
 * life. Tab switches (§10.5) only re-point the editor's `setModel` target —
 * they do NOT create or destroy models, so inactive models keep receiving
 * diagnostics, semantic tokens, and workspace edits (§8.3).
 *
 * The registry maintains two maps kept atomically consistent:
 * - `byId`:    `DocumentId → ModelEntry`
 * - `idByUri`: canonical URI string → `DocumentId`
 *
 * The URI string is the single source of truth both Monaco and Tinymist see;
 * it is derived from the document's authoritative `origin` via
 * [`originToUri`](./documentUri.ts).
 *
 * ## Anti-bounce-back (§8.4)
 *
 * When the backend reloads a disk file and pushes new content (a "controlled
 * replace"), the registry updates the model via `applyExternalContent`. That
 * `setValue` fires Monaco's `onDidChangeContent`, which the editor's onChange
 * handler would otherwise forward back to the backend as a brand-new user edit
 * — an infinite loop. To break the loop, the registry marks the document as
 * "suppressing forward" for the duration of that single content-change event:
 * the editor's onChange handler calls `isSuppressingForward` and skips the
 * forward when it returns true. The mark is set immediately before `setValue`
 * and cleared immediately after — Monaco dispatches all `onDidChangeContent`
 * listeners SYNCHRONOUSLY inside `setValue`, so every listener firing during
 * that dispatch sees the mark, and it is gone the instant `setValue` returns.
 * This holds for the editor's onChange handler (which forwards to the backend
 * asynchronously, never re-entering the registry synchronously). Caveat: if a
 * listener ever synchronously re-entered `applyExternalContent` on the SAME
 * documentId, its inner `finally` would clear the mark while the outer dispatch
 * is still running — not a current concern (no such listener exists) but
 * documented for future maintainers. See
 * [`applyExternalContent`](Self.applyExternalContent) and
 * [`isSuppressingForward`](Self.isSuppressingForward).
 */

/**
 * One open document's Monaco model + the per-document bookkeeping the registry
 * keeps alongside it (spec §8.1).
 */
export interface ModelEntry {
  /** The live Monaco model. Owned by the registry for the document's open life. */
  model: Monaco.editor.ITextModel;
  /** Canonical URI string — what Monaco and Tinymist both see. */
  uri: string;
  /** The owning document id. Stable across origin transitions (§11). */
  documentId: string;
  /**
   * Saved on tab switch (§10.5), restored on activate. `null` until the first
   * capture (the editor's `saveViewState` produces the first non-null value).
   * Preserved across URI migration (§11) so a Save As keeps scroll/cursor.
   */
  viewState: Monaco.editor.ICodeEditorViewState | null;
  /**
   * Last backend revision applied to this model. Used by the controlled-replace
   * guard (§8.4) to suppress the bounce-back: when the registry itself replaces
   * model text on behalf of a backend disk-reload, it records the new revision
   * so the resulting onChange is NOT re-forwarded as a user edit. Also the
   * baseline for staleness — a reload whose revision is `<=` current is a no-op.
   */
  lastSyncedRevision: number;
}

/** Options for [`MonacoModelRegistry.openModel`](Self.openModel). */
export interface OpenModelOptions {
  /** Initial text content (from documentsStore). */
  content: string;
  /** The authoritative origin (drives the URI). */
  origin: DocumentOrigin;
  /** Current backend revision (§8.4 guard baseline). */
  revision: number;
}

/** Result of [`MonacoModelRegistry.activate`](Self.activate). */
export interface ActivateResult {
  /** The newly-active model (caller does `editor.setModel`). */
  model: Monaco.editor.ITextModel;
  /** Restored view state to apply via `editor.restoreViewState` (or null). */
  viewState: Monaco.editor.ICodeEditorViewState | null;
}

/**
 * The app-wide singleton registry. Constructed at module load; no Monaco API
 * is called until the first method invocation, so importing this module does
 * NOT initialize Monaco (safe under jsdom).
 */
class MonacoModelRegistry {
  private byId = new Map<string, ModelEntry>();
  private idByUri = new Map<string, string>();

  /**
   * Document ids whose CURRENT (synchronous) content-change dispatch is a
   * self-induced controlled replace that must NOT be forwarded to the backend
   * as a user edit (§8.4). Added immediately before `model.setValue` and
   * removed immediately after — Monaco fires all `onDidChangeContent`
   * listeners synchronously inside `setValue`, so every listener that runs
   * during the dispatch sees the mark, and it is gone the moment `setValue`
   * returns. This holds for the editor's onChange (which forwards to the
   * backend asynchronously); see the class-level Anti-bounce-back note for
   * the synchronous-reentrancy caveat. Read by the editor's onChange handler
   * via [`isSuppressingForward`](Self.isSuppressingForward).
   */
  private suppressForward = new Set<string>();

  /**
   * Open (or return existing) model for a document (§10.1 Open).
   *
   * Idempotent on `documentId`: re-opening with the SAME origin is a no-op that
   * returns the existing entry. Opening an already-known document with a
   * DIFFERENT origin is a URI migration and is delegated to
   * [`migrateUri`](Self.migrateUri) (used by Task 9's Save As). For Task 2 the
   * migration primitive itself is correct; the LSP didClose/didOpen sequencing
   * is layered on by Task 9.
   *
   * TOTAL on URI: this method NEVER throws on a URI collision even when the
   * registry's id-keyed view disagrees with Monaco's URI-keyed view. Monaco's
   * `ModelService` tracks models by URI; this registry tracks them by
   * `documentId`. The two stay consistent under normal flows
   * (open/close/migrate all update BOTH maps atomically), but divergence is
   * reachable in real life — e.g. the backend reissuing a fresh `documentId`
   * for a path whose model is still alive after an LSP restart, a React remount
   * resetting component refs while this singleton (and Monaco's models)
   * persist, or an HMR re-import emptying this registry's maps while Monaco
   * keeps its models. Without reconciliation, reaching `createModel` for a URI
   * Monaco already holds throws `ModelService: Cannot add model because it
   * already exists!`, which propagates out of a React effect and tears the
   * editor tree down. So before creating, we reconcile against BOTH the
   * `idByUri` map and (belt-and-suspenders) `Monaco.editor.getModel(uri)` and
   * adopt/rebind the existing model instead of recreating it. The happy path
   * (truly new URI) is unchanged.
   */
  openModel(documentId: string, opts: OpenModelOptions): ModelEntry {
    const existing = this.byId.get(documentId);
    if (existing !== undefined) {
      const existingUri = originToUri(opts.origin, documentId as DocumentId);
      if (existingUri === existing.uri) {
        // Same origin → idempotent no-op. (Content/revision are assumed in
        // sync; the caller drives content via applyExternalContent / edits.)
        return existing;
      }
      // Different origin → URI migration (Save As / rename). Delegate so the
      // maps stay atomic. Task 9 layers didClose/didOpen on top.
      return this.migrateUri(documentId, opts.origin);
    }

    const uri = originToUri(opts.origin, documentId as DocumentId);

    // URI reconciliation — see the method doc. We are about to create a model
    // at `uri`, but Monaco's ModelService is URI-keyed and may already hold a
    // live model there even though THIS registry's id-keyed map does not know
    // `documentId`. Check both sides and adopt the existing model instead of
    // recreating (which would throw).
    const ownerOfUri = this.idByUri.get(uri);
    if (ownerOfUri !== undefined && ownerOfUri !== documentId) {
      const owned = this.byId.get(ownerOfUri);
      if (owned !== undefined) {
        // Rebind the live entry to the new id (e.g. backend reissued an id for
        // the same path). Preserves model/diagnostics/view-state/undo history.
        // Drop the old id everywhere we track it; this branch only fires under
        // divergence, so a stale oldId is expected.
        this.byId.delete(ownerOfUri);
        this.suppressForward.delete(ownerOfUri);
        owned.documentId = documentId;
        this.byId.set(documentId, owned);
        // idByUri already maps uri → ownerOfUri; rewrite to the new id.
        this.idByUri.set(uri, documentId);
        return owned;
      }
      // Stale idByUri row (its byId entry was already removed, e.g. a partial
      // close). Drop the stale row and fall through to create / adopt below.
      this.idByUri.delete(uri);
    }

    // Belt-and-suspenders: even if our idByUri map missed it, Monaco itself may
    // still hold a model at `uri` (e.g. HMR re-imported this module and emptied
    // our maps while Monaco kept its models). Adopt the orphan — recreating
    // would throw. The caller drives content/revision via applyExternalContent
    // / edits, so we do NOT clobber the adopted model's text here.
    const orphan = Monaco.editor.getModel(Uri.parse(uri));
    if (orphan !== null && this.idByUri.get(uri) === undefined) {
      const entry: ModelEntry = {
        model: orphan,
        uri,
        documentId,
        viewState: null,
        lastSyncedRevision: opts.revision,
      };
      this.byId.set(documentId, entry);
      this.idByUri.set(uri, documentId);
      return entry;
    }

    // Truly new URI — create the model. If it still throws (genuinely
    // unreachable after the reconciliation above), neither map is touched
    // (atomic).
    const model = Monaco.editor.createModel(
      opts.content,
      "typst",
      Uri.parse(uri),
    );

    const entry: ModelEntry = {
      model,
      uri,
      documentId,
      viewState: null,
      lastSyncedRevision: opts.revision,
    };

    this.byId.set(documentId, entry);
    this.idByUri.set(uri, documentId);

    return entry;
  }

  /** Read-only lookup by document id. */
  getModel(documentId: string): ModelEntry | undefined {
    return this.byId.get(documentId);
  }

  /**
   * Snapshot of all current entries. The LSP `didOpen` replay on (re)connect
   * does NOT consume this directly: it happens implicitly inside
   * `vscode-languageclient`'s `DidOpenTextDocumentFeature.register()`, which
   * iterates `monaco.editor.getModels()` (the live models this registry owns)
   * and sends `didOpen` for each that matches the documentSelector. This
   * snapshot is used by the diagnostics bridge to clear per-generation
   * tinymist diagnostics for every known doc on a restart. Returns a fresh
   * array referencing the live `ModelEntry` objects.
   */
  snapshot(): ModelEntry[] {
    return Array.from(this.byId.values());
  }

  /**
   * Activate a document in the editor (§10.5 tab switch): capture the OUTGOING
   * editor's view state, set the model, and return the view state to restore.
   *
   * Does NOT send any LSP document-lifecycle notification — tab switches are
   * invisible to Tinymist (the model stays open and keeps receiving diagnostics).
   *
   * `outgoingId` may be `null` on the very first activation (nothing to
   * capture); an outgoing id that isn't currently open is silently skipped
   * (defensive against a stale id racing a close).
   */
  activate(
    documentId: string,
    editor: Monaco.editor.IStandaloneCodeEditor,
    outgoingId: string | null,
  ): ActivateResult {
    const entry = this.byId.get(documentId);
    if (entry === undefined) {
      throw new Error(
        `MonacoModelRegistry.activate: unknown documentId ${documentId}`,
      );
    }

    // Capture the OUTGOING doc's view state before swapping (§10.5). Skip if
    // null (first activation) or if the id isn't open (stale id racing a close).
    if (outgoingId !== null) {
      const outgoing = this.byId.get(outgoingId);
      if (outgoing !== undefined) {
        outgoing.viewState = editor.saveViewState();
      }
    }

    editor.setModel(entry.model);
    return { model: entry.model, viewState: entry.viewState };
  }

  /**
   * Save the editor's current view state onto a document's entry (§10.5 — the
   * "save old viewState" half of a tab switch, exposed standalone so callers
   * can capture state without immediately activating another doc). No-op for
   * an unknown id.
   */
  saveViewState(
    documentId: string,
    editor: Monaco.editor.IStandaloneCodeEditor,
  ): void {
    const entry = this.byId.get(documentId);
    if (entry === undefined) return;
    entry.viewState = editor.saveViewState();
  }

  /**
   * Controlled replace (§8.4): the backend reloaded a disk file and pushed new
   * content/revision. Replace the model text WITHOUT triggering a re-forward
   * to the backend (the anti-bounce-back).
   *
   * Mechanics:
   * 1. No-op if the document isn't open, or the revision is stale
   *    (`<= current`) — a slow reload must not clobber a newer buffer.
   * 2. Mark the id as suppressing-forward.
   * 3. `model.setValue(content)` — fires `onDidChangeContent` SYNCHRONOUSLY
   *    for every listener (Monaco dispatches inline). The editor's onChange
   *    handler therefore probes `isSuppressingForward` and sees true, so it
   *    skips the forward.
   * 4. Clear the suppress mark (now that the synchronous dispatch is over).
   * 5. Update `lastSyncedRevision`.
   *
   * Returns true if applied, false if not (unknown id / stale revision).
   */
  applyExternalContent(
    documentId: string,
    content: string,
    revision: number,
  ): boolean {
    const entry = this.byId.get(documentId);
    if (entry === undefined) return false;
    // Stale: a strictly-older-or-equal revision must not overwrite a newer
    // buffer (§8.4 guard baseline).
    if (revision <= entry.lastSyncedRevision) return false;

    // Mark BEFORE setValue; clear AFTER in a finally. Monaco dispatches all
    // change listeners synchronously inside setValue, so every listener that
    // runs during the dispatch sees the mark. The editor's onChange forwards
    // asynchronously, so it observes the mark; see the class-level note for
    // the (currently-unreachable) synchronous-reentrancy caveat.
    this.suppressForward.add(documentId);
    entry.lastSyncedRevision = revision;
    try {
      entry.model.setValue(content);
    } finally {
      this.suppressForward.delete(documentId);
    }
    return true;
  }

  /**
   * URI migration primitive (§11 Save As / §12 rename). Monaco model URIs are
   * immutable, so changing a document's origin requires model replacement.
   * Atomically:
   *  1. build the NEW uri from `newOrigin`;
   *  2. if it equals the current uri → no-op (return current entry);
   *  3. create a new model at the new uri carrying the CURRENT text;
   *  4. update both maps (remove old uri from `idByUri`, add new uri, swap the
   *     `byId` entry's `model`/`uri`);
   *  5. dispose the OLD model AFTER the map swap (so a concurrent
   *     `resolveDocumentId` never returns a stale id pointing at a disposed
   *     model).
   *
   * PRESERVED across the migration (§11): `documentId`, `lastSyncedRevision`,
   * `viewState`. CLEARED intentionally: Monaco undo/redo history (a new model
   * starts with empty history — §11 explicitly accepts this).
   *
   * Emits nothing LSP-side: Task 9 layers `didClose(old)` / `didOpen(new)` on
   * top and drives the `editor.setModel` swap. Returns the new `ModelEntry`.
   * Throws if `documentId` is unknown.
   */
  migrateUri(documentId: string, newOrigin: DocumentOrigin): ModelEntry {
    const entry = this.byId.get(documentId);
    if (entry === undefined) {
      throw new Error(
        `MonacoModelRegistry.migrateUri: unknown documentId ${documentId}`,
      );
    }

    const newUri = originToUri(newOrigin, documentId as DocumentId);
    if (newUri === entry.uri) {
      // Same origin → same uri. Nothing to migrate.
      return entry;
    }

    const oldUri = entry.uri;
    const oldModel = entry.model;
    const currentText = oldModel.getValue();

    // Create the new model FIRST; if it throws, neither map is touched.
    const newModel = Monaco.editor.createModel(
      currentText,
      "typst",
      Uri.parse(newUri),
    );

    // Atomic map swap: remove old uri, add new uri, replace the entry's model
    // + uri. Do this BEFORE disposing the old model so a concurrent
    // resolveDocumentId never returns an id pointing at a disposed model.
    this.idByUri.delete(oldUri);
    this.idByUri.set(newUri, documentId);

    entry.model = newModel;
    entry.uri = newUri;
    // viewState + lastSyncedRevision + documentId preserved (§11).

    oldModel.dispose();

    return entry;
  }

  /**
   * Close (§10.4 Close): dispose the model and drop both map entries. Returns
   * true if something was closed, false if the id was unknown.
   *
   * The CALLER is responsible for the LSP `didClose` notification, which MUST
   * happen before this call (§10.4: didClose precedes model dispose). The
   * registry does not send LSP notifications.
   */
  closeModel(documentId: string): boolean {
    const entry = this.byId.get(documentId);
    if (entry === undefined) return false;

    // Drop map entries BEFORE disposing the model so a concurrent
    // resolveDocumentId never returns an id pointing at a disposed model.
    this.idByUri.delete(entry.uri);
    this.byId.delete(documentId);
    this.suppressForward.delete(documentId);

    entry.model.dispose();
    return true;
  }

  /**
   * URI → DocumentId resolution (§13.2 diagnostics routing). Untitled URIs go
   * through [`parseUntitledUriId`](./documentUri.ts) (handles BOTH scheme
   * variants regardless of the active untitled scheme), then verified against
   * the registry's current canonical uri for that id (so a STALE untitled uri
   * left over from a Save As migration does NOT resolve — §11: "迁移期间到达的
   * 旧 URI diagnostics 被丢弃"). Real `file:` URIs go through the `idByUri`
   * map. Returns `null` for unknown URIs (a closed doc, a stale uri after
   * migration, etc.) so the diagnostics bridge can drop them.
   */
  resolveDocumentId(uri: string): string | null {
    // Our untitled URIs (both `untitled:` and the fallback virtual `file:`
    // form) round-trip through parseUntitledUriId regardless of the active
    // scheme — try it first. But the parsed id is only valid if the entry is
    // still open AND its canonical uri matches (a migrated-away untitled doc
    // must NOT resolve under its old untitled uri).
    const untitledId = parseUntitledUriId(uri);
    if (untitledId !== null) {
      const entry = this.byId.get(untitledId);
      if (entry !== undefined && entry.uri === uri) {
        return untitledId;
      }
    }
    // Real file URIs (and anything else) go through the canonical uri→id map.
    return this.idByUri.get(uri) ?? null;
  }

  /**
   * Is this document's CURRENT (synchronous) content-change dispatch a
   * self-induced controlled replace that must NOT be forwarded to the backend
   * as a user edit? (§8.4 anti-bounce-back.) The editor's onChange handler
   * calls this and skips the forward when it returns true. The mark is set
   * immediately before `model.setValue` (in
   * [`applyExternalContent`](Self.applyExternalContent)) and cleared
   * immediately after, so it is true only for the duration of that single
   * synchronous dispatch.
   */
  isSuppressingForward(documentId: string): boolean {
    return this.suppressForward.has(documentId);
  }

  /**
   * Test/diagnostic ONLY: clear all state (both maps, the suppress set, and
   * dispose every live model). Production code does NOT call this — the
   * `ForTest` suffix is the greppable guard (mirrors `setUntitledSchemeForTest`
   * in [`documentUri`](./documentUri.ts)). The registry is a process-lifetime
   * singleton and models are removed via [`closeModel`](Self.closeModel). Used
   * by the test suite's `beforeEach`.
   */
  resetForTest(): void {
    for (const entry of this.byId.values()) {
      entry.model.dispose();
    }
    this.byId.clear();
    this.idByUri.clear();
    this.suppressForward.clear();
  }
}

/**
 * The app-wide singleton. Import this; do not construct your own registry.
 * (Task 3 wires [`MonacoEditor.tsx`](./MonacoEditor.tsx) to drive it; Task 4
 * uses [`snapshot`](Self.snapshot) for LSP replay; Task 9 layers Save As on
 * [`migrateUri`](Self.migrateUri).)
 */
export const monacoModelRegistry = new MonacoModelRegistry();
