import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useContextMenuStore, type MenuItem } from "../Sidebar/contextMenuStore";
import { useUiStore } from "../../store/uiStore";
import { dispatch } from "../../hooks/useAppCommands";
import { loadSession } from "../../lib/session";

/**
 * Custom window titlebar for Windows.
 *
 * Replaces the OS frame (the main window has `decorations: false` on Windows —
 * see `src-tauri/src/lib.rs`). Renders:
 *   ┌──────────────────────────────────────────────────────────┐
 *   │ [icon] Typst Studio   File Edit View Help       [─][▢][✕] │
 *   └──────────────────────────────────────────────────────────┘
 *
 *   - Left: app icon + product name.
 *   - Center-left: top-level menus. Each opens a floating dropdown (reusing
 *     the shared `ContextMenu` via `contextMenuStore`) whose items dispatch the
 *     same command ids the native menu emits on macOS — one dispatch path.
 *   - Right: window controls (minimize / maximize-or-restore / close).
 *   - The bar is a drag region (`data-tauri-drag-region`); double-click
 *     toggles maximize. Interactive children opt out automatically.
 *
 * macOS/Linux never render this component (App gates on `isWindows`), so their
 * native traffic-light / WM frames are untouched.
 */

/** Product label shown next to the icon. */
const PRODUCT_NAME = "Typst Studio";

export function TitleBar() {
  const { t } = useTranslation("menu");
  const { t: tTitlebar } = useTranslation("titlebar");
  const [maximized, setMaximized] = useState(false);
  const openMenu = useContextMenuStore((s) => s.open);
  // Which top-level menu's dropdown is currently open, if any. `null` when no
  // dropdown is showing. Drives the "active" highlight (the open button stays
  // highlighted even when the pointer leaves it for the dropdown) and disables
  // hover feedback on the sibling buttons (so they don't look interactive while
  // another menu is open).
  const menuCurrent = useContextMenuStore((s) => s.current);
  const [openName, setOpenName] = useState<
    "file" | "edit" | "view" | "help" | null
  >(null);
  // Clear the active menu whenever the dropdown closes (item selected, outside
  // click, Escape, scroll, …).
  useEffect(() => {
    if (menuCurrent === null) setOpenName(null);
  }, [menuCurrent]);

  const win = getCurrentWindow();

  // Track maximize state to flip the middle control's icon. `onResized` fires
  // for both user drags and the maximize/restore/snap gestures on Windows.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    const refresh = () => {
      win
        .isMaximized()
        .then(setMaximized)
        .catch(() => setMaximized(false));
    };
    refresh();
    win
      .onResized(() => refresh())
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {});
    return () => unlisten?.();
  }, [win]);

  // ---- Window control actions -------------------------------------------
  const onMinimize = useCallback(() => {
    void win.minimize();
  }, [win]);
  const onToggleMaximize = useCallback(() => {
    void win.toggleMaximize();
  }, [win]);
  // Close goes through `close()`: the Rust `on_window_event` handler intercepts
  // `CloseRequested` (prevents the close, emits `close_requested`), which
  // `useAppCommands` routes through the unsaved-tab guard. So the custom button
  // gets the SAME save-prompt flow as the OS close gesture.
  const onClose = useCallback(() => {
    void win.close();
  }, [win]);

  // ---- Menu open ---------------------------------------------------------
  /** Open a dropdown anchored to a button's bottom-left corner, tagging it
   *  with `name` so the button stays highlighted while its menu is open. */
  function openAt(
    e: React.MouseEvent,
    name: "file" | "edit" | "view" | "help",
    items: MenuItem[],
  ) {
    const el = e.currentTarget as HTMLElement;
    const rect = el.getBoundingClientRect();
    setOpenName(name);
    openMenu(items, rect.left, rect.bottom);
  }
  const openFileMenu = (e: React.MouseEvent) => openAt(e, "file", buildFileMenu(t));
  const openEditMenu = (e: React.MouseEvent) => openAt(e, "edit", buildEditMenu(t));
  const openViewMenu = (e: React.MouseEvent) => openAt(e, "view", buildViewMenu(t));
  const openHelpMenu = (e: React.MouseEvent) => openAt(e, "help", buildHelpMenu(t));

  return (
    <header
      className="titlebar"
      data-tauri-drag-region
      onDoubleClick={onToggleMaximize}
    >
      <div className="titlebar-title" data-tauri-drag-region>
        <img src="/icon.svg" alt="" className="titlebar-logo" draggable={false} />
        <span className="titlebar-product">{PRODUCT_NAME}</span>
      </div>

      <nav className="titlebar-menu" aria-label={t("file")}>
        <MenuButton
          label={t("file")}
          active={openName === "file"}
          anyOpen={openName !== null}
          onClick={openFileMenu}
        />
        <MenuButton
          label={t("edit")}
          active={openName === "edit"}
          anyOpen={openName !== null}
          onClick={openEditMenu}
        />
        <MenuButton
          label={t("view")}
          active={openName === "view"}
          anyOpen={openName !== null}
          onClick={openViewMenu}
        />
        <MenuButton
          label={t("help")}
          active={openName === "help"}
          anyOpen={openName !== null}
          onClick={openHelpMenu}
        />
      </nav>

      <div className="titlebar-spacer" data-tauri-drag-region />

      <div className="titlebar-controls">
        <button
          type="button"
          className="titlebar-ctrl"
          aria-label={tTitlebar("minimize")}
          title={tTitlebar("minimize")}
          onClick={onMinimize}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <rect x="0" y="4.5" width="10" height="1" fill="currentColor" />
          </svg>
        </button>
        <button
          type="button"
          className="titlebar-ctrl"
          aria-label={tTitlebar(maximized ? "restore" : "maximize")}
          title={tTitlebar(maximized ? "restore" : "maximize")}
          onClick={onToggleMaximize}
        >
          {maximized ? (
            // Restore: two overlapping squares.
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <rect
                x="2.5"
                y="0.5"
                width="6"
                height="6"
                fill="none"
                stroke="currentColor"
                strokeWidth="1"
              />
              <rect
                x="0.5"
                y="2.5"
                width="6"
                height="6"
                fill="var(--color-surface-frost)"
                stroke="currentColor"
                strokeWidth="1"
              />
            </svg>
          ) : (
            // Maximize: a single square.
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <rect
                x="0.5"
                y="0.5"
                width="9"
                height="9"
                fill="none"
                stroke="currentColor"
                strokeWidth="1"
              />
            </svg>
          )}
        </button>
        <button
          type="button"
          className="titlebar-ctrl titlebar-ctrl-close"
          aria-label={tTitlebar("close")}
          title={tTitlebar("close")}
          onClick={onClose}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path
              d="M0.5 0.5 L9.5 9.5 M9.5 0.5 L0.5 9.5"
              stroke="currentColor"
              strokeWidth="1"
              fill="none"
            />
          </svg>
        </button>
      </div>
    </header>
  );
}

/** A single top-level menu trigger.
 *  - `active`: this menu's dropdown is currently open → stays highlighted.
 *  - `anyOpen`: some menu is open → hovering this button switches to it
 *    (desktop-menu convention), and sibling buttons suppress their hover
 *    feedback so they don't look independently interactive.
 *  - `onClick`: opens the dropdown (or, if `anyOpen`, the hover handler
 *    already switched to it and the click is a no-op). */
function MenuButton({
  label,
  active,
  anyOpen,
  onClick,
}: {
  label: string;
  active: boolean;
  anyOpen: boolean;
  onClick: (e: React.MouseEvent) => void;
}) {
  return (
    <button
      type="button"
      className={
        "titlebar-menu-btn" +
        (active ? " titlebar-menu-btn-active" : "") +
        (anyOpen && !active ? " titlebar-menu-btn-suppressed" : "")
      }
      // When a menu is already open, hovering another top-level button
      // switches to it immediately — no click required.
      onPointerEnter={(e) => {
        if (anyOpen && !active) onClick(e);
      }}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

// ---- Menu builders --------------------------------------------------------
// Each builder returns the item list for its dropdown. Action items call
// `dispatch(id)` — the SAME dispatch the native menu's `menu_event` takes on
// macOS — so there's a single command path regardless of platform.

type T = (key: string, opts?: Record<string, unknown>) => string;

/** A plain action item that dispatches a command id. */
function action(label: string, id: string): MenuItem {
  return { type: "action", label, onSelect: () => void dispatch(id) };
}

/** A checked action item (toggles a UI visibility flag). */
function check(label: string, id: string, checked: boolean): MenuItem {
  return {
    type: "action",
    label,
    icon: checked ? <span className="titlebar-check">✓</span> : undefined,
    onSelect: () => void dispatch(id),
  };
}

const sep = (): MenuItem => ({ type: "separator" });

function buildFileMenu(t: T): MenuItem[] {
  // Open Recent — a nested submenu whose children are the recent workspaces.
  // An empty children list renders the parent row disabled ("No recent
  // workspaces"); see ContextMenu's submenu handling.
  const recent = readRecentSync();
  const recentChildren: MenuItem[] = recent.length
    ? recent.map((path, i) => ({
        type: "action",
        label: shortLabel(path),
        onSelect: () => void dispatch(`open-recent:${i}`),
      }))
    : [
        {
          type: "action",
          label: t("noRecentWorkspaces"),
          disabled: true,
          onSelect: () => {},
        },
      ];
  return [
    action(t("newTab"), "new-tab"),
    action(t("openFile"), "open-file"),
    action(t("openFolder"), "open-folder"),
    { type: "submenu", label: t("openRecent"), children: recentChildren },
    sep(),
    action(t("save"), "save"),
    action(t("saveAs"), "save-as"),
    sep(),
    action(t("closeTab"), "close-tab"),
    sep(),
    {
      type: "submenu",
      label: t("export"),
      children: [
        action(t("exportPdf"), "export-pdf"),
        action(t("exportPng"), "export-png"),
        action(t("exportSvg"), "export-svg"),
      ],
    },
  ];
}

function buildEditMenu(t: T): MenuItem[] {
  return [
    // Undo/Redo/Cut/Copy/Paste/SelectAll act on the focused webview via the
    // browser's editing commands (document.execCommand). The native menu used
    // predefined items for these; in the custom titlebar we dispatch the same
    // editor command the browser would. execCommand is deprecated but remains
    // the only way to trigger these from a button in a webview.
    editAction(t("undo"), "undo"),
    editAction(t("redo"), "redo"),
    sep(),
    editAction(t("cut"), "cut"),
    editAction(t("copy"), "copy"),
    editAction(t("paste"), "paste"),
    editAction(t("selectAll"), "selectAll"),
    sep(),
    action(t("settings"), "open-settings"),
  ];
}

/** An editing-command item routed through document.execCommand. */
function editAction(label: string, command: string): MenuItem {
  return {
    type: "action",
    label,
    onSelect: () => {
      try {
        document.execCommand(command);
      } catch {
        // execCommand can throw in restricted contexts; ignore — editing
        // commands are best-effort from the titlebar.
      }
    },
  };
}

function buildViewMenu(t: T): MenuItem[] {
  // Read live visibility flags so the check marks reflect current state.
  const ui = useUiStore.getState();
  return [
    action(t("findInFiles"), "workbench.action.findInFiles"),
    action(t("outline"), "workbench.view.outline"),
    sep(),
    check(t("toggleSidebar"), "toggle-sidebar", ui.sidebarVisible),
    check(t("togglePreview"), "toggle-preview", ui.previewVisible),
  ];
}

function buildHelpMenu(t: T): MenuItem[] {
  return [
    {
      type: "action",
      label: t("about", { name: PRODUCT_NAME }),
      onSelect: () => {
        // No native About dialog from the webview; show a simple alert. The
        // macOS native menu still has its own rich About panel via
        // PredefinedMenuItem.
        window.alert(PRODUCT_NAME);
      },
    },
  ];
}

// ---- helpers --------------------------------------------------------------

/**
 * Read recent workspaces SYNCHRONOUSLY for menu construction. The session is
 * normally loaded by app startup, so we cache the first async read into a
 * module-scoped variable; the menu re-reads on every open so a freshly-loaded
 * session shows up on the second click.
 */
let recentCache: string[] = [];
let recentLoaded = false;
async function primeRecent(): Promise<void> {
  try {
    const session = await loadSession();
    recentCache = session.recentWorkspaces ?? [];
  } catch {
    recentCache = [];
  }
  recentLoaded = true;
}
// Kick off the load once at module evaluation; subsequent menu opens see it.
void primeRecent();

function readRecentSync(): string[] {
  if (!recentLoaded) return [];
  return recentCache;
}

/** Workspace basename for a recent entry's label (mirrors the Rust helper). */
function shortLabel(path: string): string {
  const trimmed = path.trimEnd().replace(/[\\/]+$/, "");
  const base = trimmed.split(/[\\/]/).pop();
  return base && base.length > 0 ? base : path;
}
