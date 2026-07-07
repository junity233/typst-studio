import { useEffect, useState } from "react";
import { AlertTriangle, ZoomIn, ZoomOut } from "lucide-react";
import { readFileBytesCached } from "../../lib/viewerByteCache";
import { toIpcError } from "../../lib/ipc-error";
import i18n from "../../i18n";

/**
 * In-app image viewer for `DocumentKind === "image"` tabs (png/jpg/jpeg/gif/
 * svg/webp/bmp). Preview-only — no editing, no dirty state, no save.
 *
 * The bytes are fetched on demand via the backend `read_file_bytes` command
 * (NOT the `@tauri-apps/plugin-fs` plugin, which is capability-scoped to
 * `$HOME/**` and cannot read arbitrary workspace paths). The bytes are wrapped
 * in a `Blob` and exposed via an object URL that is revoked on unmount / when
 * the path changes, so memory is reclaimed.
 *
 * SVG is served as `image/svg+xml` so it renders as a vector image (not parsed
 * inline — matches the existing `SvgPage` technique of keeping decode
 * off-main-thread). Raster formats fall back to the browser's generic image
 * sniffing via `application/octet-stream` (WebView2/WKWebView sniff the real
 * type from the bytes).
 */
export function ImageViewer({ path }: { path: string }): React.JSX.Element {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);

  // (Re)load the image whenever the path changes. Each load mints a fresh
  // object URL and revokes the previous one to avoid leaking blob memory when
  // switching between image tabs.
  useEffect(() => {
    let revoked = false;
    let createdUrl: string | null = null;
    setUrl(null);
    setError(null);
    setZoom(1);

    (async () => {
      try {
        // Cached by path: switching away from this tab and back is instant
        // (bytes already in memory; only the Blob/object URL rebuilds, which
        // is cheap relative to the IPC disk read).
        const bytes = await readFileBytesCached(path);
        if (revoked) return;
        const isSvg = path.toLowerCase().endsWith(".svg");
        const blob = new Blob([bytes], {
          type: isSvg ? "image/svg+xml" : "application/octet-stream",
        });
        createdUrl = URL.createObjectURL(blob);
        if (revoked) {
          URL.revokeObjectURL(createdUrl);
          createdUrl = null;
          return;
        }
        setUrl(createdUrl);
      } catch (e) {
        if (revoked) return;
        setError(toIpcError(e).message);
      }
    })();

    return () => {
      revoked = true;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [path]);

  if (error) {
    return (
      <div className="pane pane-empty image-viewer-error">
        <AlertTriangle size={28} />
        <p>
          {i18n.t("couldNotOpen", {
            ns: "errors",
            message: error,
          })}
        </p>
      </div>
    );
  }

  if (url === null) {
    return <div className="pane pane-empty">{i18n.t("loading", { ns: "preview" })}</div>;
  }

  return (
    <div className="image-viewer">
      <div className="image-viewer-viewport">
        {/* eslint-disable-next-line jsx-a11y/alt-text -- alt derived from filename */}
        <img
          src={url}
          alt={path.split(/[\\/]/).pop() ?? "image"}
          style={{ transform: `scale(${zoom})` }}
          draggable={false}
        />
      </div>
      <div className="image-viewer-toolbar">
        <button
          type="button"
          className="icon-button"
          title={i18n.t("zoomOut", { ns: "preview" })}
          onClick={() => setZoom((z) => Math.max(0.1, +(z - 0.1).toFixed(2)))}
        >
          <ZoomOut size={14} />
        </button>
        <span className="image-viewer-zoom">{Math.round(zoom * 100)}%</span>
        <button
          type="button"
          className="icon-button"
          title={i18n.t("zoomIn", { ns: "preview" })}
          onClick={() => setZoom((z) => Math.min(10, +(z + 0.1).toFixed(2)))}
        >
          <ZoomIn size={14} />
        </button>
        <button
          type="button"
          className="image-viewer-reset"
          onClick={() => setZoom(1)}
        >
          {i18n.t("actualSize", { ns: "preview" })}
        </button>
      </div>
    </div>
  );
}
