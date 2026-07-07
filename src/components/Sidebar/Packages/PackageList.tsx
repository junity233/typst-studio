import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { selectFiltered, usePackagesStore } from "../../../store/packagesStore";

export function PackageList() {
  const { t } = useTranslation("packages");
  const setSelected = usePackagesStore((s) => s.setSelected);
  // Derive via useMemo — see TemplateGallery for why the selector must not
  // return a fresh array (useSyncExternalStore Object.is loop).
  const index = usePackagesStore((s) => s.index);
  const filter = usePackagesStore((s) => s.filter);
  const packages = useMemo(() => selectFiltered({ index, filter }, false), [index, filter]);

  if (packages.length === 0) {
    return <p className="packages-empty">{t("empty")}</p>;
  }

  return (
    <ul className="pkg-list">
      {packages.map((e) => (
        <li key={`${e.name}@${e.version}`}>
          <button
            className="pkg-row"
            onClick={() => setSelected(`${e.name}@${e.version}`)}
          >
            <span className="pkg-row-name">{e.name}</span>
            <span className="pkg-row-ver">{e.version}</span>
            <span className="pkg-row-desc">{e.description ?? ""}</span>
            <span className="pkg-row-cat">{e.categories.join(" · ")}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
