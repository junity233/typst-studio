import { useEffect } from "react";
import { onMenuEvent } from "../lib/tauri";
import {
  exportPdf,
  exportPng,
  exportSvg,
  openFile,
  saveAs as saveAsBE,
  saveFile,
} from "../lib/tauri";
import { useTabsStore } from "../store/tabsStore";
import { useWorkspaceStore } from "../store/workspaceStore";
import { useUiStore } from "../store/uiStore";

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

    return () => {
      unlisten?.();
    };
  }, []);
}

/** Run the action for a menu id. Exported for testing / programmatic dispatch. */
export async function dispatch(menuId: string): Promise<void> {
  const tabs = useTabsStore.getState();
  const activeId = tabs.activeId;
  const activeTab = tabs.tabs.find((t) => t.id === activeId) ?? null;
  const ws = useWorkspaceStore.getState();
  const ui = useUiStore.getState();

  try {
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
        if (activeId !== null) await tabs.closeTab(activeId);
        break;

      case "toggle-sidebar":
        ui.toggleSidebar();
        break;

      case "toggle-preview":
        ui.togglePreview();
        break;

      case "export-pdf":
        if (activeId !== null) await exportPdf(activeId);
        break;

      case "export-png":
        if (activeId !== null) await exportPng(activeId);
        break;

      case "export-svg":
        if (activeId !== null) await exportSvg(activeId);
        break;

      default:
        // Unknown / predefined items are handled natively; ignore here.
        break;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[menu:${menuId}] failed:`, msg);
    window.alert(`${labelFor(menuId)}: ${msg}`);
  }
}

/** Open a single file via the native dialog and add it as a tab. */
async function handleOpenFile(): Promise<void> {
  const doc = await openFile();
  if (doc === null) return;
  useTabsStore.getState().openPath(doc);
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
