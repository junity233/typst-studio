import { exportPdf, exportPng, openFile, saveFile } from "../../lib/tauri";
import { useTabsStore } from "../../store/tabsStore";

async function run(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[${label}] ${msg}`);
    window.alert(`${label}: ${msg}`);
  }
}

export function TitleBar() {
  const activeId = useTabsStore((s) => s.activeId);
  const activeTab = useTabsStore((s) =>
    s.tabs.find((t) => t.id === s.activeId) ?? null,
  );
  const openPath = useTabsStore((s) => s.openPath);
  const markSaved = useTabsStore((s) => s.markSaved);

  const handleOpen = (): void => {
    void run("Open", async () => {
      const doc = await openFile();
      if (doc === null) return;
      openPath(doc);
    });
  };

  const handleSave = (): void => {
    if (activeId === null || activeTab === null) return;
    void run("Save", async () => {
      await saveFile(activeId);
      if (activeTab.path !== null) {
        markSaved(activeId, activeTab.path);
      }
    });
  };

  const handleExportPdf = (): void => {
    if (activeId === null) return;
    void run("Export PDF", async () => {
      const saved = await exportPdf(activeId);
      console.log("[Export PDF] saved to", saved);
    });
  };

  const handleExportPng = (): void => {
    if (activeId === null) return;
    void run("Export PNG", async () => {
      const saved = await exportPng(activeId);
      console.log(`[Export PNG] saved ${saved.length} page(s)`);
    });
  };

  // The primary (filled-blue) treatment is reserved for when there is unsaved
  // work; a clean tab downshifts to the dark utility style. Purely visual —
  // the button stays clickable either way.
  const saveClass = activeTab !== null && activeTab.dirty
    ? "btn-primary"
    : "btn-utility";

  return (
    <header className="toolbar">
      <span className="toolbar-brand">Typst Studio</span>
      <nav className="toolbar-actions">
        <button className="btn-utility" onClick={handleOpen}>
          Open
        </button>
        <button
          className={saveClass}
          onClick={handleSave}
          title="Save (Cmd/Ctrl+S)"
        >
          Save
        </button>
        <button className="btn-ghost" onClick={handleExportPdf}>
          Export PDF
        </button>
        <button className="btn-ghost" onClick={handleExportPng}>
          Export PNG
        </button>
      </nav>
    </header>
  );
}
