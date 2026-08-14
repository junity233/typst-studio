//! Apply LSP `TextEdit[]` to file text — the pure core of the
//! `apply_text_edits_to_disk_file` IPC.
//!
//! The wire format mirrors the Language Server Protocol's `TextEdit` (ranges
//! are 0-based `{line, character}` with `character` counted in **UTF-16 code
//! units**, the encoding tinymist negotiates). Converting those positions to
//! byte offsets in a Rust `String` is the only subtle part; everything else is
//! a splice.
//!
//! Line-splitting note: lines are split on `\n` only, and a `\r` belongs to the
//! line it sits on (counted as one character). This matches how LSP servers
//! built on typst's `Source` index LF and CRLF files (typst treats `\r\n` as
//! one terminator with the `\r` as line content), so edits landing mid-line
//! (the rename-refactoring case this exists for) splice at the right offset.
//! Exotic files using lone `\r` / VT / FF as separators are numbered
//! differently by typst's line index; edits into them fail with a clean
//! out-of-range error rather than corrupting the file.

use serde::Deserialize;

use crate::error::{AppError, Result};

/// LSP `Position` (0-based line + UTF-16 character).
#[derive(Debug, Clone, Copy, Deserialize)]
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    ts(export_to = "../../src/lib/types.ts")
)]
pub struct WirePosition {
    pub line: u32,
    pub character: u32,
}

/// LSP `Range`.
#[derive(Debug, Clone, Copy, Deserialize)]
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    ts(export_to = "../../src/lib/types.ts")
)]
pub struct WireRange {
    pub start: WirePosition,
    pub end: WirePosition,
}

/// LSP `TextEdit` (`newText` arrives camelCase on the wire).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    ts(export_to = "../../src/lib/types.ts")
)]
pub struct WireTextEdit {
    pub range: WireRange,
    pub new_text: String,
}

/// Byte offset of an LSP `{line, character}` position within `text`.
///
/// Errors (rather than clamping) when the line is out of bounds: the server
/// produced positions from this exact file moments ago, so an out-of-range
/// line means the file changed underneath us and any splice would corrupt it.
/// A `character` past the line end IS clamped to the line end — servers may
/// emit end-of-line positions that count the terminator differently.
fn position_to_byte_offset(text: &str, pos: WirePosition) -> Result<usize> {
    let mut line_start = 0usize;
    for (i, line) in text.split('\n').enumerate() {
        if i as u32 == pos.line {
            let mut units = 0u32;
            for (byte_idx, ch) in line.char_indices() {
                if units >= pos.character {
                    return Ok(line_start + byte_idx);
                }
                units += ch.len_utf16() as u32;
            }
            // Past the final character of the line → clamp to line end
            // (excluding the `\n` terminator).
            return Ok(line_start + line.len());
        }
        // +1 skips the `\n` separator itself.
        line_start += line.len() + 1;
    }
    Err(AppError::InvalidInput(format!(
        "LSP position line {} is outside the file ({} lines)",
        pos.line,
        text.split('\n').count()
    )))
}

/// Apply a set of LSP text edits to `text`, returning the new content.
///
/// Edits are applied back-to-front (sorted descending) so earlier byte
/// offsets stay valid; overlapping edits are rejected as a corruption guard
/// (the protocol guarantees disjoint ranges from a conforming server).
pub fn apply_text_edits(text: &str, edits: &[WireTextEdit]) -> Result<String> {
    if edits.is_empty() {
        return Ok(text.to_string());
    }
    // Resolve + sort descending by start offset (ties broken by end offset).
    let mut resolved: Vec<(usize, usize, &str)> = Vec::with_capacity(edits.len());
    for e in edits {
        let start = position_to_byte_offset(text, e.range.start)?;
        let end = position_to_byte_offset(text, e.range.end)?;
        if end < start {
            return Err(AppError::InvalidInput(format!(
                "TextEdit range end precedes start ({end} < {start})"
            )));
        }
        resolved.push((start, end, e.new_text.as_str()));
    }
    resolved.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.cmp(&a.1)));

    let mut out = text.to_string();
    let mut last_start = usize::MAX;
    for (start, end, new_text) in resolved {
        if end > last_start {
            return Err(AppError::InvalidInput(
                "overlapping TextEdits refused (would corrupt the file)".into(),
            ));
        }
        last_start = start;
        out.replace_range(start..end, new_text);
    }
    Ok(out)
}

/// Parse a `file:` URI into an absolute filesystem path (percent-decoding
/// applied). Rejects non-file schemes and malformed URIs.
pub fn file_uri_to_path(uri: &str) -> Result<std::path::PathBuf> {
    let url = url::Url::parse(uri)
        .map_err(|e| AppError::InvalidInput(format!("invalid file URI `{uri}`: {e}")))?;
    if url.scheme() != "file" {
        return Err(AppError::InvalidInput(format!(
            "expected a file: URI, got scheme `{}`",
            url.scheme()
        )));
    }
    url.to_file_path().map_err(|_| {
        AppError::InvalidInput(format!("file URI is not absolute on this OS: `{uri}`"))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(feature = "export-types")]
    fn export_types() {
        use ts_rs::TS;
        let cfg = ts_rs::Config::default();
        WirePosition::export(&cfg).unwrap();
        WireRange::export(&cfg).unwrap();
        WireTextEdit::export(&cfg).unwrap();
    }

    fn edit(sl: u32, sc: u32, el: u32, ec: u32, new_text: &str) -> WireTextEdit {
        WireTextEdit {
            range: WireRange {
                start: WirePosition { line: sl, character: sc },
                end: WirePosition { line: el, character: ec },
            },
            new_text: new_text.to_string(),
        }
    }

    #[test]
    fn replaces_an_identifier_mid_line() {
        let text = "let old_name = 1;\n";
        let out = apply_text_edits(text, &[edit(0, 4, 0, 12, "new_name")]).unwrap();
        assert_eq!(out, "let new_name = 1;\n");
    }

    #[test]
    fn applies_multiple_edits_back_to_front() {
        let text = "aaa bbb ccc";
        let out = apply_text_edits(
            text,
            &[edit(0, 8, 0, 11, "CCC"), edit(0, 0, 0, 3, "AAA")],
        )
        .unwrap();
        assert_eq!(out, "AAA bbb CCC");
    }

    #[test]
    fn multiline_replacement_and_insert() {
        let text = "one\ntwo\nthree";
        // Replace "two" with "TWO\nTWO", insert at start.
        let out = apply_text_edits(
            text,
            &[edit(1, 0, 1, 3, "TWO\nTWO"), edit(0, 0, 0, 0, ">>> ")],
        )
        .unwrap();
        assert_eq!(out, ">>> one\nTWO\nTWO\nthree");
    }

    #[test]
    fn empty_edit_list_is_identity() {
        assert_eq!(apply_text_edits("x", &[]).unwrap(), "x");
    }

    #[test]
    fn utf16_positions_index_surrogate_pairs_and_cjk() {
        // "𝕏" is one char outside the BMP = 2 UTF-16 units; "中" is 1 unit.
        // Unit map: a=0, 𝕏=1-2, 中=3, b=4.
        let text = "a𝕏中b";
        // Replace "中" (unit 3) with "!". A character offset of 2 falls
        // INSIDE 𝕏's surrogate pair; the resolver clamps forward to the next
        // char boundary (unit 3), so the range (2..3) is empty-at-中 → the
        // "!" inserts before 中.
        let out = apply_text_edits(text, &[edit(0, 2, 0, 3, "!")]).unwrap();
        assert_eq!(out, "a𝕏!中b");
        // Replace the astral char itself (units 1..3 = 𝕏 through start of 中).
        let out2 = apply_text_edits(text, &[edit(0, 1, 0, 3, "?")]).unwrap();
        assert_eq!(out2, "a?中b");
    }

    #[test]
    fn character_past_line_end_clamps_to_line_end() {
        let text = "ab\ncd";
        let out = apply_text_edits(text, &[edit(0, 0, 0, 99, "X")]).unwrap();
        assert_eq!(out, "X\ncd");
    }

    #[test]
    fn line_out_of_bounds_errors() {
        let err = apply_text_edits("ab", &[edit(5, 0, 5, 1, "X")]).unwrap_err();
        assert!(err.to_string().contains("outside the file"));
    }

    #[test]
    fn overlapping_edits_are_refused() {
        let err = apply_text_edits(
            "abcdef",
            &[edit(0, 1, 0, 4, "X"), edit(0, 3, 0, 5, "Y")],
        )
        .unwrap_err();
        assert!(err.to_string().contains("overlapping"));
    }

    #[test]
    fn inverted_range_errors() {
        let err = apply_text_edits("abc", &[edit(0, 2, 0, 1, "X")]).unwrap_err();
        assert!(err.to_string().contains("precedes start"), "got: {err}");
    }

    #[test]
    fn crlf_line_ending_keeps_cr_as_content() {
        let text = "ab\r\ncd";
        // Replace "cd" on line 1 — the \r stays untouched on line 0.
        let out = apply_text_edits(text, &[edit(1, 0, 1, 2, "XY")]).unwrap();
        assert_eq!(out, "ab\r\nXY");
    }

    #[test]
    fn file_uri_to_path_parses_windows_and_posix() {
        let p = file_uri_to_path("file:///D:/ws/a%20b/main.typ").unwrap();
        assert!(p.to_string_lossy().contains("a b"));
        assert!(p.to_string_lossy().ends_with("main.typ"));
        assert!(file_uri_to_path("https://x/y").is_err());
        assert!(file_uri_to_path("not-a-uri").is_err());
    }
}
