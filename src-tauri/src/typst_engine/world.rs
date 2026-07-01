//! `EditorWorld` — a long-lived, single-document [`typst::World`] implementation
//! backing the live editor.
//!
//! ## Design
//!
//! `EditorWorld` owns the main [`Source`] behind a [`parking_lot::RwLock`] so
//! that the `&self` [`World`] methods can read it while the editor thread
//! updates the text via [`EditorWorld::set_text`]. The font collection (book +
//! lazy-loaded faces) comes from a [`SystemFontLoader`].
//!
//! ## Incremental compilation across edits
//!
//! comemo memoizes [`World`] calls *per* [`track`](comemo::Track) token, and
//! [`typst::compile`] calls `world.track()` afresh on every invocation — which
//! hands comemo a brand-new accelerator id each time. That means `source(id)`
//! is re-read on every compile, so in-place edits are picked up immediately
//! **without** a [`comemo::evict`] call. Editing the [`Source`] in place via
//! [`Source::replace`] (rather than reconstructing it) additionally preserves
//! syntax-node identity, so comemo's cross-compile accelerator can fast-path
//! unchanged subtrees. Keeping the *same* `EditorWorld` instance alive across
//! edits is therefore what unlocks incremental caching.
//!
//! [`World`]: typst::World
//! [`SystemFontLoader`]: super::font_loader::SystemFontLoader

use std::path::PathBuf;

use chrono::{Datelike, Timelike};
use parking_lot::RwLock;
use typst::diag::{FileError, FileResult};
use typst::foundations::{Bytes, Datetime, Duration};
use typst::syntax::{FileId, Source};
use typst::text::{Font, FontBook};
use typst::utils::LazyHash;
use typst::{Library, LibraryExt, World};

use super::font_loader::{FontLoader, SystemFontLoader};

/// The production [`World`] for Typst Studio: one in-memory document, edited
/// in place, compiled repeatedly.
pub struct EditorWorld {
    /// The standard library, hashed once at construction. Cheap to borrow.
    library: LazyHash<Library>,
    /// The editable main source. Interior-mutable so `&self` World methods can
    /// read while `set_text` mutates.
    source: RwLock<Source>,
    /// File id of the main source. Stable across text edits (only the content
    /// changes), so we read it once and cache it to avoid locking in `main()`.
    source_id: FileId,
    /// Font book + lazy font loader.
    fonts: SystemFontLoader,
    /// "Today" frozen at construction. Typst's `datetime` functions read this.
    today: chrono::DateTime<chrono::Utc>,
}

impl EditorWorld {
    /// Create a new world seeded with the given source text, using the full
    /// system + embedded font set.
    pub fn new(initial_text: impl Into<String>) -> Self {
        Self::with_font_loader(initial_text, SystemFontLoader::new())
    }

    /// Create a new world backed by a specific font loader. Useful for tests
    /// that want the deterministic, embedded-only set.
    pub fn with_font_loader(initial_text: impl Into<String>, fonts: SystemFontLoader) -> Self {
        let source = Source::detached(initial_text.into());
        let source_id = source.id();
        Self {
            library: LazyHash::new(Library::default()),
            source: RwLock::new(source),
            source_id,
            fonts,
            today: chrono::Utc::now(),
        }
    }

    /// Replace the entire source text in place.
    ///
    /// Takes `&self` (interior mutability) so a shared `Arc<EditorWorld>` can
    /// be updated by the editor thread while the scheduler holds a reference.
    /// Uses [`Source::replace`] to do a minimal diff + incremental reparse,
    /// preserving syntax-node identity for comemo.
    pub fn set_text(&self, text: String) {
        self.source.write().replace(&text);
    }

    /// The current source text.
    pub fn text(&self) -> String {
        self.source.read().text().to_string()
    }

    /// A snapshot of the main [`Source`] (cheap — `Source` is reference-counted).
    pub fn main_source(&self) -> Source {
        self.source.read().clone()
    }
}

impl World for EditorWorld {
    fn library(&self) -> &LazyHash<Library> {
        &self.library
    }

    fn book(&self) -> &LazyHash<FontBook> {
        self.fonts.book()
    }

    fn main(&self) -> FileId {
        self.source_id
    }

    fn source(&self, id: FileId) -> FileResult<Source> {
        if id == self.source_id {
            // `Source` is `Arc<..>`, so clone is just a refcount bump.
            Ok(self.source.read().clone())
        } else {
            Err(FileError::NotFound(PathBuf::from(
                id.vpath().get_with_slash().to_owned(),
            )))
        }
    }

    fn file(&self, id: FileId) -> FileResult<Bytes> {
        // MVP decision: `#include` / `#read` / `image` of external files is
        // disabled. Only the in-memory main source is compilable.
        Err(FileError::NotFound(PathBuf::from(
            id.vpath().get_with_slash().to_owned(),
        )))
    }

    fn font(&self, index: usize) -> Option<Font> {
        self.fonts.font(index)
    }

    fn today(&self, _offset: Option<Duration>) -> Option<Datetime> {
        // The offset would select a timezone; for the MVP we always report the
        // UTC timestamp captured at construction.
        let now = self.today;
        Datetime::from_ymd_hms(
            now.year(),
            now.month() as u8,
            now.day() as u8,
            now.hour() as u8,
            now.minute() as u8,
            now.second() as u8,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn embedded_world(text: &str) -> EditorWorld {
        // Embedded-only keeps tests fast and deterministic (no system scan).
        EditorWorld::with_font_loader(text, SystemFontLoader::embedded_only())
    }

    #[test]
    fn main_id_is_stable_across_edits() {
        let world = embedded_world("Hello");
        let id_before = world.main();
        world.set_text("Completely different text".to_string());
        let id_after = world.main();
        assert_eq!(id_before, id_after, "file id must not change on edit");
    }

    #[test]
    fn text_reflects_latest_edit() {
        let world = embedded_world("one");
        assert_eq!(world.text(), "one");
        world.set_text("two".to_string());
        assert_eq!(world.text(), "two");
    }

    #[test]
    fn source_returns_main_source() {
        let world = embedded_world("#set page(width: 10cm)");
        let src = world.source(world.main()).expect("main source should resolve");
        assert_eq!(src.id(), world.main());
        assert!(src.text().contains("10cm"));
    }

    #[test]
    fn source_returns_not_found_for_other_files() {
        let world = embedded_world("Hi");
        // Build a genuinely different file id (`other.typ`). Note: a second
        // `Source::detached` would reuse the same `/main.typ` id, so we must
        // construct one explicitly.
        let other = FileId::new(
            typst::syntax::RootedPath::new(
                typst::syntax::VirtualRoot::Project,
                typst::syntax::VirtualPath::new("other.typ").expect("valid path"),
            ),
        );
        assert_ne!(other, world.main());
        let err = world.source(other);
        assert!(err.is_err(), "non-main files must not resolve");
    }

    #[test]
    fn file_is_always_disabled() {
        let world = embedded_world("Hi");
        let res = world.file(world.main());
        assert!(res.is_err(), "#include / #read must be disabled (MVP)");
    }

    #[test]
    fn today_returns_some_datetime() {
        let world = embedded_world("");
        // Call the `World::today` trait method directly (no inherent shadow).
        assert!(
            World::today(&world, None).is_some(),
            "today() should yield a date"
        );
    }

    #[test]
    fn world_is_send_sync() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<EditorWorld>();
    }
}
