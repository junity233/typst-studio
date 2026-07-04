import { useEffect, useState } from "react";
import { Workbench } from "./components/Shell/Workbench";
import { CommandBar } from "./components/CommandBar/CommandBar";
import { StatusBar } from "./components/StatusBar/StatusBar";
import { ConfirmDialog } from "./components/Dialogs/ConfirmDialog";
import { ContextMenu } from "./components/Sidebar/ContextMenu";
import { useTypstCompile } from "./hooks/useTypstCompile";
import { useAppCommands } from "./hooks/useAppCommands";
import { useExternalFileRouting } from "./hooks/useExternalFileRouting";
import { useStartupSession } from "./hooks/useStartupSession";
import { onSettingsWindow, onStartupProblems, openSettings } from "./lib/tauri";
import { useStartupProblemsStore } from "./store/startupProblemsStore";

/**
 * The application shell. Composes three regions:
 *   ┌─────────────────────────────────────────────┐
 *   │ CommandBar  (breadcrumb + overflow menu)    │  ← top
 *   ├─────────────────────────────────────────────┤
 *   │ Workbench                                   │
 *   │  ┌──────────┬───────────────────────────┐   │
 *   │  │ Sidebar  │  EditorArea (tabs+preview) │   │  ← main
 *   │  └──────────┴───────────────────────────┘   │
 *   ├─────────────────────────────────────────────┤
 *   │ StatusBar                                   │  ← bottom
 *   └─────────────────────────────────────────────┘
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
  const [settingsOpen, setSettingsOpen] = useState(false);

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

  return (
    <div className="app">
      <CommandBar />
      <Workbench />
      <StatusBar />
      <ConfirmDialog />
      <ContextMenu />
      {settingsOpen && (
        <div
          className="settings-modal-overlay"
          onClick={() => void openSettings()}
        />
      )}
    </div>
  );
}
