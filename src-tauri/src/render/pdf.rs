//! `PdfRenderer` — PDF export via the `typst-pdf` crate.
//!
//! Produces the raw bytes of a single PDF containing every page of a compiled
//! [`PagedDocument`].

use typst_layout::PagedDocument;
use typst_pdf::{PdfOptions, pdf};

use super::pipeline::RenderPipeline;

/// Renders a Typst document into a single PDF file's raw bytes.
pub struct PdfRenderer;

impl PdfRenderer {
    /// Create a new renderer with default options.
    pub fn new() -> Self {
        Self
    }
}

impl Default for PdfRenderer {
    fn default() -> Self {
        Self::new()
    }
}

impl RenderPipeline for PdfRenderer {
    type Output = Vec<u8>;

    fn render(&self, doc: &PagedDocument) -> Self::Output {
        // `typst_pdf::pdf` is infallible for well-formed `PagedDocument`s; it
        // only fails on internal conversion errors, which are not recoverable
        // at this layer. We surface them as a panic with full context.
        pdf(doc, &PdfOptions::default()).unwrap_or_else(|err| {
            panic!("typst-pdf conversion failed: {err:?}")
        })
    }
}

#[cfg(test)]
mod tests {
    //! Strategy: **Option A** (runtime test). See `svg.rs` for rationale.
    use super::*;
    use std::path::PathBuf;

    use typst::LibraryExt;
    use typst::diag::{FileError, FileResult};
    use typst::foundations::{Bytes, Datetime, Duration};
    use typst_layout::PagedDocument;
    use typst::syntax::{FileId, RootedPath, Source, VirtualPath, VirtualRoot};
    use typst::text::{Font, FontBook};
    use typst::{Library, World};
    use typst_kit::fonts::FontStore;
    use typst::utils::LazyHash;

    struct MiniWorld {
        library: LazyHash<Library>,
        fonts: FontStore,
        main: FileId,
        source: Source,
    }

    impl MiniWorld {
        fn new(text: &str) -> Self {
            let path = RootedPath::new(
                VirtualRoot::Project,
                VirtualPath::new("main.typ").expect("valid path"),
            );
            let main = FileId::new(path);
            let mut fonts = FontStore::new();
            fonts.extend(typst_kit::fonts::embedded());
            Self {
                library: LazyHash::new(Library::default()),
                fonts,
                main,
                source: Source::new(main, text.to_string()),
            }
        }

        fn compile(&self) -> Result<PagedDocument, String> {
            typst::compile::<PagedDocument>(self)
                .output
                .map_err(|errs| format!("{errs:?}"))
        }
    }

    impl World for MiniWorld {
        fn library(&self) -> &LazyHash<Library> {
            &self.library
        }
        fn book(&self) -> &LazyHash<FontBook> {
            self.fonts.book()
        }
        fn main(&self) -> FileId {
            self.main
        }
        fn source(&self, id: FileId) -> FileResult<Source> {
            if id == self.main {
                Ok(self.source.clone())
            } else {
                Err(FileError::NotFound(PathBuf::from(
                    id.vpath().get_with_slash().to_owned(),
                )))
            }
        }
        fn file(&self, id: FileId) -> FileResult<Bytes> {
            Ok(Bytes::from_string(self.source(id)?.text().to_string()))
        }
        fn font(&self, index: usize) -> Option<Font> {
            self.fonts.font(index)
        }
        fn today(&self, _: Option<Duration>) -> Option<Datetime> {
            None
        }
    }

    #[test]
    fn pdf_renderer_emits_valid_pdf_header() {
        let world = MiniWorld::new("Hello, PDF!");
        let doc = world.compile().expect("compile failed");
        let bytes = PdfRenderer.render(&doc);

        assert!(!bytes.is_empty(), "PDF bytes should be non-empty");
        // Every PDF file starts with `%PDF-`.
        assert_eq!(&bytes[..5], b"%PDF-", "PDF magic header missing");
    }
}
