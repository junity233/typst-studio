import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { usePackagesStore } from "../../../store/packagesStore";
import { TemplateGallery } from "./TemplateGallery";
import { PackageList } from "./PackageList";
import { InstalledList } from "./InstalledList";
import { PackageDetail } from "./PackageDetail";

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
  const loadCatalog = usePackagesStore((s) => s.loadCatalog);
  const loadInstalled = usePackagesStore((s) => s.loadInstalled);

  useEffect(() => {
    void loadCatalog();
    void loadInstalled();
  }, [loadCatalog, loadInstalled]);

  return (
    <div className="packages">
      {selectedKey ? (
        <PackageDetail />
      ) : (
        <>
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
