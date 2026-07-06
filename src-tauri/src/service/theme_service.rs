//! User CSS theme discovery + hot-reload service.
//!
//! Themes live in `<app_config_dir>/themes/<id>/`, each folder containing a
//! `theme.json` (metadata) and a `theme.css` (the user-authored stylesheet that
//! overrides the `:root` tokens defined in `src/styles/global.css`). The
//! folder name is the stable theme `id` (stored in the `appearance.theme`
//! setting); `name`/`description` come from `theme.json`.
//!
//! In addition to user themes on disk, a set of **built-in** themes is compiled
//! into the binary via `include_str!` (see [`BUILT_IN_THEMES`]). Built-ins are
//! listed first in the picker and their CSS is served from the embedded
//! constant. A user theme with the same `id` as a built-in **overrides** the
//! built-in: the picker shows the user's metadata and `css_for` reads the
//! user's `theme.css` from disk — so built-ins double as editable presets.
//!
//! The service scans the themes directory once at construction, caches the
//! result, and watches the directory for changes. On any change it re-scans and
//! emits a `themes_changed` Tauri event so the frontend can refresh the theme
//! picker and re-apply the current theme's CSS without a restart (hot reload).
//!
//! The special id `"default"` means "no user CSS — use the built-in light
//! tokens"; it is never present on disk and `css_for("default")` returns
//! `None`.
//!
//! All failures (missing dir, unreadable json, missing css) are tolerated: a
//! malformed theme is simply skipped, never blocking app startup. This mirrors
//! the non-fatal watcher style of `WorkspaceService`.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter as _};

use crate::fs::watcher;

/// The metadata read from a theme's `theme.json`. Fields are optional and
/// degrade gracefully: a missing/invalid `theme.json` falls back to the folder
/// name for `name` and empty for `description`, so a theme that consists of
/// only `theme.css` still appears in the picker.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    ts(export_to = "../../src/lib/types.ts")
)]
pub struct ThemeInfo {
    /// Stable id (the theme's folder name). Used as the stored value of the
    /// `appearance.theme` setting.
    pub id: String,
    /// Friendly display name. Falls back to `id` when `theme.json` omits it.
    pub name: String,
    /// Short description shown under the name in the picker. Empty string when
    /// absent.
    pub description: String,
    /// Light/Dark hint. `"all"` (default) means "no preference". Recorded for
    /// future Monaco/preview-background linkage; not yet acted on.
    pub base: String,
}

/// The raw shape of `theme.json` — every field optional so a partial file
/// still yields a usable `ThemeInfo`.
#[derive(Debug, Default, Deserialize)]
struct ThemeManifest {
    name: Option<String>,
    description: Option<String>,
    base: Option<String>,
}

/// Payload of the `themes_changed` event: the full refreshed theme list,
/// emitted by this service's watcher whenever the themes directory changes (a
/// theme added/removed/edited). The frontend replaces its picker options and
/// re-applies the current theme's CSS.
///
/// Defined here (not in `ipc::events`) so the service layer has no reverse
/// dependency on the IPC layer — `ipc::events` re-exports it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    ts(export_to = "../../src/lib/types.ts")
)]
pub struct ThemesChangedPayload {
    pub themes: Vec<ThemeInfo>,
}

/// One compiled-in built-in theme: metadata (as `&'static str` so the whole
/// table can live in a `static`) + CSS embedded via `include_str!`. The CSS
/// path is relative to this file (`src/service/theme_service.rs`), the same
/// `include_str!` pattern used for the settings manifest (see
/// `settings/manifest.rs`). Built-in themes ship with the binary; a user theme
/// with the same `id` overrides the built-in (see [`ThemeService::list`] and
/// [`ThemeService::css_for`]). Use [`BuiltInTheme::info`] to build a
/// [`ThemeInfo`] (owned `String`s) on demand.
struct BuiltInTheme {
    id: &'static str,
    name: &'static str,
    description: &'static str,
    base: &'static str,
    css: &'static str,
}

impl BuiltInTheme {
    /// Build an owned [`ThemeInfo`] from this built-in's `&'static str` fields.
    fn info(&self) -> ThemeInfo {
        ThemeInfo {
            id: self.id.to_string(),
            name: self.name.to_string(),
            description: self.description.to_string(),
            base: self.base.to_string(),
        }
    }
}

/// Built-in themes, in picker display order. To add a new built-in, drop a
/// `<id>/{theme.css,theme.json}` under `src-tauri/themes/` and add an entry
/// here. A user can override any of these by creating a same-named folder in
/// their `<app_config_dir>/themes/` — the picker then shows the user's
/// metadata and `css_for` serves the user's CSS.
static BUILT_IN_THEMES: &[BuiltInTheme] = &[
    BuiltInTheme {
        id: "carbon-dark",
        name: "Carbon Dark",
        description: "True-black dark theme; near-black surfaces with a blue accent.",
        base: "dark",
        css: include_str!("../../themes/carbon-dark/theme.css"),
    },
    BuiltInTheme {
        id: "graphite",
        name: "Graphite",
        description: "Soft warm-grey dark theme; reduced contrast for long writing sessions.",
        base: "dark",
        css: include_str!("../../themes/graphite/theme.css"),
    },
    BuiltInTheme {
        id: "sepia",
        name: "Sepia",
        description: "Warm cream/brown light theme; reading-comfort oriented like an e-reader.",
        base: "light",
        css: include_str!("../../themes/sepia/theme.css"),
    },
    BuiltInTheme {
        id: "accent-green",
        name: "Accent Green",
        description: "Default chrome with a green accent.",
        base: "light",
        css: include_str!("../../themes/accent-green/theme.css"),
    },
    BuiltInTheme {
        id: "accent-indigo",
        name: "Accent Indigo",
        description: "Default chrome with an indigo accent.",
        base: "light",
        css: include_str!("../../themes/accent-indigo/theme.css"),
    },
    BuiltInTheme {
        id: "accent-purple",
        name: "Accent Purple",
        description: "Default chrome with a purple accent.",
        base: "light",
        css: include_str!("../../themes/accent-purple/theme.css"),
    },
];

/// The theme discovery + hot-reload service. Constructed once in `.setup` and
/// shared via `AppState`.
pub struct ThemeService {
    /// `<app_config_dir>/themes/`. May not exist on disk; that just means
    /// "no user themes" and is not an error.
    themes_dir: PathBuf,
    /// Cached scan result. Shared with the watcher callback (as an `Arc`) so a
    /// `'static` closure can refresh it in place — keeping `list()` /
    /// `css_for()` consistent with the `themes_changed` payload they emit.
    themes: Arc<RwLock<Vec<ThemeInfo>>>,
    /// Keeps the themes-dir watcher alive. Dropped on service drop, which
    /// stops the watcher (see [`watcher::WatcherGuard`]).
    watcher: RwLock<Option<watcher::WatcherGuard>>,
    /// Cloned into the watcher callback so it can emit `themes_changed`. `None`
    /// in tests (mirrors `SaveCoordinator`'s `Option<AppHandle>` pattern) — the
    /// watcher is simply not started in that case.
    app: Option<AppHandle>,
}

impl ThemeService {
    /// Construct, ensure the themes dir exists (best-effort), and populate the
    /// cache with an initial scan. Never fails: a missing/unreadable dir just
    /// yields an empty theme list.
    pub fn new(themes_dir: PathBuf, app: AppHandle) -> Self {
        Self::new_opt(themes_dir, Some(app))
    }

    /// Construct with an optional `AppHandle`. `None` skips the watcher's emit
    /// path (used in tests); the cache is still populated and refreshable via
    /// `scan`. Public `new` is the production entry point that always has a
    /// handle.
    fn new_opt(themes_dir: PathBuf, app: Option<AppHandle>) -> Self {
        if let Err(e) = std::fs::create_dir_all(&themes_dir) {
            tracing::warn!(
                error = %e,
                dir = %themes_dir.display(),
                "themes: could not create themes directory; user themes disabled",
            );
        }
        let svc = Self {
            themes_dir,
            themes: Arc::new(RwLock::new(Vec::new())),
            watcher: RwLock::new(None),
            app,
        };
        let scanned = svc.scan();
        tracing::info!(count = scanned.len(), "themes: initial scan complete");
        svc
    }

    /// Re-scan the themes directory and update the cache. Returns the freshly
    /// scanned list (a clone). Safe to call from any thread (the cache is a
    /// `parking_lot::RwLock`); called both from `new()` and the watcher flush
    /// thread.
    pub fn scan(&self) -> Vec<ThemeInfo> {
        let found = read_themes_dir(&self.themes_dir);
        *self.themes.write() = found.clone();
        found
    }

    /// The merged theme catalog: built-in themes first (in their defined
    /// order), then any user themes not shadowed by a built-in. A user theme
    /// whose `id` matches a built-in **overrides** the built-in entry (the
    /// user's metadata wins in the picker), so users can retitle/retint a
    /// built-in by dropping a same-named folder in their themes dir. Reflects
    /// the latest scan (the watcher refreshes the cache in place).
    pub fn list(&self) -> Vec<ThemeInfo> {
        let user = self.themes.read().clone();
        merge_builtin_and_user(&user)
    }

    /// Read the CSS source for `id`. Returns `None` for the built-in default
    /// theme or any unreadable theme (the frontend falls back to default in
    /// that case). Resolution order: (1) the special `"default"` id → `None`;
    /// (2) a user theme on disk with this id (validated against the cached
    /// scan, so a forged `../path` id can never reach disk) — this lets a user
    /// theme **override** a built-in; (3) a compiled-in built-in constant.
    pub fn css_for(&self, id: &str) -> Option<String> {
        if id.eq_ignore_ascii_case("default") {
            return None;
        }
        // Prefer a user theme on disk if one exists with this id — a user can
        // override a built-in by dropping a same-named folder in themes dir.
        // `css_for_in` gates the read on the scanned cache, guarding traversal.
        let cached = self.themes.read().clone();
        if let Some(css) = css_for_in(&self.themes_dir, &cached, id) {
            return Some(css);
        }
        // Otherwise serve the compiled-in built-in (if any).
        BUILT_IN_THEMES
            .iter()
            .find(|t| t.id == id)
            .map(|t| t.css.to_string())
    }

    /// The resolved themes directory (for the "open themes folder" action).
    pub fn themes_dir(&self) -> &Path {
        &self.themes_dir
    }

    /// Start watching the themes directory for changes. On each debounced batch
    /// the service re-scans and emits `themes_changed` with the new full list.
    /// Failure is non-fatal (logged); the picker still works, just without
    /// live updates (a restart re-scans).
    pub fn start_watcher(&self) {
        // If the dir doesn't exist (create_dir_all failed in `new`), don't
        // attempt to watch — `notify` would error anyway.
        if !self.themes_dir.is_dir() {
            tracing::debug!("themes: skipping watcher — directory absent");
            return;
        }
        // No AppHandle (tests) → nothing to emit; skip the watcher entirely.
        // The cache is still refreshable via `scan()`.
        let Some(app) = self.app.clone() else {
            tracing::debug!("themes: skipping watcher — no AppHandle (test mode)");
            return;
        };
        // The callback shares the cache (`Arc<RwLock<...>>`) so it can refresh
        // it in place — keeping `list()` / `css_for()` consistent with the
        // `themes_changed` payload. Without this, a freshly-added theme would
        // appear in the picker (the frontend gets the event) but selecting it
        // would no-op: `css_for` gates the read on the stale cache.
        let themes_dir = self.themes_dir.clone();
        let themes_cache = Arc::clone(&self.themes);
        let on_change: watcher::OnChange = Arc::new(move |_paths: &[PathBuf]| {
            let user = read_themes_dir(&themes_dir);
            // Update the cache from the same scan that produced the payload so
            // the two can never diverge.
            *themes_cache.write() = user.clone();
            // Emit the *merged* list (built-ins + user overrides) so the picker
            // never loses built-ins on a disk-only rescan.
            let merged = merge_builtin_and_user(&user);
            let payload = ThemesChangedPayload { themes: merged };
            // Broadcast the full list; the frontend replaces its picker options
            // and re-applies the current theme's CSS.
            let _ = app.emit("themes_changed", payload);
        });
        match watcher::watch(&self.themes_dir, watcher::DEFAULT_DEBOUNCE, on_change) {
            Ok(guard) => *self.watcher.write() = Some(guard),
            Err(e) => tracing::warn!(error = %e, "themes: watcher failed to start; hot-reload disabled"),
        }
    }
}

/// Merge compiled-in built-ins with on-disk user themes: built-ins first (in
/// their defined order), then user themes whose ids don't shadow a built-in. A
/// user theme with the same `id` as a built-in **overrides** the built-in's
/// metadata (name/description/base), so the picker reflects the user's retitled
/// version while `css_for` still serves the user's CSS from disk. Pure (no
/// `&self`); shared by `list()` and the watcher's emit path so the two can
/// never diverge.
fn merge_builtin_and_user(user: &[ThemeInfo]) -> Vec<ThemeInfo> {
    let mut merged: Vec<ThemeInfo> =
        BUILT_IN_THEMES.iter().map(|t| t.info()).collect();
    for t in user {
        if let Some(pos) = merged.iter().position(|b| b.id == t.id) {
            merged[pos] = t.clone(); // user overrides the built-in's metadata
        } else {
            merged.push(t.clone());
        }
    }
    merged
}

/// Read the CSS for `id` given a cached scan (`themes`) rooted at `themes_dir`.
/// Returns `None` for the built-in default theme, for any id not in the cache
/// (guarding against path traversal from IPC input), or when the file is
/// unreadable. Pure (no `&self`), so it is unit-testable without a service.
fn css_for_in(themes_dir: &Path, themes: &[ThemeInfo], id: &str) -> Option<String> {
    if id.eq_ignore_ascii_case("default") {
        return None;
    }
    // Only serve CSS for an id actually present in the scanned cache. The scan
    // includes only direct subdirectories that contain a `theme.css`, so a
    // forged id like "../something" can never resolve here.
    if !themes.iter().any(|t| t.id == id) {
        return None;
    }
    let path = themes_dir.join(id).join("theme.css");
    std::fs::read_to_string(&path).ok()
}

/// Read every direct subdirectory of `dir` that contains both `theme.json`
/// (optional — falls back to folder name) and `theme.css` (required). Returns
/// an empty vec when `dir` is missing or unreadable. Sorted by display name
/// for stable picker ordering.
fn read_themes_dir(dir: &Path) -> Vec<ThemeInfo> {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };
    let mut themes: Vec<ThemeInfo> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let path = e.path();
            if !path.is_dir() {
                return None;
            }
            let id = path.file_name()?.to_string_lossy().into_owned();
            // `theme.css` is required; a folder without it is not a theme.
            if !path.join("theme.css").is_file() {
                return None;
            }
            // `theme.json` is optional; missing or invalid fields degrade
            // gracefully (name ← id, description ← "", base ← "all").
            let manifest = std::fs::read_to_string(path.join("theme.json"))
                .ok()
                .and_then(|s| serde_json::from_str::<ThemeManifest>(&s).ok())
                .unwrap_or_default();
            let base = manifest
                .base
                .filter(|b| matches!(b.as_str(), "light" | "dark" | "all"))
                .unwrap_or_else(|| "all".to_string());
            Some(ThemeInfo {
                name: manifest.name.unwrap_or_else(|| id.clone()),
                description: manifest.description.unwrap_or_default(),
                id,
                base,
            })
        })
        .collect();
    themes.sort_by_key(|t| t.name.to_lowercase());
    themes
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_themes_dir_skips_folders_without_css() {
        let root = std::env::temp_dir().join(format!("typst-themes-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("good")).unwrap();
        std::fs::write(root.join("good").join("theme.css"), ":root{}").unwrap();
        std::fs::write(
            root.join("good").join("theme.json"),
            r#"{"name":"Good","description":"d","base":"dark"}"#,
        )
        .unwrap();
        // Folder with only json, no css → skipped.
        std::fs::create_dir_all(root.join("no-css")).unwrap();
        std::fs::write(root.join("no-css").join("theme.json"), "{}").unwrap();
        // Folder with only css → kept (json optional).
        std::fs::create_dir_all(root.join("css-only")).unwrap();
        std::fs::write(root.join("css-only").join("theme.css"), ":root{}").unwrap();

        let themes = read_themes_dir(&root);
        let ids: Vec<_> = themes.iter().map(|t| t.id.as_str()).collect();
        assert!(ids.contains(&"good"), "good should be present: {ids:?}");
        assert!(
            ids.contains(&"css-only"),
            "css-only should be present (json optional): {ids:?}",
        );
        assert!(!ids.contains(&"no-css"), "no-css should be skipped: {ids:?}");

        let good = themes.iter().find(|t| t.id == "good").unwrap();
        assert_eq!(good.name, "Good");
        assert_eq!(good.description, "d");
        assert_eq!(good.base, "dark");

        let css_only = themes.iter().find(|t| t.id == "css-only").unwrap();
        assert_eq!(css_only.name, "css-only", "name falls back to id");
        assert_eq!(css_only.description, "");
        assert_eq!(css_only.base, "all");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn read_themes_dir_handles_missing_dir() {
        let themes = read_themes_dir(Path::new("/nonexistent/typst-themes-does-not-exist"));
        assert!(themes.is_empty());
    }

    #[test]
    fn css_for_default_is_none_and_validates_id() {
        let root = std::env::temp_dir().join(format!("typst-themes-css-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("a")).unwrap();
        std::fs::write(root.join("a").join("theme.css"), ":root{--x:1}").unwrap();

        let themes = read_themes_dir(&root);
        assert_eq!(css_for_in(&root, &themes, "default"), None);
        assert_eq!(css_for_in(&root, &themes, "DEFAULT"), None);
        assert_eq!(css_for_in(&root, &themes, "a"), Some(":root{--x:1}".to_string()));
        // Unknown / traversal ids resolve to None — never read from disk.
        assert_eq!(css_for_in(&root, &themes, "../etc/passwd"), None);
        assert_eq!(css_for_in(&root, &themes, "nonexistent"), None);

        let _ = std::fs::remove_dir_all(&root);
    }

    /// Regression for the cache-vs-watcher divergence: a theme added to disk
    /// after the initial scan must be visible to `list()` AND `css_for()` once
    /// `scan()` runs again (the watcher's refresh path). Before the fix the
    /// watcher emitted the new theme to the picker but the backend cache stayed
    /// stale, so selecting the freshly-added theme silently no-op'd to default.
    /// Regression for the cache-vs-watcher divergence: a theme added to disk
    /// after the initial scan must be visible to `list()` AND `css_for()` once
    /// `scan()` runs again (the watcher's refresh path). Before the fix the
    /// watcher emitted the new theme to the picker but the backend cache stayed
    /// stale, so selecting the freshly-added theme silently no-op'd to default.
    #[test]
    fn rescan_picks_up_themes_added_after_construction() {
        let root = std::env::temp_dir().join(format!(
            "typst-themes-rescan-{}",
            uuid::Uuid::new_v4(),
        ));
        // Construct with one theme present (no AppHandle → test mode, no emit).
        std::fs::create_dir_all(root.join("first")).unwrap();
        std::fs::write(root.join("first").join("theme.css"), ":root{--a:1}").unwrap();
        let svc = ThemeService::new_opt(root.clone(), None);

        // Add a second theme after construction (mimics a watcher fire).
        std::fs::create_dir_all(root.join("second")).unwrap();
        std::fs::write(root.join("second").join("theme.css"), ":root{--b:2}").unwrap();
        // `list()` = built-ins (6) + user-discovered. Before re-scan the user
        // cache only knows "first" → list() = 7. `scan()` returns only user
        // themes (no built-ins), so it's still 1 here.
        assert_eq!(svc.scan().len(), 1, "pre-rescan user cache only has 'first'");
        assert_eq!(
            svc.list().len(),
            BUILT_IN_THEMES.len() + 1,
            "list() = built-ins + 'first'",
        );
        // Re-scan — the watcher's refresh path.
        let scanned = svc.scan();
        assert_eq!(scanned.len(), 2, "rescan should find the new theme");
        assert_eq!(
            svc.list().len(),
            BUILT_IN_THEMES.len() + 2,
            "list() must reflect the refreshed cache",
        );
        // The headline regression: css_for must serve the newly-added theme.
        assert_eq!(
            svc.css_for("second"),
            Some(":root{--b:2}".to_string()),
            "css_for must read themes added after the initial scan",
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    /// Built-in themes appear in `list()` even with an empty/missing themes dir,
    /// and `css_for` serves their embedded CSS without any disk file.
    #[test]
    fn built_in_themes_listed_and_css_served_without_disk() {
        // Point the service at a non-existent dir so there are zero user themes.
        let root = std::env::temp_dir().join(format!(
            "typst-themes-builtin-{}",
            uuid::Uuid::new_v4(),
        ));
        let svc = ThemeService::new_opt(root.clone(), None);

        let list = svc.list();
        let ids: Vec<_> = list.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids.len(), BUILT_IN_THEMES.len(), "all built-ins present");
        // Display order matches BUILT_IN_THEMES definition order.
        for (got, want) in list.iter().zip(BUILT_IN_THEMES.iter()) {
            assert_eq!(got.id, want.id);
            assert_eq!(got.name, want.name);
        }
        // css_for each built-in returns non-empty embedded CSS.
        for t in BUILT_IN_THEMES {
            let css = svc.css_for(t.id).expect("built-in css should resolve");
            assert!(!css.is_empty(), "built-in {} css is empty", t.id);
        }
        // An unknown id still resolves to None.
        assert_eq!(svc.css_for("nonexistent-id"), None);
        assert_eq!(svc.css_for("default"), None);
    }

    /// A user theme with the same id as a built-in overrides the built-in's
    /// metadata in the picker AND its CSS in `css_for` — so a built-in is
    /// effectively an editable preset.
    #[test]
    fn user_theme_overrides_builtin() {
        let root = std::env::temp_dir().join(format!(
            "typst-themes-override-{}",
            uuid::Uuid::new_v4(),
        ));
        // User drops a same-named folder for the "carbon-dark" built-in with a
        // custom name and custom CSS.
        std::fs::create_dir_all(root.join("carbon-dark")).unwrap();
        std::fs::write(root.join("carbon-dark").join("theme.css"), ":root{--user:1}").unwrap();
        std::fs::write(
            root.join("carbon-dark").join("theme.json"),
            r#"{"name":"My Carbon","description":"custom"}"#,
        )
        .unwrap();
        let svc = ThemeService::new_opt(root.clone(), None);

        // list() still has exactly BUILT_IN_THEMES.len() entries (override, not
        // append), and the carbon-dark entry reflects the USER's metadata.
        let list = svc.list();
        assert_eq!(list.len(), BUILT_IN_THEMES.len(), "override should not duplicate");
        let entry = list.iter().find(|t| t.id == "carbon-dark").unwrap();
        assert_eq!(entry.name, "My Carbon");
        assert_eq!(entry.description, "custom");

        // css_for serves the USER's CSS (override), not the embedded constant.
        assert_eq!(
            svc.css_for("carbon-dark"),
            Some(":root{--user:1}".to_string()),
            "user css must override the built-in constant",
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    /// `merge_builtin_and_user` is the single source of truth shared by `list()`
    /// and the watcher's emit payload; assert its merge semantics directly.
    #[test]
    fn merge_builtin_and_user_orders_and_overrides() {
        let user = vec![ThemeInfo {
            id: "carbon-dark".to_string(),
            name: "Renamed".to_string(),
            description: "overridden".to_string(),
            base: "dark".to_string(),
        }];
        let merged = merge_builtin_and_user(&user);
        // Same total length as built-ins (override in place, no dup).
        assert_eq!(merged.len(), BUILT_IN_THEMES.len());
        // First entry is still the carbon-dark id but with the user's name.
        assert_eq!(merged[0].id, "carbon-dark");
        assert_eq!(merged[0].name, "Renamed");
        // A user theme that doesn't shadow a built-in is appended at the end.
        let user_extra = vec![ThemeInfo {
            id: "my-own".to_string(),
            name: "My Own".to_string(),
            description: String::new(),
            base: "light".to_string(),
        }];
        let merged2 = merge_builtin_and_user(&user_extra);
        assert_eq!(merged2.len(), BUILT_IN_THEMES.len() + 1);
        assert_eq!(merged2.last().unwrap().id, "my-own");
    }
}
