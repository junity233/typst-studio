import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Maximize2, X } from "lucide-react";
import type { PendingApproval } from "../../store/assistantTools";

interface DiffCardProps {
  approval: PendingApproval & { verdict: "pending" | "applied" | "rejected" };
  onApply: () => void;
  onReject: () => void;
}

interface DiffLine {
  kind: "ctx" | "del" | "add";
  text: string;
  /** 1-based line number in the original (before) file. -1 for pure additions. */
  beforeLine: number;
  /** 1-based line number in the after file. -1 for pure deletions. */
  afterLine: number;
}

/**
 * Line-level diff. Finds the first/last differing line between before/after,
 * marks the middle as del/add, and tags line numbers for the expanded view.
 */
function computeDiff(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }

  const out: DiffLine[] = [];
  // Context before
  for (let i = 0; i < prefix; i++) {
    out.push({ kind: "ctx", text: a[i], beforeLine: i + 1, afterLine: i + 1 });
  }
  // Deleted lines
  for (let i = prefix; i < a.length - suffix; i++) {
    out.push({ kind: "del", text: a[i], beforeLine: i + 1, afterLine: -1 });
  }
  // Added lines
  for (let i = prefix; i < b.length - suffix; i++) {
    out.push({ kind: "add", text: b[i], beforeLine: -1, afterLine: i + 1 });
  }
  // Context after
  for (let i = a.length - suffix; i < a.length; i++) {
    out.push({ kind: "ctx", text: a[i], beforeLine: i + 1, afterLine: i + 1 });
  }
  return out;
}

/**
 * Cap a diff's context to `ctx` lines around each change. `computeDiff`
 * returns the WHOLE file as context (unlimited), which would render huge
 * documents unreadably in the modal. Dropped runs are visible via the
 * line-number gutters (the numbers jump).
 */
function contextWindow(diff: DiffLine[], ctx: number): DiffLine[] {
  const keep = new Array<boolean>(diff.length).fill(false);
  for (let i = 0; i < diff.length; i++) {
    if (diff[i].kind === "ctx") continue;
    for (
      let j = Math.max(0, i - ctx);
      j <= Math.min(diff.length - 1, i + ctx);
      j++
    ) {
      keep[j] = true;
    }
  }
  return diff.filter((_, i) => keep[i]);
}

export function DiffCard({ approval, onApply, onReject }: DiffCardProps) {
  const { t } = useTranslation("assistant");
  const [poppedOut, setPoppedOut] = useState(false);

  const before = approval.before ?? "";
  const after =
    approval.kind === "write_file"
      ? (approval.after ?? "")
      : // Function replacer: with a string replacement, String.replace applies
        // substitution patterns ($&, $', $$ …) to new_string, diverging from the
        // literal text applyStrReplace inserts. A function's return value is
        // used literally (and keeps first-match semantics).
        before.replace(approval.old_string ?? "", () => approval.new_string ?? "");
  const diff = computeDiff(before, after);
  // Inline card shows ONLY the changed lines (no context).
  const changedLines = diff.filter((l) => l.kind !== "ctx");
  const path = approval.path.split(/[\\/]/).pop() ?? approval.path;

  return (
    <>
      <div className="assistant-diff-card" data-verdict={approval.verdict}>
        <div className="assistant-diff-card__header">
          <span className="assistant-diff-card__tool">
            {approval.kind} · {path}
          </span>
          <button
            className="assistant-diff-card__expand"
            onClick={() => setPoppedOut(true)}
            title={t("expandDiff")}
            aria-label={t("expandDiff")}
          >
            <Maximize2 size={12} />
          </button>
        </div>
        <pre className="assistant-diff-card__body">
          {changedLines.map((line, i) => (
            <div
              key={i}
              className={`assistant-diff-line assistant-diff-line--${line.kind}`}
            >
              <span className="assistant-diff-line__sign">
                {line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}
              </span>
              <span className="assistant-diff-line__text">{line.text}</span>
            </div>
          ))}
          {changedLines.length === 0 && (
            <div className="assistant-diff-line assistant-diff-line--ctx">
              <span className="assistant-diff-line__sign"> </span>
              <span className="assistant-diff-line__text assistant-diff-line--empty">
                {t("noChanges")}
              </span>
            </div>
          )}
        </pre>
        {approval.verdict === "pending" && (
          <div className="assistant-diff-card__actions">
            <button className="assistant-btn assistant-btn--ghost" onClick={onReject}>
              {t("reject")}
            </button>
            <button className="assistant-btn assistant-btn--primary" onClick={onApply}>
              {t("apply")}
            </button>
          </div>
        )}
        {approval.verdict !== "pending" && (
          <div className="assistant-diff-card__verdict">
            {approval.verdict === "applied" ? t("applied") : t("rejected")}
          </div>
        )}
      </div>

      {poppedOut && (
        <DiffModal
          // The modal shows the FULL diff (context lines + line numbers),
          // capped to a window around the changes — unlike the inline card,
          // which shows only the changed lines.
          diff={contextWindow(diff, 3)}
          path={path}
          verdict={approval.verdict}
          onApply={onApply}
          onReject={onReject}
          onClose={() => setPoppedOut(false)}
        />
      )}
    </>
  );
}

/** Full-screen diff modal with context lines + line numbers. */
function DiffModal({
  diff,
  path,
  verdict,
  onApply,
  onReject,
  onClose,
}: {
  diff: DiffLine[];
  path: string;
  verdict: "pending" | "applied" | "rejected";
  onApply: () => void;
  onReject: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("assistant");
  // Esc closes — window-level listener like AboutModal (a focused element
  // inside the portal is not guaranteed to receive the key). Attached only
  // while the modal is mounted (it's conditionally rendered).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return createPortal(
    <div className="dialog-overlay assistant-diff-modal-overlay" onClick={onClose}>
      <div
        className="assistant-diff-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="assistant-diff-modal__header">
          <span className="assistant-diff-modal__title">{path}</span>
          <button
            className="assistant-diff-modal__close"
            onClick={onClose}
            aria-label={t("close")}
          >
            <X size={16} />
          </button>
        </div>
        <div className="assistant-diff-modal__body">
          <pre className="assistant-diff-modal__pre">
            {diff.map((line, i) => (
              <div
                key={i}
                className={`assistant-diff-line assistant-diff-line--${line.kind}`}
              >
                {/* Line-number gutters (before/after); blank for pure adds /
                  dels, so the columns stay aligned. */}
                <span className="assistant-diff-line__num">
                  {line.beforeLine > 0 ? line.beforeLine : ""}
                </span>
                <span className="assistant-diff-line__num">
                  {line.afterLine > 0 ? line.afterLine : ""}
                </span>
                <span className="assistant-diff-line__sign">
                  {line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}
                </span>
                <span className="assistant-diff-line__text">{line.text}</span>
              </div>
            ))}
          </pre>
        </div>
        {verdict === "pending" && (
          <div className="assistant-diff-modal__actions">
            <button className="assistant-btn assistant-btn--ghost" onClick={onReject}>
              {t("reject")}
            </button>
            <button className="assistant-btn assistant-btn--primary" onClick={onApply}>
              {t("apply")}
            </button>
          </div>
        )}
        {verdict !== "pending" && (
          <div className="assistant-diff-modal__verdict">
            {verdict === "applied" ? t("applied") : t("rejected")}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
