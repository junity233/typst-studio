import { useTranslation } from "react-i18next";
import type { PendingApproval } from "../../store/assistantTools";

interface DiffCardProps {
  approval: PendingApproval & { verdict: "pending" | "applied" | "rejected" };
  onApply: () => void;
  onReject: () => void;
}

interface DiffLine {
  kind: "ctx" | "del" | "add";
  text: string;
}

/**
 * Minimal line-level diff (no char highlighting, no LCS). Finds the common
 * prefix and suffix between before/after and marks the middle as -/+ .
 * Matches DESIGN.md's minimalism; avoids a diff-library dependency.
 */
function lineDiff(before: string, after: string): DiffLine[] {
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
  for (let i = 0; i < prefix; i++) out.push({ kind: "ctx", text: a[i] });
  for (let i = prefix; i < a.length - suffix; i++) {
    out.push({ kind: "del", text: a[i] });
  }
  for (let i = prefix; i < b.length - suffix; i++) {
    out.push({ kind: "add", text: b[i] });
  }
  for (let i = a.length - suffix; i < a.length; i++) {
    out.push({ kind: "ctx", text: a[i] });
  }
  return out;
}

export function DiffCard({ approval, onApply, onReject }: DiffCardProps) {
  const { t } = useTranslation("assistant");
  const before = approval.before ?? "";
  const after =
    approval.kind === "write_file"
      ? (approval.after ?? "")
      : before.replace(approval.old_string ?? "", approval.new_string ?? "");
  const diff = lineDiff(before, after);
  const path = approval.path.split(/[\\/]/).pop() ?? approval.path;

  return (
    <div className="assistant-diff-card" data-verdict={approval.verdict}>
      <div className="assistant-diff-card__header">
        <span className="assistant-diff-card__tool">
          {approval.kind} · {path}
        </span>
      </div>
      <pre className="assistant-diff-card__body">
        {diff.map((line, i) => (
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
      </pre>
      {approval.verdict === "pending" && (
        <div className="assistant-diff-card__actions">
          <button
            className="assistant-btn assistant-btn--ghost"
            onClick={onReject}
          >
            {t("reject")}
          </button>
          <button
            className="assistant-btn assistant-btn--primary"
            onClick={onApply}
          >
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
  );
}
