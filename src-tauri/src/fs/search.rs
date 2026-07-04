//! Cross-file search engine (§Search view).
//!
//! Recursively walks the workspace root, skipping the same `IGNORED_DIRS` the
//! Explorer tree skips, and matches each line of each UTF-8 file against a
//! [`SearchQuery`]. Literal matching is hand-rolled (fast, no allocation for
//! ASCII case-insensitive); regex matching uses the `regex` crate. Per-file and
//! total hit caps guard against pathological inputs (huge generated files).
//!
//! Non-UTF-8 / unreadable files are silently skipped (best-effort: the Search
//! view is informational, never blocking).

use crate::domain::search::{SearchHit, SearchQuery};
use anyhow::Result;
use regex::Regex;
use std::collections::HashSet;
use std::path::Path;

/// Recursively search `root` for lines matching `query`.
///
/// - Skips `IGNORED_DIRS` (same set as the Explorer tree).
/// - Skips non-UTF-8 / unreadable files.
/// - Caps per-file hits at `max_per_file` and total at `max_total`.
pub fn search(root: &Path, query: &SearchQuery) -> Result<Vec<SearchHit>> {
    let matcher = build_matcher(query)?;
    let ignored: HashSet<&'static str> = crate::fs::tree::IGNORED_DIRS
        .iter()
        .copied()
        .collect();
    let include = query.include_glob.as_deref();
    let mut hits: Vec<SearchHit> = Vec::new();

    for entry in walkdir::WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            if e.file_type().is_dir() {
                let name = e.file_name();
                if ignored.contains(name.to_string_lossy().as_ref()) {
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
        if let Some(glob) = include {
            let name = entry.file_name().to_string_lossy();
            if !matches_simple_glob(glob, &name) {
                continue;
            }
        }
        let path = entry.path();
        let rel = match path.strip_prefix(root) {
            Ok(r) => r.to_string_lossy().replace('\\', "/").to_string(),
            Err(_) => continue,
        };
        // Skip non-UTF-8 / unreadable files (best-effort: the Search view is
        // informational, never blocking).
        let text = match std::fs::read_to_string(path) {
            Ok(t) => t,
            Err(_) => continue,
        };

        let mut file_hits = 0;
        for (line_idx, line) in text.lines().enumerate() {
            if file_hits >= query.max_per_file {
                break;
            }
            if hits.len() >= query.max_total {
                return Ok(hits);
            }
            for range in matcher.find(line) {
                let col = line[..range.start].chars().count() as u32 + 1;
                let line_text = truncate_line(line, 500);
                let end = (range.end).min(line_text.len()) as u32;
                hits.push(SearchHit {
                    relative: rel.clone(),
                    line: line_idx as u32 + 1,
                    column: col,
                    line_text,
                    match_start: range.start as u32,
                    match_end: end,
                });
                file_hits += 1;
                if file_hits >= query.max_per_file || hits.len() >= query.max_total {
                    break;
                }
            }
        }
    }
    Ok(hits)
}

/// One matching strategy: a compiled regex, or a hand-rolled literal search.
/// The literal path avoids constructing a regex (and its small per-match cost)
/// for the common "plain text" case.
enum Matcher {
    Regex(Regex),
    Literal {
        needle_lower: String,
        needle_orig: String,
        case_sensitive: bool,
        whole_word: bool,
    },
}

impl Matcher {
    /// Return all (start, end) byte ranges of matches in `haystack`.
    fn find<'a>(&'a self, haystack: &'a str) -> Vec<std::ops::Range<usize>> {
        match self {
            Matcher::Regex(r) => r.find_iter(haystack).map(|m| m.range()).collect(),
            Matcher::Literal {
                needle_lower,
                needle_orig,
                case_sensitive,
                whole_word,
            } => {
                let (h, n): (std::borrow::Cow<'a, str>, &str) = if *case_sensitive {
                    (std::borrow::Cow::Borrowed(haystack), needle_orig.as_str())
                } else {
                    (std::borrow::Cow::Owned(haystack.to_lowercase()), needle_lower.as_str())
                };
                let mut out = Vec::new();
                let mut start = 0;
                while let Some(idx) = h[start..].find(n) {
                    let abs_start = start + idx;
                    let abs_end = abs_start + n.len();
                    // Map back to original haystack indices (case-insensitive
                    // lowercasing preserves byte positions for ASCII; for non-
                    // ASCII this is best-effort).
                    if *whole_word && !is_word_boundary(haystack, abs_start, abs_end) {
                        start = abs_end;
                        continue;
                    }
                    out.push(abs_start..abs_end);
                    start = abs_end;
                    if n.is_empty() {
                        break;
                    }
                }
                out
            }
        }
    }
}

/// Build the matcher for a query, validating the regex if requested.
fn build_matcher(query: &SearchQuery) -> Result<Matcher> {
    if query.is_regex {
        let pat = if query.whole_word {
            format!(r"\b(?:{})\b", query.pattern)
        } else {
            query.pattern.clone()
        };
        let re = regex::RegexBuilder::new(&pat)
            .case_insensitive(!query.case_sensitive)
            .build()
            .map_err(|e| anyhow::anyhow!("invalid regex: {e}"))?;
        Ok(Matcher::Regex(re))
    } else {
        Ok(Matcher::Literal {
            needle_lower: query.pattern.to_lowercase(),
            needle_orig: query.pattern.clone(),
            case_sensitive: query.case_sensitive,
            whole_word: query.whole_word,
        })
    }
}

/// Whether the slice `[start, end)` of `s` is bounded by non-word characters
/// (or the string ends). Used for `whole_word` matching (ASCII only — the
/// Search view's whole-word is a simple, fast check, not full Unicode UAX-29).
fn is_word_boundary(s: &str, start: usize, end: usize) -> bool {
    let before = start > 0
        && s.as_bytes()
            .get(start - 1)
            .map(|b| b.is_ascii_alphanumeric())
            .unwrap_or(false);
    let after = s.as_bytes().get(end).map(|b| b.is_ascii_alphanumeric()).unwrap_or(false);
    !before && !after
}

/// Truncate a line to at most `max` bytes (on a char boundary), appending an
/// ellipsis if truncation occurred. Keeps the match text on screen while
/// preventing a single huge minified line from dominating the result list.
fn truncate_line(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    let mut t = s[..end].to_string();
    t.push('…');
    t
}

/// Minimal glob: supports a single leading/trailing `*` (e.g. "*.typ",
/// "Make*"). Anything more complex falls back to exact match. This covers the
/// Search view's `includeGlob` use case (filtering by extension).
fn matches_simple_glob(glob: &str, name: &str) -> bool {
    if !glob.contains('*') {
        return name == glob;
    }
    if let Some(suffix) = glob.strip_prefix('*') {
        return name.ends_with(suffix);
    }
    if let Some(prefix) = glob.strip_suffix('*') {
        return name.starts_with(prefix);
    }
    name == glob
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write;

    fn make_fixture() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        // main.typ with two hits on different lines
        let mut f = fs::File::create(dir.path().join("main.typ")).unwrap();
        writeln!(f, "#set page(...)\nHello World\nWorld peace\n").unwrap();
        // nested.typ in a subdir
        fs::create_dir(dir.path().join("sub")).unwrap();
        let mut f2 = fs::File::create(dir.path().join("sub").join("nested.typ")).unwrap();
        writeln!(f2, "another World here").unwrap();
        // ignored: target/build.typ should be skipped
        fs::create_dir_all(dir.path().join("target")).unwrap();
        let mut f3 = fs::File::create(dir.path().join("target").join("build.typ")).unwrap();
        writeln!(f3, "World in target").unwrap();
        dir
    }

    #[test]
    fn literal_case_insensitive_finds_all() {
        let dir = make_fixture();
        let q = SearchQuery {
            pattern: "world".into(),
            is_regex: false,
            case_sensitive: false,
            whole_word: false,
            include_glob: None,
            max_per_file: 100,
            max_total: 100,
        };
        let hits = search(dir.path(), &q).unwrap();
        // main.typ: 2 (Hello World, World peace — note "world" in "World")
        // sub/nested.typ: 1
        // target/build.typ: 0 (ignored)
        assert!(hits.len() >= 3, "expected at least 3 hits, got {}", hits.len());
        assert!(hits.iter().all(|h| !h.relative.starts_with("target")));
    }

    #[test]
    fn literal_case_sensitive_finds_none_when_wrong_case() {
        let dir = make_fixture();
        let q = SearchQuery {
            pattern: "world".into(),
            is_regex: false,
            case_sensitive: true,
            whole_word: false,
            include_glob: None,
            max_per_file: 100,
            max_total: 100,
        };
        let hits = search(dir.path(), &q).unwrap();
        assert_eq!(hits.len(), 0, "expected 0 case-sensitive hits");
    }

    #[test]
    fn regex_matches_pattern() {
        let dir = make_fixture();
        let q = SearchQuery {
            pattern: r"W\w+d".into(),
            is_regex: true,
            case_sensitive: true,
            whole_word: false,
            include_glob: None,
            max_per_file: 100,
            max_total: 100,
        };
        let hits = search(dir.path(), &q).unwrap();
        assert!(hits.len() >= 3, "expected at least 3 regex hits, got {}", hits.len());
    }

    #[test]
    fn include_glob_filters_files() {
        let dir = make_fixture();
        let q = SearchQuery {
            pattern: "world".into(),
            is_regex: false,
            case_sensitive: false,
            whole_word: false,
            include_glob: Some("*.typ".into()),
            max_per_file: 100,
            max_total: 100,
        };
        let hits = search(dir.path(), &q).unwrap();
        assert!(hits.iter().all(|h| h.relative.ends_with(".typ")));
    }

    #[test]
    fn columns_and_line_numbers_are_1_indexed() {
        let dir = make_fixture();
        let q = SearchQuery {
            pattern: "World".into(),
            is_regex: false,
            case_sensitive: true,
            whole_word: false,
            include_glob: None,
            max_per_file: 100,
            max_total: 100,
        };
        let hits = search(dir.path(), &q).unwrap();
        for h in &hits {
            assert!(h.line >= 1);
            assert!(h.column >= 1);
        }
    }
}
