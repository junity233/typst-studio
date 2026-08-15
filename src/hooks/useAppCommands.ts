import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { onMenuEvent, onCloseRequested } from "../lib/tauri";
import {
  openFile,
  markCleanShutdown,
  saveSession,
  discardRecovery,
} from "../lib/tauri";
import { useTabsStore, readAllDocuments } from "../store/tabsStore";
import { useWorkspaceStore } from "../store/workspaceStore";
import { useProjectConfigStore } from "../store/projectConfigStore";
import { workspacePathsEqual } from "../lib/workspacePath";
import { useUiStore } from "../store/uiStore";
import { useDialogStore } from "../store/dialogStore";
import { saveTab } from "../lib/commands";
import { flushAndSaveAs } from "../lib/saveDocument";
import { captureAndSaveSession } from "../lib/session";
import { captureWindowBounds } from "../lib/windowState";
import { captureLayout } from "../lib/layoutState";
import { toIpcError } from "../lib/ipc-error";
import i18n from "../i18n";
import { commandRegistry } from "../extensions/registry";
import { createHostApi } from "../extensions/api";
import {
  parseKeybinding,
  matchKeybinding,
  type ParsedKeybinding,
} from "../extensions/keybinding";
import { readSetting } from "./useSetting";
import { useTauriListener } from "./useTauriListener";
// Captured-phase shortcut yield rule (input/textarea/select/contenteditable
// own their keystrokes, Monaco's hidden textarea exempted). Extracted to
// lib/editableTarget.ts for direct testability — see its JSDoc there.
import { isEditableTarget } from "../lib/editableTarget";
// Import the workbench extension's lazy activator. Activating is deferred to
// first dispatch() call (NOT module load) to avoid a circular init: this file
// exports helpers that the workbench module imports back, so running activate()
// during import would reach those helpers before they are initialized.
import { ensureActivated as ensureWorkbenchActivated } from "../extensions/workbench";

const hostApi = createHostApi("workbench.dispatch");

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
  useTauriListener(onMenuEvent, (payload) => {
    void dispatch(payload.id);
  });

  useEffect(() => {
    // Capture-phase keybinding dispatcher. The native menu's accelerator only
    // fires when the keypress reaches the OS — but Monaco (and the VS Code
    // services we wire via filesServiceOverride) can swallow Cmd+S etc. in the
    // webview before it bubbles, so the menu handler never runs. This
    // document-level capture listener sits ahead of the editor and matches the
    // event against every command's keybinding, making all shortcuts reliable
    // regardless of focus.
    //
    // The single source of truth for what's bound is `commandRegistry` — each
    // command contributes a default `keybinding` string, which a user may
    // override via the `keybindings.<cmdId>` setting. We resolve the effective
    // binding per keydown (cheap: ~20 commands) so a setting change takes
    // effect on the very next keystroke with no re-subscription needed.
    const parseCache = new Map<string, ParsedKeybinding | null>();
    const match = (binding: string, ev: KeyboardEvent): boolean => {
      let parsed = parseCache.get(binding);
      if (parsed === undefined) {
        parsed = parseKeybinding(binding);
        parseCache.set(binding, parsed);
      }
      // parsed is now ParsedKeybinding | null (undefined filled in above).
      return parsed !== null && parsed !== undefined && matchKeybinding(parsed, ev);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      // A focused editable control (input, textarea, select, [contenteditable])
      // owns the keystrokes — let it handle them, and skip every app-global
      // shortcut so typing in the Search panel or Assistant textarea does not
      // trigger save / find / format. (Monaco's own textarea is exempted inside
      // isEditableTarget — see its comment.)
      if (isEditableTarget(e.target)) return;

      for (const cmd of commandRegistry.all()) {
        const binding = cmd.keybinding;
        if (!binding) continue;
        // User override wins; fall back to the command's default binding.
        const settingPath = `keybindings.${cmd.id}`;
        const overridden = readSetting<string | undefined>(settingPath, undefined);
        const effective = overridden ?? binding;
        // Empty string = explicitly disabled.
        if (effective === "") continue;
        if (match(effective, e)) {
          e.preventDefault();
          e.stopPropagation();
          void dispatch(cmd.id);
          return;
        }
      }
    };
    document.addEventListener("keydown", onKeyDown, true);

    return () => {
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
  useTauriListener(onCloseRequested, () => {
    void handleCloseRequested();
  });
}

/** Run the action for a menu id. Exported for testing / programmatic dispatch. */
export async function dispatch(menuId: string): Promise<void> {
  // Register the core commands on first use (idempotent). Deferred from module
  // load to avoid a circular init with the workbench extension.
  ensureWorkbenchActivated();
  try {
    // "Open Recent > <workspace>" submenu (§7.2): id is
    // `open-recent:<path-or-index>`. Dynamic id — kept as a special case, not
    // a registered command.
    if (menuId.startsWith("open-recent:")) {
      await handleOpenRecent(menuId);
      return;
    }

    // Look up in the registry (workbench extension registers the core commands).
    const cmd = commandRegistry.get(menuId);
    if (cmd) {
      if (cmd.enablement && !cmd.enablement(hostApi)) return;
      await cmd.handler(hostApi);
      return;
    }

    // Unknown / predefined items (Cut/Copy/Quit/etc.) handled natively; ignore.
  } catch (e) {
    // §5.3: a Cancelled code (dismissed dialog) is not a failure — silent.
    const ipc = toIpcError(e);
    if (ipc.code === "cancelled") {
      return;
    }
    console.warn(`[menu:${menuId}] failed:`, ipc.code, ipc.message);
    const cmd = commandRegistry.get(menuId);
    const label = cmd?.title ?? labelFor(menuId) ?? menuId;
    window.alert(
      i18n.t("commandFailed", { ns: "errors", label, message: ipc.message }),
    );
  }
}

/** Open a single file via the native dialog and add it as a tab. */
export async function handleOpenFile(): Promise<void> {
  const doc = await openFile();
  if (doc === null) return;
  useTabsStore.getState().openPath(doc);
}

/**
 * Handle an "Open Recent > <workspace>" menu pick (§7.2 "最近工作区"). The id
 * suffix is EITHER an absolute path (URI-encoded — TitleBar dispatches
 * `open-recent:<encodeURIComponent(path)>`) or the legacy integer index into
 * the session's recent list. The path form is preferred: a TitleBar-side
 * index refers to a stale module-load snapshot of the list, so after any
 * workspace open mid-session the indices diverge and an index pick can open
 * the WRONG workspace; the fresh list is re-loaded here and matched by path.
 * Best-effort: a stale/missing entry silently no-ops (the menu is static for
 * the session, so a removed folder can still be listed).
 */
async function handleOpenRecent(menuId: string): Promise<void> {
  const suffix = menuId.slice("open-recent:".length);
  const { loadSession, recordWorkspace } = await import("../lib/session");
  const { openWorkspaceByPath } = await import("../lib/tauri");
  const session = await loadSession();
  let path: string | undefined;
  if (/^\d+$/.test(suffix)) {
    // Legacy payload: an index into the FRESH recent list.
    path = session.recentWorkspaces[Number(suffix)];
  } else {
    // Path payload: decode and match by path equality (separator- and,
    // on Windows, case-insensitive via `workspacePathsEqual`).
    let decoded: string;
    try {
      decoded = decodeURIComponent(suffix);
    } catch {
      return; // malformed encoding — ignore
    }
    path = session.recentWorkspaces.find((p) =>
      workspacePathsEqual(p, decoded),
    );
  }
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
      // Persist so session.lastWorkspace + the recent list track this open
      // (matches workspaceStore.openWorkspace); otherwise the next launch
      // would reopen the previous workspace.
      recordWorkspace(meta.root);
      // Re-hydrate the project-config store for the new root (also mirrors
      // workspaceStore.openWorkspace), or the Project panel keeps the previous
      // workspace's configPath/typFiles.
      void useProjectConfigStore.getState().hydrate();
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
  // dirty check reflects current edits at the moment of close. Includes
  // soft-closed (hidden) docs: a hidden doc can still hold unsaved edits in its
  // alive Monaco model, and silently losing them on app exit would violate the
  // "no data loss without prompting" guarantee.
  const docs = readAllDocuments();
  const dirty = docs.filter((t) => t.dirty);
  if (dirty.length === 0) {
    await captureAndSaveSession();
    await captureAndSaveWindowState();
    await markCleanShutdown();
    await getCurrentWindow().destroy();
    return;
  }
  const choice = await useDialogStore.getState().confirm({
    title: i18n.t("closeUnsaved.title", {
      ns: "dialog",
      count: dirty.length,
    }),
    message: i18n.t("closeUnsaved.dontSaveChangesLost", { ns: "dialog" }),
    confirmLabel: i18n.t("closeUnsaved.saveAll", { ns: "dialog" }),
    discardLabel: i18n.t("dontSave", { ns: "common" }),
    cancelLabel: i18n.t("cancel", { ns: "common" }),
  });
  if (choice === "cancel") return;
  if (choice === "discard") {
    // §5.1.4: discard recovery snapshots for every dirty doc so the user's
    // explicit "Don't Save" isn't re-offered next launch. The per-tab close
    // path (closeTabWithConfirm) does this per doc; the app-wide path must too.
    await Promise.all(dirty.map((t) => discardRecovery(t.id).catch(() => {})));
    await captureAndSaveSession(new Set(dirty.map((t) => t.id)));
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
      sidebarWidth: readSidebarWidth(),
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
 * Read the persisted sidebar-pane width from localStorage (the Workbench
 * manages it there as `ts-sidebar-width`). Returns null when unset/invalid so
 * the session layout omits it (the component default applies on restore).
 * Mirrors {@link readPreviewWidth}.
 */
function readSidebarWidth(): number | null {
  try {
    const raw = localStorage.getItem("ts-sidebar-width");
    if (raw) {
      const n = Number(raw);
      if (Number.isFinite(n) && n >= 0) return n;
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
export async function handleSave(
  activeId: string | null,
  activeTab: { path: string | null } | null,
): Promise<void> {
  if (activeId === null || activeTab === null) return;
  // Route through `saveTab` (lib/commands) instead of flushing directly, so
  // Ctrl+S / the menu Save command get the full save contract: untitled →
  // Save As, cancelled silent, and — critically — the §5.4 conflict gate: an
  // `external_conflict` rejection opens the ConflictDialog (a resolution
  // path), where a raw alert here would leave the user stuck. saveTab also
  // no-ops on a vanished doc and handles the SAVE_AS_RECOVERY_CODES fallback.
  await saveTab(activeId);
}

/** Save As: write to a new file and rebind the tab to it. */
export async function handleSaveAs(activeId: string | null): Promise<void> {
  if (activeId === null) return;
  const saved = await flushAndSaveAs(activeId);
  useTabsStore.getState().markSaved(activeId, saved.path, saved.revision);
}

/** Human label for an alert, given a menu id. */
export function labelFor(menuId: string): string {
  switch (menuId) {
    case "open-file": return i18n.t("commandLabel.openFile", { ns: "dialog" });
    case "open-folder": return i18n.t("commandLabel.openFolder", { ns: "dialog" });
    case "save": return i18n.t("commandLabel.save", { ns: "dialog" });
    case "save-as": return i18n.t("commandLabel.saveAs", { ns: "dialog" });
    case "close-tab": return i18n.t("commandLabel.closeTab", { ns: "dialog" });
    case "export-pdf": return i18n.t("commandLabel.exportPdf", { ns: "dialog" });
    case "export-png": return i18n.t("commandLabel.exportPng", { ns: "dialog" });
    case "export-svg": return i18n.t("commandLabel.exportSvg", { ns: "dialog" });
    default: return menuId;
  }
}
