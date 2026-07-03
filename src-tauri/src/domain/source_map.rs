//! Source map — a reverse index from source line to preview-page geometry.
//!
//! The live preview is rendered as a rasterized blob-URL `<img>` (see
//! `SvgPage.tsx`); the SVG carries no source-location metadata. To support
//! scroll-sync (editor ↔ preview) and click-to-source without giving up the
//! off-main-thread SVG decode, the backend walks the retained
//! [`typst_layout::PagedDocument`] once per compile and emits one
//! [`LineRect`] per source line: the line's bounding box on a preview page.
//!
//! All geometry is in Typst's page coordinate space (points, y-down, origin at
//! the page's top-left). The frontend rescales by the rendered `<img>`'s
//! `naturalWidth` / `getBoundingClientRect().width` ratio (which already
//! accounts for the CSS `zoom` setting).

/// A source line's bounding rectangle on a preview page.
///
/// `page` is 0-indexed; `line` is 1-indexed (matching Monaco). Geometry is in
/// points, relative to the page's top-left corner.
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    ts(export_to = "../../src/lib/types.ts")
)]
pub struct LineRect {
    /// 1-indexed source line.
    pub line: u32,
    /// 0-indexed page number.
    pub page: u16,
    /// Left edge of the line's bounding box, in pt.
    pub x: f32,
    /// Top edge of the line's bounding box, in pt.
    pub y: f32,
    /// Width of the bounding box, in pt.
    pub w: f32,
    /// Height of the bounding box, in pt.
    pub h: f32,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(feature = "export-types")]
    fn export_types() {
        use ts_rs::TS;
        let cfg = ts_rs::Config::default();
        LineRect::export(&cfg).unwrap();
    }

    #[test]
    fn camel_case_wire_fields() {
        let r = LineRect { line: 3, page: 0, x: 56.0, y: 100.0, w: 200.0, h: 12.0 };
        let json = serde_json::to_string(&r).unwrap();
        assert!(json.contains("\"line\":3"));
        assert!(json.contains("\"page\":0"));
        assert!(json.contains("\"x\":56"));
        assert!(json.contains("\"y\":100"));
        assert!(json.contains("\"w\":200"));
        assert!(json.contains("\"h\":12"));
    }
}
