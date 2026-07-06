import { useEffect, useState } from "react";
import { packageGetThumbnail } from "../../../lib/tauri";

/**
 * A template thumbnail. Lazily extracts from the cached package on viewport
 * entry; falls back to a parchment first-letter block when not installed or
 * no thumbnail. The thumbnail is the ONE element allowed `--shadow-product`.
 */
export function Thumbnail({
  name,
  version,
  isTemplate,
}: {
  name: string;
  version: string;
  isTemplate: boolean;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [seen, setSeen] = useState(false);
  const [ref, setRef] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!ref || !seen || !isTemplate) return;
    let cancelled = false;
    void packageGetThumbnail(name, version).then((p) => {
      if (!cancelled && p) setSrc(p);
    });
    return () => {
      cancelled = true;
    };
  }, [ref, seen, name, version, isTemplate]);

  useEffect(() => {
    if (!ref) return;
    const ob = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true);
          ob.disconnect();
        }
      },
      { root: ref.closest(".packages-body") },
    );
    ob.observe(ref);
    return () => ob.disconnect();
  }, [ref]);

  if (src) {
    return (
      <img
        className="pkg-thumb-img"
        src={`asset://${src.replace(/\\/g, "/")}`}
        alt=""
      />
    );
  }
  return (
    <div className="pkg-thumb-fallback" ref={setRef}>
      <span>{name.slice(0, 1).toUpperCase()}</span>
    </div>
  );
}
