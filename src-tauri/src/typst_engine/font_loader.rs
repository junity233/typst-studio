//! `FontLoader` — abstracts font discovery so the source of fonts (system,
//! embedded, a custom directory) can be swapped without touching the world.
//!
//! In typst 0.15 there is no `Fonts` builder; the concrete handle is
//! [`typst_kit::fonts::FontStore`], which owns a [`LazyHash<FontBook>`] and
//! resolves fonts by index on demand. `SystemFontLoader` wraps a `FontStore`
//! populated with the embedded fallback fonts plus every font discoverable on
//! the host system (via the `scan-fonts` feature of `typst-kit`).

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

/// A [`FontLoader`] backed by typst-kit's embedded fonts + a system font scan.
pub struct SystemFontLoader {
    fonts: FontStore,
}

impl SystemFontLoader {
    /// Build a loader containing the bundled embedded fonts and every font
    /// found by scanning the host system font directories.
    pub fn new() -> Self {
        let mut store = FontStore::new();
        // Bundled fallback fonts (New Computer Modern family, etc.). Always
        // available, so the editor renders even on a font-less host.
        store.extend(typst_kit::fonts::embedded());
        // Host fonts. `system()` is gated by typst-kit's `scan-fonts` feature,
        // which is enabled in Cargo.toml. Fonts are loaded lazily from disk by
        // `FontStore::font`, so this only records their metadata.
        store.extend(typst_kit::fonts::system());
        Self { fonts: store }
    }

    /// Build a loader containing *only* the embedded fallback fonts (no system
    /// scan). Cheaper and fully deterministic — handy for tests.
    pub fn embedded_only() -> Self {
        let mut store = FontStore::new();
        store.extend(typst_kit::fonts::embedded());
        Self { fonts: store }
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
