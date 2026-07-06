import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useRecoveryStore, recoverRequiresCompareFirst } from "../../store/recoveryStore";
import {
  recoverDocument,
  discardRecovery,
  compareRecovery,
} from "../../lib/tauri";
import type { RecoverableInfo, CompareRecovery } from "../../lib/types";
import { useTabsStore } from "../../store/tabsStore";
import { useDocumentsStore } from "../../store/documentsStore";
import { toIpcError } from "../../lib/ipc-error";
import i18n from "../../i18n";

/**
 * Crash-recovery dialog (§5.1.3).
 *
 * Shown at startup when the backend emitted `recovery_available` (the prior
 * session crashed, or a snapshot is newer than disk). Lists each recoverable
 * document with its filename, original path, capture time, and a disk-changed
 * indicator. Each row has three actions:
 *
 *   - **Recover**: create a dirty in-memory doc from the snapshot (does NOT
 *     write disk).
 *   - **Compare**: open a side-by-side read-only view of the snapshot vs the
 *     current disk content (minimal — no inline diff engine yet).
 *   - **Discard**: delete the snapshot permanently.
 *
 * Default selection per doc kind (§5.1.3):
 *   - Untitled → Recover.
 *   - Disk unchanged → Recover (the buffer is the newer version).
 *   - Disk changed → MUST Compare first (Recover is disabled until the user
 *     has compared; once compared, Recover enables and is available). This
 *     prevents silently clobbering an external change with a recovered buffer
 *     without first showing the user both versions.
 *
 * Once every snapshot is decided (recovered or discarded), the dialog
 * auto-closes and normal session restore proceeds.
 */
export function RecoveryDialog() {
  const { t } = useTranslation("dialog");
  const dialogOpen = useRecoveryStore((s) => s.dialogOpen);
  const recoverable = useRecoveryStore((s) => s.recoverable);

  if (!dialogOpen) return null;

  return (
    <div className="dialog-overlay" role="presentation">
      <div
        className="dialog recovery-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t("recovery.ariaLabel")}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="dialog-title">{t("recovery.title")}</h2>
        <p className="dialog-message">{t("recovery.message")}</p>
        <ul className="recovery-list">
          {recoverable.map((snap) => (
            <RecoveryRow key={snap.documentId} snap={snap} />
          ))}
        </ul>
      </div>
    </div>
  );
}

/** One recoverable document row. Self-contained: holds its own compare state. */
function RecoveryRow({ snap }: { snap: RecoverableInfo }) {
  const { t } = useTranslation("dialog");
  const markDecided = useRecoveryStore((s) => s.markDecided);
  const markRecovered = useRecoveryStore((s) => s.markRecovered);
  const markCompared = useRecoveryStore((s) => s.markCompared);
  // §5.1.3: a disk-changed doc's Recover is disabled until the user has
  // Compare'd it. `comparedIds` is lifted into the store so the enablement
  // survives re-renders and is unit-testable.
  const hasCompared = useRecoveryStore((s) => s.comparedIds.has(snap.documentId));
  const [compare, setCompare] = useState<CompareRecovery | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isUntitled = snap.canonicalPath === undefined || snap.canonicalPath === null;
  // §5.1.3 default action matrix, via the shared pure helper: a disk-changed
  // doc must be compared first, but once compared the requirement is lifted
  // (Recover becomes available).
  const mustCompare = recoverRequiresCompareFirst(snap, hasCompared);

  const handleRecover = async () => {
    setBusy(true);
    setError(null);
    try {
      const recovered = await recoverDocument(snap.documentId);
      // Create a dirty in-memory doc from the snapshot. If the snapshot had a
      // canonical path (a disk file), open it as an untitled-style doc seeded
      // with the recovered content — we deliberately do NOT write disk. The
      // title carries the original filename so the user recognizes it.
      const doc = await useTabsStore.getState().openTab(recovered.content);
      // Override the title/path display to reflect the recovered origin so the
      // user knows where this buffer came from.
      useDocumentsStore.getState().upsertDocument({
        id: doc,
        title: recovered.title,
        path: null,
        dirty: true,
        content: recovered.content,
        // §17: recovered docs open as untitled-style in-memory docs (we do NOT
        // write disk), so the authoritative origin is `untitled`.
        origin: { kind: "untitled" },
        revision: 0,
        compiledRevision: -1,
        conflict: "none",
        conflictDiskContent: null,
        status: "idle",
        durationMs: null,
        svgPages: [],
        lineMap: [],
        outline: [],
      });
      markRecovered(snap.documentId);
      markDecided(snap.documentId);
    } catch (e) {
      setError(toIpcError(e).message);
    } finally {
      setBusy(false);
    }
  };

  const handleCompare = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await compareRecovery(snap.documentId);
      setCompare(result);
      // §5.1.3: recording the compare here enables Recover for a disk-changed
      // doc (the user has now viewed both versions). Done after the IPC
      // succeeds so a failed compare doesn't unlock Recover.
      markCompared(snap.documentId);
    } catch (e) {
      setError(toIpcError(e).message);
    } finally {
      setBusy(false);
    }
  };

  const handleDiscard = async () => {
    setBusy(true);
    setError(null);
    try {
      await discardRecovery(snap.documentId);
      markDecided(snap.documentId);
    } catch (e) {
      setError(toIpcError(e).message);
    } finally {
      setBusy(false);
    }
  };

  const captured = formatCaptureTime(snap.capturedAt);

  return (
    <li className="recovery-row">
      <div className="recovery-row-head">
        <span className="recovery-name">{snap.title}</span>
        {snap.diskChanged && (
          <span className="recovery-flag" title={t("recovery.diskChangedTitle")}>
            {t("recovery.diskChangedLabel")}
          </span>
        )}
        {isUntitled && (
          <span className="recovery-flag" title={t("recovery.untitledTitle")}>
            {t("recovery.untitledLabel")}
          </span>
        )}
      </div>
      <div className="recovery-meta">
        {snap.canonicalPath ? (
          <span className="recovery-path">{snap.canonicalPath}</span>
        ) : (
          <span className="recovery-path">{t("recovery.notSavedToDisk")}</span>
        )}
        <span className="recovery-time">{captured}</span>
      </div>
      {error && <div className="recovery-error">{error}</div>}
      <div className="recovery-actions">
        <button
          className="btn-utility"
          onClick={handleDiscard}
          disabled={busy}
        >
          {t("recovery.discard")}
        </button>
        <button
          className="btn-ghost"
          onClick={handleCompare}
          disabled={busy || isUntitled}
          title={isUntitled ? t("recovery.compareTitleOff") : t("recovery.compareTitleOn")}
        >
          {t("recovery.compare")}
        </button>
        <button
          className="btn-primary"
          onClick={handleRecover}
          disabled={busy || mustCompare}
          title={mustCompare ? t("recovery.recoverTitleOff") : t("recovery.recoverTitleOn")}
          autoFocus={!mustCompare}
        >
          {t("recovery.recover")}
        </button>
      </div>
      {compare && <CompareView compare={compare} />}
    </li>
  );
}

/**
 * Minimal side-by-side read-only compare (§5.1.3 "比较"). No inline diff engine
 * yet — just two `<pre>` panes so the user can eyeball the differences. A real
 * diff (word/line highlight) is future work; documented here so the gap is
 * explicit.
 */
function CompareView({ compare }: { compare: CompareRecovery }) {
  const { t } = useTranslation("dialog");
  return (
    <div className="recovery-compare" role="region" aria-label={t("recovery.compareView.ariaLabel")}>
      <div className="recovery-compare-pane">
        <div className="recovery-compare-label">{t("recovery.compareView.recoveredSnapshot")}</div>
        <pre>{compare.snapshot}</pre>
      </div>
      <div className="recovery-compare-pane">
        <div className="recovery-compare-label">{t("recovery.compareView.currentDisk")}</div>
        <pre>{compare.disk ?? t("recovery.compareView.fileMissingOrNotOnDisk")}</pre>
      </div>
    </div>
  );
}

/**
 * Format a unix-millis capture timestamp as a locale string. Best-effort: on
 * invalid input falls back to the raw number so the UI never breaks.
 */
function formatCaptureTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return i18n.t("recovery.unknownTime", { ns: "dialog" });
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return String(ms);
  }
}
