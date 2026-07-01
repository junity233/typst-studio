//! `FontLoader` — abstracts font discovery so the source of fonts (system,
//! embedded, a custom directory) can be swapped without touching the world.
//!
//! In typst 0.15 there is no `Fonts` builder; the concrete handle is
//! [`typst_kit::fonts::FontStore`], which owns a [`LazyHash<FontBook>`] and
//! resolves fonts by index on demand. `SystemFontLoader` wraps a `FontStore`
//! populated with the embedded fallback fonts plus every font discoverable on
//! the host system (via the `scan-fonts` feature of `typst-kit`).

use std::sync::{Arc, LazyLock};

use typst::text::{Font, FontBook};
use typst::utils::LazyHash;
use typst_kit::fonts::FontStore;

/// Read access to the font collection exposed by a [`typst::World`].
pub trait FontLoader: Send + Sync {
    /// Metadata describing every known font.
    fn book(&self) -> &LazyHash<FontBook>;

    /// Resolve the font at the given book index, loading it if necessary.
    fn font(&self, id: usize) -> Option<Font>;
}

/// Process-wide cache of the full font store (embedded + system scan).
///
/// The system font scan (`typst_kit::fonts::system()`) walks every host font
/// directory and is the dominant cost of building a World — hundreds of
/// milliseconds on macOS. It is identical for every tab, so we build it exactly
/// once per process and share the `FontStore` (cheaply, via `Arc`) across every
/// `EditorWorld`. Opening a second tab no longer re-scans.
///
/// Initialized eagerly at app startup via [`warm()`] (called from `lib.rs`
/// `.setup()`) so the first tab open isn't delayed by the scan; the `LazyLock`
/// is the safety net if any code path constructs a World before `warm()` runs.
static SYSTEM_FONTS: LazyLock<Arc<FontStore>> = LazyLock::new(|| {
    let mut store = FontStore::new();
    // Bundled fallback fonts (New Computer Modern family, etc.). Always
    // available, so the editor renders even on a font-less host.
    store.extend(typst_kit::fonts::embedded());
    // Host fonts. `system()` is gated by typst-kit's `scan-fonts` feature,
    // which is enabled in Cargo.toml. Fonts are loaded lazily from disk by
    // `FontStore::font`, so this only records their metadata.
    store.extend(typst_kit::fonts::system());
    Arc::new(store)
});

/// Pre-build the process-wide font store. Call once at app startup (before the
/// first tab opens) so the system font scan doesn't delay the first open. Safe
/// to call any number of times; a no-op after the first.
pub fn warm() {
    let _ = &*SYSTEM_FONTS;
}

/// A [`FontLoader`] backed by typst-kit's embedded fonts + a system font scan.
///
/// Cheap to clone (the underlying `FontStore` is shared via `Arc`) — every
/// `EditorWorld` gets a handle to the single process-wide font collection.
#[derive(Clone)]
pub struct SystemFontLoader {
    fonts: Arc<FontStore>,
}

impl SystemFontLoader {
    /// Build a loader containing the bundled embedded fonts and every font
    /// found by scanning the host system font directories. The expensive scan
    /// runs once per process (see [`SYSTEM_FONTS`] / [`warm`]); subsequent
    /// calls just bump the `Arc` refcount.
    pub fn new() -> Self {
        Self {
            fonts: SYSTEM_FONTS.clone(),
        }
    }

    /// Build a loader containing *only* the embedded fallback fonts (no system
    /// scan). Cheaper and fully deterministic — handy for tests.
    pub fn embedded_only() -> Self {
        let mut store = FontStore::new();
        store.extend(typst_kit::fonts::embedded());
        Self {
            fonts: Arc::new(store),
        }
    }
}

impl Default for SystemFontLoader {
    fn default() -> Self {
        Self::new()
    }
}

impl FontLoader for SystemFontLoader {
    fn book(&self) -> &LazyHash<FontBook> {
        self.fonts.book()
    }

    fn font(&self, id: usize) -> Option<Font> {
        self.fonts.font(id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_loader_has_nonempty_book() {
        let loader = SystemFontLoader::embedded_only();
        // `FontBook` exposes no `len`, but resolving index 0 proves the book
        // holds at least one face. The embedded set ships several (regular,
        // bold, italic, math, mono, ...).
        assert!(
            loader.font(0).is_some(),
            "index 0 should resolve to an embedded font"
        );
    }

    #[test]
    fn can_resolve_a_font_by_index() {
        let loader = SystemFontLoader::embedded_only();
        let font = loader
            .font(0)
            .expect("index 0 should resolve to an embedded font");
        let info = font.info();
        // The embedded family is "New Computer Modern"; just sanity-check we
        // got *some* family name back.
        assert!(
            !info.family.is_empty(),
            "resolved font should have a family name"
        );
    }

    #[test]
    fn out_of_range_index_is_none() {
        let loader = SystemFontLoader::embedded_only();
        assert!(
            loader.font(usize::MAX).is_none(),
            "index past the end should be None"
        );
    }

    #[test]
    fn loader_is_send_sync() {
        fn assert_send_sync<T: Send + Sync + ?Sized>() {}
        assert_send_sync::<SystemFontLoader>();
        assert_send_sync::<dyn FontLoader>();
    }
}
