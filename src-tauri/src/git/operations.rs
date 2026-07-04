//! Git mutation + history operations (§Source Control).
//!
//! # Status of each operation in this build
//!
//! - `log` — fully implemented (read-only walk of HEAD's first-parent chain).
//! - `stage` / `unstage` / `commit` — **stubbed**. gix 0.85 exposes no
//!   high-level `index.stage()` helper and no `index.write_tree()` convenience;
//!   correct staging requires hashing blobs, mutating the in-memory index, and
//!   (for commit) recursively building tree objects via `gix_object::TreeEditor`.
//!   Rather than ship a subtly-wrong implementation, these return a clear
//!   `Err(anyhow!(...))` so the panel degrades gracefully (the buttons surface
//!   the message) instead of corrupting the user's index. Status + log fully
//!   cover the read-only Source Control experience.
//!
//! All functions re-discover the repo from `root` (the workspace path) on every
//! call — `gix::Repository` is `Send` but not `Sync`.

use crate::domain::git_status::CommitLog;
use anyhow::{Context, Result};
use std::path::Path;

/// The message returned by the not-yet-wired mutation commands. Surfaced to the
/// UI as the command's error string (the panel shows it inline).
const NOT_WIRED: &str = "this git operation is not yet wired to the gix 0.85 \
     index/tree API in this build (status and log are available)";

/// Stage a single file (`git add <path>`).
pub fn stage(_root: &Path, _path: &str) -> Result<()> {
    // TODO(gix): hash the worktree blob, upsert/replace the index entry, write
    // the index back. Requires gix_index entry construction + stat; deferred.
    Err(anyhow::anyhow!("git stage: {NOT_WIRED}"))
}

/// Unstage a single file (`git reset HEAD <path>`).
pub fn unstage(_root: &Path, _path: &str) -> Result<()> {
    // TODO(gix): reset the index entry to its HEAD-tree state. Deferred.
    Err(anyhow::anyhow!("git unstage: {NOT_WIRED}"))
}

/// Create a commit with `message` on the current branch (`git commit -m`).
///
/// Returns the new commit's full hex id on success.
pub fn commit(_root: &Path, _message: &str) -> Result<String> {
    // TODO(gix): build the tree from the index (no `write_tree` helper in 0.85 —
    // requires TreeEditor over grouped index entries), then
    // `repo.commit("HEAD", message, tree_id, [head_commit_id])`. Deferred.
    Err(anyhow::anyhow!("git commit: {NOT_WIRED}"))
}

/// Walk HEAD's first-parent chain and return up to `limit` recent commits.
///
/// Returns `Ok(vec![])` for a repo with no commits (unborn HEAD).
pub fn log(root: &Path, limit: usize) -> Result<Vec<CommitLog>> {
    let repo = gix::discover(root).context("not a git repository")?;

    // Resolve HEAD to a commit id. An unborn branch (no commits yet) yields an
    // empty log rather than an error.
    let head_id = match repo.head_commit() {
        Ok(c) => c.id,
        Err(_) => return Ok(Vec::new()),
    };

    let walk = repo
        .rev_walk(Some(head_id))
        .first_parent_only()
        .all()
        .context("start revision walk")?;

    let mut out = Vec::with_capacity(limit.min(64));
    for info_result in walk {
        let info = info_result.context("revision walk item")?;
        let commit = info.object().context("read commit object")?;
        // Author as "Name <email>". Both fields are `&BStr`; trim whitespace
        // defensively (gix preserves it verbatim).
        let author_ref = commit.author().context("decode author")?;
        use gix::bstr::ByteSlice as _;
        let name = author_ref.name.to_str().unwrap_or("").trim();
        let email = author_ref.email.to_str().unwrap_or("").trim();
        let author = if email.is_empty() {
            name.to_string()
        } else {
            format!("{name} <{email}>")
        };

        // Summary = first line of the message.
        let message = commit
            .message()
            .ok()
            .map(|m| {
                m.title
                    .to_str()
                    .map(|s| s.trim().to_string())
                    .unwrap_or_default()
            })
            .unwrap_or_default();

        // Committer time as unix seconds.
        let time = commit.time().map(|t| t.seconds).unwrap_or(0);

        out.push(CommitLog {
            id: info.id.to_hex().to_string(),
            message,
            author,
            time,
        });
        if out.len() >= limit {
            break;
        }
    }

    Ok(out)
}
