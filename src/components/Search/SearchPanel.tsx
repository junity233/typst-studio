import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, ChevronsDownUp, ChevronsUpDown, FileText } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useSearchStore } from "../../store/searchStore";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { openFile } from "../../lib/openFile";
import { editorApiRef } from "../Editor/editorApiRef";
import type { SearchHit } from "../../lib/types";

/**
 * The Search view (§Search view), rendered inside the sidebar body. A query box
 * + option toggles (case / whole-word / regex) on top, and a tree-shaped result
 * list below: results are grouped by file, each file group is collapsible, and
 * clicking a hit opens the file and reveals the line via the shared editor API
 * ref.
 *
 * The tree shape mirrors the Outline view's design language (DESIGN.md):
 * chevron expand/collapse, weight-based hierarchy, parchment hover, soft
 * nesting guide lines. Default state is all-expanded so users see results
 * immediately; collapsing a file is for de-cluttering once they've scanned it.
 *
 * Debounced search: re-runs 300ms after the last query/option change; Enter
 * forces an immediate run, Escape clears the query. Visibility is toggled via
 * the Activity Bar (the sidebar host owns show/hide), not from within.
 */
export function SearchPanel(_props: { viewId?: string }) {
  const { t } = useTranslation("search");
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

  // Group hits by file path (preserves first-seen order, which is the walkdir
  // traversal order — stable across re-runs of the same query).
  const grouped = useMemo(() => {
    const m = new Map<string, SearchHit[]>();
    for (const h of results) {
      const arr = m.get(h.relative);
      if (arr) arr.push(h);
      else m.set(h.relative, [h]);
    }
    return [...m.entries()];
  }, [results]);

  // Collapsed file paths. Defaults to "all expanded" — the user just ran a
  // search and wants to see what came back. Collapsing is for de-cluttering
  // after they've scanned a file's hits.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  // Reset collapse state whenever the result set changes substantively. We
  // track by the sorted file list (cheap to derive) so a search that returns
  // the same files but different hit lines doesn't reset the user's manual
  // collapses, but a genuinely new search does. Also reset on query change
  // since a typed query is the clearest "new search" signal.
  const fileSignature = grouped.map(([f]) => f).join("\n");
  const lastSigRef = useRef(fileSignature);
  const lastQueryRef = useRef(query);
  useEffect(() => {
    if (
      fileSignature !== lastSigRef.current ||
      query !== lastQueryRef.current
    ) {
      lastSigRef.current = fileSignature;
      lastQueryRef.current = query;
      setCollapsed(new Set());
    }
  }, [fileSignature, query]);

  const toggleFile = (file: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(file)) next.delete(file);
      else next.add(file);
      return next;
    });

  // Toolbar "collapse all" / "expand all" — operates on the current result
  // set's file list. Disabled when there's nothing to act on (no files, or
  // already in the target state).
  const allFiles = grouped.map(([f]) => f);
  const collapseAll = () => setCollapsed(new Set(allFiles));
  const expandAll = () => setCollapsed(new Set());
  const hasFiles = allFiles.length > 0;
  const allCollapsed = hasFiles && allFiles.every((f) => collapsed.has(f));

  return (
    <div className="search-panel">
      <div className="search-header">
        <input
          className="search-input"
          placeholder={t("placeholder")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void run();
            if (e.key === "Escape") clear();
          }}
          autoFocus
        />
        <div className="search-options">
          <button
            type="button"
            className={caseSensitive ? "active" : ""}
            onClick={() => setOption("caseSensitive", !caseSensitive)}
            title={t("matchCase")}
          >
            Aa
          </button>
          <button
            type="button"
            className={wholeWord ? "active" : ""}
            onClick={() => setOption("wholeWord", !wholeWord)}
            title={t("wholeWord")}
          >
            W
          </button>
          <button
            type="button"
            className={isRegex ? "active" : ""}
            onClick={() => setOption("isRegex", !isRegex)}
            title={t("regex")}
          >
            .*
          </button>
        </div>
      </div>

      <div className="search-results">
        {!searching && !error && grouped.length > 0 && (
          <div className="tree-toolbar" role="toolbar" aria-label="Result actions">
            <button
              type="button"
              className="tree-toolbar-btn"
              title="Collapse all files"
              aria-label="Collapse all files"
              disabled={allCollapsed}
              onClick={collapseAll}
            >
              <ChevronsDownUp size={14} />
            </button>
            <button
              type="button"
              className="tree-toolbar-btn"
              title="Expand all files"
              aria-label="Expand all files"
              disabled={collapsed.size === 0}
              onClick={expandAll}
            >
              <ChevronsUpDown size={14} />
            </button>
            <span className="tree-toolbar-count">
              {results.length} result{results.length === 1 ? "" : "s"} in{" "}
              {grouped.length} file{grouped.length === 1 ? "" : "s"}
            </span>
          </div>
        )}
        {searching && <div className="search-status">{t("searching")}</div>}
        {error && <div className="search-error">{error}</div>}
        {!searching && !error && results.length === 0 && query.trim() && (
          <div className="search-status">{t("noResults")}</div>
        )}

        {grouped.map(([file, hits]) => {
          const isCollapsed = collapsed.has(file);
          const { dir, name } = splitPath(file);
          return (
            <div key={file} className="search-file-group">
              {/* File header row — click toggles collapse for the whole group.
                  Shows a file glyph + chevron + dimmed dir + bold name + count. */}
              <button
                type="button"
                className="search-file-row"
                aria-expanded={!isCollapsed}
                onClick={() => toggleFile(file)}
                title={file}
              >
                <ChevronRight
                  size={12}
                  className={isCollapsed ? "search-chevron" : "search-chevron expanded"}
                />
                <FileText size={13} className="search-file-icon" />
                {dir && <span className="search-file-dir">{dir}/</span>}
                <span className="search-file-name">{name}</span>
                <span className="search-hit-count">{hits.length}</span>
              </button>

              {!isCollapsed && (
                <div className="search-hits" role="group">
                  {hits.map((h, i) => (
                    <button
                      key={i}
                      type="button"
                      className="search-hit-row"
                      title={`${file}:${h.line}`}
                      onClick={() =>
                        handleHitClick(rootPath, h.relative, h.line, h.column)
                      }
                    >
                      <span className="search-hit-line">{h.line}</span>
                      <span className="search-hit-text">
                        {renderHitText(h.lineText, h.matchStart, h.matchEnd)}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Split `dir/sub/file.typ` → { dir: "dir/sub", name: "file.typ" }. */
function splitPath(relative: string): { dir: string; name: string } {
  const idx = relative.lastIndexOf("/");
  if (idx === -1) return { dir: "", name: relative };
  return { dir: relative.slice(0, idx), name: relative.slice(idx + 1) };
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
