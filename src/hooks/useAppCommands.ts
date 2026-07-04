import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { onMenuEvent, onCloseRequested } from "../lib/tauri";
import {
  exportPdf,
  exportPng,
  exportSvg,
  openFile,
  openSettings,
  saveAs as saveAsBE,
  saveFile,
  markCleanShutdown,
  saveSession,
} from "../lib/tauri";
import { useTabsStore, readOrderedDocuments } from "../store/tabsStore";
import { useDocumentsStore } from "../store/documentsStore";
import { useWorkspaceStore } from "../store/workspaceStore";
import { useUiStore } from "../store/uiStore";
import { useDialogStore } from "../store/dialogStore";
import { closeTabWithConfirm, saveTab } from "../lib/commands";
import { captureAndSaveSession } from "../lib/session";
import { captureWindowBounds } from "../lib/windowState";
import { captureLayout } from "../lib/layoutState";
import { toIpcError } from "../lib/ipc-error";

/**
 * Centralized command dispatch for the native app menu. Subscribes to the
 * `menu_event` channel (emitted by the Rust menu handler) and routes each id to
 * the right store/service action. Mounted once at the app root.
 *
 * Save logic: a titled tab saves in place; an untitled tab falls through to
 * Save As. The View toggle ids update both the checked menu item (handled in
 * Rust) and the local UI flags.
 */
export function useAppCommands(): void {
  useEffect(() => {
    let unlisten: (() => void) | undefined;

    onMenuEvent((payload) => {
      void dispatch(payload.id);
    }).then((fn) => {
      unlisten = fn;
    });

    // Capture-phase Cmd/Ctrl+S. The native menu's accelerator only fires when
    // the keypress reaches the OS — but Monaco (and the VS Code services we
    // wire via filesServiceOverride) can swallow Cmd+S in the webview before it
    // bubbles, so the menu handler never runs. This document-level capture
    // listener sits ahead of the editor, intercepts the save shortcut directly,
    // and dispatches our save — making Cmd+S reliable regardless of focus.
    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "s" && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        void dispatch("save");
      }
      // Cmd/Ctrl+Shift+S → Save As.
      if (mod && e.shiftKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        e.stopPropagation();
        void dispatch("save-as");
      }
    };
    document.addEventListener("keydown", onKeyDown, true);

    return () => {
      unlisten?.();
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, []);

  /**
   * Main-window close guard. The backend intercepts the OS close and emits
   * `close_requested` instead of closing; here we decide: if there are no dirty
   * tabs, close now; otherwise show one consolidated Save All / Don't Save /
   * Cancel dialog. `destroy()` (not `close()`) is used so CloseRequested isn't
   * re-emitted, which would loop back here.
   */
  useEffect(() => {
    let unlisten: (() => void) | undefined;

    onCloseRequested(() => {
      void handleCloseRequested();
    }).then((fn) => {
      unlisten = fn;
    });

    return () => {
      unlisten?.();
    };
  }, []);
}

/** Run the action for a menu id. Exported for testing / programmatic dispatch. */
export async function dispatch(menuId: string): Promise<void> {
  const tabs = useTabsStore.getState();
  const activeId = tabs.activeId;
  const activeTab =
    activeId !== null
      ? (useDocumentsStore.getState().documents[activeId] ?? null)
      : null;
  const ws = useWorkspaceStore.getState();
  const ui = useUiStore.getState();

  try {
    // "Open Recent > <workspace>" submenu (§7.2): the id is `open-recent:<i>`,
    // where <i> indexes into the session's recent_workspaces. Resolve + open.
    if (menuId.startsWith("open-recent:")) {
      await handleOpenRecent(menuId);
      return;
    }
    switch (menuId) {
      case "new-tab":
        await tabs.openTab();
        break;

      case "open-file":
        await handleOpenFile();
        break;

      case "open-folder":
        await ws.openWorkspace();
        break;

      case "save":
        await handleSave(activeId, activeTab);
        break;

      case "save-as":
        await handleSaveAs(activeId);
        break;

      case "close-tab":
        if (activeId !== null) await closeTabWithConfirm(activeId);
        break;

      case "toggle-sidebar":
        ui.toggleSidebar();
        break;

      case "toggle-preview":
        ui.togglePreview();
        break;

      case "open-settings":
        await openSettings();
        break;

      case "export-pdf":
        if (activeId !== null && activeTab !== null) {
          await exportPdf(activeId, activeTab.revision);
        }
        break;

      case "export-png":
        if (activeId !== null && activeTab !== null) {
          await exportPng(activeId, activeTab.revision);
        }
        break;

      case "export-svg":
        if (activeId !== null && activeTab !== null) {
          await exportSvg(activeId, activeTab.revision);
        }
        break;

      default:
        // Unknown / predefined items are handled natively; ignore here.
        break;
    }
  } catch (e) {
    // §5.3: a Cancelled code (dismissed dialog) is not a failure — silent.
    const ipc = toIpcError(e);
    if (ipc.code === "cancelled") {
      return;
    }
    console.warn(`[menu:${menuId}] failed:`, ipc.code, ipc.message);
    window.alert(`${labelFor(menuId)}: ${ipc.message}`);
  }
}

/** Open a single file via the native dialog and add it as a tab. */
async function handleOpenFile(): Promise<void> {
  const doc = await openFile();
  if (doc === null) return;
  useTabsStore.getState().openPath(doc);
}

/**
 * Handle an "Open Recent > <workspace>" menu pick (§7.2 "最近工作区"). The id
 * is `open-recent:<i>`; resolve `<i>` against the session's recent list and
 * open that workspace by path. Best-effort: a stale/missing entry is logged
 * (the menu is static for the session, so a removed folder can still be listed).
 */
async function handleOpenRecent(menuId: string): Promise<void> {
  const idxStr = menuId.slice("open-recent:".length);
  const idx = Number(idxStr);
  if (!Number.isInteger(idx) || idx < 0) return;
  const { loadSession } = await import("../lib/session");
  const { openWorkspaceByPath } = await import("../lib/tauri");
  const session = await loadSession();
  const path = session.recentWorkspaces[idx];
  if (!path) return;
  try {
    const meta = await openWorkspaceByPath(path);
    if (meta) {
      useWorkspaceStore.setState({
        rootPath: meta.root,
        name: meta.name,
        tree: {},
        expanded: new Set(),
      });
      await useWorkspaceStore.getState().refresh("");
    }
  } catch (e) {
    console.warn(`[menu:open-recent] could not open "${path}":`, e);
  }
}

/**
 * Close the app, guarding unsaved tabs. Reads the tab list fresh (no React
 * selector) so the check reflects current edits at the moment of close.
 *
 * Before destroying the window three things are awaited so the final state is
 * persisted for the next launch:
 *   1. the session tab list + active view ([`captureAndSaveSession`]),
 *   2. the window bounds + UI-panel layout (§7.2 — captured here, alongside
 *      the session, so the next launch reopens at the same size/position/layout),
 *   3. the clean-shutdown marker (§5.1.2 — tells the next launch this session
 *      ended cleanly).
 *
 * The fire-and-forget captures from the store actions may otherwise be cut off
 * by the window going away, so these final awaits are what make the persisted
 * state authoritative.
 *
 * Crash recovery (§5.1.2): right before `destroy()`, write the clean-shutdown
 * marker so the next launch knows this session ended cleanly (every dirty doc
 * was saved or explicitly discarded). The "Don't Save" path also calls
 * `discardRecovery` per doc (handled in `closeTabWithConfirm`), so the user's
 * explicit discards aren't offered again next launch.
 */
async function handleCloseRequested(): Promise<void> {
  // Read the live view order + domain state fresh (no React selector) so the
  // dirty check reflects current edits at the moment of close.
  const docs = readOrderedDocuments();
  const dirty = docs.filter((t) => t.dirty);
  if (dirty.length === 0) {
    await captureAndSaveSession();
    await captureAndSaveWindowState();
    await markCleanShutdown();
    await getCurrentWindow().destroy();
    return;
  }
  const choice = await useDialogStore.getState().confirm({
    title: `You have ${dirty.length} unsaved document${dirty.length === 1 ? "" : "s"}`,
    message: "If you don't save, your changes will be lost.",
    confirmLabel: "Save All",
    discardLabel: "Don't Save",
    cancelLabel: "Cancel",
  });
  if (choice === "cancel") return;
  if (choice === "discard") {
    await captureAndSaveSession();
    await captureAndSaveWindowState();
    await markCleanShutdown();
    await getCurrentWindow().destroy();
    return;
  }
  // choice === "confirm" → Save All, then close only if every save succeeded.
  for (const t of dirty) {
    if (!(await saveTab(t.id))) return;
  }
  await captureAndSaveSession();
  await captureAndSaveWindowState();
  await markCleanShutdown();
  await getCurrentWindow().destroy();
}

/**
 * Capture the current window geometry + UI-panel layout into the persisted
 * session (§7.2), so the next launch reopens at the same size/position/layout.
 *
 * Window bounds come from the live window API ([`captureWindowBounds`]); the
 * layout (sidebar/preview/diagnostics visibility + pane widths) comes from the
 * uiStore + a localStorage-backed preview width. Both are merged into one
 * `save_session` patch. Best-effort: a failure is logged but never throws —
 * losing one capture is harmless (the prior values stand, and the next close
 * re-captures).
 */
export async function captureAndSaveWindowState(): Promise<void> {
  try {
    const windowBounds = await captureWindowBounds();
    const ui = useUiStore.getState();
    const layout = captureLayout({
      sidebarVisible: ui.sidebarVisible,
      previewVisible: ui.previewVisible,
      diagnosticsVisible: readDiagnosticsVisible(),
      previewWidth: readPreviewWidth(),
    });
    await saveSession({ windowBounds, layout });
  } catch (e) {
    console.warn("[windowState] captureAndSaveWindowState failed:", e);
  }
}

/**
 * Read the persisted preview-pane width from localStorage (the EditorArea
 * manages it there as `ts-preview-width`). Returns null when unset/invalid so
 * the session layout omits it (the component default applies on restore).
 */
function readPreviewWidth(): number | null {
  try {
    const raw = localStorage.getItem("ts-preview-width");
    if (raw) {
      const n = Number(raw);
      if (Number.isFinite(n) && n >= 240) return n;
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Read the diagnostics-panel visibility. The panel's collapsed state is local
 * to `EditorArea` (not in a store), so we read the DOM: the panel exposes a
 * `[data-diagnostics-collapsed]` attribute. Returns false (visible-default) on
 * any failure — non-fatal, the session layout just won't capture it precisely.
 */
function readDiagnosticsVisible(): boolean {
  try {
    const el = document.querySelector("[data-diagnostics-panel]");
    if (el) {
      const collapsed = el.getAttribute("data-diagnostics-collapsed") === "true";
      return !collapsed;
    }
  } catch {
    // ignore
  }
  return false;
}

/** Save the active tab in place, or Save As if it's untitled. */
async function handleSave(
  activeId: string | null,
  activeTab: { path: string | null } | null,
): Promise<void> {
  if (activeId === null || activeTab === null) return;
  if (activeTab.path === null) {
    await handleSaveAs(activeId);
    return;
  }
  await saveFile(activeId);
  useTabsStore.getState().markSaved(activeId, activeTab.path);
}

/** Save As: write to a new file and rebind the tab to it. */
async function handleSaveAs(activeId: string | null): Promise<void> {
  if (activeId === null) return;
  const path = await saveAsBE(activeId);
  useTabsStore.getState().markSaved(activeId, path);
}

/** Human label for an alert, given a menu id. */
function labelFor(menuId: string): string {
  switch (menuId) {
    case "open-file": return "Open File";
    case "open-folder": return "Open Folder";
    case "save": return "Save";
    case "save-as": return "Save As";
    case "close-tab": return "Close Tab";
    case "export-pdf": return "Export PDF";
    case "export-png": return "Export PNG";
    case "export-svg": return "Export SVG";
    default: return menuId;
  }
}
