import { useEffect } from "react";
import { Workbench } from "./components/Shell/Workbench";
import { CommandBar } from "./components/CommandBar/CommandBar";
import { StatusBar } from "./components/StatusBar/StatusBar";
import { useTypstCompile } from "./hooks/useTypstCompile";
import { useAppCommands } from "./hooks/useAppCommands";
import { initTabs, useTabsStore } from "./store/tabsStore";

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

  // Ensure at least one tab exists on first load.
  useEffect(() => {
    void initTabs();
  }, []);

  // Reference tabs so the store is touched even before any tab is open — keeps
  // the selector warm and avoids "unused" lint in this thin shell.
  useTabsStore((s) => s.activeId);

  return (
    <div className="app">
      <CommandBar />
      <Workbench />
      <StatusBar />
    </div>
  );
}
