import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { RefreshCw } from "lucide-react";
import { selectCategories, usePackagesStore } from "../../../store/packagesStore";
import { useDebounce } from "../../../hooks/useDebounce";
import { TemplateGallery } from "./TemplateGallery";
import { PackageList } from "./PackageList";
import { InstalledList } from "./InstalledList";
import { PackageDetail } from "./PackageDetail";

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
export function PackagesPanel({
  visible = true,
}: {
  /** The sidebar passes the view id (unused here) + current visibility. */
  viewId?: string;
  visible?: boolean;
}) {
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
  const debouncedQuery = useDebounce(query, 300);

  // Push the debounced query into the store filter (applied client-side).
  useEffect(() => {
    setFilter({ query: debouncedQuery || undefined });
  }, [debouncedQuery, setFilter]);

  // Load the full index the FIRST time the view becomes visible — not on
  // mount. The sidebar pre-mounts every view for instant tab switches, and
  // `loadCatalog`/`refreshIndex` download the complete Typst Universe index
  // when the disk cache is empty, far too heavy to run at startup for a tab
  // the user may never open. `fetched` guarantees it runs at most once per
  // mount; filtering is client-side, so filters never re-fetch.
  const [fetched, setFetched] = useState(false);
  useEffect(() => {
    if (!visible || fetched) return;
    setFetched(true);
    void loadCatalog();
    void loadInstalled();
  }, [visible, fetched, loadCatalog, loadInstalled]);

  // The Installed tab doesn't use the search box.
  const showSearch = activeTab !== "installed";
  const isLoading = indexStatus === "loading";
  const fetchedDate =
    indexFetchedAt != null
      ? new Date(indexFetchedAt * 1000).toLocaleDateString()
      : "";

  // Category options come from the FULL index (selectCategories), so the
  // dropdown keeps every category regardless of the current selection. Derived
  // via useMemo — selectCategories returns a fresh array each call, which would
  // loop useSyncExternalStore if used directly as a selector.
  const isTemplateView = activeTab === "templates";
  const index = usePackagesStore((s) => s.index);
  const categories = useMemo(
    () => selectCategories({ index }, isTemplateView),
    [index, isTemplateView],
  );
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
