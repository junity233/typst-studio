//! Bibliography entry model + native parsing (Task 4 — Bibliography panel).
//!
//! Parses `.bib` (BibLaTeX) and `.yml`/`.yaml` (Hayagriva YAML) bibliography
//! files into a flat list of [`BibEntry`] payloads using the `hayagriva` crate,
//! which is already a transitive dependency of `typst-library` (declaring it
//! directly here dedupes to the same 0.10.x — no new code compiled).
//!
//! This module is pure (no IO): it takes already-read text + a [`BibFormat`]
//! and returns entries. The IPC layer ([`crate::ipc::bib_commands`]) handles
//! file reading + workspace discovery.
//!
//! Field extraction strategy: the typed getters are used for `key`, `title`,
//! `authors`, and `year` — they avoid the fragility of serde-derived Display
//! impls while giving clean output:
//! - `key`: `Entry::key()` returns `&str` (the field is `#[serde(skip)]`, so it
//!   is NOT reachable via `serde_json::to_value`).
//! - `entry_type`: `EntryType` does not impl `Display`, but it serializes to its
//!   kebab-case name (`#[serde(rename_all = "kebab-case")]`), so we round-trip
//!   it through `serde_json::to_value` → `.as_str()`.
//! - `title`: `FormatString` impl `Display` (the full formatted title).
//! - `authors`: `Person::given_first(false)` yields "Given Family" (the natural
//!   reading order for a reference list). `name_first` would emit "Family, Given".
//! - `year`: `Date.year` is a public `i32` field.

use thiserror::Error;

/// The bibliography file format. Sniffed from the extension by the caller, with
/// a content-heuristic fallback in [`sniff_format`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BibFormat {
    /// BibLaTeX (`.bib`) — `@type{key, field = value, …}` records.
    BibLatex,
    /// Hayagriva YAML (`.yml`/`.yaml`) — `key: {type: …, …}` map.
    HayagrivaYaml,
}

/// One bibliography entry surfaced to the Bibliography panel. CamelCase on the
/// wire to match the frontend TS interface (`{ key, entryType, title?, authors, year? }`).
#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BibEntry {
    /// The citation key — what goes inside `#cite(<key>)`.
    pub key: String,
    /// The entry type as a kebab-case string (e.g. "article", "book").
    pub entry_type: String,
    /// The full formatted title, if present.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Author display names ("Given Family"), in order. Empty when absent.
    #[serde(default)]
    pub authors: Vec<String>,
    /// The 4-digit publication year, if a date is present.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub year: Option<i32>,
}

/// Errors raised by [`parse_bibliography`]. The IPC layer maps these into
/// [`AppError`](crate::error::AppError).
#[derive(Debug, Error)]
pub enum BibParseError {
    /// BibLaTeX (`.bib`) parse failure. Carries the joined error messages — the
    /// `hayagriva` BibLaTeX parser returns a `Vec<BibLaTeXError>` (often several
    /// for one malformed file), so we flatten them for a single user-facing line.
    #[error("failed to parse BibLaTeX: {0}")]
    BibLatex(String),

    /// Hayagriva YAML (`.yml`/`.yaml`) parse failure.
    #[error("failed to parse Hayagriva YAML: {0}")]
    Yaml(String),

    /// `serde_json` round-trip failed while extracting `entry_type`. Should be
    /// unreachable in practice (EntryType always serializes), but we keep the
    /// branch total rather than `unwrap`-ing.
    #[error("internal: entry-type serialization failed: {0}")]
    Json(String),
}

/// Parse bibliography `content` (already-read file text) into [`BibEntry`]s.
///
/// `format` selects the parser; use [`sniff_format`] to derive it from a
/// filename when the caller does not know it up front.
pub fn parse_bibliography(
    content: &str,
    format: BibFormat,
) -> Result<Vec<BibEntry>, BibParseError> {
    let library = match format {
        BibFormat::BibLatex => hayagriva::io::from_biblatex_str(content)
            .map_err(|errs| BibParseError::BibLatex(errs.into_iter().map(|e| e.to_string()).collect::<Vec<_>>().join("; ")))?,
        BibFormat::HayagrivaYaml => hayagriva::io::from_yaml_str(content)
            .map_err(|e| BibParseError::Yaml(e.to_string()))?,
    };

    Ok(library.iter().map(entry_to_bib).collect::<Result<_, _>>()?)
}

/// Convert a single `hayagriva::Entry` into a [`BibEntry`].
fn entry_to_bib(entry: &hayagriva::Entry) -> Result<BibEntry, BibParseError> {
    // `entry_type` does not impl Display, but serializes to its kebab-case name.
    let entry_type = serde_json::to_value(entry.entry_type())
        .map_err(|e| BibParseError::Json(e.to_string()))?
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| "misc".to_string());

    let title = entry.title().map(|t| t.to_string());

    let authors = entry
        .authors()
        .map(|persons| {
            persons
                .iter()
                .map(|p| p.given_first(false))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let year = entry.date_any().map(|d| d.year);

    Ok(BibEntry {
        key: entry.key().to_string(),
        entry_type,
        title,
        authors,
        year,
    })
}

/// Sniff the format from a file extension, falling back to a content heuristic
/// mirroring typst-library's `bibliography.rs` decode logic. The heuristic
/// counts BibLaTeX record openings (`{`) vs. YAML mapping markers (`:` at line
/// starts / `- ` list dashes): BibLaTeX files are brace-heavy, YAML files are
/// not.
///
/// Returns `None` when the extension is unrecognized AND the content is
/// ambiguous/empty — the caller treats this as "not a bibliography file".
pub fn sniff_format(extension: &str, content: &str) -> Option<BibFormat> {
    let ext = extension.trim_start_matches('.').to_ascii_lowercase();
    match ext.as_str() {
        "bib" => Some(BibFormat::BibLatex),
        "yaml" | "yml" => Some(BibFormat::HayagrivaYaml),
        _ => sniff_from_content(content),
    }
}

/// Content-only heuristic: a BibLaTeX file has at least one `@`-record with a
/// `{`, while YAML bibliography uses a top-level `key:` mapping. This mirrors
/// typst-library's fallback (prefer BibLaTeX when brace-heavy, else YAML).
fn sniff_from_content(content: &str) -> Option<BibFormat> {
    let braces = content.matches('{').count();
    // A YAML bibliography is a map of `key: {...}`; it still contains braces
    // (one pair per entry), but BibLaTeX has many more (one per field). Use the
    // presence of an `@type{` record as a strong BibLaTeX signal; otherwise
    // default to YAML for anything map-shaped.
    let has_at_record = content.lines().any(|line| {
        let t = line.trim_start();
        t.starts_with('@') && t.contains('{')
    });
    if has_at_record && braces > 0 {
        Some(BibFormat::BibLatex)
    } else if content.contains(':') {
        Some(BibFormat::HayagrivaYaml)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Two-entry BibLaTeX fixture covering the common fields we extract.
    const BIB_FIXTURE: &str = r#"
@article{einstein1905,
  author = {Albert Einstein},
  title = {On the Electrodynamics of Moving Bodies},
  year = {1905}
}

@book{knuth1984,
  author = {Donald E. Knuth},
  title = {The TeXbook},
  year = {1984}
}
"#;

    /// Minimal Hayagriva YAML fixture (two entries).
    const YAML_FIXTURE: &str = r#"
einstein1905:
  type: Article
  title: On the Electrodynamics of Moving Bodies
  author:
    - Albert Einstein
  date: 1905
knuth1984:
  type: Book
  title: The TeXbook
  author: Donald E. Knuth
  date: 1984
"#;

    #[test]
    fn parses_biblatex_entries() {
        let entries = parse_bibliography(BIB_FIXTURE, BibFormat::BibLatex).expect("bib parses");
        assert_eq!(entries.len(), 2, "expected 2 entries, got {entries:?}");

        let einstein = entries
            .iter()
            .find(|e| e.key == "einstein1905")
            .expect("einstein1905 entry present");
        assert_eq!(einstein.entry_type, "article");
        assert_eq!(
            einstein.title.as_deref(),
            Some("On the Electrodynamics of Moving Bodies")
        );
        assert_eq!(einstein.authors, vec!["Albert Einstein".to_string()]);
        assert_eq!(einstein.year, Some(1905));

        let knuth = entries
            .iter()
            .find(|e| e.key == "knuth1984")
            .expect("knuth1984 entry present");
        assert_eq!(knuth.entry_type, "book");
        assert_eq!(knuth.year, Some(1984));
    }

    #[test]
    fn parses_hayagriva_yaml_entries() {
        let entries =
            parse_bibliography(YAML_FIXTURE, BibFormat::HayagrivaYaml).expect("yaml parses");
        assert_eq!(entries.len(), 2, "expected 2 entries, got {entries:?}");

        let einstein = entries
            .iter()
            .find(|e| e.key == "einstein1905")
            .expect("einstein1905 entry present");
        assert_eq!(einstein.entry_type, "article");
        assert_eq!(
            einstein.title.as_deref(),
            Some("On the Electrodynamics of Moving Bodies")
        );
        assert_eq!(einstein.authors, vec!["Albert Einstein".to_string()]);
        assert_eq!(einstein.year, Some(1905));
    }

    #[test]
    fn biblatex_parse_error_is_typed() {
        let bad = "@article{bad, title = {Unclosed";
        let err = parse_bibliography(bad, BibFormat::BibLatex).unwrap_err();
        assert!(matches!(err, BibParseError::BibLatex(_)), "got {err:?}");
    }

    #[test]
    fn yaml_parse_error_is_typed() {
        let bad = "this: is: not: valid: yaml: {";
        let err = parse_bibliography(bad, BibFormat::HayagrivaYaml).unwrap_err();
        assert!(matches!(err, BibParseError::Yaml(_)), "got {err:?}");
    }

    #[test]
    fn sniff_format_by_extension() {
        assert_eq!(sniff_format("bib", ""), Some(BibFormat::BibLatex));
        assert_eq!(sniff_format(".BIB", ""), Some(BibFormat::BibLatex));
        assert_eq!(sniff_format("yml", ""), Some(BibFormat::HayagrivaYaml));
        assert_eq!(sniff_format("yaml", ""), Some(BibFormat::HayagrivaYaml));
    }

    #[test]
    fn sniff_format_falls_back_to_content() {
        assert_eq!(
            sniff_format("txt", "@article{x, title={T}}"),
            Some(BibFormat::BibLatex)
        );
        assert_eq!(
            sniff_format("txt", "key:\n  type: Article"),
            Some(BibFormat::HayagrivaYaml)
        );
        assert_eq!(sniff_format("txt", "no markers here"), None);
    }

    #[test]
    fn entries_serialize_camel_case() {
        let entries = parse_bibliography(BIB_FIXTURE, BibFormat::BibLatex).unwrap();
        let json = serde_json::to_value(&entries).unwrap();
        let first = json.as_array().unwrap()[0].as_object().unwrap();
        assert!(first.contains_key("entryType"));
        assert!(first.contains_key("key"));
        assert!(first.contains_key("title"));
        assert!(first.contains_key("authors"));
        assert!(first.contains_key("year"));
    }
}
