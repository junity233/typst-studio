//! Extension → [`DocumentKind`] classification (shared by every open path).
//!
//! The backend has three independent "is this path openable, and as what?"
//! entry points — the native open dialog (`commands::open_file`), the
//! tree/single-instance path open (`fs_commands::open_file_by_path`), and the
//! single-instance argv router (`file_routing::extract_*_arg`). They MUST agree
//! on which extensions are accepted and how they are classified, so the
//! mapping lives here as the single source of truth.
//!
//! Files whose extension is not recognized (or which have none) fall back to
//! [`DocumentKind::Text`] — they open as plain-text editor tabs. Unknown
//! extensions are therefore editable rather than rejected, matching how a
//! general-purpose editor treats arbitrary text files. Only recognized binary
//! extensions opt out of the text pipeline.

use std::path::Path;

use crate::domain::document::DocumentKind;

/// Image extensions opened as [`DocumentKind::Image`] (preview-only).
///
/// Kept in sync with the existing image-picker dialog filter in
/// `commands::pick_image_file` (`png/jpg/jpeg/gif/svg/webp/bmp`).
pub const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp"];

/// Markdown extensions opened as [`DocumentKind::Markdown`] (editable +
/// rendered preview).
pub const MARKDOWN_EXTENSIONS: &[&str] = &["md", "markdown", "mdx"];

/// PDF extension, opened as [`DocumentKind::Pdf`] (preview-only).
pub const PDF_EXTENSIONS: &[&str] = &["pdf"];

/// Typst source extensions, opened as [`DocumentKind::Typst`] (the historical
/// default — compiled, LSP-attached, SVG-previewed).
pub const TYPST_EXTENSIONS: &[&str] = &["typ", "typst"];

/// Classify a path by its extension into a [`DocumentKind`].
///
/// Extension matching is ASCII-case-insensitive (so `.PDF`, `.Md`, `.JSON`
/// all work). A path with no extension, or an unrecognized extension, is
/// treated as [`DocumentKind::Text`] — i.e. opened as an editable plain-text
/// tab. This keeps the editor useful for arbitrary text files (logs, config
/// snippets, unknown source) without an exhaustive extension allowlist.
///
/// Pure (no IO); safe to call with any path.
pub fn classify(path: &Path) -> DocumentKind {
    let Some(ext) = path.extension().and_then(|e| e.to_str()) else {
        return DocumentKind::Text;
    };
    let ext = ext.to_ascii_lowercase();
    if TYPST_EXTENSIONS.iter().any(|e| *e == ext) {
        DocumentKind::Typst
    } else if MARKDOWN_EXTENSIONS.iter().any(|e| *e == ext) {
        DocumentKind::Markdown
    } else if PDF_EXTENSIONS.iter().any(|e| *e == ext) {
        DocumentKind::Pdf
    } else if IMAGE_EXTENSIONS.iter().any(|e| *e == ext) {
        DocumentKind::Image
    } else {
        DocumentKind::Text
    }
}

/// `true` if `path`'s extension is one this app can open as a tab (i.e. any
/// recognized extension OR a fallback text file). Used by the single-instance
/// argv router to decide whether to forward a CLI argument as an open request.
///
/// Because unknown extensions fall back to plain text, this is `true` for any
/// path that has *some* chance of being editable. The router additionally
/// rejects directories / non-existent paths at the call site.
pub fn is_openable(path: &Path) -> bool {
    // Every path with an extension is potentially openable (text fallback).
    // A path with NO extension (e.g. a bare executable name) is not.
    path.extension().is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_typst_extensions() {
        assert_eq!(classify(Path::new("/x/main.typ")), DocumentKind::Typst);
        assert_eq!(classify(Path::new("/x/MAIN.TYP")), DocumentKind::Typst);
        assert_eq!(classify(Path::new("/x/a.typst")), DocumentKind::Typst);
    }

    #[test]
    fn classifies_markdown_extensions() {
        assert_eq!(classify(Path::new("/x/README.md")), DocumentKind::Markdown);
        assert_eq!(classify(Path::new("/x/a.MARKDOWN")), DocumentKind::Markdown);
        assert_eq!(classify(Path::new("/x/a.mdx")), DocumentKind::Markdown);
    }

    #[test]
    fn classifies_image_extensions() {
        for ext in IMAGE_EXTENSIONS {
            assert_eq!(
                classify(Path::new(&format!("/x/photo.{ext}"))),
                DocumentKind::Image,
                "extension {ext}"
            );
        }
        // Uppercase JPG is still an image.
        assert_eq!(classify(Path::new("/x/PHOTO.JPG")), DocumentKind::Image);
    }

    #[test]
    fn classifies_pdf() {
        assert_eq!(classify(Path::new("/x/doc.pdf")), DocumentKind::Pdf);
        assert_eq!(classify(Path::new("/x/DOC.PDF")), DocumentKind::Pdf);
    }

    #[test]
    fn unknown_extension_falls_back_to_text() {
        assert_eq!(classify(Path::new("/x/data.json")), DocumentKind::Text);
        assert_eq!(classify(Path::new("/x/run.py")), DocumentKind::Text);
        assert_eq!(classify(Path::new("/x/notes.txt")), DocumentKind::Text);
        assert_eq!(classify(Path::new("/x/.weirdext")), DocumentKind::Text);
    }

    #[test]
    fn no_extension_is_text() {
        // A path with no extension still opens as plain text.
        assert_eq!(classify(Path::new("/x/Makefile")), DocumentKind::Text);
        assert_eq!(classify(Path::new("/x/Dockerfile")), DocumentKind::Text);
    }

    #[test]
    fn is_openable_requires_an_extension() {
        assert!(is_openable(Path::new("/x/a.json")));
        assert!(is_openable(Path::new("/x/a.typ")));
        assert!(is_openable(Path::new("/x/Makefile.bak")));
        // No extension -> not openable via argv routing.
        assert!(!is_openable(Path::new("/x/Makefile")));
    }
}
