import { Workbench } from "./components/Shell/Workbench";
import { CommandBar } from "./components/CommandBar/CommandBar";
import { StatusBar } from "./components/StatusBar/StatusBar";
import { ConfirmDialog } from "./components/Dialogs/ConfirmDialog";
import { ContextMenu } from "./components/Sidebar/ContextMenu";
import { useTypstCompile } from "./hooks/useTypstCompile";
import { useAppCommands } from "./hooks/useAppCommands";

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
 */
export default function App() {
  useTypstCompile();
  useAppCommands();

  return (
    <div className="app">
      <CommandBar />
      <Workbench />
      <StatusBar />
      <ConfirmDialog />
      <ContextMenu />
    </div>
  );
}
