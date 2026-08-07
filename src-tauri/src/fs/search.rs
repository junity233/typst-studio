//! Cross-file search + replace engine (§Search view).
//!
//! Recursively walks the workspace root, skipping the same `IGNORED_DIRS` the
//! Explorer tree skips, and matches each line of each UTF-8 file against a
//! [`SearchQuery`]. Literal matching is hand-rolled (fast, no allocation for
//! ASCII case-insensitive); regex matching uses the `regex` crate. Per-file and
//! total hit caps guard against pathological inputs (huge generated files).
//!
//! Non-UTF-8 / unreadable files are silently skipped (best-effort: the Search
//! view is informational, never blocking).
//!
//! Replace (`replace_compute`) reuses the same walker + matcher to compute the
//! post-replacement text for every hit file. It deliberately does NOT write to
//! disk or touch open documents — that coordination (open-doc buffer vs. raw
//! disk write) belongs to the IPC layer, which has `AppState`. Here we stay
//! pure: walk, match, splice, return.

use crate::domain::search::{ReplaceRequest, SearchHit, SearchQuery, TargetRef};
use anyhow::Result;
use regex::Regex;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

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
                // Char offsets (for JS String.slice compatibility — JS indexes
                // by UTF-16 code units; for BMP characters char count == UTF-16
                // unit count, which covers the vast majority of Typst content.
                // Astral plane chars (emoji etc.) would still mis-highlight by
                // surrogates, but that's a rare edge case acceptable for the
                // informational search panel.)
                let char_start = line[..range.start].chars().count() as u32;
                // Compute match_end from the *original* line (not the possibly-
                // truncated line_text), then clamp to line_text's char length so
                // we never index past the displayed string.
                let char_end_full = line[..range.end].chars().count() as u32;
                let line_text_char_len = line_text.chars().count() as u32;
                // Clamp both to the displayed (possibly truncated) length. If the
                // match starts beyond the truncation point (rare, only for
                // >500-byte lines), start == end == line_text_char_len and
                // `slice` returns empty (no highlight, no crash) rather than
                // indexing past the string.
                let match_start = char_start.min(line_text_char_len);
                let match_end = char_end_full.min(line_text_char_len);
                hits.push(SearchHit {
                    relative: rel.clone(),
                    line: line_idx as u32 + 1,
                    column: col,
                    line_text,
                    match_start,
                    match_end,
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

/// Validate a regex replacement string against the compiled regex. `regex`'s
/// `expand` / `replace_all` **panic** when the replacement references a capture
/// group that doesn't exist (e.g. pattern `World` + replacement `$1`, or
/// `(a)` + `$5`, or `${oops}`). That panic would unwind inside `spawn_blocking`
/// and surface as an opaque IPC error with no hint that the *replacement* was
/// the problem. This pre-flight check parses the `$name` / `${name}` / `$N`
/// references in `replacement` and rejects any that don't resolve to a real
/// capture index or name — turning a runtime panic into a clean, actionable
/// error before any file is read or written.
fn validate_regex_replacement(re: &Regex, replacement: &str) -> Result<()> {
    // Collect the set of valid capture names + the highest numeric index.
    let mut max_index = 0usize; // $0 (whole match) is always valid.
    let mut names: std::collections::HashSet<&str> = std::collections::HashSet::new();
    for (i, name) in re.capture_names().enumerate() {
        max_index = i.saturating_sub(1).max(max_index); // enumerate includes $0
        if let Some(n) = name {
            names.insert(n);
        }
    }
    // capture_names() yields Some(name) for named groups; the count of slots is
    // re.captures_len(). Numeric refs must be < captures_len (0-indexed, $0 ok).
    let captures_len = re.captures_len();

    let bytes = replacement.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'$' {
            i += 1;
            continue;
        }
        // $$ is an escaped literal dollar.
        if i + 1 < bytes.len() && bytes[i + 1] == b'$' {
            i += 2;
            continue;
        }
        i += 1;
        // ${...} braced form.
        if i < bytes.len() && bytes[i] == b'{' {
            let start = i + 1;
            let end = match bytes[start..].iter().position(|&b| b == b'}') {
                Some(p) => start + p,
                None => {
                    // Unterminated ${ — regex would panic; reject with a clear msg.
                    return Err(anyhow::anyhow!(
                        "replacement has unterminated `${{'` — use `${{name}}` or `$$` for a literal dollar"
                    ));
                }
            };
            let name = &replacement[start..end];
            validate_one_ref(name, captures_len, &names)?;
            i = end + 1;
            continue;
        }
        // Bare $name / $N: read consecutive word chars ([A-Za-z0-9_]).
        let start = i;
        while i < bytes.len()
            && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_')
        {
            i += 1;
        }
        if i == start {
            // Lone `$` followed by a non-word char — regex treats `$x` where x
            // isn't a valid name char as a literal `$`; not a panic. Skip.
            continue;
        }
        let name = &replacement[start..i];
        validate_one_ref(name, captures_len, &names)?;
    }
    let _ = max_index;
    Ok(())
}

/// Check a single capture-group reference (the text inside `$…` or `${…}`).
fn validate_one_ref(
    name: &str,
    captures_len: usize,
    names: &std::collections::HashSet<&str>,
) -> Result<()> {
    // Empty (${}) — invalid.
    if name.is_empty() {
        return Err(anyhow::anyhow!("replacement has empty capture reference `${{}}`"));
    }
    // All-digits → numeric index. Must be < captures_len ($0 is the whole match).
    if name.bytes().all(|b| b.is_ascii_digit()) {
        let n: usize = name.parse().unwrap_or(usize::MAX);
        if n >= captures_len {
            return Err(anyhow::anyhow!(
                "replacement `${{{name}}}` references capture group {n}, but the pattern only has {} group(s)",
                captures_len.saturating_sub(1)
            ));
        }
        return Ok(());
    }
    // Otherwise a named group.
    if !names.contains(name) {
        return Err(anyhow::anyhow!(
            "replacement `${{{name}}}` references a capture group that doesn't exist in the pattern"
        ));
    }
    Ok(())
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

// ─── Replace engine ──────────────────────────────────────────────────────

/// One file's computed replacement (the IPC layer writes this to disk or into
/// the open doc's buffer). `new_content` is the full file text with all
/// requested matches spliced out/in; `match_count` is how many matches were
/// replaced (for the summary toast).
#[derive(Debug, Clone)]
pub struct FileReplacement {
    pub relative: String,
    pub abs_path: PathBuf,
    pub new_content: String,
    pub match_count: usize,
}

/// Walk `root` (same traversal as [`search`]) and, for every file that has at
/// least one match under `req.query`, compute the post-replacement text. Does
/// NOT write to disk or touch open documents — returns the computed content so
/// the IPC layer can route each file to the right sink.
///
/// Honors `req.replacement`, `req.preserve_case` (literal mode only), and
/// `req.target` (restricts to a single match at an exact location).
///
/// Line-based: matches and replacements are applied independently per line
/// (same constraint as `search`). Cross-line patterns are not supported.
pub fn replace_compute(root: &Path, req: &ReplaceRequest) -> Result<Vec<FileReplacement>> {
    let query = &req.query;
    let matcher = build_matcher(query)?;
    let replacement = req.replacement.as_str();
    // Pre-validate a regex replacement so a bad capture reference ($5 on a
    // pattern with fewer groups) becomes a clean error instead of a panic
    // inside spawn_blocking. Literal mode needs no validation.
    if let Matcher::Regex(re) = &matcher {
        validate_regex_replacement(re, replacement)?;
    }
    let preserve_case = req.preserve_case;
    let target = req.target.as_ref();
    let ignored: HashSet<&'static str> = crate::fs::tree::IGNORED_DIRS.iter().copied().collect();
    let include = query.include_glob.as_deref();
    let mut out: Vec<FileReplacement> = Vec::new();

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
        // If a target is set, skip every file that isn't it.
        if let Some(t) = target {
            if t.relative != rel {
                continue;
            }
        }
        // Skip non-UTF-8 / unreadable files (best-effort, same as `search`).
        // Also skip files larger than the byte guard: a multi-MB generated
        // file (JSON/CSV checked into the workspace) would otherwise be read
        // wholesale, rebuilt in memory, and written back — slow and memory-
        // hungry. The search hit caps protect the result LIST, but replace
        // walks every matching file regardless, so this is the only ceiling.
        // Mirrors fs_commands.rs::MAX_SOURCE_FILE_BYTES (10 MiB).
        const REPLACE_MAX_FILE_BYTES: u64 = 10 * 1024 * 1024;
        if let Ok(meta) = std::fs::metadata(path) {
            if meta.len() > REPLACE_MAX_FILE_BYTES {
                continue;
            }
        }
        let text = match std::fs::read_to_string(path) {
            Ok(t) => t,
            Err(_) => continue,
        };

        // Match the target against (line, column) BEFORE we decide whether this
        // file has a relevant match. `column` is 1-indexed scalar values; we
        // compare against the matcher's per-line match ranges (byte offsets →
        // char offsets). If the target doesn't resolve to a real match, the
        // file produces no replacement.
        let target_match_line = target.and_then(|t| if t.line >= 1 { Some(t.line as usize) } else { None });
        let target_match_col = target.and_then(|t| if t.column >= 1 { Some(t.column as u32) } else { None });

        let mut rebuilt = String::with_capacity(text.len());
        let mut total_matches = 0usize;
        let mut any_change = false;
        // Preserve the trailing newline shape: iterate with line endings kept.
        let lines = split_lines_with_endings(&text);
        for (line_idx, (line, ending)) in lines.into_iter().enumerate() {
            // SearchHit.line is 1-indexed.
            let line_no = line_idx + 1;
            let ranges = matcher.find(line);
            if ranges.is_empty() {
                rebuilt.push_str(line);
                rebuilt.push_str(&ending);
                continue;
            }
            // Resolve which ranges to replace.
            let (to_replace, matched_count) = select_ranges(
                &ranges,
                line,
                line_no,
                target,
                target_match_line,
                target_match_col,
            );
            if to_replace.is_empty() {
                // Matches present but none selected (target didn't line up on
                // this line) — keep line verbatim.
                rebuilt.push_str(line);
                rebuilt.push_str(&ending);
                continue;
            }
            let replaced = splice_replacements(line, &to_replace, replacement, preserve_case, &matcher);
            rebuilt.push_str(&replaced);
            rebuilt.push_str(&ending);
            total_matches += matched_count;
            any_change = true;
        }

        if any_change {
            out.push(FileReplacement {
                relative: rel.clone(),
                abs_path: path.to_path_buf(),
                new_content: rebuilt,
                match_count: total_matches,
            });
        }
    }
    Ok(out)
}

/// Decide which match ranges in a line get replaced, honoring an optional
/// `target` (single-match pin). Returns the selected ranges + how many matches
/// they represent (for the count).
fn select_ranges(
    ranges: &[std::ops::Range<usize>],
    line: &str,
    line_no: usize,
    target: Option<&TargetRef>,
    target_line: Option<usize>,
    target_col: Option<u32>,
) -> (Vec<std::ops::Range<usize>>, usize) {
    if let (Some(_), Some(want_line), Some(want_col)) = (target, target_line, target_col) {
        // Only the single range whose char-start column == target.column on the
        // target line. Lines other than the target contribute nothing.
        if line_no != want_line {
            return (Vec::new(), 0);
        }
        for r in ranges {
            let col = char_column_at(line, r.start);
            if col == want_col {
                return (vec![r.clone()], 1);
            }
        }
        return (Vec::new(), 0);
    }
    // No target: replace every match on the line.
    (ranges.to_vec(), ranges.len())
}

/// Char-offset → 1-indexed column (scalar values). Mirrors the search column
/// math in `search()`.
fn char_column_at(line: &str, byte_offset: usize) -> u32 {
    line[..byte_offset].chars().count() as u32 + 1
}

/// Splice `replacement` into `line` at each range in `ranges` (which must be
/// sorted, non-overlapping, ascending by start — true of both `Matcher::find`
/// and our target selection). For literal mode + `preserve_case`, the
/// replacement is recased per-range to match the matched text's casing.
fn splice_replacements(
    line: &str,
    ranges: &[std::ops::Range<usize>],
    replacement: &str,
    preserve_case: bool,
    matcher: &Matcher,
) -> String {
    if ranges.is_empty() {
        return line.to_string();
    }
    // Regex mode → delegate to regex::replace_all for capture-group support.
    // (preserve_case is ignored for regex by design.)
    if let Matcher::Regex(re) = matcher {
        // Single pinned range (target case, or a line with exactly one match):
        // expand $1/$name against the one match whose start aligns with the
        // range. We scan captures_iter (cheap: one line) rather than guess at
        // captures_at semantics.
        if ranges.len() == 1 {
            let want = ranges[0].start;
            for caps in re.captures_iter(line) {
                if caps.get(0).map(|m| m.start()).unwrap_or(usize::MAX) == want {
                    let r = &ranges[0];
                    let mut out = String::with_capacity(line.len() + replacement.len());
                    out.push_str(&line[..r.start]);
                    // expand() writes $1/$name interpolation into `out`.
                    caps.expand(replacement, &mut out);
                    out.push_str(&line[r.end..]);
                    return out;
                }
            }
            // No aligned capture (shouldn't happen): literal splice.
            let r = &ranges[0];
            let mut out = String::with_capacity(line.len() + replacement.len());
            out.push_str(&line[..r.start]);
            out.push_str(replacement);
            out.push_str(&line[r.end..]);
            return out;
        }
        // Replace-all path: every match on the line, capture-group aware.
        return re.replace_all(line, replacement).into_owned();
    }
    // Literal mode: stitch by ranges, optionally recasing each replacement.
    let mut out = String::with_capacity(line.len() + replacement.len() * ranges.len());
    let mut cursor = 0usize;
    for r in ranges {
        if r.start < cursor {
            continue; // overlap guard (shouldn't happen for literal finds)
        }
        out.push_str(&line[cursor..r.start]);
        if preserve_case {
            let matched = &line[r.start..r.end];
            out.push_str(&apply_preserve_case(matched, replacement));
        } else {
            out.push_str(replacement);
        }
        cursor = r.end;
        // Empty-match avoidance: if the range is zero-width, force forward
        // progress so we can't loop. (Literal finds are never zero-width, so
        // this is defensive only.)
        if r.end == r.start {
            if let Some((b, _)) = line[r.end..].char_indices().next() {
                cursor = r.end + b;
            }
        }
    }
    out.push_str(&line[cursor..]);
    out
}

/// Recase `replacement` to mirror the casing of `matched` (preserve-case mode,
/// literal only). Three shapes:
/// - All-upper (e.g. `WORLD`) → uppercase replacement.
/// - Capitalized-first (e.g. `World`) → capitalize first char of replacement.
/// - Otherwise → replacement unchanged (also covers all-lower).
fn apply_preserve_case(matched: &str, replacement: &str) -> String {
    let mut chars = matched.chars();
    let first = match chars.next() {
        Some(c) => c,
        None => return replacement.to_string(),
    };
    let rest_upper = matched.chars().skip(1).all(|c| !c.is_lowercase());
    let rest_has_alpha = matched.chars().skip(1).any(|c| c.is_alphabetic());
    if first.is_uppercase() && rest_upper && rest_has_alpha {
        // ALL UPPER
        return replacement.to_uppercase();
    }
    if first.is_uppercase() {
        // Title-case first char only.
        let mut r = replacement.chars();
        match r.next() {
            Some(c) => {
                let mut out = String::new();
                for u in c.to_uppercase() {
                    out.push(u);
                }
                out.push_str(r.as_str());
                out
            }
            None => replacement.to_string(),
        }
    } else {
        replacement.to_string()
    }
}

/// Split `text` into `(line_without_ending, ending)` pairs, preserving the
/// original line terminators (and any trailing partial line). This keeps the
/// rebuilt text byte-identical to the original except where we splice. Handles
/// both LF and CRLF.
fn split_lines_with_endings(text: &str) -> Vec<(&str, String)> {
    let mut out = Vec::new();
    let mut cursor = 0;
    let bytes = text.as_bytes();
    while cursor < bytes.len() {
        // Find next LF relative to `cursor`.
        match text[cursor..].find('\n') {
            Some(i) => {
                let line_end = cursor + i; // absolute index of the LF byte
                // A preceding CR (CRLF) is part of the ending, not the content.
                let has_cr = line_end > cursor && bytes[line_end - 1] == b'\r';
                let content_end = if has_cr { line_end - 1 } else { line_end };
                let line = &text[cursor..content_end];
                // Ending spans [\r? then \n] = text[content_end .. line_end+1].
                let ending = &text[content_end..line_end + 1];
                out.push((line, ending.to_string()));
                cursor = line_end + 1;
            }
            None => {
                // Last partial line, no terminator.
                out.push((&text[cursor..], String::new()));
                break;
            }
        }
    }
    out
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

    // ── replace_compute tests ───────────────────────────────────────────

    fn query(pattern: &str) -> SearchQuery {
        SearchQuery {
            pattern: pattern.into(),
            is_regex: false,
            case_sensitive: true,
            whole_word: false,
            include_glob: None,
            max_per_file: 100,
            max_total: 100,
        }
    }

    fn replace_req(q: SearchQuery, replacement: &str) -> ReplaceRequest {
        ReplaceRequest {
            query: q,
            replacement: replacement.into(),
            preserve_case: false,
            target: None,
        }
    }

    fn read_file(dir: &tempfile::TempDir, rel: &str) -> String {
        std::fs::read_to_string(dir.path().join(rel)).unwrap()
    }

    #[test]
    fn replace_literal_all_matches_in_file() {
        let dir = make_fixture();
        let req = replace_req(
            query("World"),
            "Earth",
        );
        let out = replace_compute(dir.path(), &req).unwrap();
        // main.typ had 2 hits, sub/nested.typ had 1 → both files replaced.
        let main = out.iter().find(|f| f.relative == "main.typ").unwrap();
        assert_eq!(main.match_count, 2);
        assert!(main.new_content.contains("Hello Earth"));
        assert!(main.new_content.contains("Earth peace"));
        assert!(!main.new_content.contains("World"));
        let nested = out.iter().find(|f| f.relative == "sub/nested.typ").unwrap();
        assert_eq!(nested.match_count, 1);
        assert!(nested.new_content.contains("another Earth here"));
    }

    #[test]
    fn replace_case_insensitive_uses_replacement_verbatim() {
        let dir = make_fixture();
        let mut q = query("world");
        q.case_sensitive = false;
        let req = replace_req(q, "earth");
        let out = replace_compute(dir.path(), &req).unwrap();
        let main = out.iter().find(|f| f.relative == "main.typ").unwrap();
        assert!(main.new_content.contains("Hello earth"));
        assert!(main.new_content.contains("earth peace"));
    }

    #[test]
    fn replace_preserve_case_mirrors_match_casing() {
        let dir = make_fixture();
        let q = query("World");
        // No need to change case sensitivity: pattern matches only "World".
        let mut req = replace_req(q, "earth");
        req.preserve_case = true;
        let out = replace_compute(dir.path(), &req).unwrap();
        let main = out.iter().find(|f| f.relative == "main.typ").unwrap();
        // "World" is title-cased → replacement becomes "Earth".
        assert!(main.new_content.contains("Hello Earth"));
        assert!(main.new_content.contains("Earth peace"));
    }

    #[test]
    fn replace_preserve_case_all_upper() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "WORLD world\n").unwrap();
        let req = ReplaceRequest {
            query: query("WORLD"),
            replacement: "earth".into(),
            preserve_case: true,
            target: None,
        };
        let out = replace_compute(dir.path(), &req).unwrap();
        let a = out.iter().find(|f| f.relative == "a.txt").unwrap();
        // "WORLD" all-upper → "EARTH"; "world" untouched (didn't match).
        assert_eq!(a.new_content, "EARTH world\n");
    }

    #[test]
    fn replace_regex_expands_capture_groups() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "foo(bar) baz(qux)\n").unwrap();
        let mut q = query(r"\((\w+)\)");
        q.is_regex = true;
        let req = replace_req(q, "[$1]");
        let out = replace_compute(dir.path(), &req).unwrap();
        let a = out.iter().find(|f| f.relative == "a.txt").unwrap();
        assert_eq!(a.new_content, "foo[bar] baz[qux]\n");
    }

    /// A replacement that references a capture group the pattern doesn't have
    /// must be rejected with a clear error, NOT panic inside spawn_blocking.
    /// (regex's expand/replace_all panic on a missing group reference.)
    #[test]
    fn replace_regex_bad_capture_ref_is_rejected_not_panicked() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "World\n").unwrap();
        // Pattern has NO capture groups, but the replacement references $1.
        let mut q = query("World");
        q.is_regex = true;
        let req = replace_req(q, "$1");
        let err = replace_compute(dir.path(), &req).unwrap_err();
        assert!(
            err.to_string().contains("capture group"),
            "expected a capture-group error, got: {err}"
        );
        // Numeric out-of-range: pattern has one group, replacement asks for $5.
        let mut q2 = query(r"(World)");
        q2.is_regex = true;
        let req2 = replace_req(q2, "$5");
        let err2 = replace_compute(dir.path(), &req2).unwrap_err();
        assert!(
            err2.to_string().contains("capture group"),
            "expected a capture-group error, got: {err2}"
        );
        // Named group that doesn't exist.
        let mut q3 = query(r"(World)");
        q3.is_regex = true;
        let req3 = replace_req(q3, "${oops}");
        let err3 = replace_compute(dir.path(), &req3).unwrap_err();
        assert!(
            err3.to_string().contains("doesn't exist"),
            "expected a missing-named-group error, got: {err3}"
        );
    }

    /// A valid replacement (including $$ literal dollar and named groups) is
    /// accepted — guards against the validator being over-eager.
    #[test]
    fn replace_regex_valid_references_accepted() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "World\n").unwrap();
        // One named group `w`; replacement uses both the named ref and an
        // escaped dollar ($$ → literal $). Both are valid references.
        let mut q = query(r"(?P<w>World)");
        q.is_regex = true;
        let req = replace_req(q, "[${w}] $$");
        let out = replace_compute(dir.path(), &req).unwrap();
        let a = out.iter().find(|f| f.relative == "a.txt").unwrap();
        assert_eq!(a.new_content, "[World] $\n");
    }

    #[test]
    fn replace_empty_replacement_deletes_match() {
        let dir = make_fixture();
        let req = replace_req(query("World"), "");
        let out = replace_compute(dir.path(), &req).unwrap();
        let main = out.iter().find(|f| f.relative == "main.typ").unwrap();
        assert!(main.new_content.contains("Hello "));
        assert!(!main.new_content.contains("World"));
    }

    #[test]
    fn replace_target_pins_single_match() {
        let dir = make_fixture();
        // "World peace" — line 3, the match "World" starts at column 1.
        let mut req = replace_req(query("World"), "Earth");
        req.target = Some(TargetRef {
            relative: "main.typ".into(),
            line: 3,
            column: 1,
        });
        let out = replace_compute(dir.path(), &req).unwrap();
        let main = out.iter().find(|f| f.relative == "main.typ").unwrap();
        assert_eq!(main.match_count, 1);
        // Only the line-3 match replaced; the line-2 one is intact.
        assert!(main.new_content.contains("Hello World"));
        assert!(main.new_content.contains("Earth peace"));
    }

    #[test]
    fn replace_target_wrong_column_is_noop() {
        let dir = make_fixture();
        let mut req = replace_req(query("World"), "Earth");
        req.target = Some(TargetRef {
            relative: "main.typ".into(),
            line: 3,
            column: 99, // no match starts here
        });
        let out = replace_compute(dir.path(), &req).unwrap();
        // No file qualifies → empty outcome.
        assert!(out.is_empty(), "expected no replacements, got {:?}", out);
    }

    #[test]
    fn replace_preserves_trailing_newline_shape() {
        // No trailing newline at EOF must be preserved as "no trailing newline".
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "ab ab").unwrap(); // no trailing \n
        let req = replace_req(query("ab"), "X");
        let out = replace_compute(dir.path(), &req).unwrap();
        let a = out.iter().find(|f| f.relative == "a.txt").unwrap();
        assert_eq!(a.new_content, "X X");
        assert!(!a.new_content.ends_with('\n'));
    }

    #[test]
    fn replace_preserves_crlf_endings() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), b"World\r\nWorld\r\n").unwrap();
        let req = replace_req(query("World"), "Earth");
        let out = replace_compute(dir.path(), &req).unwrap();
        let a = out.iter().find(|f| f.relative == "a.txt").unwrap();
        assert_eq!(a.new_content, "Earth\r\nEarth\r\n");
        let _ = read_file; // silence unused if no other reader test
    }
}
