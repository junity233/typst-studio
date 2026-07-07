//! Bibliography Tauri commands (Task 4) — thin adapters over
//! [`crate::domain::bib_entry`].
//!
//! Two stateless commands:
//! - [`bibliography_parse`]: read + parse a single `.bib`/`.yml`/`.yaml` file.
//! - [`bibliography_discover`]: walk the workspace root and list candidate
//!   bibliography files.
//!
//! Neither needs [`AppState`](crate::ipc::state::AppState) — they are pure file
//! IO + the hayagriva parser, so they take primitives and return
//! `Result<T, AppError>`, matching the shape of `package_dir_is_empty` /
//! `package_compiler_version`.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use tauri::async_runtime;

use crate::domain::bib_entry::{self, BibEntry, BibEntryEditable, BibFormat};
use crate::error::{AppError, Result};

/// Metadata about a discovered bibliography file. The path is absolute
/// (workspace-rooted). `entryCount` is a fast, approximate count used to show
/// the user how many references each file holds without parsing the full
/// payload (it counts top-level BibLaTeX `@` records or YAML top-level keys).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    ts(export_to = "../../src/lib/types.ts")
)]
pub struct BibFileInfo {
    /// Absolute filesystem path to the `.bib`/`.yml`/`.yaml` file.
    pub path: String,
    /// Approximate entry count (records/keys), for a quick size signal in the UI.
    /// `null` when the count could not be cheaply determined.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entry_count: Option<usize>,
}

/// Parse a bibliography file at `path` into [`BibEntry`]s. The format is sniffed
/// from the extension (`.bib` → BibLaTeX, `.yml`/`.yaml` → Hayagriva YAML) with
/// a content-heuristic fallback for unrecognized extensions.
#[tauri::command]
pub async fn bibliography_parse(path: String) -> Result<Vec<BibEntry>> {
    let p = PathBuf::from(&path);
    // File reading is blocking std::fs; run it off the async worker so a slow
    // disk never stalls the runtime. The payload is small (bib files are KBs),
    // so the spawn overhead is negligible.
    let content = async_runtime::spawn_blocking(move || {
        std::fs::read_to_string(&p)
    })
    .await
    .map_err(|e| AppError::Other(format!("bibliography_parse join: {e}")))?
    .map_err(|e| AppError::Io(e))?;

    let format = sniff_for_path(&path, &content);
    bib_entry::parse_bibliography(&content, format)
        .map_err(|e| AppError::Other(format!("{e}")))
}

/// Discover bibliography files under `rootPath` (absolute). Walks the tree with
/// the same `IGNORED_DIRS` the Explorer tree + Search view skip, capped at a
/// safe depth and file count. Returns `[]` for a closed workspace (`rootPath`
/// `None`) or an unreadable/non-directory root — the panel shows its empty state.
#[tauri::command]
pub async fn bibliography_discover(root_path: Option<String>) -> Result<Vec<BibFileInfo>> {
    let Some(root) = root_path else {
        return Ok(Vec::new());
    };
    let root = PathBuf::from(&root);
    // Walk + stat are blocking IO; move them off the async worker.
    let files = async_runtime::spawn_blocking(move || discover_sync(&root))
        .await
        .map_err(|e| AppError::Other(format!("bibliography_discover join: {e}")))??;
    Ok(files)
}

/// Parse a bibliography file at `path` into the full-field [`BibEntryEditable`]
/// form used by the edit modal. Unlike [`bibliography_parse`] (the 5-field
/// panel-list projection), this surfaces every set field so the edit form can
/// render and round-trip journal/volume/pages/url/publisher/… generically via
/// the `extra` list.
///
/// Mirrors `bibliography_parse`: stateless, format sniffed from the extension
/// (with a content fallback), file read off the async worker via
/// `spawn_blocking` so a slow disk never stalls the runtime.
#[tauri::command]
pub async fn bibliography_parse_full(path: String) -> Result<Vec<BibEntryEditable>> {
    let p = PathBuf::from(&path);
    let content = async_runtime::spawn_blocking(move || std::fs::read_to_string(&p))
        .await
        .map_err(|e| AppError::Other(format!("bibliography_parse_full join: {e}")))?
        .map_err(|e| AppError::Io(e))?;

    let format = sniff_for_path(&path, &content);
    bib_entry::parse_bibliography_editable(&content, format)
        .map_err(|e| AppError::Other(format!("{e}")))
}

/// Save a bibliography file: `content` is the full, already-serialized file
/// text (produced by the frontend from the edited `BibEntryEditable` list via
/// [`bib_entry::serialize_bibliography`], or a hand-edited buffer). Written
/// atomically via [`crate::persistence::atomic::write_bytes`] so a crash mid-write
/// never leaves a half-written file — the original is untouched on any failure.
///
/// The serialization (re-parse original → apply edits → re-serialize) is
/// expected to happen on the frontend side OR a future `bibliography_serialize`
/// command; this command is the dumb, durable write primitive. It is format-
/// agnostic: it writes the bytes verbatim regardless of `.bib`/`.yml`.
#[tauri::command]
pub async fn bibliography_save(path: String, content: String) -> Result<()> {
    let p = PathBuf::from(&path);
    // Atomic write is blocking std::fs; run it off the async worker.
    async_runtime::spawn_blocking(move || {
        crate::persistence::atomic::write_bytes(&p, content.as_bytes())
    })
    .await
    .map_err(|e| AppError::Other(format!("bibliography_save join: {e}")))?
    .map_err(|e| AppError::Other(format!("{e}")))
}

/// Save edited `BibEntryEditable` entries back to `path`, preserving untouched
/// entries and untouched fields. This is the save path the edit modal uses: the
/// frontend sends the FULL edited entry list, and this command:
///   1. re-reads the original file text (needed for the fidelity-preserving
///      re-parse-and-patch strategy in [`bib_entry::serialize_bibliography`] —
///      the frontend has neither the original text nor the hayagriva/biblatex
///      crates, so serialization MUST happen in Rust),
///   2. sniffs the format from the extension (same logic as `bibliography_parse`),
///   3. serializes the edited entries onto the original,
///   4. writes the result atomically via [`crate::persistence::atomic::write_bytes`].
///
/// All four steps run off the async worker via `spawn_blocking` (they are
/// blocking std::fs + CPU parse/serialize on small files). On any failure the
/// original file is untouched (atomic write) and the error surfaces to the
/// caller, which leaves its in-memory list unchanged.
#[tauri::command]
pub async fn bibliography_save_entries(
    path: String,
    entries: Vec<BibEntryEditable>,
) -> Result<()> {
    let p = PathBuf::from(&path);
    async_runtime::spawn_blocking(move || -> Result<()> {
        // 1. Re-read the original (fidelity strategy needs the source text).
        let original = std::fs::read_to_string(&p).map_err(AppError::Io)?;
        // 2. Sniff the format from the path + content (same logic as parse).
        let format = sniff_for_path(&path, &original);
        // 3. Serialize: re-parse the original, apply the edits, re-emit.
        let serialized = bib_entry::serialize_bibliography(&original, format, &entries)
            .map_err(|e| AppError::Other(format!("{e}")))?;
        // 4. Atomic write — the original survives any failure here.
        crate::persistence::atomic::write_bytes(&p, serialized.as_bytes())
            .map_err(|e| AppError::Other(format!("{e}")))
    })
    .await
    .map_err(|e| AppError::Other(format!("bibliography_save_entries join: {e}")))?
}

/// Synchronous discovery: walk `root`, collect `.bib`/`.yml`/`.yaml` files,
/// skip the usual ignore dirs, cap depth + count.
fn discover_sync(root: &Path) -> Result<Vec<BibFileInfo>> {
    if !root.is_dir() {
        // A non-directory root yields no results (the panel shows the empty
        // state) rather than an error — discovery is best-effort.
        return Ok(Vec::new());
    }

    let ignored: HashSet<&'static str> = crate::fs::tree::IGNORED_DIRS
        .iter()
        .copied()
        .collect();

    const MAX_DEPTH: usize = 5;
    const MAX_FILES: usize = 100;

    let mut out: Vec<BibFileInfo> = Vec::new();
    for entry in walkdir::WalkDir::new(root)
        .follow_links(false)
        .max_depth(MAX_DEPTH)
        .into_iter()
        .filter_entry(|e| {
            if e.file_type().is_dir() {
                let name = e.file_name();
                // Skip the standard ignore dirs AND any hidden dir (leading dot)
                // so we don't descend into `.git`, `.cache`, etc.
                let s = name.to_string_lossy();
                if ignored.contains(s.as_ref()) || s.starts_with('.') {
                    return false;
                }
            }
            true
        })
    {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        let Some(ext) = path.extension().and_then(|e| e.to_str()) else {
            continue;
        };
        if !matches!(
            ext.to_ascii_lowercase().as_str(),
            "bib" | "yaml" | "yml"
        ) {
            continue;
        }
        if out.len() >= MAX_FILES {
            break;
        }
        // Best-effort entry count: read the file (it's small) and count records.
        // A read failure degrades to `entry_count: None` rather than dropping
        // the file from the list — the user can still select it and hit the real
        // parse error via `bibliography_parse`.
        let entry_count = std::fs::read_to_string(path)
            .ok()
            .map(|c| count_entries(&c, ext));
        out.push(BibFileInfo {
            path: path.to_string_lossy().to_string(),
            entry_count,
        });
    }
    Ok(out)
}

/// Cheap entry count for the discover list, without a full hayagriva parse.
/// For BibLaTeX, counts `@type{` records; for YAML, counts non-empty,
/// non-indented top-level keys. Returns 0 for empty/ambiguous content.
fn count_entries(content: &str, ext: &str) -> usize {
    match ext.to_ascii_lowercase().as_str() {
        "bib" => content
            .lines()
            .filter(|l| {
                let t = l.trim_start();
                t.starts_with('@') && t.contains('{')
            })
            .count(),
        _ => content
            .lines()
            // A top-level YAML bibliography key is a non-indented line ending
            // in `:`. Skip comments and document markers (`---`).
            .filter(|l| {
                let t = l.trim_end();
                !l.starts_with(' ')
                    && !l.starts_with('\t')
                    && !l.starts_with('#')
                    && !t.starts_with("---")
                    && !t.starts_with("...")
                    && t.ends_with(':')
            })
            .count(),
    }
}

/// Resolve the [`BibFormat`] for a path, sniffing the extension first and
/// falling back to content. Unknown extension + ambiguous content defaults to
/// BibLaTeX (the more common format in Typst workflows) via the heuristic.
fn sniff_for_path(path: &str, content: &str) -> BibFormat {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");
    bib_entry::sniff_format(ext, content).unwrap_or(BibFormat::BibLatex)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(feature = "export-types")]
    fn export_types() {
        use ts_rs::TS;
        let cfg = ts_rs::Config::default();
        BibFileInfo::export(&cfg).unwrap();
    }

    #[test]
    fn count_entries_biblatex_counts_at_records() {
        let bib = "@article{a,\n title={T}\n}\n\n@book{b,\n title={U}\n}\n";
        assert_eq!(count_entries(bib, "bib"), 2);
    }

    #[test]
    fn count_entries_yaml_counts_top_level_keys() {
        let yaml = "a:\n  type: Article\nb:\n  type: Book\n# comment\n";
        assert_eq!(count_entries(yaml, "yaml"), 2);
    }

    #[test]
    fn sniff_for_path_uses_extension() {
        assert_eq!(sniff_for_path("refs.bib", "anything"), BibFormat::BibLatex);
        assert_eq!(
            sniff_for_path("refs.yaml", "anything"),
            BibFormat::HayagrivaYaml
        );
    }

    #[test]
    fn sniff_for_path_unknown_ext_uses_content() {
        assert_eq!(
            sniff_for_path("refs.txt", "@article{x, title={T}}"),
            BibFormat::BibLatex
        );
        assert_eq!(
            sniff_for_path("refs.txt", "key:\n  type: Article"),
            BibFormat::HayagrivaYaml
        );
    }
}
