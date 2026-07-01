//! `SourceProvider` — abstracts where the editor's main source comes from.
//!
//! The trait lets the scheduler (Phase 4) swap between in-memory text, a file
//! watcher, or a language-server-backed buffer without touching the world.
//!
//! Note: [`EditorWorld`](super::world::EditorWorld) does *not* use this trait
//! directly — it owns its [`Source`] and edits it in place (via
//! [`Source::replace`]) to preserve incremental-reparse identity for comemo.
//! `InMemorySource` is the simpler, "rebuild each call" variant suitable for
//! tests and throwaway worlds that don't need cross-edit incremental caching.

use parking_lot::RwLock;
use typst::diag::FileResult;
use typst::syntax::Source;

/// Provides the main Typst source file to a [`typst::World`] implementation.
pub trait SourceProvider: Send + Sync {
    /// The main source, as a fully-parsed [`Source`].
    fn main_source(&self) -> FileResult<Source>;
}

/// A [`SourceProvider`] backed by a single in-memory string.
///
/// The text is stored behind a [`RwLock`] so it can be updated from a different
/// thread than the one compiling (e.g. the editor thread vs. the compile task).
/// Each call to [`main_source`](SourceProvider::main_source) re-parses the text
/// into a fresh detached [`Source`].
pub struct InMemorySource {
    text: RwLock<String>,
}

impl InMemorySource {
    /// Create a new source seeded with the given text.
    pub fn new(text: impl Into<String>) -> Self {
        Self {
            text: RwLock::new(text.into()),
        }
    }

    /// Replace the entire source text.
    pub fn set_text(&self, text: String) {
        *self.text.write() = text;
    }

    /// A snapshot of the current text.
    pub fn text(&self) -> String {
        self.text.read().clone()
    }
}

impl SourceProvider for InMemorySource {
    fn main_source(&self) -> FileResult<Source> {
        Ok(Source::detached(self.text.read().clone()))
    }
}

impl Default for InMemorySource {
    fn default() -> Self {
        Self::new(String::new())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn main_source_reflects_latest_text() {
        let src = InMemorySource::new("Hello");
        let first = src.main_source().expect("first source");
        assert_eq!(first.text(), "Hello");

        src.set_text("World".to_string());
        let second = src.main_source().expect("second source");
        assert_eq!(second.text(), "World");
    }

    #[test]
    fn set_text_updates_snapshot() {
        let src = InMemorySource::default();
        assert_eq!(src.text(), "");
        src.set_text("#set page(width: 10cm)".to_string());
        assert_eq!(src.text(), "#set page(width: 10cm)");
    }

    #[test]
    fn source_is_send_sync() {
        fn assert_send_sync<T: Send + Sync + ?Sized>() {}
        assert_send_sync::<InMemorySource>();
        assert_send_sync::<dyn SourceProvider>();
    }
}
