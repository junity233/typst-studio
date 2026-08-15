//! Shared test scaffolding for the renderer tests (`svg.rs`, `png.rs`,
//! `pdf.rs`): a minimal throwaway [`typst::World`] backed by `typst-kit`'s
//! embedded fonts so each renderer is validated end-to-end against a real
//! compile. Test-only — never compiled into the binary.

use std::path::PathBuf;

use typst::LibraryExt;
use typst::diag::{FileError, FileResult};
use typst::foundations::{Bytes, Datetime, Duration};
use typst_layout::PagedDocument;
use typst::syntax::{FileId, RootedPath, Source, VirtualPath, VirtualRoot};
use typst::text::{Font, FontBook};
use typst::utils::LazyHash;
use typst::{Library, World};
use typst_kit::fonts::FontStore;

/// Minimal `World` for tests: one in-memory source + embedded fonts.
pub(crate) struct MiniWorld {
    library: LazyHash<Library>,
    fonts: FontStore,
    main: FileId,
    source: Source,
}

impl MiniWorld {
    pub(crate) fn new(text: &str) -> Self {
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

    pub(crate) fn compile(&self) -> Result<PagedDocument, String> {
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
