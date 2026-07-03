import { useTabsStore } from "../../store/tabsStore";
import { useDocumentsStore } from "../../store/documentsStore";
import { closeTabWithConfirm } from "../../lib/commands";

export function TabStrip() {
  const tabs = useTabsStore((s) => s.tabs);
  const activeId = useTabsStore((s) => s.activeId);
  const activate = useTabsStore((s) => s.activate);
  const openTab = useTabsStore((s) => s.openTab);
  // Subscribe to the documents map so the dirty indicator updates live.
  const documents = useDocumentsStore((s) => s.documents);

  return (
    <div className="tabstrip" role="tablist" aria-label="Open documents">
      {tabs.map((id) => {
        const active = id === activeId;
        const doc = documents[id];
        const title = doc?.title ?? id;
        const dirty = doc?.dirty ?? false;
        return (
          <div
            key={id}
            role="tab"
            tabIndex={0}
            aria-selected={active}
            className={"tab" + (active ? " tab-active" : "")}
            onClick={() => activate(id)}
          >
            {dirty && <span className="tab-dirty" aria-hidden="true" />}
            <span className="tab-title">{title}</span>
            <button
              className="tab-close"
              type="button"
              aria-label={`Close ${title}`}
              onClick={(e) => {
                e.stopPropagation();
                void closeTabWithConfirm(id);
              }}
            >
              ×
            </button>
          </div>
        );
      })}
      <button
        className="tab-add"
        type="button"
        aria-label="New tab"
        onClick={() => openTab()}
      >
        +
      </button>
    </div>
  );
}
