import { useEffect, useRef, useState } from "react";
import { AlertTriangle } from "lucide-react";
// pdf.js entry. The worker is loaded as a URL by Vite so it ships as a separate
// chunk (decoded off-main-thread, matching pdfjs's performance model).
import * as pdfjsLib from "pdfjs-dist";
// The `?url` suffix tells Vite to emit the worker as a separate asset and give
// us its resolved URL at runtime. This is the pdfjs-recommended Vite setup.
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { readFileBytesCached } from "../../lib/viewerByteCache";
import { toIpcError } from "../../lib/ipc-error";
import i18n from "../../i18n";

// Configure the worker once per module load. pdfjs forks a Web Worker to parse
// PDFs off the main thread; without this it falls back to a fake worker that
// runs inline and janks the UI on large PDFs.
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

/**
 * In-app PDF viewer for `DocumentKind === "pdf"` tabs. Preview-only.
 *
 * The PDF bytes are fetched via the backend `read_file_bytes` command (not the
 * `@tauri-apps/plugin-fs` plugin, which is scope-limited to `$HOME/**`).
 * pdf.js renders each page to a `<canvas>` at a device-pixel ratio that matches
 * the display, so text stays crisp on HiDPI screens. Pages render sequentially
 * as the user scrolls into them (a simple "render all, but lazily" approach is
 * fine for the preview use case; very large PDFs could be enhanced with
 * IntersectionObserver-based on-demand rendering later).
 */
export function PdfViewer({ path }: { path: string }): React.JSX.Element {
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pageCanvases, setPageCanvases] = useState<React.JSX.Element[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setLoading(true);
    setPageCanvases([]);
    // Declared in the effect's outer closure (not inside the async IIFE) so the
    // cleanup function can reach it and clean up the document on unmount. Kept
    // `null` until `getDocument` resolves; the cleanup's `doc?.cleanup()` is a
    // no-op while it is, which is the correct behavior when unmount happens
    // before the load completes (nothing to release yet).
    let doc: pdfjsLib.PDFDocumentProxy | null = null;

    (async () => {
      try {
        // Cached by path: switching away from this tab and back is instant
        // (bytes already in memory; only the pdf.js render rebuilds, which is
        // cheap relative to the IPC disk read).
        const bytes = await readFileBytesCached(path);
        if (cancelled) return;
        // pdf.js transfers the buffer to the worker; `.slice()` keeps a copy
        // owned by this closure so the worker's `transfer` can't detach our
        // underlying buffer (defensive — readFileBytes already returns a fresh
        // Uint8Array, but the explicit copy documents intent).
        const data = new Uint8Array(bytes);
        const loadedDoc = await pdfjsLib.getDocument({ data }).promise;
        doc = loadedDoc;
        if (cancelled) return;
        const pages: React.JSX.Element[] = [];
        for (let i = 1; i <= doc.numPages; i++) {
          if (cancelled) return;
          const page = await doc.getPage(i);
          // 1.5x scale is a reasonable crispness/size tradeoff; matches the
          // existing preview's "fit to width" feel without exploding memory.
          const viewport = page.getViewport({ scale: 1.5 });
          pages.push(
            <PdfPageCanvas key={i} page={page} width={viewport.width} height={viewport.height} />,
          );
        }
        if (cancelled) return;
        setPageCanvases(pages);
        setLoading(false);
      } catch (e) {
        if (cancelled) return;
        setError(toIpcError(e).message);
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      // Clean up the pdf.js document so parsed page objects / cached fonts are
      // released. Without this, switching away from a PDF tab leaks them: the
      // cleanup only set `cancelled = true` before, leaving the loaded doc
      // alive. `cleanup()` is safe to call even mid-render (it drops the page
      // proxies the worker is holding) and is a no-op if `doc` is still null
      // (load hadn't completed / failed). The Web Worker itself is shared and
      // reused across loads, so `cleanup()` (not `PDFLoadingTask.destroy()`) is
      // the right teardown for an already-loaded `PDFDocumentProxy`.
      void doc?.cleanup();
    };
  }, [path]);

  if (error) {
    return (
      <div className="pane pane-empty pdf-viewer-error">
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

  if (loading) {
    return <div className="pane pane-empty">{i18n.t("loading", { ns: "preview" })}</div>;
  }

  return (
    <div className="pdf-viewer pane-scroll" ref={containerRef}>
      {pageCanvases}
    </div>
  );
}

/**
 * Render one PDF page to a `<canvas>`. The pdf.js `PDFPageProxy` is rendered
 * once on mount; the canvas is sized to the page's viewport at the chosen scale
 * and DPR-adjusted so the backing store matches the display for crisp text.
 */
function PdfPageCanvas({
  page,
  width,
  height,
}: {
  page: pdfjsLib.PDFPageProxy;
  width: number;
  height: number;
}): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    canvas.style.width = `${Math.floor(width)}px`;
    canvas.style.height = `${Math.floor(height)}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    // Render at the DPR-adjusted scale so 1 canvas pixel == 1 device pixel.
    let renderTask: pdfjsLib.RenderTask | undefined;
    (async () => {
      const viewport = page.getViewport({ scale: 1.5 * dpr });
      renderTask = page.render({ canvas, canvasContext: ctx, viewport });
      try {
        await renderTask.promise;
      } catch {
        // Render can be cancelled when the component unmounts mid-render
        // (pdf.js throws on cancel); swallow silently.
      }
    })();
    return () => {
      renderTask?.cancel();
    };
  }, [page, width, height]);

  return <canvas ref={canvasRef} className="pdf-page" />;
}
