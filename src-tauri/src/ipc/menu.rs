//! Native application menu (File / Edit / View / Help). Export is nested under
//! File (File → Export → PDF/PNG/SVG).
//!
//! Built once at startup via [`build_menu`] and applied app-wide (macOS global
//! menubar; Windows/Linux per-window). Menu items with ids emit a `menu_event`
//! Tauri event carrying the id; the frontend's [`useAppCommands`] hook listens
//! and dispatches (save / export / toggle / etc.). Predefined items (Quit, Cut,
//! Copy, About) perform their native action themselves and are not handled here.
//!
//! [`useAppCommands`]: ../../../src/hooks/useAppCommands.ts

use serde::Serialize;
use tauri::menu::{
    AboutMetadataBuilder, CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu,
};
use tauri::{AppHandle, Emitter as _, Runtime};

/// Payload emitted on the `menu_event` channel when an id-backed menu item or
/// check item is activated. The frontend dispatches on `id` (and reads
/// `checked` for toggle items).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuEventPayload {
    pub id: String,
    /// For check items, the new checked state; `false` for normal items.
    pub checked: bool,
}

/// The menu ids used across the app. Kept here as the single source of truth so
/// the frontend handler can mirror them.
pub mod ids {
    pub const NEW_TAB: &str = "new-tab";
    pub const OPEN_FILE: &str = "open-file";
    pub const OPEN_FOLDER: &str = "open-folder";
    pub const SAVE: &str = "save";
    pub const SAVE_AS: &str = "save-as";
    pub const CLOSE_TAB: &str = "close-tab";
    pub const TOGGLE_SIDEBAR: &str = "toggle-sidebar";
    pub const TOGGLE_PREVIEW: &str = "toggle-preview";
    /// Cross-file Find in Files (§Search view). The frontend dispatch routes
    /// this to the registered `workbench.action.findInFiles` command, which
    /// opens the bottom Search panel.
    pub const FIND_IN_FILES: &str = "workbench.action.findInFiles";
    /// Show the Source Control view (§Source Control). The frontend dispatch
    /// routes this to the registered `workbench.view.scm` command, which
    /// activates the SCM sidebar view.
    pub const SOURCE_CONTROL: &str = "workbench.view.scm";
    /// Show the Outline view (§Outline). Routes to the registered
    /// `workbench.view.outline` command, which activates the Outline sidebar.
    pub const OUTLINE: &str = "workbench.view.outline";
    pub const EXPORT_PDF: &str = "export-pdf";
    pub const EXPORT_PNG: &str = "export-png";
    pub const EXPORT_SVG: &str = "export-svg";
    pub const OPEN_SETTINGS: &str = "open-settings";

    /// Prefix for "Open Recent > <workspace>" submenu items. The full id is
    /// `open-recent:<index>` where `<index>` is the 0-based position into the
    /// session's `recent_workspaces` list. (§7.2 "最近工作区".)
    pub const OPEN_RECENT_PREFIX: &str = "open-recent:";

    /// Build an "Open Recent" item id for `index`.
    pub fn open_recent(index: usize) -> String {
        format!("{}{}", OPEN_RECENT_PREFIX, index)
    }

    /// Parse an "Open Recent" item id back into its list index, or `None` if the
    /// id isn't an open-recent item.
    pub fn parse_open_recent(id: &str) -> Option<usize> {
        id.strip_prefix(OPEN_RECENT_PREFIX)?.parse::<usize>().ok()
    }
}

/// Build the full application menu. On macOS the first submenu is the app-name
/// menu (About/Services/Hide/Quit) — Tauri does not auto-insert it.
pub fn build_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    // ---- macOS app-name menu ----
    #[cfg(target_os = "macos")]
    let app_menu = build_app_name_menu(app)?;

    // ---- Export (nested under File; built first so File can reference it) ----
    let export = Submenu::with_items(
        app,
        "Export",
        true,
        &[
            &MenuItem::with_id(app, ids::EXPORT_PDF, "PDF…", true, None::<&str>)?,
            &MenuItem::with_id(app, ids::EXPORT_PNG, "PNG…", true, None::<&str>)?,
            &MenuItem::with_id(app, ids::EXPORT_SVG, "SVG…", true, None::<&str>)?,
        ],
    )?;

    // ---- Open Recent (nested under File; §7.2 "最近工作区") ----
    // Populated from the session's `recent_workspaces` at menu-build time. The
    // menu is static for the session's lifetime; reopening a workspace refreshes
    // the list on the NEXT launch. (A live-refresh menu is a future polish.)
    let open_recent = build_open_recent_submenu(app)?;

    // ---- File (Export + Open Recent live here as nested submenus) ----
    let file = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &MenuItem::with_id(app, ids::NEW_TAB, "New Tab", true, Some("CmdOrCtrl+T"))?,
            &MenuItem::with_id(app, ids::OPEN_FILE, "Open File…", true, Some("CmdOrCtrl+O"))?,
            &MenuItem::with_id(
                app,
                ids::OPEN_FOLDER,
                "Open Folder…",
                true,
                Some("CmdOrCtrl+Shift+O"),
            )?,
            &open_recent,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, ids::SAVE, "Save", true, Some("CmdOrCtrl+S"))?,
            &MenuItem::with_id(app, ids::SAVE_AS, "Save As…", true, Some("CmdOrCtrl+Shift+S"))?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, ids::CLOSE_TAB, "Close Tab", true, Some("CmdOrCtrl+W"))?,
            &PredefinedMenuItem::separator(app)?,
            &export,
        ],
    )?;

    // ---- Edit (prebuilt native items; they act on the focused webview) ----
    // On non-macOS the Settings entry has no app-name menu to live in, so it is
    // appended here. Named locals (not inline temporaries) are required because
    // the items outlive the single statement that registers them.
    let undo = PredefinedMenuItem::undo(app, None)?;
    let redo = PredefinedMenuItem::redo(app, None)?;
    let edit_sep = PredefinedMenuItem::separator(app)?;
    let cut = PredefinedMenuItem::cut(app, None)?;
    let copy = PredefinedMenuItem::copy(app, None)?;
    let paste = PredefinedMenuItem::paste(app, None)?;
    let select_all = PredefinedMenuItem::select_all(app, None)?;

    #[cfg(not(target_os = "macos"))]
    let settings_item =
        MenuItem::with_id(app, ids::OPEN_SETTINGS, "Settings…", true, Some("CmdOrCtrl+,"))?;

    // `mut` is only needed on platforms that append the Settings item below
    // (non-macOS); on macOS the push is cfg'd out, so silence unused_mut there.
    #[cfg_attr(target_os = "macos", allow(unused_mut))]
    let mut edit_items: Vec<&dyn tauri::menu::IsMenuItem<R>> =
        vec![&undo, &redo, &edit_sep, &cut, &copy, &paste, &select_all];
    #[cfg(not(target_os = "macos"))]
    edit_items.push(&settings_item);

    let edit = Submenu::with_items(app, "Edit", true, &edit_items)?;

    // ---- View (Find in Files + toggle items) ----
    let view = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &MenuItem::with_id(
                app,
                ids::FIND_IN_FILES,
                "Find in Files",
                true,
                Some("CmdOrCtrl+Shift+F"),
            )?,
            &MenuItem::with_id(
                app,
                ids::SOURCE_CONTROL,
                "Source Control",
                true,
                Some("CmdOrCtrl+Shift+G"),
            )?,
            &MenuItem::with_id(
                app,
                ids::OUTLINE,
                "Outline",
                true,
                Some("CmdOrCtrl+Shift+O"),
            )?,
            &PredefinedMenuItem::separator(app)?,
            &CheckMenuItem::with_id(
                app,
                ids::TOGGLE_SIDEBAR,
                "Toggle Sidebar",
                true,
                true,
                Some("CmdOrCtrl+B"),
            )?,
            &CheckMenuItem::with_id(
                app,
                ids::TOGGLE_PREVIEW,
                "Toggle Preview",
                true,
                true,
                Some("CmdOrCtrl+\\"),
            )?,
        ],
    )?;

    // ---- Help (About) ----
    let about_meta = AboutMetadataBuilder::new()
        .name(Some(app.package_info().name.clone()))
        .version(Some(app.package_info().version.to_string()))
        .build();
    let help = Submenu::with_items(
        app,
        "Help",
        true,
        &[&PredefinedMenuItem::about(app, None, Some(about_meta))?],
    )?;

    // ---- Assemble top-level (macOS: only submenus) ----
    #[cfg(target_os = "macos")]
    {
        Menu::with_items(app, &[&app_menu, &file, &edit, &view, &help])
    }
    #[cfg(not(target_os = "macos"))]
    {
        Menu::with_items(app, &[&file, &edit, &view, &help])
    }
}

/// Build the "Open Recent" submenu (§7.2 "最近工作区") from the session's
/// `recent_workspaces`. Reads `session.json` directly from the app config dir
/// (the session service isn't constructed until `.setup`, which runs AFTER
/// menu building). On any failure (missing dir, unreadable file, empty list)
/// the submenu holds a single disabled "No recent workspaces" item so the menu
/// structure is stable across launches.
fn build_open_recent_submenu<R: Runtime>(
    app: &AppHandle<R>,
) -> tauri::Result<Submenu<R>> {
    let recents = read_recent_workspaces(app);
    if recents.is_empty() {
        // A disabled placeholder keeps the submenu structure stable.
        let placeholder =
            MenuItem::with_id(app, "open-recent-empty", "No recent workspaces", false, None::<&str>)?;
        return Submenu::with_items(app, "Open Recent", true, &[&placeholder]);
    }
    // Build one item per recent workspace, labeled by its basename (full path is
    // long; the basename + the index-id → the frontend resolves the full path).
    // Collect through `Result` so a single OS-menu construction failure
    // propagates as `?` (degrades) instead of panicking the app at startup.
    let items: Vec<MenuItem<R>> = recents
        .iter()
        .enumerate()
        .map(|(i, path)| {
            let label = short_label(path);
            MenuItem::with_id(app, ids::open_recent(i), label, true, None::<&str>)
        })
        .collect::<tauri::Result<Vec<_>>>()?;
    // Collect as trait-object references for `with_items`.
    let item_refs: Vec<&dyn tauri::menu::IsMenuItem<R>> =
        items.iter().map(|i| i as &dyn tauri::menu::IsMenuItem<R>).collect();
    Submenu::with_items(app, "Open Recent", true, &item_refs)
}

/// Read the `recent_workspaces` list directly from `session.json` in the app
/// config dir. Best-effort: any failure (no config dir, missing/corrupt file,
/// no `recentWorkspaces` field) → empty vec. Used only at menu-build time to
/// populate "Open Recent"; the authoritative read is the SessionService in
/// `.setup`.
fn read_recent_workspaces<R: Runtime>(app: &AppHandle<R>) -> Vec<String> {
    use tauri::Manager as _;
    let Ok(cfg_dir) = app.path().app_config_dir() else {
        return Vec::new();
    };
    let path = cfg_dir.join("session.json");
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return Vec::new();
    };
    v.get("recentWorkspaces")
        .and_then(|w| w.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

/// A short label for a workspace path: its final path segment (folder name),
/// falling back to the full path if empty. macOS-style: the basename alone is
/// how recent folders appear in native app menus.
fn short_label(path: &str) -> String {
    let trimmed = path.trim_end_matches(['/', '\\']);
    match trimmed.rsplit(['/', '\\']).next() {
        Some(name) if !name.is_empty() => name.to_string(),
        _ => path.to_string(),
    }
}
/// The macOS app-name submenu: About / Services / Hide / Hide Others / Quit.
/// Quit (Cmd+Q) is a predefined item whose accelerator + behavior are baked in.
#[cfg(target_os = "macos")]
fn build_app_name_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Submenu<R>> {
    Submenu::with_items(
        app,
        app.package_info().name.clone(),
        true,
        &[
            &PredefinedMenuItem::about(app, None, None)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, ids::OPEN_SETTINGS, "Settings…", true, Some("CmdOrCtrl+,"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )
}

/// Handle a menu event: look up the activated item, read its checked state if
/// it's a check item, and emit a `menu_event` the frontend dispatches on.
/// Called from the `on_menu_event` handler registered on the app builder.
pub fn dispatch_menu_event(app: &AppHandle, id: &tauri::menu::MenuId) {
    // For check items, reflect the new (post-toggle) checked state. muda fires
    // the event *after* toggling, so is_checked() already reports the new value.
    let checked = app
        .menu()
        .and_then(|m| m.get(id))
        .and_then(|item| item.as_check_menuitem().map(|c| c.is_checked()))
        .map(|r| r.unwrap_or(false))
        .unwrap_or(false);
    let payload = MenuEventPayload {
        id: id.as_ref().to_string(),
        checked,
    };
    let _ = app.emit("menu_event", payload);
}
