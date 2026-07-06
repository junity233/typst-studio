import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { usePackagesStore } from "../../../store/packagesStore";
import { TemplateGallery } from "./TemplateGallery";
import { PackageList } from "./PackageList";
import { InstalledList } from "./InstalledList";
import { PackageDetail } from "./PackageDetail";

/** Debounce a fast-changing value by `delay` ms. */
function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return debounced;
}

/**
 * The Packages sidebar view: three tabs (Templates / Packages / Installed)
 * over the Universe index. Template-vs-package is a filter dimension. Detail
 * is a push-replace navigation within the panel.
 */
export function PackagesPanel() {
  const { t } = useTranslation("packages");
  const activeTab = usePackagesStore((s) => s.activeTab);
  const setActiveTab = usePackagesStore((s) => s.setActiveTab);
  const selectedKey = usePackagesStore((s) => s.selectedKey);
  const filter = usePackagesStore((s) => s.filter);
  const setFilter = usePackagesStore((s) => s.setFilter);
  const loadCatalog = usePackagesStore((s) => s.loadCatalog);
  const loadInstalled = usePackagesStore((s) => s.loadInstalled);

  const [query, setQuery] = useState(filter.query ?? "");
  const debouncedQuery = useDebounced(query, 300);

  // Push the debounced query into the store filter.
  useEffect(() => {
    setFilter({ query: debouncedQuery || undefined });
  }, [debouncedQuery, setFilter]);

  // Re-fetch the catalog whenever the filter changes (server-side filter).
  // Keep the latest loadCatalog + filter in a ref so the effect deps stay
  // stable across renders while still reacting to filter changes.
  const loadRef = useRef(loadCatalog);
  loadRef.current = loadCatalog;
  useEffect(() => {
    void loadRef.current();
  }, [filter]);

  // Initial load (catalog + installed) on first mount.
  useEffect(() => {
    void loadInstalled();
  }, [loadInstalled]);

  // The Installed tab doesn't use the search box.
  const showSearch = activeTab !== "installed";

  return (
    <div className="packages">
      {selectedKey ? (
        <PackageDetail />
      ) : (
        <>
          {showSearch && (
            <div className="packages-search">
              <input
                className="packages-search-input"
                type="search"
                placeholder={t("searchPlaceholder")}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label={t("searchPlaceholder")}
              />
            </div>
          )}
          <div className="packages-tabs" role="tablist">
            {(["templates", "packages", "installed"] as const).map((tab) => (
              <button
                key={tab}
                role="tab"
                aria-selected={activeTab === tab}
                className={`packages-tab${activeTab === tab ? " active" : ""}`}
                onClick={() => setActiveTab(tab)}
              >
                {t(`tabs.${tab}`)}
              </button>
            ))}
          </div>
          <div className="packages-body">
            {activeTab === "templates" && <TemplateGallery />}
            {activeTab === "packages" && <PackageList />}
            {activeTab === "installed" && <InstalledList />}
          </div>
        </>
      )}
    </div>
  );
}
