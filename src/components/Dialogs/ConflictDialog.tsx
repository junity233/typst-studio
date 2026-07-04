import { useState } from "react";
import {
  resolveConflictUseDisk,
  resolveConflictOverwrite,
  saveAs as saveAsBE,
} from "../../lib/tauri";
import { useConflictDialogStore } from "../../store/conflictDialogStore";
import { useDocumentsStore, type Document } from "../../store/documentsStore";
import { useTabsStore } from "../../store/tabsStore";
import { toIpcError, isCancelled } from "../../lib/ipc-error";
import type { ConflictState } from "../../lib/types";

/**
 * Conflict-resolution dialog (§5.4).
 *
 * Shown when a document's `conflict != "none"` and the user either tried to
 * save it (the SaveCoordinator gate rejected the in-place save with
 * `ExternalConflict`; `saveTab` opened this dialog instead of alerting) or
 * clicked the StatusBar's "Conflict" entry. The actions per §5.4:
 *
 *   - **比较 (Compare)**: side-by-side read-only view of the editor buffer vs
 *     the disk content (only available when disk content exists, i.e. the
 *     "modified" variant). Minimal `<pre>` diff, like RecoveryDialog's compare.
 *   - **使用磁盘版本 (Use disk)**: replace the buffer with the disk content,
 *     bump revision, clear dirty + conflict. Only for "modified".
 *   - **覆盖磁盘 (Overwrite disk)**: atomic-save the current buffer, bypassing
 *     the conflict gate. Available for "modified" / "replaced" (we have a
 *     readable target).
 *   - **另存为 (Save As)**: write elsewhere (not blocked by the gate). Clears
 *     the conflict on the original doc.
 *   - **稍后处理 (Later)**: keep the conflict (in-place save stays blocked),
 *     close the dialog, continue editing.
 *
 * For "missing" / "permission_changed" the disk content is unavailable, so the
 * dialog shows an explanatory message and offers Save As (+ recreate for
 * missing) instead of the compare / use-disk actions.
 */
export function ConflictDialog() {
  const openForId = useConflictDialogStore((s) => s.openForId);
  const error = useConflictDialogStore((s) => s.error);
  const close = useConflictDialogStore((s) => s.close);
  const setError = useConflictDialogStore((s) => s.setError);
  const doc = useDocumentsStore((s) =>
    openForId !== null ? (s.documents[openForId] ?? null) : null,
  );

  // Local compare-toggle: flips the side-by-side view on. Survives the async
  // actions below (which don't unmount the dialog) without crossing store
  // boundaries.
  const [showCompare, setShowCompare] = useState(false);
  const [busy, setBusy] = useState(false);

  if (openForId === null || doc === null) return null;

  const variant = doc.conflict;
  const hasDiskContent =
    variant === "modified" && doc.conflictDiskContent !== null;

  // --- action handlers -------------------------------------------------------
  const handleUseDisk = async () => {
    setBusy(true);
    setError(null);
    try {
      const diskContent = await resolveConflictUseDisk(openForId);
      // The backend already bumped revision + cleared dirty + conflict; mirror
      // that into the local document so the editor hydrates immediately.
      useDocumentsStore.setState((s) => ({
        documents: {
          ...s.documents,
          [openForId]: {
            ...s.documents[openForId],
            content: diskContent,
            dirty: false,
            conflict: "none",
            conflictDiskContent: null,
            // Bump the optimistic revision to match the backend's bump so the
            // next compile event isn't treated as stale.
            revision: s.documents[openForId].revision + 1,
          },
        },
      }));
      close();
    } catch (e) {
      setError(toIpcError(e).message);
    } finally {
      setBusy(false);
    }
  };

  const handleOverwrite = async () => {
    setBusy(true);
    setError(null);
    try {
      await resolveConflictOverwrite(openForId);
      // Overwrite succeeded → conflict + dirty cleared by the backend. Mirror.
      useDocumentsStore.setState((s) => ({
        documents: {
          ...s.documents,
          [openForId]: {
            ...s.documents[openForId],
            dirty: false,
            conflict: "none",
            conflictDiskContent: null,
          },
        },
      }));
      if (doc.path !== null) {
        useTabsStore.getState().markSaved(openForId, doc.path);
      }
      close();
    } catch (e) {
      if (!isCancelled(e)) {
        setError(toIpcError(e).message);
      }
    } finally {
      setBusy(false);
    }
  };

  const handleSaveAs = async () => {
    setBusy(true);
    setError(null);
    try {
      const path = await saveAsBE(openForId);
      // Save As rebinds the doc to the new path and clears dirty; it also
      // resolves the conflict on the original (the buffer is now saved
      // elsewhere). markSaved mirrors path/dirty/conflict in one shot.
      useTabsStore.getState().markSaved(openForId, path);
      close();
    } catch (e) {
      if (!isCancelled(e)) {
        setError(toIpcError(e).message);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dialog-overlay" role="presentation">
      <div
        className="dialog conflict-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Resolve file conflict"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="dialog-title">Resolve conflict: {doc.title}</h2>
        <ConflictMessage variant={variant} />
        {error && <div className="conflict-error">{error}</div>}
        <div className="conflict-actions">
          <button
            className="btn-ghost"
            onClick={() => setShowCompare((v) => !v)}
            disabled={!hasDiskContent || busy}
            title={
              hasDiskContent
                ? "Compare the editor buffer with the disk content"
                : "No disk content to compare for this conflict kind"
            }
          >
            {showCompare ? "Hide compare" : "Compare"}
          </button>
          <button
            className="btn-utility"
            onClick={handleUseDisk}
            disabled={!hasDiskContent || busy}
            title={
              hasDiskContent
                ? "Replace the editor buffer with the disk content"
                : "Only available when the disk content is readable (modified)"
            }
          >
            Use disk
          </button>
          <button
            className="btn-utility"
            onClick={handleOverwrite}
            disabled={!canOverwrite(variant) || busy}
            title={
              canOverwrite(variant)
                ? "Overwrite the disk file with the editor buffer"
                : "Only available when the disk file is writable (modified / replaced)"
            }
          >
            Overwrite disk
          </button>
          <button
            className="btn-utility"
            onClick={handleSaveAs}
            disabled={busy}
            title="Save the buffer to a new file (keeps both versions)"
          >
            Save As…
          </button>
          <button
            className="btn-primary"
            onClick={close}
            disabled={busy}
            title="Keep editing; in-place save stays blocked until you resolve"
            autoFocus
          >
            Later
          </button>
        </div>
        {showCompare && hasDiskContent && (
          <CompareView buffer={doc.content} disk={doc.conflictDiskContent ?? ""} />
        )}
      </div>
    </div>
  );
}

/**
 * Whether the "Overwrite disk" action is available for `variant`. Available
 * when the disk file is readable+writable (modified / replaced); NOT for
 * missing (file gone) or permission_changed (file unreadable). Pure + exported
 * for unit-testing the action matrix.
 */
export function canOverwrite(variant: ConflictState): boolean {
  return variant === "modified" || variant === "replaced";
}

/** Variant-specific explanatory message above the action buttons. */
function ConflictMessage({ variant }: { variant: ConflictState }) {
  const message = conflictMessage(variant);
  return <p className="dialog-message">{message}</p>;
}

/**
 * Human description of each conflict variant. Pure + exported so the render
 * test and any future status-bar tooltip share ONE definition of the wording.
 */
export function conflictMessage(variant: ConflictState): string {
  switch (variant) {
    case "modified":
      return "The file changed on disk while you had unsaved edits. Choose how to reconcile the two versions.";
    case "missing":
      return "The file was deleted or moved on disk. The buffer is preserved — recreate it (Save As to the same path) or save elsewhere.";
    case "permission_changed":
      return "The file became read-only or inaccessible. Fix the file permissions, or Save As to a writable location.";
    case "replaced":
      return "The file was replaced on disk (same content, but the file identity changed — e.g. an external tool rewrote it). Overwrite to keep your buffer, or Save As.";
    case "none":
    default:
      return "";
  }
}

/**
 * Minimal side-by-side read-only compare (§5.4 比较). No inline diff engine —
 * two `<pre>` panes so the user can eyeball the differences, mirroring the
 * RecoveryDialog compare. A real word/line-highlighted diff is future work.
 */
function CompareView({
  buffer,
  disk,
}: {
  buffer: string;
  disk: string;
}) {
  return (
    <div
      className="conflict-compare"
      role="region"
      aria-label="Editor buffer vs disk comparison"
    >
      <div className="conflict-compare-pane">
        <div className="conflict-compare-label">Editor buffer</div>
        <pre>{buffer}</pre>
      </div>
      <div className="conflict-compare-pane">
        <div className="conflict-compare-label">Disk</div>
        <pre>{disk}</pre>
      </div>
    </div>
  );
}

// Re-export the Document type alias for the render test's convenience.
export type { Document };
