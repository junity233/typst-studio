//! Domain types for the Source Control view (§Source Control).
//!
//! Pure data models — no IO. Wire format mirrors `git status --porcelain`:
//! each file carries a *staged* (head↔index) and an *unstaged* (index↔worktree)
//! classification.

use serde::{Deserialize, Serialize};

/// Classification of one side (staged or unstaged) of a file's git status.
///
/// Serialized as kebab-case to match the Rust enum's
/// `#[serde(rename_all = "kebab-case")]` (e.g. `"type-changed"`).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    ts(export_to = "../../src/lib/types.ts")
)]
pub enum GitStatusKind {
    /// No change on this side (the default/zero value).
    #[default]
    Unchanged,
    /// Content differs from the comparison baseline.
    Modified,
    /// Newly tracked (staged add, or untracked on the worktree side).
    Added,
    /// Removed relative to the baseline.
    Deleted,
    /// Present in the worktree but not tracked by git (worktree side only).
    Untracked,
    /// Renamed or copied (with rewrite tracking enabled).
    Renamed,
    /// The filesystem entry type changed (e.g. file ↔ symlink).
    TypeChanged,
}

/// One file's git status (§Source Control). `staged` is head↔index, `unstaged`
/// is index↔worktree (matching `git status --porcelain` XY format).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    ts(export_to = "../../src/lib/types.ts")
)]
pub struct GitFileStatus {
    /// Path relative to the workspace root (forward-slash separators).
    pub path: String,
    /// head↔index classification (the `X` of `git status --porcelain`).
    pub staged: GitStatusKind,
    /// index↔worktree classification (the `Y` of `git status --porcelain`).
    pub unstaged: GitStatusKind,
}

/// One commit in the recent log (§Source Control).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    ts(export_to = "../../src/lib/types.ts")
)]
pub struct CommitLog {
    /// Commit hash (full 40-char hex; the frontend shortens for display).
    pub id: String,
    /// Commit summary (first line / title).
    pub message: String,
    /// Author name + email formatted as `"Name <email>"`.
    pub author: String,
    /// Committer time as a Unix timestamp (seconds).
    pub time: i64,
}
