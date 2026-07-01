import { useTabsStore } from "../../store/tabsStore";

export function TabStrip() {
  const tabs = useTabsStore((s) => s.tabs);
  const activeId = useTabsStore((s) => s.activeId);
  const activate = useTabsStore((s) => s.activate);
  const closeTab = useTabsStore((s) => s.closeTab);
  const openTab = useTabsStore((s) => s.openTab);

  return (
    <div className="tabstrip" role="tablist" aria-label="Open documents">
      {tabs.map((tab) => {
        const active = tab.id === activeId;
        return (
          <div
            key={tab.id}
            role="tab"
            tabIndex={0}
            aria-selected={active}
            className={"tab" + (active ? " tab-active" : "")}
            onClick={() => activate(tab.id)}
          >
            {tab.dirty && <span className="tab-dirty" aria-hidden="true" />}
            <span className="tab-title">{tab.title}</span>
            <button
              className="tab-close"
              type="button"
              aria-label={`Close ${tab.title}`}
              onClick={(e) => {
                e.stopPropagation();
                closeTab(tab.id);
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
