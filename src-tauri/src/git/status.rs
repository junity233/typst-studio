//! Workspace git status collection (§Source Control).
//!
//! # Verified gix 0.85 status API
//!
//! The mapping below is written against the actual gix 0.85 source
//! (`~/.cargo/registry/.../gix-0.85.0/src/status/`). The key shapes:
//!
//! `Repository::status(progress) -> Platform` — takes a progress impl
//! (`gix::progress::Discard` discards). Then `Platform::into_iter(patterns)`
//! takes `impl IntoIterator<Item = BString>` (pass an empty vec to consider all
//! paths) and returns a `status::Iter` yielding `Result<status::Item, _>`.
//!
//! ```ignore
//! pub enum Item {
//!     IndexWorktree(index_worktree::Item),
//!     TreeIndex(gix_diff::index::Change),   // == ChangeRef<'static,'static>
//! }
//! ```
//!
//! `gix_diff::index::Change` (= `ChangeRef<'static, 'static>`) variants are
//! **`Addition`, `Deletion`, `Modification`, `Rewrite`** (NOT `Add`/`Delete`).
//! `.location() -> &BStr` gives the repo-relative path.
//!
//! `index_worktree::Item` variants:
//! - `Modification { rela_path, status: EntryStatus, .. }` — tracked file changed
//! - `DirectoryContents { entry: gix_dir::Entry, .. }` — dirwalk hit (untracked/ignored)
//! - `Rewrite { dirwalk_entry, copy, .. }` — rename/copy detected
//!
//! `.rela_path() -> &BStr` works on every variant. `EntryStatus` variants:
//! `Conflict`, `Change(Change)`, `NeedsUpdate`, `IntentToAdd`. The inner
//! `gix_status::index_as_worktree::Change` has `Removed`, `Type`, `Modification`,
//! `SubmoduleModification`. `gix_dir::entry::Status` has `Pruned`, `Tracked`,
//! `Ignored`, `Untracked`.

use crate::domain::git_status::{GitFileStatus, GitStatusKind};
use anyhow::{Context, Result};
use std::collections::HashMap;
use std::path::Path;

/// Collect workspace git status. Returns `Ok(None)` when `root` is not inside
/// a git repository (the UI shows a friendly empty state — never an error).
pub fn collect_status(root: &Path) -> Result<Option<Vec<GitFileStatus>>> {
    let repo = match gix::discover(root) {
        Ok(r) => r,
        Err(_) => return Ok(None),
    };

    // path → entry. The same path can appear in both a TreeIndex (staged) and an
    // IndexWorktree (unstaged) item, so we upsert and fill each side separately.
    let mut by_path: HashMap<String, GitFileStatus> = HashMap::new();

    let platform = repo
        .status(gix::progress::Discard)
        .context("build status platform")?;
    // Empty pattern vec == consider every path (matches `git status` with no pathspec).
    let iter = platform
        .into_iter(Vec::<gix::bstr::BString>::new())
        .context("start status iteration")?;

    for item_result in iter {
        let item = item_result.context("status item")?;
        match item {
            // head↔index (staged). `Change` is `ChangeRef<'static,'static>`.
            gix::status::Item::TreeIndex(change) => {
                let path = bstr_to_string(change.location());
                let kind = match change {
                    gix::diff::index::Change::Addition { .. } => GitStatusKind::Added,
                    gix::diff::index::Change::Deletion { .. } => GitStatusKind::Deleted,
                    gix::diff::index::Change::Modification { .. } => GitStatusKind::Modified,
                    // Rewrite collapses a delete+add into a rename/copy.
                    gix::diff::index::Change::Rewrite { .. } => GitStatusKind::Renamed,
                };
                upsert(&mut by_path, path).staged = kind;
            }

            // index↔worktree (unstaged).
            gix::status::Item::IndexWorktree(wi) => {
                use gix::status::index_worktree::Item as WItem;
                match wi {
                    WItem::Modification { ref status, .. } => {
                        // `rela_path()` is available on every IndexWorktree item.
                        let path = bstr_to_string(wi.rela_path());
                        let kind = entry_status_to_kind(status);
                        upsert(&mut by_path, path).unstaged = kind;
                    }
                    WItem::DirectoryContents { entry, .. } => {
                        // Only untracked entries surface as user-visible changes here;
                        // ignored/pruned/tracked dirwalk hits carry no actionable status.
                        if matches!(entry.status, gix::dir::entry::Status::Untracked) {
                            let path = bstr_to_string(&entry.rela_path);
                            upsert(&mut by_path, path).unstaged = GitStatusKind::Untracked;
                        }
                    }
                    WItem::Rewrite {
                        dirwalk_entry,
                        copy,
                        ..
                    } => {
                        // A rewrite on the worktree side is a rename (or copy) the user
                        // has not staged yet.
                        let path = bstr_to_string(&dirwalk_entry.rela_path);
                        upsert(&mut by_path, path).unstaged = if copy {
                            GitStatusKind::Added
                        } else {
                            GitStatusKind::Renamed
                        };
                    }
                }
            }
        }
    }

    Ok(Some(by_path.into_values().collect()))
}

/// Map an index↔worktree `EntryStatus` to our wire enum.
fn entry_status_to_kind(
    status: &gix::status::plumbing::index_as_worktree::EntryStatus<(), gix::submodule::Status>,
) -> GitStatusKind {
    use gix::status::plumbing::index_as_worktree::{Change as WChange, EntryStatus};
    match status {
        // An intent-to-add entry behaves like an untracked file in `git status`
        // (shown as `??`/`A`), so surface it as Untracked to the UI.
        EntryStatus::IntentToAdd => GitStatusKind::Untracked,
        EntryStatus::Conflict { .. } => GitStatusKind::Modified,
        EntryStatus::NeedsUpdate(_) => GitStatusKind::Unchanged,
        EntryStatus::Change(change) => match change {
            WChange::Removed => GitStatusKind::Deleted,
            WChange::Type { .. } => GitStatusKind::TypeChanged,
            WChange::Modification { .. } | WChange::SubmoduleModification(_) => {
                GitStatusKind::Modified
            }
        },
    }
}

/// Insert a default entry for `path` if absent and return a `&mut` to it.
/// The entry's `path` field is kept in sync with the map key.
fn upsert<'a>(
    map: &'a mut HashMap<String, GitFileStatus>,
    path: String,
) -> &'a mut GitFileStatus {
    map.entry(path.clone()).or_insert(GitFileStatus {
        path,
        staged: GitStatusKind::Unchanged,
        unstaged: GitStatusKind::Unchanged,
    })
}

/// Convert a gix repo-relative path (bytes) to an owned, forward-slash
/// `String`. gix paths are already forward-slash on every platform, but we
/// normalize defensively.
fn bstr_to_string(bytes: &[u8]) -> String {
    use gix::bstr::ByteSlice as _;
    bytes
        .to_str()
        .map(|s| s.replace('\\', "/"))
        .unwrap_or_default()
}
