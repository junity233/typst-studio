//! `FontLoader` — abstracts font discovery so the source of fonts (system,
//! embedded, a custom directory) can be swapped without touching the world.
//!
//! In typst 0.15 there is no `Fonts` builder; the concrete handle is
//! [`typst_kit::fonts::FontStore`], which owns a [`LazyHash<FontBook>`] and
//! resolves fonts by index on demand. `SystemFontLoader` wraps a `FontStore`
//! populated with the embedded fallback fonts plus every font discoverable on
//! the host system (via the `scan-fonts` feature of `typst-kit`), plus any
//! user-configured extra directories (the `compiler.extraFontDirs` setting).

use std::sync::{Arc, OnceLock};

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

/// Process-wide cache of the full font store (embedded + system scan + any
/// user-configured extra directories).
///
/// The system font scan (`typst_kit::fonts::system()`) walks every host font
/// directory and is the dominant cost of building a World — hundreds of
/// milliseconds on macOS. It is identical for every tab, so we build it exactly
/// once per process and share the `FontStore` (cheaply, via `Arc`) across every
/// `EditorWorld`. Opening a second tab no longer re-scans.
///
/// Initialized eagerly at app startup via [`warm()`] (called from `lib.rs`
/// `.setup()`) so the first tab open isn't delayed by the scan. `warm()` takes
/// the user-configured extra font directories (the `compiler.extraFontDirs`
/// setting) so they are folded into the one-time scan; the `OnceLock` fallback
/// (empty extra dirs) is the safety net if any code path constructs a World
/// before `warm()` runs.
static SYSTEM_FONTS: OnceLock<Arc<FontStore>> = OnceLock::new();

/// Build the process-wide `FontStore`: embedded fallbacks + every host system
/// font + every font discoverable under each path in `extra_dirs`. Non-existent
/// / unreadable extra directories are skipped (best-effort: a bad entry must
/// not block font loading).
fn build_store(extra_dirs: &[std::path::PathBuf]) -> Arc<FontStore> {
    let mut store = FontStore::new();
    // Bundled fallback fonts (New Computer Modern family, etc.). Always
    // available, so the editor renders even on a font-less host.
    store.extend(typst_kit::fonts::embedded());
    // Host fonts. `system()` is gated by typst-kit's `scan-fonts` feature,
    // which is enabled in Cargo.toml. Fonts are loaded lazily from disk by
    // `FontStore::font`, so this only records their metadata.
    store.extend(typst_kit::fonts::system());
    // User-configured extra directories (the `compiler.extraFontDirs` setting).
    // `scan(path)` recurses a directory and yields `(FontPath, FontInfo)` the
    // store accepts directly. A missing/unreadable dir just yields nothing.
    for dir in extra_dirs {
        store.extend(typst_kit::fonts::scan(dir));
    }
    Arc::new(store)
}

/// Pre-build the process-wide font store, folding in `extra_dirs` (the
/// `compiler.extraFontDirs` setting). Call once at app startup (before the
/// first tab opens) so the system font scan doesn't delay the first open. Safe
/// to call any number of times; only the FIRST call's `extra_dirs` take effect
/// — the store is process-wide and not rebuilt. Changing extra font dirs
/// therefore requires an app restart to take effect.
pub fn warm(extra_dirs: &[std::path::PathBuf]) {
    SYSTEM_FONTS.get_or_init(|| build_store(extra_dirs));
}

/// Access the process-wide font store, initializing it with no extra dirs if
/// `warm()` hasn't run yet (the safety net for any World built before startup
/// warms it — e.g. some test paths).
fn store() -> Arc<FontStore> {
    SYSTEM_FONTS
        .get_or_init(|| build_store(&[]))
        .clone()
}

/// All known font family names (original case, sorted, deduped), drawn from the
/// process-wide warmed font store. Used by the Settings font picker so the user
/// can choose from the same set the compiler sees. Cheap after the first World
/// build (the scan ran at startup via [`warm`]); before that it lazily builds
/// an empty-extra-dirs store via the [`store`] safety net.
pub fn list_families() -> Vec<String> {
    let mut names: Vec<String> = store()
        .book()
        .families()
        .map(|(name, _)| name.to_string())
        .collect();
    names.sort();
    names.dedup();
    names
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
    /// found by scanning the host system font directories (plus any
    /// user-configured extra directories). The expensive scan runs once per
    /// process (see [`SYSTEM_FONTS`] / [`warm`]); subsequent calls just bump
    /// the `Arc` refcount.
    pub fn new() -> Self {
        Self {
            fonts: store(),
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
