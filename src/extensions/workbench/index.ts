import type { HostApi } from "../api";
import { commandRegistry } from "../registry";
import { useTabsStore } from "../../store/tabsStore";
import { useDocumentsStore } from "../../store/documentsStore";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { useUiStore } from "../../store/uiStore";
import {
  exportPdf,
  exportPng,
  exportSvg,
  openSettings,
} from "../../lib/tauri";
import { closeTabWithConfirm } from "../../lib/commands";
import {
  handleOpenFile,
  handleSave,
  handleSaveAs,
  labelFor,
} from "../../hooks/useAppCommands";
import i18n from "../../i18n";

/**
 * In-tree 'workbench' extension: registers the core File/View/Export commands
 * that used to live as a hardcoded switch in dispatch(). Each handler reads
 * live state at call time via getState(), so enablement and active-tab lookups
 * reflect the moment of invocation, not the moment of registration.
 *
 * Error handling (toIpcError / cancelled / window.alert) is centralized in
 * dispatch() — handlers throw freely.
 *
 * Activation: activate() registers the commands and is idempotent.
 * ensureActivated() is the lazy entry point — it is called by dispatch() on
 * first use and by App.tsx via activateAll(). Activation is deliberately NOT
 * done at module-load top level: this module imports helpers (labelFor,
 * handleSave, …) from useAppCommands.ts, which in turn imports this module, so
 * running activate() during import would hit those helpers before they are
 * initialized (circular init). Deferring to first call sidesteps the cycle.
 */
let activated = false;

/** Register the core commands into the registry, once. Idempotent. */
export function ensureActivated(): void {
  if (activated) return;
  const selfApi: HostApi = {
    extensionId: "workbench",
    registerView: () => {},
    registerCommand: (c) => commandRegistry.register(c),
    registerMenuItem: () => {},
  };
  activate(selfApi);
}

export default function activate(ctx: HostApi): void {
  if (activated) return;
  activated = true;

  ctx.registerCommand({
    id: "new-tab",
    title: labelFor("new-tab") || i18n.t("newTab", { ns: "command" }),
    category: "File",
    keybinding: "CmdOrCtrl+T",
    handler: async () => {
      await useTabsStore.getState().openTab();
    },
  });

  ctx.registerCommand({
    id: "open-file",
    title: labelFor("open-file"),
    category: "File",
    keybinding: "CmdOrCtrl+O",
    handler: async () => {
      await handleOpenFile();
    },
  });

  ctx.registerCommand({
    id: "open-folder",
    title: labelFor("open-folder"),
    category: "File",
    // No keybinding: Shift+O collides with Show Outline, and muda (Tauri's
    // menu lib) doesn't support the chord accelerator we'd prefer
    // (Ctrl+K Ctrl+O, VS Code's Open Folder). Reachable via the File menu +
    // welcome screen.
    handler: async () => {
      await useWorkspaceStore.getState().openWorkspace();
    },
  });

  ctx.registerCommand({
    id: "save",
    title: labelFor("save"),
    category: "File",
    keybinding: "CmdOrCtrl+S",
    handler: async () => {
      const { activeId } = useTabsStore.getState();
      const activeTab =
        activeId !== null
          ? (useDocumentsStore.getState().documents[activeId] ?? null)
          : null;
      await handleSave(activeId, activeTab);
    },
    enablement: () => useTabsStore.getState().activeId !== null,
  });

  ctx.registerCommand({
    id: "save-as",
    title: labelFor("save-as"),
    category: "File",
    keybinding: "CmdOrCtrl+Shift+S",
    handler: async () => {
      const { activeId } = useTabsStore.getState();
      await handleSaveAs(activeId);
    },
    enablement: () => useTabsStore.getState().activeId !== null,
  });

  ctx.registerCommand({
    id: "close-tab",
    title: labelFor("close-tab"),
    category: "View",
    keybinding: "CmdOrCtrl+W",
    handler: async () => {
      const { activeId } = useTabsStore.getState();
      if (activeId !== null) await closeTabWithConfirm(activeId);
    },
    enablement: () => useTabsStore.getState().activeId !== null,
  });

  ctx.registerCommand({
    id: "toggle-sidebar",
    title: i18n.t("toggleSidebar", { ns: "command" }),
    category: "View",
    keybinding: "CmdOrCtrl+B",
    handler: () => useUiStore.getState().toggleSidebar(),
  });

  ctx.registerCommand({
    id: "toggle-preview",
    title: i18n.t("togglePreview", { ns: "command" }),
    category: "View",
    keybinding: "CmdOrCtrl+\\",
    handler: () => useUiStore.getState().togglePreview(),
  });

  ctx.registerCommand({
    id: "open-settings",
    title: i18n.t("openSettings", { ns: "command" }),
    category: "View",
    keybinding: "CmdOrCtrl+,",
    handler: async () => {
      await openSettings();
    },
  });

  ctx.registerCommand({
    id: "export-pdf",
    title: labelFor("export-pdf"),
    category: "File",
    handler: async () => {
      const { activeId } = useTabsStore.getState();
      const activeTab =
        activeId !== null
          ? (useDocumentsStore.getState().documents[activeId] ?? null)
          : null;
      if (activeId !== null && activeTab !== null) {
        await exportPdf(activeId, activeTab.revision);
      }
    },
    enablement: () => useTabsStore.getState().activeId !== null,
  });

  ctx.registerCommand({
    id: "export-png",
    title: labelFor("export-png"),
    category: "File",
    handler: async () => {
      const { activeId } = useTabsStore.getState();
      const activeTab =
        activeId !== null
          ? (useDocumentsStore.getState().documents[activeId] ?? null)
          : null;
      if (activeId !== null && activeTab !== null) {
        await exportPng(activeId, activeTab.revision);
      }
    },
    enablement: () => useTabsStore.getState().activeId !== null,
  });

  ctx.registerCommand({
    id: "export-svg",
    title: labelFor("export-svg"),
    category: "File",
    handler: async () => {
      const { activeId } = useTabsStore.getState();
      const activeTab =
        activeId !== null
          ? (useDocumentsStore.getState().documents[activeId] ?? null)
          : null;
      if (activeId !== null && activeTab !== null) {
        await exportSvg(activeId, activeTab.revision);
      }
    },
    enablement: () => useTabsStore.getState().activeId !== null,
  });
}
