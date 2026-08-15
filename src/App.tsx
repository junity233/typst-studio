import { useEffect, useState } from "react";
import { useTauriListener } from "./hooks/useTauriListener";
import { Workbench } from "./components/Shell/Workbench";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { TitleBar } from "./components/TitleBar/TitleBar";
import { StatusBar } from "./components/StatusBar/StatusBar";
import { StartupProblemsPanel } from "./components/StatusBar/StartupProblemsPanel";
import { ConfirmDialog } from "./components/Dialogs/ConfirmDialog";
import { RecoveryDialog } from "./components/Dialogs/RecoveryDialog";
import { ConflictDialog } from "./components/Dialogs/ConflictDialog";
import { BatchExportDialog } from "./components/Dialogs/BatchExportDialog";
import { FormulaModal } from "./components/FormulaModal/FormulaModal";
import { AboutModal } from "./components/About/AboutModal";
import { ContextMenu } from "./components/Sidebar/ContextMenu";
import { CommandPalette } from "./components/CommandPalette/CommandPalette";
import { useTypstCompile } from "./hooks/useTypstCompile";
import { useAppCommands } from "./hooks/useAppCommands";
import { useExternalFileRouting } from "./hooks/useExternalFileRouting";
import { useStartupSession } from "./hooks/useStartupSession";
import { useWindowRestore } from "./hooks/useWindowRestore";
import { useAutosave } from "./hooks/useAutosave";
// React to a backend WorkspaceChange LSP restart by reconnecting
// appLanguageClient (now the live client — MonacoEditor starts it and this
// hook re-starts it against fresh endpoints after generation bumps).
import { useLspWorkspaceReconnect } from "./hooks/useLspWorkspaceReconnect";
// Keep tinymist's runtime config (formatter choice) in sync with the app
// settings: pushes on every client Ready and on settings changes.
import { useTinymistConfigSync } from "./components/Editor/tinymistConfig";
import { activateAll } from "./extensions";
import {
  onSettingsWindow,
  onStartupProblems,
  onRecoveryAvailable,
  onFsChanged,
  openSettings,
} from "./lib/tauri";
import { invalidateFsChanged } from "./lib/viewerByteCache";
import { isWindows, isTauri } from "./lib/platform";
import { useStartupProblemsStore } from "./store/startupProblemsStore";
import { useRecoveryStore } from "./store/recoveryStore";

/**
 * The application shell. Composes three regions:
 *   ┌─────────────────────────────────────────────┐
 *   │ TitleBar  (Windows only: menus + controls)  │  ← top
 *   ├─────────────────────────────────────────────┤
 *   │ Workbench                                   │
 *   │  ┌──────────┬───────────────────────────┐   │
 *   │  │ Sidebar  │  EditorArea (tabs+preview) │   │  ← main
 *   │  └──────────┴───────────────────────────┘   │
 *   ├─────────────────────────────────────────────┤
 *   │ StatusBar                                   │  ← bottom
 *   └─────────────────────────────────────────────┘
 *
 * The TitleBar renders only on Windows (custom frameless window); macOS/Linux
 * keep their native OS titlebar and global menu bar.
 *
 * While the standalone Settings window is open, a modal overlay covers the
 * shell: the Settings window floats `always_on_top`, and the overlay blocks
 * all pointer input to the editor/preview/sidebar underneath (Tauri has no
 * native cross-platform modal). Clicking the overlay refocuses Settings.
 */
export default function App() {
  useTypstCompile();
  useAppCommands();
  useExternalFileRouting();
  useStartupSession();
  useWindowRestore();
  useAutosave();
  useLspWorkspaceReconnect();
  useTinymistConfigSync();
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Activate all in-tree extensions (registers their views/commands). Runs once;
  // extensions are idempotent-safe via the registry's duplicate-id guard.
  useEffect(() => {
    void activateAll();
  }, []);

  useTauriListener(onSettingsWindow, (open) => setSettingsOpen(open));

  // Collect non-fatal startup problems (§6.5) into the store for a non-modal
  // banner. The full problem-panel UI is a later batch (S19); for now the
  // StatusBar reads the store count.
  useTauriListener(onStartupProblems, (problems) => {
    useStartupProblemsStore.getState().setProblems(problems);
  });

  // Crash recovery (§5.1.3): the backend emits `recovery_available` once at
  // startup if recoverable snapshots exist. Populate the recovery store, which
  // opens the RecoveryDialog. `useStartupSession` waits (bounded) for this
  // event + dialog resolution before doing the normal session restore, so
  // recovery wins over session for docs that have both.
  useTauriListener(onRecoveryAvailable, (payload) => {
    useRecoveryStore.getState().offerRecovery(payload.snapshots);
  });

  // Keep the binary-viewer byte cache fresh: drop cached image/PDF bytes for
  // paths the backend watcher reports as changed. App is permanently mounted,
  // so the cache is invalidated even when no viewer is currently mounted (a
  // later mount of the same tab then re-reads from disk). Mounted viewers
  // additionally listen themselves to reload their content live.
  useTauriListener(onFsChanged, ({ paths }) => {
    invalidateFsChanged(paths);
  });

  return (
    <ErrorBoundary>
    <div className="app">
      {/* The custom TitleBar calls Tauri's getCurrentWindow() at render, which
          throws outside the Tauri shell. Gate on isTauri so the frontend still
          renders in a plain browser (e.g. for dev/visual checks). */}
      {isWindows && isTauri && <TitleBar />}
      <Workbench />
      {/* §6.5: non-modal startup-problems panel. Overlays the workbench's
          bottom-right corner; non-blocking. Renders only when problems exist
          and haven't been dismissed. */}
      <StartupProblemsPanel />
      <StatusBar />
      <ConfirmDialog />
      <RecoveryDialog />
      <ConflictDialog />
      {/* Command-palette `export-batch` opens this (batchExportStore). */}
      <BatchExportDialog />
      {/* Store-driven (useFormulaModalStore); opened by the toolbar button and
          the Ctrl+Alt+M command. Renders nothing when closed. */}
      <FormulaModal />
      {/* Store-driven (useAboutModalStore); opened by Help → About and the
          open-about command. Renders nothing when closed. */}
      <AboutModal />
      <ContextMenu />
      <CommandPalette />
      {settingsOpen && (
        <div
          className="settings-modal-overlay"
          onClick={() => void openSettings()}
        />
      )}
    </div>
    </ErrorBoundary>
  );
}
