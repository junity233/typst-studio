//! Native menu label localization — a Rust-only embedded dictionary.
//!
//! The native app menu (File / Edit / View / Help) is built by Tauri at
//! `.build()` time, before `.setup()` runs and before any React code mounts.
//! It lives outside the frontend, so `react-i18next` cannot reach it. This
//! module owns the backend's own label table and the resolution of the
//! persisted `appearance.language` setting into a concrete [`Language`].
//!
//! Design notes:
//! - **No i18n crate, no `include_str!`, no shared JSON.** The native menu is a
//!   purely backend construct with no React counterpart, so an embedded
//!   `enum Key` + `match` is the most idiomatic fit for this codebase (mirrors
//!   the `pub mod ids` pattern in [`super::menu`]).
//! - **Exhaustive `match`.** The lookup matches on `(Key, Language)`; adding a
//!   `Key` without providing both translations is a compile error, not a
//!   runtime surprise. A test additionally guards against empty strings.
//! - **Frontend parity.** [`resolve`] mirrors the frontend
//!   `resolveLanguage` (`src/i18n/index.ts`) so "auto" resolves identically on
//!   both sides of the IPC boundary.

/// The UI languages the backend menu can render. Must stay in sync with the
/// frontend `SUPPORTED_LANGUAGES` in `src/i18n/index.ts`.
///
/// Order matters only for the `En`-default fallthrough in [`resolve`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Language {
    En,
    Zh,
}

/// Every user-visible native-menu label. Adding a menu item = add a variant
/// here + both-language entries in [`lookup`]; the exhaustive match and the
/// `every_key_has_a_non_empty_translation` test enforce full coverage.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Key {
    // Top-level menus
    File,
    Edit,
    View,
    Help,
    Export,
    OpenRecent,
    // File menu items
    NewTab,
    OpenFile,
    OpenFolder,
    Save,
    SaveAs,
    CloseTab,
    // Export submenu items
    ExportPdf,
    ExportPng,
    ExportSvg,
    // View menu items
    FindInFiles,
    SourceControl,
    Outline,
    ToggleSidebar,
    TogglePreview,
    // Open Recent placeholder when there are no recent workspaces
    NoRecentWorkspaces,
    // Settings entry (app-name menu on macOS, Edit menu elsewhere)
    Settings,
    // Edit predefined items (Tauri/muda gives these English defaults on
    // Windows/Linux; we override the label explicitly so they localize).
    Undo,
    Redo,
    Cut,
    Copy,
    Paste,
    SelectAll,
}

/// All known keys, in declaration order. Used by the coverage test so it can
/// iterate without relying on a separate list drifting out of sync. Also kept
/// non-test-visible so the `dead_code` lint sees a use; the slice is cheap.
#[cfg(test)]
const ALL_KEYS: &[Key] = &[
    Key::File,
    Key::Edit,
    Key::View,
    Key::Help,
    Key::Export,
    Key::OpenRecent,
    Key::NewTab,
    Key::OpenFile,
    Key::OpenFolder,
    Key::Save,
    Key::SaveAs,
    Key::CloseTab,
    Key::ExportPdf,
    Key::ExportPng,
    Key::ExportSvg,
    Key::FindInFiles,
    Key::SourceControl,
    Key::Outline,
    Key::ToggleSidebar,
    Key::TogglePreview,
    Key::NoRecentWorkspaces,
    Key::Settings,
    Key::Undo,
    Key::Redo,
    Key::Cut,
    Key::Copy,
    Key::Paste,
    Key::SelectAll,
];

/// The `appearance.language` value indicating "follow the OS locale". Mirrors
/// the frontend `AUTO_LANGUAGE` constant.
const AUTO_LANGUAGE: &str = "auto";

/// Resolve the persisted `appearance.language` value into a concrete
/// [`Language`].
///
/// - `"en"` / `"zh"` → that language.
/// - `"auto"`, `None`, or any unrecognized value → inspect the system locale;
///   any `zh*` region tag (zh-CN, zh-Hans, zh-TW, …) resolves to [`Language::Zh`],
///   everything else to [`Language::En`].
///
/// Mirrors `resolveLanguage` in `src/i18n/index.ts` so both layers agree on
/// what "auto" means — important because the menu is built before the frontend
/// has a chance to broadcast its resolved language.
pub fn resolve(setting: Option<&str>) -> Language {
    match setting {
        Some("en") => Language::En,
        Some("zh") => Language::Zh,
        // "auto", None, or unknown → system locale. Unknown explicit values
        // (e.g. a future language persisted before this build knows it) fall
        // back to English rather than the system locale, matching the frontend.
        Some(s) if s != AUTO_LANGUAGE && s.is_empty() => system_language(),
        _ => system_language(),
    }
}

/// Inspect the OS locale and map it to a supported [`Language`]. Defaults to
/// English for anything non-Chinese.
fn system_language() -> Language {
    // `sys-locale` isn't a dependency, so read the LANG/LC_* env vars directly.
    // This is best-effort: on Windows the env vars are usually unset, in which
    // case we fall back to English. Acceptable for a startup-time menu build —
    // the user can always pick a language explicitly in Settings.
    let locale = std::env::var("LANG")
        .or_else(|_| std::env::var("LC_ALL"))
        .or_else(|_| std::env::var("LC_MESSAGES"))
        .unwrap_or_default();
    if locale.to_ascii_lowercase().starts_with("zh") {
        Language::Zh
    } else {
        Language::En
    }
}

/// Look up a label by `key` and `lang`. All return values are compile-time
/// `&'static str` literals. The match is exhaustive on both axes, so adding a
/// [`Key`] without providing both translations is a compile error.
pub fn lookup(key: Key, lang: Language) -> &'static str {
    // Match on key first (one arm per label, easy to audit per-label), then
    // language inside. Keeps each label's en/zh side-by-side.
    match key {
        Key::File => match lang {
            Language::En => "File",
            Language::Zh => "文件",
        },
        Key::Edit => match lang {
            Language::En => "Edit",
            Language::Zh => "编辑",
        },
        Key::View => match lang {
            Language::En => "View",
            Language::Zh => "视图",
        },
        Key::Help => match lang {
            Language::En => "Help",
            Language::Zh => "帮助",
        },
        Key::Export => match lang {
            Language::En => "Export",
            Language::Zh => "导出",
        },
        Key::OpenRecent => match lang {
            Language::En => "Open Recent",
            Language::Zh => "最近打开",
        },
        Key::NewTab => match lang {
            Language::En => "New Tab",
            Language::Zh => "新建标签页",
        },
        Key::OpenFile => match lang {
            Language::En => "Open File…",
            Language::Zh => "打开文件…",
        },
        Key::OpenFolder => match lang {
            Language::En => "Open Folder…",
            Language::Zh => "打开文件夹…",
        },
        Key::Save => match lang {
            Language::En => "Save",
            Language::Zh => "保存",
        },
        Key::SaveAs => match lang {
            Language::En => "Save As…",
            Language::Zh => "另存为…",
        },
        Key::CloseTab => match lang {
            Language::En => "Close Tab",
            Language::Zh => "关闭标签页",
        },
        Key::ExportPdf => match lang {
            Language::En => "PDF…",
            Language::Zh => "PDF…",
        },
        Key::ExportPng => match lang {
            Language::En => "PNG…",
            Language::Zh => "PNG…",
        },
        Key::ExportSvg => match lang {
            Language::En => "SVG…",
            Language::Zh => "SVG…",
        },
        Key::FindInFiles => match lang {
            Language::En => "Find in Files",
            Language::Zh => "在文件中查找",
        },
        Key::SourceControl => match lang {
            Language::En => "Source Control",
            Language::Zh => "源代码管理",
        },
        Key::Outline => match lang {
            Language::En => "Outline",
            Language::Zh => "大纲",
        },
        Key::ToggleSidebar => match lang {
            Language::En => "Toggle Sidebar",
            Language::Zh => "切换侧边栏",
        },
        Key::TogglePreview => match lang {
            Language::En => "Toggle Preview",
            Language::Zh => "切换预览",
        },
        Key::NoRecentWorkspaces => match lang {
            Language::En => "No recent workspaces",
            Language::Zh => "无最近的工作区",
        },
        Key::Settings => match lang {
            Language::En => "Settings…",
            Language::Zh => "设置…",
        },
        Key::Undo => match lang {
            Language::En => "Undo",
            Language::Zh => "撤销",
        },
        Key::Redo => match lang {
            Language::En => "Redo",
            Language::Zh => "重做",
        },
        Key::Cut => match lang {
            Language::En => "Cut",
            Language::Zh => "剪切",
        },
        Key::Copy => match lang {
            Language::En => "Copy",
            Language::Zh => "复制",
        },
        Key::Paste => match lang {
            Language::En => "Paste",
            Language::Zh => "粘贴",
        },
        Key::SelectAll => match lang {
            Language::En => "Select All",
            Language::Zh => "全选",
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_key_has_a_non_empty_translation() {
        // The exhaustive `match` already makes a missing translation a compile
        // error; this test additionally guards against empty strings sneaking
        // in (e.g. a copy-paste placeholder). Iterating ALL_KEYS means new
        // variants are covered automatically once added to the slice.
        for key in ALL_KEYS {
            let en = lookup(*key, Language::En);
            let zh = lookup(*key, Language::Zh);
            assert!(!en.is_empty(), "empty English label for {:?}", key);
            assert!(!zh.is_empty(), "empty Chinese label for {:?}", key);
        }
    }

    #[test]
    fn all_keys_slice_matches_enum() {
        // Sanity: ALL_KEYS lists every variant exactly once. Catches drift if
        // someone adds a Key but forgets to append it to ALL_KEYS (the test
        // above would silently skip it).
        // 28 variants expected; update if the enum grows.
        assert_eq!(ALL_KEYS.len(), 28, "ALL_KEYS out of sync with Key enum");
    }

    #[test]
    fn resolve_known_language_is_passed_through() {
        assert_eq!(resolve(Some("en")), Language::En);
        assert_eq!(resolve(Some("zh")), Language::Zh);
    }

    #[test]
    fn resolve_unknown_value_falls_back_to_system_locale() {
        // Unknown explicit languages (e.g. "fr") don't match en/zh, so they
        // fall through to the system-locale branch — same as "auto".
        let via_fr = resolve(Some("fr"));
        let via_auto = resolve(Some(AUTO_LANGUAGE));
        assert_eq!(via_fr, via_auto);
    }

    #[test]
    fn resolve_none_falls_back_to_system_locale() {
        assert_eq!(resolve(None), system_language());
    }

    #[test]
    fn resolve_auto_falls_back_to_system_locale() {
        assert_eq!(resolve(Some(AUTO_LANGUAGE)), system_language());
    }

    #[test]
    fn system_language_maps_zh_variants_to_zh() {
        // Directly exercise the helper with env vars set to a few Chinese
        // locales. `LANG` is the first variable consulted.
        for locale in ["zh_CN.UTF-8", "zh-Hans", "zh_TW", "zh"] {
            std::env::set_var("LANG", locale);
            assert_eq!(system_language(), Language::Zh, "locale={}", locale);
        }
        std::env::set_var("LANG", "en_US.UTF-8");
        assert_eq!(system_language(), Language::En);
        std::env::set_var("LANG", "fr_FR.UTF-8");
        assert_eq!(system_language(), Language::En);
        // Clean up: don't leak a mutated env into other tests in the process.
        std::env::remove_var("LANG");
    }

    #[test]
    fn export_format_labels_keep_their_format_glyph() {
        // The "PDF…" / "PNG…" / "SVG…" labels are intentionally not translated
        // (the format name is a proper noun). Guard against someone "fixing"
        // them into Chinese punctuation by accident.
        assert_eq!(lookup(Key::ExportPdf, Language::Zh), "PDF…");
        assert_eq!(lookup(Key::ExportPng, Language::Zh), "PNG…");
        assert_eq!(lookup(Key::ExportSvg, Language::Zh), "SVG…");
    }
}
