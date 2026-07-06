import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Allotment } from "allotment";
import { useGitStore, initGitAutoRefresh } from "../../store/gitStore";
import type { GitStatusKind } from "../../lib/types";

/**
 * Source Control panel (§Source Control). Shows the workspace's git status
 * split into "Changes" (unstaged) and "Staged Changes", a commit message box,
 * and the recent commit log. Stage/unstage/commit call the gix-backed IPC
 * commands; if any of those are stubbed in this build, their error is shown
 * inline rather than crashing the panel.
 *
 * Empty state: when the workspace is not a git repository (`isRepo === false`),
 * the panel shows a friendly hint instead of an error.
 */
export function SourceControlPanel() {
  const { t } = useTranslation("sourceControl");
  const changes = useGitStore((s) => s.changes);
  const recentLog = useGitStore((s) => s.recentLog);
  const loading = useGitStore((s) => s.loading);
  const error = useGitStore((s) => s.error);
  const isRepo = useGitStore((s) => s.isRepo);
  const refresh = useGitStore((s) => s.refresh);
  const stage = useGitStore((s) => s.stage);
  const unstage = useGitStore((s) => s.unstage);
  const commit = useGitStore((s) => s.commit);
  const [message, setMessage] = useState("");

  useEffect(() => {
    initGitAutoRefresh(); // subscribe to fs_changed (idempotent — guard in store)
    void refresh();
  }, [refresh]);

  if (!isRepo && !loading) {
    return (
      <div className="scm-empty">
        <p>{t("notARepo")}</p>
        <p className="scm-hint">{t("notARepoHint")}</p>
      </div>
    );
  }

  // A path can have both a staged and an unstaged side. Split into the two
  // sections shown by `git status`: "Changes" (anything with unstaged activity,
  // including untracked) and "Staged Changes" (anything staged).
  const staged = changes.filter((c) => c.staged !== "unchanged");
  const unstaged = changes.filter(
    (c) => c.unstaged !== "unchanged" || c.staged === "untracked",
  );

  const doCommit = (): void => {
    if (!message.trim() || staged.length === 0) return;
    void commit(message).then(() => setMessage(""));
  };

  return (
    <div className="scm-panel">
      {error && <div className="scm-error">{error}</div>}

      {/*
        Three resizable panes (commit box / changes / recent log), stacked
        vertically. Each pane is ALWAYS rendered so the Allotment's pane count
        — and therefore the user's saved drag-sizes — stays stable when a
        section happens to be empty (no staged files, no log yet). Empty
        sections just show their status line instead of unmounting the pane.

        `vertical` makes Allotment stack rows and draw horizontal sashes the
        user drags up/down (mirrors the workbench's left↔right split, rotated).
      */}
      <Allotment vertical proportionalLayout={false}>
        {/* Commit box — fixed-ish; small min so it can't collapse to nothing. */}
        <Allotment.Pane minSize={84} preferredSize={120} snap>
          <div className="scm-pane scm-commit-box">
            <textarea
              className="scm-message"
              placeholder={t("messagePlaceholder")}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  doCommit();
                }
              }}
              rows={2}
            />
            <div className="scm-commit-row">
              <button
                className="scm-commit-btn"
                disabled={!message.trim() || staged.length === 0}
                onClick={doCommit}
              >
                {t("commit")}
              </button>
              <button
                className="scm-refresh"
                onClick={() => void refresh()}
                title={t("refresh")}
              >
                ⟳
              </button>
            </div>
          </div>
        </Allotment.Pane>

        {/* Changes — the workhorse; gets the leftover height. */}
        <Allotment.Pane minSize={80} snap>
          <div className="scm-pane scm-changes">
            {loading && <div className="scm-status">{t("loading")}</div>}

            {unstaged.length > 0 && (
              <div className="scm-section">
                <div className="scm-section-title">{t("changes", { count: unstaged.length })}</div>
                {unstaged.map((c) => (
                  <div key={c.path} className="scm-row">
                    <span className={`scm-badge scm-${c.unstaged}`}>
                      {letterFor(c.unstaged)}
                    </span>
                    <span className="scm-path">{c.path}</span>
                    <button
                      className="scm-action"
                      onClick={() => void stage(c.path)}
                      title={t("stage")}
                    >
                      +
                    </button>
                  </div>
                ))}
              </div>
            )}

            {staged.length > 0 && (
              <div className="scm-section">
                <div className="scm-section-title">
                  {t("stagedChanges", { count: staged.length })}
                </div>
                {staged.map((c) => (
                  <div key={c.path} className="scm-row">
                    <span className={`scm-badge scm-${c.staged}`}>
                      {letterFor(c.staged)}
                    </span>
                    <span className="scm-path">{c.path}</span>
                    <button
                      className="scm-action"
                      onClick={() => void unstage(c.path)}
                      title={t("unstage")}
                    >
                      −
                    </button>
                  </div>
                ))}
              </div>
            )}

            {!loading && changes.length === 0 && (
              <div className="scm-status">{t("noChanges")}</div>
            )}
          </div>
        </Allotment.Pane>

        {/* Recent commits — capped so it can't swallow the whole panel; hidden
            visually (minSize 0 + collapsed) when there's no log yet, but the
            pane stays mounted so sizes don't jump when a commit lands. */}
        <Allotment.Pane
          minSize={0}
          preferredSize={140}
          maxSize={260}
          visible={recentLog.length > 0}
          snap
        >
          <div className="scm-pane scm-log">
            <div className="scm-section-title">{t("recentCommits")}</div>
            <div className="scm-log-list">
              {recentLog.map((c) => (
                <div key={c.id} className="scm-log-row">
                  <span className="scm-log-msg">{c.message}</span>
                  <span className="scm-log-author">{c.author}</span>
                </div>
              ))}
            </div>
          </div>
        </Allotment.Pane>
      </Allotment>
    </div>
  );
}

/** Single-letter badge for a status kind (mirrors `git status --short`). */
function letterFor(kind: GitStatusKind): string {
  switch (kind) {
    case "modified":
      return "M";
    case "added":
      return "A";
    case "deleted":
      return "D";
    case "untracked":
      return "U";
    case "renamed":
      return "R";
    case "type-changed":
      return "T";
    default:
      return " ";
  }
}
