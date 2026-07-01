import { SvgPage } from "./SvgPage";

interface PreviewPaneProps {
  svgPages: string[];
}

/**
 * Vertical scroll container for rendered typst pages. MVP renders all pages;
 * large documents can be virtualized later.
 */
export function PreviewPane({ svgPages }: PreviewPaneProps) {
  if (svgPages.length === 0) {
    return (
      <div className="preview-pane">
        <div className="preview-empty">No preview yet</div>
      </div>
    );
  }

  return (
    <div className="preview-pane">
      {svgPages.map((svg, i) => (
        <SvgPage key={i} svg={svg} pageNumber={i + 1} />
      ))}
    </div>
  );
}
