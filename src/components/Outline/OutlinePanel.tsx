/**
 * Outline view (§Outline) — renders the active document's heading tree.
 *
 * The heading tree arrives as a flat `OutlineNode[]` in the `compiled` event
 * payload (built by `render::outline::build_outline` on the backend). Each node
 * carries its absolute `level` and `parent` index, so this component can render
 * an indented list directly. Clicking a row reveals the heading's source line
 * in the editor via the shared `editorApiRef`.
 *
 * Empty state: "No headings" — shown when the document has no outlineable
 * headings or no document is active.
 */
import { useTabsStore } from "../../store/tabsStore";
import { useDocumentsStore } from "../../store/documentsStore";
import { editorApiRef } from "../Editor/editorApiRef";
import type { OutlineNode } from "../../lib/types";

export function OutlinePanel() {
  const activeId = useTabsStore((s) => s.activeId);
  const documents = useDocumentsStore((s) => s.documents);

  const outline: OutlineNode[] = activeId
    ? documents[activeId]?.outline ?? []
    : [];

  if (outline.length === 0) {
    return <div className="outline-empty">No headings</div>;
  }

  return (
    <div className="outline-panel">
      {outline.map((node, i) => (
        <button
          key={i}
          className="outline-row"
          // Indent by level: H1 at the base inset, each deeper level +16px.
          style={{ paddingLeft: 12 + (node.level - 1) * 16 }}
          title={node.title}
          onClick={() => {
            // `revealLine(line, column)` — column 1 (heading start). The
            // editor's revealLine scrolls the line into view if it's outside
            // the viewport (see MonacoEditor.revealLine).
            editorApiRef.current?.revealLine(node.line, 1);
          }}
        >
          {node.numbering && (
            <span className="outline-numbering">{node.numbering}</span>
          )}
          <span className="outline-title">{node.title}</span>
        </button>
      ))}
    </div>
  );
}
