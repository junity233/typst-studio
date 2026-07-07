import { useEffect, useState } from "react";
import { packageGetThumbnail } from "../../../lib/tauri";

/**
 * A template thumbnail. Lazily extracts from the cached package on viewport
 * entry (the backend returns a base64 data URI, sidestepping the Tauri
 * asset-protocol). Falls back to a parchment first-letter block when not
 * installed, has no thumbnail, or the image fails to load. The thumbnail is
 * the ONE element allowed `--shadow-product`.
 *
 * The image and fallback render inside ONE fixed-size `.pkg-thumb` container
 * so the card layout is identical before/after load (no layout shift, no
 * visual size difference between loaded and placeholder cards).
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

  // Fetch the data URI once the card scrolls into view.
  useEffect(() => {
    if (!seen || !isTemplate) return;
    let cancelled = false;
    void packageGetThumbnail(name, version).then((p) => {
      if (!cancelled && p) setSrc(p);
    });
    return () => {
      cancelled = true;
    };
  }, [seen, name, version, isTemplate]);

  // The container carries the ref so the observer stays mounted across the
  // placeholder → image transition (no re-observe churn).
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

  return (
    <div className="pkg-thumb" ref={setRef}>
      {src ? (
        <img
          className="pkg-thumb-img"
          src={src}
          alt=""
          onError={() => setSrc(null)}
        />
      ) : (
        <div className="pkg-thumb-fallback">
          <span>{name.slice(0, 1).toUpperCase()}</span>
        </div>
      )}
    </div>
  );
}
