import { useEffect, useMemo } from "react";
import { useSearchStore } from "../../store/searchStore";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { openFile } from "../../lib/openFile";
import { editorApiRef } from "../Editor/editorApiRef";
import type { SearchHit } from "../../lib/types";

/**
 * The bottom Search panel (§Search view). A query box + option toggles
 * (case / whole-word / regex) on top, and a grouped result list below. Clicking
 * a hit opens the file and reveals the line via the shared editor API ref.
 *
 * Debounced search: re-runs 300ms after the last query/option change; Enter
 * forces an immediate run, Escape hides the panel.
 */
export function SearchPanel() {
  const query = useSearchStore((s) => s.query);
  const isRegex = useSearchStore((s) => s.isRegex);
  const caseSensitive = useSearchStore((s) => s.caseSensitive);
  const wholeWord = useSearchStore((s) => s.wholeWord);
  const results = useSearchStore((s) => s.results);
  const searching = useSearchStore((s) => s.searching);
  const error = useSearchStore((s) => s.error);
  const setQuery = useSearchStore((s) => s.setQuery);
  const setOption = useSearchStore((s) => s.setOption);
  const run = useSearchStore((s) => s.run);
  const clear = useSearchStore((s) => s.clear);
  const hide = useSearchStore((s) => s.hide);
  const rootPath = useWorkspaceStore((s) => s.rootPath);

  // Debounced search: re-runs 300ms after the last query/option change.
  useEffect(() => {
    if (!query.trim()) {
      clear(); // empty query → clear results + error
      return;
    }
    const t = setTimeout(() => void run(), 300);
    return () => clearTimeout(t);
  }, [query, isRegex, caseSensitive, wholeWord, run, clear]);

  const grouped = useMemo(() => {
    const m = new Map<string, SearchHit[]>();
    for (const h of results) {
      const arr = m.get(h.relative);
      if (arr) arr.push(h);
      else m.set(h.relative, [h]);
    }
    return [...m.entries()];
  }, [results]);

  return (
    <div className="search-panel">
      <div className="search-header">
        <input
          className="search-input"
          placeholder="Search in workspace…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void run();
            if (e.key === "Escape") hide();
          }}
          autoFocus
        />
        <div className="search-options">
          <button
            type="button"
            className={caseSensitive ? "active" : ""}
            onClick={() => setOption("caseSensitive", !caseSensitive)}
            title="Match Case"
          >
            Aa
          </button>
          <button
            type="button"
            className={wholeWord ? "active" : ""}
            onClick={() => setOption("wholeWord", !wholeWord)}
            title="Whole Word"
          >
            W
          </button>
          <button
            type="button"
            className={isRegex ? "active" : ""}
            onClick={() => setOption("isRegex", !isRegex)}
            title="Regex"
          >
            .*
          </button>
        </div>
        <button type="button" className="search-close" onClick={hide} title="Close">×</button>
      </div>
      <div className="search-results">
        {searching && <div className="search-status">Searching…</div>}
        {error && <div className="search-error">{error}</div>}
        {!searching && !error && results.length === 0 && query.trim() && (
          <div className="search-status">No results</div>
        )}
        {grouped.map(([file, hits]) => (
          <div key={file} className="search-file-group">
            <div className="search-file-name">
              {file} <span className="search-hit-count">({hits.length})</span>
            </div>
            {hits.map((h, i) => (
              <button
                key={i}
                type="button"
                className="search-hit-row"
                onClick={() => handleHitClick(rootPath, h.relative, h.line, h.column)}
              >
                <span className="search-hit-line">L{h.line}</span>
                <span className="search-hit-text">
                  {renderHitText(h.lineText, h.matchStart, h.matchEnd)}
                </span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Render the line text with the matched range wrapped in `<mark>`. */
function renderHitText(line: string, start: number, end: number) {
  return (
    <>
      {line.slice(0, start)}
      <mark>{line.slice(start, end)}</mark>
      {line.slice(end)}
    </>
  );
}

/** Open the hit's file (or activate an existing tab) and reveal the line. */
async function handleHitClick(
  rootPath: string | null,
  relative: string,
  line: number,
  column: number,
): Promise<void> {
  if (!rootPath) return;
  const abs = joinPath(rootPath, relative);
  await openFile(abs);
  editorApiRef.current?.revealLine(line, column);
}

/**
 * Join a workspace root + a forward-slash relative path. Uses backslash on
 * Windows roots (which carry backslashes after canonicalization), forward slash
 * elsewhere — matching how the Explorer builds its absolute paths.
 */
function joinPath(root: string, rel: string): string {
  const sep = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  return root + sep + rel.replace(/\//g, sep);
}
