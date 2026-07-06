import { useRef } from "react";
import { useTabsStore } from "../../store/tabsStore";
import { useDocumentsStore } from "../../store/documentsStore";
import { closeTabWithConfirm } from "../../lib/commands";
import { useTranslation } from "react-i18next";

export function TabStrip() {
  const tabs = useTabsStore((s) => s.tabs);
  const activeId = useTabsStore((s) => s.activeId);
  const activate = useTabsStore((s) => s.activate);
  const openTab = useTabsStore((s) => s.openTab);
  // Subscribe to the documents map so the dirty indicator updates live.
  const documents = useDocumentsStore((s) => s.documents);
  const { t } = useTranslation("titlebar");
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const rovingId = activeId ?? tabs[0] ?? null;

  const focusAndActivate = (id: string) => {
    activate(id);
    tabRefs.current.get(id)?.focus();
  };

  return (
    <div className="tabstrip" role="tablist" aria-label={t("openDocuments")}>
      {tabs.map((id) => {
        const active = id === activeId;
        const doc = documents[id];
        const title = doc?.title ?? id;
        const dirty = doc?.dirty ?? false;
        return (
          <div
            key={id}
            className={"tab" + (active ? " tab-active" : "")}
          >
            <button
              ref={(element) => {
                if (element) tabRefs.current.set(id, element);
                else tabRefs.current.delete(id);
              }}
              className="tab-select"
              type="button"
              role="tab"
              tabIndex={id === rovingId ? 0 : -1}
              aria-selected={active}
              onClick={() => activate(id)}
              onKeyDown={(event) => {
                const index = tabs.indexOf(id);
                let target: string | undefined;
                if (event.key === "ArrowRight") {
                  target = tabs[(index + 1) % tabs.length];
                } else if (event.key === "ArrowLeft") {
                  target = tabs[(index - 1 + tabs.length) % tabs.length];
                } else if (event.key === "Home") {
                  target = tabs[0];
                } else if (event.key === "End") {
                  target = tabs[tabs.length - 1];
                } else if (event.key === "Enter" || event.key === " ") {
                  target = id;
                }
                if (target !== undefined) {
                  event.preventDefault();
                  focusAndActivate(target);
                }
              }}
              title={t("tabTooltip", { title, dirty })}
            >
              {dirty && <span className="tab-dirty" aria-hidden="true" />}
              <span className="tab-title">{title}</span>
            </button>
            <button
              className="tab-close"
              type="button"
              aria-label={t("closeTab", { title })}
              title={t("closeTab", { title })}
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
        aria-label={t("newTab")}
        title={t("newTab")}
        onClick={() => openTab()}
      >
        +
      </button>
    </div>
  );
}
