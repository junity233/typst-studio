import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { RefreshCw } from "lucide-react";
import { selectCategories, usePackagesStore } from "../../../store/packagesStore";
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
 * over the Universe Index. Template-vs-package is a filter dimension. Detail
 * is a push-replace navigation within the panel.
 *
 * Filtering (search + category) is done client-side over the full index
 * snapshot (see selectFiltered in the store), so the category dropdown —
 * derived from the UNFILTERED index — keeps all options regardless of the
 * current selection.
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
  const refreshIndex = usePackagesStore((s) => s.refreshIndex);
  const indexStatus = usePackagesStore((s) => s.indexStatus);
  const indexFetchedAt = usePackagesStore((s) => s.indexFetchedAt);
  const error = usePackagesStore((s) => s.error);
  const indexCount = usePackagesStore((s) => s.index.length);

  const [query, setQuery] = useState(filter.query ?? "");
  const debouncedQuery = useDebounced(query, 300);

  // Push the debounced query into the store filter (applied client-side).
  useEffect(() => {
    setFilter({ query: debouncedQuery || undefined });
  }, [debouncedQuery, setFilter]);

  // Load the full index once on mount (filtering is client-side, so no
  // re-fetch on filter changes).
  useEffect(() => {
    void loadCatalog();
    void loadInstalled();
  }, [loadCatalog, loadInstalled]);

  // The Installed tab doesn't use the search box.
  const showSearch = activeTab !== "installed";
  const isLoading = indexStatus === "loading";
  const fetchedDate =
    indexFetchedAt != null
      ? new Date(indexFetchedAt * 1000).toLocaleDateString()
      : "";

  // Category options come from the FULL index (selectCategories), so the
  // dropdown keeps every category regardless of the current selection.
  const isTemplateView = activeTab === "templates";
  const categories = usePackagesStore((s) => selectCategories(s, isTemplateView));
  const selectedCategory = filter.categories[0] ?? "";
  const showCategoryFilter = activeTab !== "installed" && categories.length > 0;

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
              <button
                className="packages-refresh"
                onClick={() => void refreshIndex()}
                disabled={isLoading}
                title={t("refresh")}
                aria-label={t("refresh")}
              >
                <RefreshCw size={14} className={isLoading ? "spin" : ""} />
              </button>
            </div>
          )}
          {error && indexStatus === "error" && indexCount === 0 && (
            <p className="packages-status packages-status-error">
              {t("fetchError")}
            </p>
          )}
          {indexStatus === "stale" && indexCount > 0 && fetchedDate && (
            <p className="packages-status packages-status-stale">
              {t("staleBanner", { date: fetchedDate })}
            </p>
          )}
          {isLoading && indexCount === 0 && (
            <p className="packages-status">{t("loading")}</p>
          )}
          <div className="packages-filterrow">
            <select
              className="packages-select"
              value={activeTab}
              onChange={(e) => setActiveTab(e.target.value as typeof activeTab)}
              aria-label={t("view")}
            >
              <option value="templates">{t("tabs.templates")}</option>
              <option value="packages">{t("tabs.packages")}</option>
              <option value="installed">{t("tabs.installed")}</option>
            </select>
            {showCategoryFilter && (
              <select
                className="packages-select packages-select-cat"
                value={selectedCategory}
                onChange={(e) =>
                  setFilter({
                    categories: e.target.value ? [e.target.value] : [],
                  })
                }
                aria-label={t("category")}
              >
                <option value="">{t("allCategories")}</option>
                {categories.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            )}
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
