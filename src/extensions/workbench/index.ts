import type { HostApi } from "../api";
import { commandRegistry } from "../registry";
import {
  hasActiveTab,
  useTabsStore,
} from "../../store/tabsStore";
import { useDocumentsStore } from "../../store/documentsStore";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { useUiStore } from "../../store/uiStore";
import { useAboutModalStore } from "../../store/aboutModalStore";
import {
  openFileByPath,
  openSettings,
} from "../../lib/tauri";
import { closeTabWithConfirm } from "../../lib/commands";
import {
  handleOpenFile,
  handleSave,
  handleSaveAs,
  labelFor,
} from "../../hooks/useAppCommands";
import { joinWorkspacePath } from "../../lib/workspacePath";
import { useProjectConfigStore } from "../../store/projectConfigStore";
import { runExport, defaultExportFormat } from "../../lib/exportTarget";
import { useBatchExportStore } from "../../store/batchExportStore";
import i18n from "../../i18n";

/**
 * In-tree 'workbench' extension: registers the core File/View/Export commands
 * that used to live as a hardcoded switch in dispatch(). Each handler reads
 * live state at call time via getState(), so enablement and active-tab lookups
 * reflect the moment of invocation, not the moment of registration.
 *
 * Export targeting/format logic lives in
 * [`lib/exportTarget.ts`](../../lib/exportTarget.ts) (shared with
 * auto-export-on-save); this module only registers the commands.
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
    enablement: hasActiveTab,
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
    enablement: hasActiveTab,
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
    enablement: hasActiveTab,
  });

  ctx.registerCommand({
    id: "toggle-sidebar",
    title: i18n.t("toggleSidebar", { ns: "command" }),
    category: "View",
    // Ctrl+B is reserved for Bold (format.bold). The sidebar moves to
    // Ctrl+Shift+B — pairs naturally with the bold binding (add Shift), and
    // doesn't collide with any existing keybinding in the registry.
    keybinding: "CmdOrCtrl+Shift+B",
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
    id: "open-about",
    title: i18n.t("openAbout", { ns: "command" }),
    category: "View",
    handler: () => {
      useAboutModalStore.getState().open();
    },
  });

  /** Run one export format via the shared runner (`lib/exportTarget`), which
   *  honors the project's `[export] outputPath` (macro-expanded + joined to
   *  the workspace root). When no outputPath is configured, the backend shows
   *  its save dialog. */
  async function doExport(
    format: "pdf" | "png" | "svg",
    useConfigPath: boolean,
  ): Promise<void> {
    await runExport(format, useConfigPath);
  }

  // The four export commands differ only in the format they pin: the plain
  // "export" defers to the project's `[export] format` setting
  // (defaultExportFormat), while the explicit variants pin one format. The
  // plain command reuses the PDF label (labelFor has no "export" case — the
  // native menu shows it as "Export as PDF…" for the default format).
  const exportCommands: ReadonlyArray<{
    id: string;
    format: "pdf" | "png" | "svg" | null;
  }> = [
    { id: "export", format: null },
    { id: "export-pdf", format: "pdf" },
    { id: "export-png", format: "png" },
    { id: "export-svg", format: "svg" },
  ];
  for (const { id, format } of exportCommands) {
    ctx.registerCommand({
      id,
      title: labelFor(id === "export" ? "export-pdf" : id),
      category: "File",
      handler: async () => {
        await doExport(format ?? defaultExportFormat(), true);
      },
      enablement: hasActiveTab,
    });
  }

  ctx.registerCommand({
    id: "export-batch",
    title: i18n.t("title", { ns: "batchExport" }),
    category: "File",
    handler: async () => {
      await useBatchExportStore.getState().openDialog();
    },
    enablement: () => useWorkspaceStore.getState().rootPath !== null,
  });

  ctx.registerCommand({
    id: "open-project-settings",
    title: i18n.t("openProjectSettings", { ns: "project" }),
    category: "View",
    handler: async () => {
      useUiStore.getState().setActiveView("workbench.project");
    },
    enablement: () => useWorkspaceStore.getState().rootPath !== null,
  });

  ctx.registerCommand({
    id: "go-to-main-file",
    title: i18n.t("goToMainFile", { ns: "project" }),
    category: "Go",
    handler: async () => {
      const rootPath = useWorkspaceStore.getState().rootPath;
      const main = useProjectConfigStore.getState().config?.main ?? null;
      if (main === null || rootPath === null) return;
      const doc = await openFileByPath(joinWorkspacePath(rootPath, main));
      useTabsStore.getState().openPath(doc);
    },
    enablement: () => {
      const rootPath = useWorkspaceStore.getState().rootPath;
      const main = useProjectConfigStore.getState().config?.main ?? null;
      return rootPath !== null && main !== null;
    },
  });
}
