import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, ChevronsDownUp, ChevronsUpDown, FileText } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useSearchStore } from "../../store/searchStore";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { useTabsStore } from "../../store/tabsStore";
import { useSetting } from "../../hooks/useSetting";
import { openFile } from "../../lib/openFile";
import { editorApiRef } from "../Editor/editorApiRef";
import type { SearchHit } from "../../lib/types";
import { joinWorkspacePath } from "../../lib/workspacePath";

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
  const invalidateResults = useSearchStore((s) => s.invalidateResults);
  const clear = useSearchStore((s) => s.clear);
  const rootPath = useWorkspaceStore((s) => s.rootPath);
  const [debounceMs] = useSetting<number>("search.debounceMs");

  // Debounced search: re-runs `search.debounceMs` after the last query/option
  // change. The debounce value is in the dependency array so a settings change
  // re-arms the timer at the new cadence.
  useEffect(() => {
    if (!query.trim()) {
      clear(); // empty query → clear results + error
      return;
    }
    if (rootPath === null) return;
    const t = setTimeout(() => void run(), debounceMs ?? 300);
    return () => clearTimeout(t);
  }, [query, isRegex, caseSensitive, wholeWord, rootPath, run, clear, debounceMs]);

  useEffect(() => {
    invalidateResults();
  }, [rootPath, invalidateResults]);

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
          <div className="tree-toolbar" role="toolbar" aria-label={t("actionsAriaLabel")}>
            <button
              type="button"
              className="tree-toolbar-btn"
              title={t("collapseAllFiles")}
              aria-label={t("collapseAllFiles")}
              disabled={allCollapsed}
              onClick={collapseAll}
            >
              <ChevronsDownUp size={14} />
            </button>
            <button
              type="button"
              className="tree-toolbar-btn"
              title={t("expandAllFiles")}
              aria-label={t("expandAllFiles")}
              disabled={collapsed.size === 0}
              onClick={expandAll}
            >
              <ChevronsUpDown size={14} />
            </button>
            <span className="tree-toolbar-count">
              {t("summary", {
                resultCount: results.length,
                fileCount: grouped.length,
              })}
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

/**
 * Open the hit's file (or activate an existing tab) and reveal the line.
 *
 * Reveal must wait for the target doc's model to actually attach to the editor:
 * `revealLine` operates on the currently-attached model, and the model swap for
 * a freshly-activated tab happens later, in MonacoEditor's model-sync effect.
 * So for a hit in a non-active file we stash a pending reveal (keyed by doc id)
 * that the effect flushes once the right model is attached. When the file is
 * ALREADY active (no model swap will follow), we reveal immediately.
 */
async function handleHitClick(
  rootPath: string | null,
  relative: string,
  line: number,
  column: number,
): Promise<void> {
  if (!rootPath) return;
  const abs = joinWorkspacePath(rootPath, relative);
  const docId = await openFile(abs);
  if (docId === null) return;
  // Stash first (covers the common case: a different file → a model swap will
  // follow → the effect flushes this). Then, if the doc is ALREADY active, no
  // swap will follow, so reveal now and clear the stash.
  editorApiRef.pendingReveal = { docId, line, column };
  const activeId = useTabsStore.getState().activeId;
  if (activeId === docId && editorApiRef.current) {
    editorApiRef.pendingReveal = null;
    editorApiRef.current.revealLine(line, column);
  }
}
