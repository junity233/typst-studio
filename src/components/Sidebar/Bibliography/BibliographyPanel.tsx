import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import { useDebounce } from "../../../hooks/useDebounce";
import { useBibliographyStore } from "../../../store/bibliographyStore";
import { useWorkspaceStore } from "../../../store/workspaceStore";
import { useProjectConfigStore } from "../../../store/projectConfigStore";
import { useDialogStore } from "../../../store/dialogStore";
import { joinWorkspacePath } from "../../../lib/workspacePath";
import { editorApiRef } from "../../Editor/editorApiRef";
import { BibEntryItem } from "./BibEntryItem";
import { BibEditModal } from "./BibEditModal";
import type { BibEntry, BibEntryEditable, BibFileInfo } from "../../../lib/types";

/**
 * The Bibliography sidebar view (Task 4): discovers `.bib`/`.yml`/`.yaml` files
 * in the workspace, parses the selected one natively (hayagriva, backend), and
 * lists references. Right-click a reference for a context menu (insert
 * citation / copy key / edit / delete); double-click to edit. The `+` button
 * next to the search box opens the add-reference modal.
 *
 * Discovery runs the first time the view becomes visible and whenever the
 * workspace root changes. Only shown when a folder is open
 * (`when: "workspace"` in the extension), so the empty-workspace prompt is
 * handled by the sidebar shell.
 *
 * CRUD is delegated to `bibliographyStore` (which round-trips through the
 * backend's serialize-and-write command). Delete asks for confirmation via
 * `dialogStore.confirm` BEFORE calling the store (the store just executes).
 */
export function BibliographyPanel({
  visible = true,
}: {
  /** The sidebar passes the view id (unused here) + current visibility. */
  viewId?: string;
  visible?: boolean;
}) {
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
  const addEntry = useBibliographyStore((s) => s.addEntry);
  const updateEntry = useBibliographyStore((s) => s.updateEntry);
  const deleteEntry = useBibliographyStore((s) => s.deleteEntry);
  const clear = useBibliographyStore((s) => s.clear);

  // Declared bibliography files (`.typstpro` `bibliography`) take precedence:
  // they are resolved to absolute paths and listed FIRST, deduped against the
  // scan-discovered files. The auto-select effect below then picks the first
  // declared file. When no declaration exists, the scan list is used as-is.
  const declaredBib = useProjectConfigStore((s) => s.config?.bibliography ?? null);
  const files = useMemo<BibFileInfo[]>(() => {
    const declared = (declaredBib ?? [])
      .map((rel) => (rootPath ? joinWorkspacePath(rootPath, rel) : null))
      .filter((p): p is string => p !== null)
      .map<BibFileInfo>((path) => ({ path, entryCount: null }));
    const seen = new Set(declared.map((d) => d.path));
    const merged = [...declared];
    for (const f of discoveredFiles) {
      if (!seen.has(f.path)) {
        merged.push(f);
        seen.add(f.path);
      }
    }
    return merged;
  }, [declaredBib, rootPath, discoveredFiles]);

  // Local input state, debounced into the store query so typing stays snappy.
  const [input, setInput] = useState(query);
  const debouncedInput = useDebounce(input, 150);
  useEffect(() => {
    setQuery(debouncedInput);
  }, [debouncedInput, setQuery]);

  // Discover workspace bibliography files the first time the view is VISIBLE
  // (the sidebar pre-mounts every view, and the scan should not run at startup
  // for a tab the user may never open), and again whenever the workspace root
  // changes while the panel is (or later becomes) visible. When the workspace
  // closes, reset everything so stale entries don't linger.
  const [discoveredRoot, setDiscoveredRoot] = useState<string | null>(null);
  useEffect(() => {
    if (rootPath === null) {
      clear();
      setDiscoveredRoot(null);
      return;
    }
    if (!visible || discoveredRoot === rootPath) return;
    setDiscoveredRoot(rootPath);
    void discoverFiles(rootPath);
  }, [rootPath, visible, discoveredRoot, discoverFiles, clear]);

  // Auto-select the first discovered file so the panel shows references
  // immediately without requiring a manual pick (matches the "just works"
  // expectation from the Packages/Symbols panels). Re-runs when discovery
  // resolves a new file list and nothing is active yet. Skips files that
  // previously failed to parse so a single broken file can't loop
  // (load → error → activeFilePath=null → auto-select → reload same file).
  const failedPaths = useBibliographyStore((s) => s.failedPaths);
  useEffect(() => {
    if (activeFilePath !== null) return;
    const next = files.find((f) => !failedPaths.includes(f.path));
    if (next) void loadFile(next.path);
  }, [files, activeFilePath, failedPaths, loadFile]);

  const handleCite = useCallback((key: string) => {
    editorApiRef.current?.replaceSelection(`#cite(<${key}>)`);
  }, []);

  // --- Modal state + handlers ------------------------------------------------
  // `originalKey` is captured when opening in "edit" mode so the store can
  // handle a key change (the modal's `key` field may differ from the original).
  const [editState, setEditState] = useState<
    | { mode: "add" | "edit"; entry: BibEntryEditable; originalKey: string }
    | null
  >(null);

  const handleAdd = useCallback(() => {
    setEditState({
      mode: "add",
      entry: blankTemplate(),
      originalKey: "",
    });
  }, []);

  const handleEdit = useCallback((key: string) => {
    // Read `fullEntries` lazily from the store (not from the render-scope
    // binding) so the callback identity is stable (deps []); this keeps the
    // BibEntryItem memo effective across saves (each save repopulates
    // fullEntries, which would otherwise recreate this callback and re-render
    // the whole list).
    const full = useBibliographyStore.getState().fullEntries.find(
      (e) => e.key === key,
    );
    if (!full) return;
    setEditState({ mode: "edit", entry: full, originalKey: key });
  }, []);

  const handleConfirm = useCallback(
    (entry: BibEntryEditable) => {
      if (editState === null) return;
      if (editState.mode === "add") {
        void addEntry(entry);
      } else {
        void updateEntry(editState.originalKey, entry);
      }
      setEditState(null);
    },
    [editState, addEntry, updateEntry],
  );

  const handleCancelModal = useCallback(() => setEditState(null), []);

  const handleDelete = useCallback(
    async (key: string) => {
      // Confirm BEFORE calling the store — the store just executes the delete.
      const result = await useDialogStore.getState().confirm({
        title: t("confirmDeleteTitle"),
        message: t("confirmDeleteMessage", { key }),
        confirmLabel: t("delete"),
        cancelLabel: t("cancel"),
        danger: true,
      });
      if (result === "confirm") {
        void deleteEntry(key);
      }
    },
    [deleteEntry, t],
  );

  // Case-insensitive filter over key, title, and authors.
  const normalizedQuery = debouncedInput.trim().toLowerCase();
  const visibleEntries = useMemo<BibEntry[]>(() => {
    if (normalizedQuery === "") return entries;
    return entries.filter((e) => matchesQuery(e, normalizedQuery));
  }, [entries, normalizedQuery]);

  const hasFiles = files.length > 0;
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
              {files.map((f) => {
                const failed = failedPaths.includes(f.path);
                return (
                  <option key={f.path} value={f.path}>
                    {displayName(f.path)}
                    {f.entryCount != null ? ` (${f.entryCount})` : ""}
                    {failed ? " ⚠" : ""}
                  </option>
                );
              })}
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
            <button
              type="button"
              className="bibliography-add"
              onClick={handleAdd}
              title={t("addEntry")}
              aria-label={t("addEntry")}
            >
              <Plus size={14} />
            </button>
          </div>
          {error && (
            <div className="bibliography-status bibliography-status-error">
              <p>{t("parseError")}</p>
              <p className="bibliography-status-detail">{error}</p>
            </div>
          )}
          <div className="bibliography-body">
            {loading && entries.length === 0 ? (
              <p className="bibliography-empty">{t("loading")}</p>
            ) : hasEntries ? (
              <ul className="bibliography-list" role="list">
                {visibleEntries.map((entry) => (
                  <BibEntryItem
                    key={entry.key}
                    entry={entry}
                    onCite={handleCite}
                    onEdit={handleEdit}
                    onDelete={handleDelete}
                  />
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
      {editState && (
        <BibEditModal
          mode={editState.mode}
          initial={editState.entry}
          onConfirm={handleConfirm}
          onCancel={handleCancelModal}
        />
      )}
    </div>
  );
}

/** A blank entry template for the "add" modal. */
function blankTemplate(): BibEntryEditable {
  return {
    key: "",
    entryType: "misc",
    title: null,
    authors: [],
    year: null,
    extra: [],
  };
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
