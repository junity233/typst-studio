import { useEffect, useState } from "react";
import { useGitStore } from "../../store/gitStore";
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
    void refresh();
  }, [refresh]);

  if (!isRepo && !loading) {
    return (
      <div className="scm-empty">
        <p>Not a git repository.</p>
        <p className="scm-hint">
          Open a folder containing a .git directory to enable source control.
        </p>
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
      <div className="scm-commit-box">
        <textarea
          className="scm-message"
          placeholder="Message (Ctrl+Enter to commit)"
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
            Commit
          </button>
          <button
            className="scm-refresh"
            onClick={() => void refresh()}
            title="Refresh"
          >
            ⟳
          </button>
        </div>
      </div>

      {error && <div className="scm-error">{error}</div>}

      <div className="scm-changes">
        {loading && <div className="scm-status">Loading…</div>}

        {unstaged.length > 0 && (
          <div className="scm-section">
            <div className="scm-section-title">Changes ({unstaged.length})</div>
            {unstaged.map((c) => (
              <div key={c.path} className="scm-row">
                <span className={`scm-badge scm-${c.unstaged}`}>
                  {letterFor(c.unstaged)}
                </span>
                <span className="scm-path">{c.path}</span>
                <button
                  className="scm-action"
                  onClick={() => void stage(c.path)}
                  title="Stage"
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
              Staged Changes ({staged.length})
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
                  title="Unstage"
                >
                  −
                </button>
              </div>
            ))}
          </div>
        )}

        {!loading && changes.length === 0 && (
          <div className="scm-status">No changes</div>
        )}
      </div>

      {recentLog.length > 0 && (
        <div className="scm-log">
          <div className="scm-section-title">Recent Commits</div>
          {recentLog.map((c) => (
            <div key={c.id} className="scm-log-row">
              <span className="scm-log-msg">{c.message}</span>
              <span className="scm-log-author">{c.author}</span>
            </div>
          ))}
        </div>
      )}
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
