import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  resolveConflictUseDisk,
  resolveConflictOverwrite,
} from "../../lib/tauri";
import {
  flushAndSaveAs,
  flushDocumentSnapshot,
} from "../../lib/saveDocument";
import { useConflictDialogStore } from "../../store/conflictDialogStore";
import { useDocumentsStore, type Document } from "../../store/documentsStore";
import { useTabsStore } from "../../store/tabsStore";
import { toIpcError, isCancelled } from "../../lib/ipc-error";
import i18n from "../../i18n";
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
  const { t } = useTranslation("dialog");
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
      const snapshot = await flushDocumentSnapshot(openForId);
      await resolveConflictOverwrite(openForId);
      // Overwrite succeeded → conflict + dirty cleared by the backend. Mirror.
      if (doc.path !== null) {
        useTabsStore
          .getState()
          .markSaved(openForId, doc.path, snapshot.revision);
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
      const saved = await flushAndSaveAs(openForId);
      // Save As rebinds the doc to the new path and clears dirty; it also
      // resolves the conflict on the original (the buffer is now saved
      // elsewhere). markSaved mirrors path/dirty/conflict in one shot.
      useTabsStore
        .getState()
        .markSaved(openForId, saved.path, saved.revision);
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
        aria-label={t("conflict.ariaLabel")}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="dialog-title">{t("conflict.title", { title: doc.title })}</h2>
        <ConflictMessage variant={variant} />
        {error && <div className="conflict-error">{error}</div>}
        <div className="conflict-actions">
          <button
            className="btn-ghost"
            onClick={() => setShowCompare((v) => !v)}
            disabled={!hasDiskContent || busy}
            title={
              hasDiskContent
                ? t("conflict.compareToggleTitleOn")
                : t("conflict.compareToggleTitleOff")
            }
          >
            {showCompare ? t("conflict.hideCompare") : t("conflict.compare")}
          </button>
          <button
            className="btn-utility"
            onClick={handleUseDisk}
            disabled={!hasDiskContent || busy}
            title={
              hasDiskContent
                ? t("conflict.useDiskTitleOn")
                : t("conflict.useDiskTitleOff")
            }
          >
            {t("conflict.useDisk")}
          </button>
          <button
            className="btn-utility"
            onClick={handleOverwrite}
            disabled={!canOverwrite(variant) || busy}
            title={
              canOverwrite(variant)
                ? t("conflict.overwriteTitleOn")
                : t("conflict.overwriteTitleOff")
            }
          >
            {t("conflict.overwriteDisk")}
          </button>
          <button
            className="btn-utility"
            onClick={handleSaveAs}
            disabled={busy}
            title={t("conflict.saveAsTitle")}
          >
            {t("conflict.saveAs")}
          </button>
          <button
            className="btn-primary"
            onClick={close}
            disabled={busy}
            title={t("conflict.laterTitle")}
            autoFocus
          >
            {t("conflict.later")}
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
 * Reads the localized strings from the `dialog` namespace via the i18n
 * singleton (English is the fallback, so the unit-test regexes still match).
 */
export function conflictMessage(variant: ConflictState): string {
  switch (variant) {
    case "modified":
      return i18n.t("conflict.message.modified", { ns: "dialog" });
    case "missing":
      return i18n.t("conflict.message.missing", { ns: "dialog" });
    case "permission_changed":
      return i18n.t("conflict.message.permission_changed", { ns: "dialog" });
    case "replaced":
      return i18n.t("conflict.message.replaced", { ns: "dialog" });
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
  const { t } = useTranslation("dialog");
  return (
    <div
      className="conflict-compare"
      role="region"
      aria-label={t("conflict.compareView.ariaLabel")}
    >
      <div className="conflict-compare-pane">
        <div className="conflict-compare-label">{t("conflict.compareView.editorBuffer")}</div>
        <pre>{buffer}</pre>
      </div>
      <div className="conflict-compare-pane">
        <div className="conflict-compare-label">{t("conflict.compareView.disk")}</div>
        <pre>{disk}</pre>
      </div>
    </div>
  );
}

// Re-export the Document type alias for the render test's convenience.
export type { Document };
