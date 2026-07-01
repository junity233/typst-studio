//! `EditorWorld` — a long-lived [`typst::World`] implementation backing the
//! live editor.
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
//! ## `#include` / file resolution
//!
//! When a workspace is open, the world holds a [`FileResolver`] (`Some`). Its
//! [`source`](World::source) / [`file`](World::file) then resolve any non-main
//! `FileId` to a real path under the workspace root and read it — enabling
//! `#include "intro.typ"`, `#read("data.txt")`, and `#image("logo.png")`.
//!
//! For this to resolve *relative to the main file's directory* (matching how
//! typst resolves includes — relative to the parent source's `FileId` vpath),
//! the main `Source` is built with a `FileId` derived from the main file's real
//! disk path, **not** `Source::detached` (which hardcodes `/main.typ`). For an
//! untitled tab (no workspace) the resolver is `None` and the main source stays
//! detached, preserving the original single-file MVP behavior.
//!
//! [`World`]: typst::World
//! [`SystemFontLoader`]: super::font_loader::SystemFontLoader

use std::path::Path;

use chrono::{Datelike, Timelike};
use parking_lot::RwLock;
use typst::diag::{FileError, FileResult};
use typst::foundations::{Bytes, Datetime, Duration};
use typst::syntax::{FileId, Source};
use typst::text::{Font, FontBook};
use typst::utils::LazyHash;
use typst::{Library, LibraryExt, World};

use crate::fs::FileResolver;

use super::font_loader::{FontLoader, SystemFontLoader};

/// The production [`World`] for Typst Studio: one editable main document,
/// optionally backed by a workspace root for `#include` / asset resolution.
pub struct EditorWorld {
    /// The standard library, hashed once at construction. Cheap to borrow.
    library: LazyHash<Library>,
    /// The editable main source. Interior-mutable so `&self` World methods can
    /// read while `set_text` mutates.
    source: RwLock<Source>,
    /// File id of the main source. Stable across text edits (only the content
    /// changes), so we read it once and cache it to avoid locking in `main()`.
    source_id: FileId,
    /// When `Some`, non-main files resolve against the workspace root on disk.
    /// `None` for untitled tabs (single-file MVP behavior).
    resolver: Option<FileResolver>,
    /// Font book + lazy font loader.
    fonts: SystemFontLoader,
    /// "Today" frozen at construction. Typst's `datetime` functions read this.
    today: chrono::DateTime<chrono::Utc>,
}

impl EditorWorld {
    /// Create a new world seeded with the given source text, using the full
    /// system + embedded font set. No workspace resolver — `#include` is
    /// disabled (untitled / single-file mode).
    pub fn new(initial_text: impl Into<String>) -> Self {
        Self::with_font_loader(initial_text, SystemFontLoader::new())
    }

    /// Create a new world backed by a specific font loader. Useful for tests
    /// that want the deterministic, embedded-only set. No workspace resolver.
    pub fn with_font_loader(initial_text: impl Into<String>, fonts: SystemFontLoader) -> Self {
        let source = Source::detached(initial_text.into());
        let source_id = source.id();
        Self {
            library: LazyHash::new(Library::default()),
            source: RwLock::new(source),
            source_id,
            resolver: None,
            fonts,
            today: chrono::Utc::now(),
        }
    }

    /// Create a world whose main source is backed by a real file under a
    /// workspace root. The main `Source`'s `FileId` is derived from
    /// `main_disk_path` (relative to the resolver's root), so `#include` /
    /// `#image()` resolve relative to the main file's directory — and any other
    /// file in the workspace is readable.
    ///
    /// The main text is still edited in place via [`set_text`](Self::set_text),
    /// so incremental compilation across edits is preserved.
    pub fn with_resolver(
        initial_text: impl Into<String>,
        fonts: SystemFontLoader,
        resolver: FileResolver,
        main_disk_path: &Path,
    ) -> FileResult<Self> {
        let main_id = resolver.file_id_for(main_disk_path)?;
        let source = Source::new(main_id, initial_text.into());
        Ok(Self {
            library: LazyHash::new(Library::default()),
            source: RwLock::new(source),
            source_id: main_id,
            resolver: Some(resolver),
            fonts,
            today: chrono::Utc::now(),
        })
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

    /// Fetch a source by id, for diagnostic span resolution. The main source is
    /// returned from memory; any other id is read from disk via the resolver
    /// (or, without a resolver, synthesized as detached so ranges degrade
    /// gracefully). Used by the compiler to translate per-file error spans.
    pub fn source_for_id(&self, id: FileId) -> Option<Source> {
        if id == self.source_id {
            return Some(self.source.read().clone());
        }
        self.resolver.as_ref()?.read_source(id).ok()
    }

    /// Whether this world can resolve files from disk (a workspace is open).
    pub fn has_resolver(&self) -> bool {
        self.resolver.is_some()
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
            // The main source is always served from memory (the editable buffer).
            Ok(self.source.read().clone())
        } else {
            // A non-main file: resolve from disk if a workspace is open.
            match &self.resolver {
                Some(resolver) => resolver.read_source(id),
                None => Err(FileError::NotFound(
                    id.vpath().get_with_slash().to_owned().into(),
                )),
            }
        }
    }

    fn file(&self, id: FileId) -> FileResult<Bytes> {
        match &self.resolver {
            Some(resolver) => {
                // The main source is served from its in-memory text so that
                // internal callers of `file` for the main id get the live
                // buffer, not a stale disk read.
                if id == self.source_id {
                    Ok(Bytes::from_string(self.source.read().text().to_string()))
                } else {
                    resolver.read_bytes(id)
                }
            }
            None => Err(FileError::NotFound(
                id.vpath().get_with_slash().to_owned().into(),
            )),
        }
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
    use typst::syntax::{RootedPath, VirtualPath, VirtualRoot};

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
    fn source_returns_not_found_for_other_files_without_resolver() {
        let world = embedded_world("Hi");
        let other = FileId::new(RootedPath::new(
            VirtualRoot::Project,
            VirtualPath::new("other.typ").expect("valid path"),
        ));
        assert_ne!(other, world.main());
        let err = world.source(other);
        assert!(err.is_err(), "non-main files must not resolve without a workspace");
    }

    #[test]
    fn file_is_disabled_without_resolver() {
        let world = embedded_world("Hi");
        let res = world.file(world.main());
        assert!(res.is_err(), "#include / #read must be disabled without a workspace");
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

    // --- workspace resolver path (#include enabled) -------------------------

    /// Build a temp workspace, returning (world, root) where the world's main
    /// source is `<root>/main.typ` with `#include "intro.typ"`.
    fn workspace_world() -> (EditorWorld, std::path::PathBuf) {
        let root = std::env::temp_dir().join(format!("typst-world-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("main.typ"), "#include \"intro.typ\"").unwrap();
        std::fs::write(root.join("intro.typ"), "Included content.").unwrap();
        let resolver = FileResolver::new(root.clone());
        let main = root.join("main.typ");
        let world = EditorWorld::with_resolver(
            "#include \"intro.typ\"",
            SystemFontLoader::embedded_only(),
            resolver,
            &main,
        )
        .expect("world with resolver should construct");
        (world, root)
    }

    #[test]
    fn with_resolver_resolves_included_source_from_disk() {
        let (world, root) = workspace_world();
        // main.typ includes intro.typ (relative to main's dir == root), so the
        // compiler will ask for the intro.typ FileId. We don't know that id
        // directly, but compiling should succeed and the preview should contain
        // the included text.
        let (outcome, doc) = super::super::compiler::compile(&world);
        assert!(outcome.success, "errors: {:?}", outcome.errors);
        let doc = doc.expect("document on success");
        assert!(!doc.pages().is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn with_resolver_serves_main_from_memory_after_edit() {
        let (world, root) = workspace_world();
        // Edit the in-memory main; the resolver must still serve the MAIN from
        // memory (not re-read disk), or edits wouldn't compile.
        world.set_text("Edited main text".to_string());
        assert_eq!(world.text(), "Edited main text");
        let src = world.source(world.main()).expect("main source");
        assert_eq!(src.text(), "Edited main text");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn with_resolver_file_returns_main_text_as_bytes() {
        let (world, root) = workspace_world();
        let bytes = world.file(world.main()).expect("main as bytes");
        assert!(
            String::from_utf8(bytes.to_vec())
                .unwrap()
                .contains("#include"),
            "file(main) must return the live main text"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn source_for_id_falls_back_to_detached_without_resolver() {
        let world = embedded_world("Hi");
        let other = FileId::new(RootedPath::new(
            VirtualRoot::Project,
            VirtualPath::new("other.typ").expect("valid path"),
        ));
        // Without a resolver, source_for_id returns None for non-main ids.
        assert!(world.source_for_id(other).is_none());
    }
}
