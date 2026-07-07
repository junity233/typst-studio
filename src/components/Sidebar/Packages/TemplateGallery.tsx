import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { usePackagesStore } from "../../../store/packagesStore";
import { Thumbnail } from "./Thumbnail";

export function TemplateGallery() {
  const { t } = useTranslation("packages");
  const catalog = usePackagesStore((s) => s.catalog);
  const setSelected = usePackagesStore((s) => s.setSelected);
  const templates = useMemo(
    () => catalog.filter((e) => e.template != null),
    [catalog],
  );

  if (templates.length === 0) {
    return <p className="packages-empty">{t("empty")}</p>;
  }

  return (
    <ul className="pkg-gallery">
      {templates.map((e) => (
        <li key={`${e.name}@${e.version}`}>
          <button
            className="pkg-card"
            onClick={() => setSelected(`${e.name}@${e.version}`)}
          >
            <Thumbnail name={e.name} version={e.version} isTemplate={e.template != null} />
            <span className="pkg-card-info">
              <span className="pkg-card-name">{e.name}</span>
              <span className="pkg-card-cat">{e.categories[0] ?? ""}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
