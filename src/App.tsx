import { useEffect, useState } from "react";
import { Workbench } from "./components/Shell/Workbench";
import { TitleBar } from "./components/TitleBar/TitleBar";
import { StatusBar } from "./components/StatusBar/StatusBar";
import { StartupProblemsPanel } from "./components/StatusBar/StartupProblemsPanel";
import { ConfirmDialog } from "./components/Dialogs/ConfirmDialog";
import { RecoveryDialog } from "./components/Dialogs/RecoveryDialog";
import { ConflictDialog } from "./components/Dialogs/ConflictDialog";
import { FormulaModal } from "./components/FormulaModal/FormulaModal";
import { ContextMenu } from "./components/Sidebar/ContextMenu";
import { CommandPalette } from "./components/CommandPalette/CommandPalette";
import { useTypstCompile } from "./hooks/useTypstCompile";
import { useAppCommands } from "./hooks/useAppCommands";
import { useExternalFileRouting } from "./hooks/useExternalFileRouting";
import { useStartupSession } from "./hooks/useStartupSession";
import { useWindowRestore } from "./hooks/useWindowRestore";
import { useAutosave } from "./hooks/useAutosave";
// Task 8 part C: react to a backend WorkspaceChange LSP restart by reconnecting
// appLanguageClient. Currently INERT — gated on appLanguageClient.isRunning(),
// which is false until the Phase-C rewire makes it the active client (today the
// wrapper's client still drives the live session). Mounted so the subscription
// is live and ready the moment the rewire lands.
import { useLspWorkspaceReconnect } from "./hooks/useLspWorkspaceReconnect";
import { activateAll } from "./extensions";
import {
  onSettingsWindow,
  onStartupProblems,
  onRecoveryAvailable,
  openSettings,
} from "./lib/tauri";
import { isWindows } from "./lib/platform";
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
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Activate all in-tree extensions (registers their views/commands). Runs once;
  // extensions are idempotent-safe via the registry's duplicate-id guard.
  useEffect(() => {
    void activateAll();
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    onSettingsWindow((open) => setSettingsOpen(open)).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  // Collect non-fatal startup problems (§6.5) into the store for a non-modal
  // banner. The full problem-panel UI is a later batch (S19); for now the
  // StatusBar reads the store count.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    onStartupProblems((problems) => {
      useStartupProblemsStore.getState().setProblems(problems);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  // Crash recovery (§5.1.3): the backend emits `recovery_available` once at
  // startup if recoverable snapshots exist. Populate the recovery store, which
  // opens the RecoveryDialog. `useStartupSession` waits (bounded) for this
  // event + dialog resolution before doing the normal session restore, so
  // recovery wins over session for docs that have both.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    onRecoveryAvailable((payload) => {
      useRecoveryStore.getState().offerRecovery(payload.snapshots);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  return (
    <div className="app">
      {isWindows && <TitleBar />}
      <Workbench />
      {/* §6.5: non-modal startup-problems panel. Overlays the workbench's
          bottom-right corner; non-blocking. Renders only when problems exist
          and haven't been dismissed. */}
      <StartupProblemsPanel />
      <StatusBar />
      <ConfirmDialog />
      <RecoveryDialog />
      <ConflictDialog />
      {/* Store-driven (useFormulaModalStore); opened by the toolbar button and
          the Ctrl+Alt+M command. Renders nothing when closed. */}
      <FormulaModal />
      <ContextMenu />
      <CommandPalette />
      {settingsOpen && (
        <div
          className="settings-modal-overlay"
          onClick={() => void openSettings()}
        />
      )}
    </div>
  );
}
