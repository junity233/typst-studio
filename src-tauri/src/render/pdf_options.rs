//! User-facing PDF export options — the pure string → `PdfOptions` bridge.
//!
//! The app exposes three settings (`export.pdfPageRanges`, `export.pdfStandard`,
//! `export.pdfTagged`); this module parses them into the `typst-pdf`
//! `PdfOptions` the renderer consumes. Parsing is strict (errors surface in the
//! export dialog instead of silently producing a wrong-PDF).

use std::num::NonZeroUsize;

use typst::foundations::Smart;
use typst::layout::PageRanges;
use typst_pdf::{PdfOptions, PdfStandard, PdfStandards};

use crate::error::{AppError, Result};

/// Parse a page-range expression like `"1-3,5,8-"` (empty/blank → `None` =
/// all pages). Each comma-separated part is `N`, `A-B`, `A-` (to the end), or
/// `-B` (from the start). 1-indexed, matching the typst CLI's `--pages`.
pub fn parse_page_ranges(input: &str) -> Result<Option<PageRanges>> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let mut ranges = Vec::new();
    for part in trimmed.split(',') {
        let part = part.trim();
        if part.is_empty() {
            return Err(AppError::InvalidInput(format!(
                "empty page-range part in `{input}`"
            )));
        }
        // A bare `-` would parse as the full range (None..=None = all pages),
        // silently turning a typo into "export everything".
        if part == "-" {
            return Err(AppError::InvalidInput(format!(
                "bare `-` is not a page range in `{input}`"
            )));
        }
        let (start, end) = match part.split_once('-') {
            None => {
                let n = parse_page_number(part, input)?;
                (Some(n), Some(n))
            }
            Some((a, b)) => {
                let start = if a.is_empty() { None } else { Some(parse_page_number(a, input)?) };
                let end = if b.is_empty() { None } else { Some(parse_page_number(b, input)?) };
                (start, end)
            }
        };
        if let (Some(s), Some(e)) = (start, end) {
            if e < s {
                return Err(AppError::InvalidInput(format!(
                    "page range {s}-{e} is inverted in `{input}`"
                )));
            }
        }
        ranges.push(start..=end);
    }
    Ok(Some(PageRanges::new(ranges)))
}

fn parse_page_number(raw: &str, context: &str) -> Result<NonZeroUsize> {
    raw.trim()
        .parse::<NonZeroUsize>()
        .map_err(|_| {
            AppError::InvalidInput(format!(
                "`{raw}` is not a positive page number (in `{context}`)"
            ))
        })
}

/// The `export.pdfStandard` subset this app exposes. `none` keeps typst's
/// default output; the others map to `typst_pdf::PdfStandard` by their serde
/// names (the same strings the typst CLI's `--pdf-standard` accepts).
pub fn parse_pdf_standard(input: &str) -> Result<Option<PdfStandard>> {
    Ok(match input.trim() {
        "" | "none" => None,
        "1.7" => Some(PdfStandard::V_1_7),
        "2.0" => Some(PdfStandard::V_2_0),
        "a-1b" => Some(PdfStandard::A_1b),
        "a-2b" => Some(PdfStandard::A_2b),
        "a-3b" => Some(PdfStandard::A_3b),
        "a-4" => Some(PdfStandard::A_4),
        "a-4f" => Some(PdfStandard::A_4f),
        "ua-1" => Some(PdfStandard::Ua_1),
        other => {
            return Err(AppError::InvalidInput(format!(
                "unknown PDF standard `{other}`"
            )));
        }
    })
}

/// Build the `PdfOptions` for an export run from the three user settings.
/// Errors on invalid ranges/standard input so the caller can show a dialog.
pub fn pdf_options_from_settings(
    page_ranges: &str,
    standard: &str,
    tagged: bool,
) -> Result<PdfOptions> {
    let standards = match parse_pdf_standard(standard)? {
        Some(std) => PdfStandards::new(&[std]).map_err(|e| {
            AppError::InvalidInput(format!(
                "PDF standard `{standard}` is not applicable: {e:?}"
            ))
        })?,
        None => PdfStandards::default(),
    };
    Ok(PdfOptions {
        ident: Smart::Auto,
        creator: Smart::Auto,
        timestamp: None,
        page_ranges: parse_page_ranges(page_ranges)?,
        standards,
        tagged,
        pretty: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_ranges_mean_all_pages() {
        assert!(parse_page_ranges("").unwrap().is_none());
        assert!(parse_page_ranges("   ").unwrap().is_none());
    }

    #[test]
    fn parses_single_range_and_open_ends() {
        let r = parse_page_ranges("1-3").unwrap().unwrap();
        assert!(r.includes_page(NonZeroUsize::new(1).unwrap()));
        assert!(r.includes_page(NonZeroUsize::new(3).unwrap()));
        assert!(!r.includes_page(NonZeroUsize::new(4).unwrap()));

        let open = parse_page_ranges("5-").unwrap().unwrap();
        assert!(!open.includes_page(NonZeroUsize::new(4).unwrap()));
        assert!(open.includes_page(NonZeroUsize::new(999).unwrap()));

        let from_start = parse_page_ranges("-2,7").unwrap().unwrap();
        assert!(from_start.includes_page(NonZeroUsize::new(1).unwrap()));
        assert!(from_start.includes_page(NonZeroUsize::new(2).unwrap()));
        assert!(!from_start.includes_page(NonZeroUsize::new(3).unwrap()));
        assert!(from_start.includes_page(NonZeroUsize::new(7).unwrap()));
    }

    #[test]
    fn rejects_zero_inverted_and_garbage() {
        assert!(parse_page_ranges("0").is_err());
        assert!(parse_page_ranges("3-1").is_err());
        assert!(parse_page_ranges("a-b").is_err());
        assert!(parse_page_ranges("1,,2").is_err());
        assert!(parse_page_ranges("1-3,").is_err());
        // A bare `-` must not silently mean "all pages".
        assert!(parse_page_ranges("-").is_err());
    }

    #[test]
    fn standard_parsing_round_trips_known_names() {
        assert!(parse_pdf_standard("none").unwrap().is_none());
        assert!(parse_pdf_standard("").unwrap().is_none());
        assert!(matches!(parse_pdf_standard("a-2b").unwrap(), Some(PdfStandard::A_2b)));
        assert!(matches!(parse_pdf_standard("ua-1").unwrap(), Some(PdfStandard::Ua_1)));
        assert!(parse_pdf_standard("a-99").is_err());
    }

    #[test]
    fn options_builder_applies_all_three_settings() {
        let opts = pdf_options_from_settings("2", "a-2b", false).unwrap();
        assert!(opts.page_ranges.is_some());
        assert!(!opts.tagged);
        let defaults = pdf_options_from_settings("", "none", true).unwrap();
        assert!(defaults.page_ranges.is_none());
        assert!(defaults.tagged);
    }
}
