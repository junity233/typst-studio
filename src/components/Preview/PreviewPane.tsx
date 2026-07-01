import { useSetting } from "../../hooks/useSetting";
import { SvgPage } from "./SvgPage";

interface PreviewPaneProps {
  svgPages: string[];
  /** Manual recompile trigger; shown only while `preview.autoRefresh` is off. */
  onRefresh?: () => void;
}

/**
 * Vertical scroll container for rendered typst pages. MVP renders all pages;
 * large documents can be virtualized later.
 *
 * Surface background follows `preview.background`: "light" keeps the parchment
 * canvas (via the `.preview-pane` CSS rule); "dark" overrides it with a literal
 * near-black desk surface (no dark token exists in the light-first palette).
 * The page paper itself always stays white — a real page on a dark desk.
 */
export function PreviewPane({ svgPages, onRefresh }: PreviewPaneProps) {
  const [autoRefresh] = useSetting<boolean>("preview.autoRefresh");
  const [zoomLevel] = useSetting<number>("preview.zoomLevel");
  const [background] = useSetting<string>("preview.background");

  const surfaceStyle =
    background === "dark" ? { background: "#1e1e22" } : undefined;
  const zoom = zoomLevel ?? 1;

  return (
    <div className="preview-pane" style={surfaceStyle}>
      {autoRefresh === false && onRefresh && (
        <button
          className="preview-refresh"
          type="button"
          onClick={onRefresh}
          title="Refresh preview"
        >
          Refresh
        </button>
      )}
      {svgPages.length === 0 ? (
        <div className="preview-empty">No preview yet</div>
      ) : (
        svgPages.map((svg, i) => (
          <SvgPage key={i} svg={svg} pageNumber={i + 1} zoom={zoom} />
        ))
      )}
    </div>
  );
}
