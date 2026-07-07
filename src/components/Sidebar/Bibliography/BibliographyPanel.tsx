import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDebounce } from "../../../hooks/useDebounce";
import { useBibliographyStore } from "../../../store/bibliographyStore";
import { useWorkspaceStore } from "../../../store/workspaceStore";
import { editorApiRef } from "../../Editor/editorApiRef";
import { BibEntryItem } from "./BibEntryItem";
import type { BibEntry } from "../../../lib/types";

/**
 * The Bibliography sidebar view (Task 4): discovers `.bib`/`.yml`/`.yaml` files
 * in the workspace, parses the selected one natively (hayagriva, backend), and
 * lists references. Clicking a reference inserts `#cite(<key>)` at the caret.
 *
 * Discovery runs on mount and whenever the workspace root changes. Only shown
 * when a folder is open (`when: "workspace"` in the extension), so the empty-
 * workspace prompt is handled by the sidebar shell.
 */
export function BibliographyPanel() {
  const { t } = useTranslation("bibliography");
  const rootPath = useWorkspaceStore((s) => s.rootPath);

  const discoveredFiles = useBibliographyStore((s) => s.discoveredFiles);
  const activeFilePath = useBibliographyStore((s) => s.activeFilePath);
  const entries = useBibliographyStore((s) => s.entries);
  const query = useBibliographyStore((s) => s.query);
  const setQuery = useBibliographyStore((s) => s.setQuery);
  const loading = useBibliographyStore((s) => s.loading);
  const error = useBibliographyStore((s) => s.error);
  const discoverFiles = useBibliographyStore((s) => s.discoverFiles);
  const loadFile = useBibliographyStore((s) => s.loadFile);
  const clear = useBibliographyStore((s) => s.clear);

  // Local input state, debounced into the store query so typing stays snappy.
  const [input, setInput] = useState(query);
  const debouncedInput = useDebounce(input, 150);
  useEffect(() => {
    setQuery(debouncedInput);
  }, [debouncedInput, setQuery]);

  // Discover files on mount + whenever the workspace root changes. When the
  // workspace closes, reset everything so stale entries don't linger.
  useEffect(() => {
    if (rootPath === null) {
      clear();
      return;
    }
    void discoverFiles(rootPath);
  }, [rootPath, discoverFiles, clear]);

  // Auto-select the first discovered file so the panel shows references
  // immediately without requiring a manual pick (matches the "just works"
  // expectation from the Packages/Symbols panels). Re-runs when discovery
  // resolves a new file list and nothing is active yet.
  useEffect(() => {
    if (activeFilePath === null && discoveredFiles.length > 0) {
      void loadFile(discoveredFiles[0].path);
    }
  }, [discoveredFiles, activeFilePath, loadFile]);

  const handleCite = useCallback((key: string) => {
    editorApiRef.current?.replaceSelection(`#cite(<${key}>)`);
  }, []);

  // Case-insensitive filter over key, title, and authors.
  const normalizedQuery = debouncedInput.trim().toLowerCase();
  const visibleEntries = useMemo<BibEntry[]>(() => {
    if (normalizedQuery === "") return entries;
    return entries.filter((e) => matchesQuery(e, normalizedQuery));
  }, [entries, normalizedQuery]);

  const hasFiles = discoveredFiles.length > 0;
  const hasEntries = visibleEntries.length > 0;

  return (
    <div className="bibliography-panel">
      {hasFiles ? (
        <>
          <div className="bibliography-fileselect">
            <select
              className="bibliography-select"
              value={activeFilePath ?? ""}
              onChange={(e) => void loadFile(e.target.value)}
              aria-label={t("selectFile")}
            >
              {discoveredFiles.map((f) => (
                <option key={f.path} value={f.path}>
                  {displayName(f.path)}
                  {f.entryCount != null ? ` (${f.entryCount})` : ""}
                </option>
              ))}
            </select>
          </div>
          <div className="bibliography-search">
            <input
              className="bibliography-search-input"
              type="search"
              placeholder={t("searchPlaceholder")}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              aria-label={t("searchPlaceholder")}
            />
          </div>
          {error && (
            <p className="bibliography-status bibliography-status-error">
              {t("parseError")}
            </p>
          )}
          <div className="bibliography-body">
            {loading && entries.length === 0 ? (
              <p className="bibliography-empty">{t("loading")}</p>
            ) : hasEntries ? (
              <ul className="bibliography-list" role="list">
                {visibleEntries.map((entry) => (
                  <BibEntryItem key={entry.key} entry={entry} onCite={handleCite} />
                ))}
              </ul>
            ) : (
              <p className="bibliography-empty">{t("noEntries")}</p>
            )}
          </div>
        </>
      ) : (
        <div className="bibliography-body">
          {loading ? (
            <p className="bibliography-empty">{t("loading")}</p>
          ) : (
            <p className="bibliography-empty">{t("noFiles")}</p>
          )}
        </div>
      )}
    </div>
  );
}

/** Reduce an absolute path to its basename for the file selector. */
function displayName(path: string): string {
  const norm = path.replace(/\\/g, "/");
  const idx = norm.lastIndexOf("/");
  return idx >= 0 ? norm.slice(idx + 1) : path;
}

/** Case-insensitive match over an entry's key, title, and authors. */
function matchesQuery(entry: BibEntry, q: string): boolean {
  if (entry.key.toLowerCase().includes(q)) return true;
  if (entry.title && entry.title.toLowerCase().includes(q)) return true;
  for (const author of entry.authors) {
    if (author.toLowerCase().includes(q)) return true;
  }
  return false;
}
