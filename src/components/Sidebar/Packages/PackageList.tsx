import { useTranslation } from "react-i18next";
import { selectFiltered, usePackagesStore } from "../../../store/packagesStore";

export function PackageList() {
  const { t } = useTranslation("packages");
  const setSelected = usePackagesStore((s) => s.setSelected);
  // Client-side filter over the full index (packages view).
  const packages = usePackagesStore((s) => selectFiltered(s, false));

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
