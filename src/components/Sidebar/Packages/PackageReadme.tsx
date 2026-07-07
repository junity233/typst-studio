import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useTranslation } from "react-i18next";
import { packageGetReadme } from "../../../lib/tauri";

/**
 * Renders a cached package's README as markdown (GFM). Fetches on mount/name
 * change; shows nothing while loading and a quiet note if there is no README.
 * Self-contained so PackageDetail stays focused on metadata + actions.
 */
export function PackageReadme({ name, version }: { name: string; version: string }) {
  const { t } = useTranslation("packages");
  const [readme, setReadme] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setReadme(null);
    setLoaded(false);
    let cancelled = false;
    void packageGetReadme(name, version).then((text) => {
      if (cancelled) return;
      setReadme(text);
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [name, version]);

  if (!loaded) return null;
  if (!readme) return <p className="pkg-readme-empty">{t("noReadme")}</p>;

  return (
    <div className="pkg-readme">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{readme}</ReactMarkdown>
    </div>
  );
}
