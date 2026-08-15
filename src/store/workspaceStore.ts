import { create } from "zustand";
import type { DeleteOutcome, DirEntry, EntryKind } from "../lib/types";
import {
  closeWorkspace as closeWorkspaceBE,
  copyEntry as copyEntryBE,
  createEntry as createEntryBE,
  deleteEntry as deleteEntryBE,
  deleteEntryPermanent as deleteEntryPermanentBE,
  getWorkspace as getWorkspaceBE,
  openDefaultWorkspace as openDefaultWorkspaceBE,
  openWorkspace as openWorkspaceBE,
  openWorkspaceByPath as openWorkspaceByPathBE,
  readDir as readDirBE,
  renameEntry as renameEntryBE,
} from "../lib/tauri";
import { recordWorkspace, loadSession, captureAndSaveSession } from "../lib/session";
import { useProjectConfigStore } from "./projectConfigStore";
import { removeDocFromStores } from "./tabsStore";

/**
 * Shared body of `deleteEntry` / `deleteEntryPermanent`: the backend preflight
 * hard-closed any clean open docs (incl. hidden) under the deleted entry (so
 * they don't linger as zombies feeding the conflict dialog); drop them from
 * the frontend stores too, re-activate a neighbor, and re-capture the session.
 */
async function deleteEntryCommon(
  rel: string,
  backendDelete: (rel: string) => Promise<{ outcome: DeleteOutcome; closedDocIds: string[] }>,
): Promise<void> {
  const res = await backendDelete(rel);
  for (const id of res.closedDocIds) removeDocFromStores(id);
  await useWorkspaceStore.getState().refresh(parentRel(rel));
  if (res.closedDocIds.length > 0) void captureAndSaveSession();
}

/**
 * Workspace store: the open folder, its lazily-loaded file tree, and the file
 * operations (create/rename/delete) that mutate it.
 *
 * The tree is stored as a map from a directory's relative path to its immediate
 * children (`DirEntry[]`). The root is keyed by `""`. A directory not yet in the
 * map hasn't been expanded. This keeps large workspaces cheap: only expanded
 * folders are loaded (via the backend's lazy `read_dir`).
 *
 * This store deliberately does NOT own document content — that's the domain
 * `documentsStore` (with `tabsStore` as the views store). A tree click loads
 * the file's content via `openFileByPath` and hands the resulting
 * `OpenedDocument` to `tabsStore.openPath`, which fans out into both stores,
 * keeping the stores decoupled.
 */
export interface WorkspaceState {
  /** Absolute path of the open workspace root, or null when closed. */
  rootPath: string | null;
  /** Display name of the root folder. */
  name: string | null;
  /** Loaded tree branches: relative dir path → its immediate children. */
  tree: Record<string, DirEntry[]>;
  /** Set of expanded directory relative paths (for the UI to track arrows). */
  expanded: Set<string>;
  /** Whether an async tree load is in flight (for spinners). */
  loading: boolean;

  /** Hydrate from the backend's current workspace (on app start). */
  hydrate: () => Promise<void>;
  /** Open a folder via a native dialog and load its root listing. */
  openWorkspace: () => Promise<void>;
  /** Close the workspace, clearing the tree. */
  closeWorkspace: () => Promise<void>;

  /** Ensure a directory's children are loaded (lazy expand). No-op if cached. */
  ensureLoaded: (rel: string) => Promise<void>;
  /** Force-refresh a directory's children from disk. */
  refresh: (rel: string) => Promise<void>;
  /** Refresh every currently-loaded directory (used on fs_changed). */
  refreshAll: () => Promise<void>;

  /** Toggle a directory's expanded state, loading on first expand. */
  toggleExpand: (rel: string) => Promise<void>;
  /** Collapse every currently-expanded directory. */
  collapseAll: () => void;
  /** Expand every currently-loaded directory (lazy tree — only loaded ones). */
  expandAll: () => Promise<void>;

  /** File operations (each also refreshes the affected directory). */
  createEntry: (rel: string, kind: EntryKind) => Promise<void>;
  /**
   * Rename/move an entry. §6.4: the backend rebinds open docs and emits
   * `docs_rebound`; the store only refreshes the file tree (the doc rebind is
   * handled by the event subscription in useTypstCompile).
   */
  renameEntry: (from: string, to: string) => Promise<void>;
  /**
   * Delete an entry via the system trash (§5.5). Rejects with `delete_blocked`
   * when a dirty document is open under the target.
   */
  deleteEntry: (rel: string) => Promise<void>;
  /**
   * Permanently delete an entry (§5.5 advanced action; NOT recoverable). Same
   * dirty-doc protection as [`deleteEntry`].
   */
  deleteEntryPermanent: (rel: string) => Promise<void>;
  /**
   * Recursively copy an entry to another workspace-relative path (Copy / Paste /
   * Duplicate). The source is left untouched; both source and destination
   * parent dirs are refreshed.
   */
  copyEntry: (from: string, to: string) => Promise<void>;
}

/** The parent directory of a workspace-relative path ("" if at root). */
function parentRel(rel: string): string {
  if (rel === "" || rel === ".") return "";
  const idx = rel.lastIndexOf("/");
  return idx < 0 ? "" : rel.slice(0, idx);
}

export const useWorkspaceStore = create<WorkspaceState>()((set, get) => ({
  rootPath: null,
  name: null,
  tree: {},
  expanded: new Set<string>(),
  loading: false,

  hydrate: async () => {
    try {
      let meta = await getWorkspaceBE();
      // Nothing open yet: try to restore the last workspace from the session
      // memory before falling back to the cwd default. This makes the app
      // reopen where the user left off.
      if (!meta) {
        const session = await loadSession();
        if (session.lastWorkspace) {
          meta = await openWorkspaceByPathBE(session.lastWorkspace);
        }
        if (!meta) {
          meta = await openDefaultWorkspaceBE();
        }
      }
      if (meta) {
        set({ rootPath: meta.root, name: meta.name });
        await get().refresh("");
        // Load the workspace's `.typstpro` (project config) once the root is
        // established. Subscribes to `project_config_changed` on first call.
        void useProjectConfigStore.getState().hydrate();
      }
    } catch (e) {
      console.warn("[workspace.hydrate] failed:", e);
    }
  },

  openWorkspace: async () => {
    try {
      const meta = await openWorkspaceBE();
      if (meta === null) return; // user cancelled
      set({
        rootPath: meta.root,
        name: meta.name,
        tree: {},
        expanded: new Set<string>(),
      });
      await get().refresh("");
      // Persist the chosen workspace so it reopens on next launch.
      recordWorkspace(meta.root);
      // Re-hydrate the project config for the new root.
      void useProjectConfigStore.getState().hydrate();
    } catch (e) {
      console.error("[workspace.openWorkspace] failed:", e);
      throw e;
    }
  },

  closeWorkspace: async () => {
    try {
      await closeWorkspaceBE();
    } catch (e) {
      console.warn("[workspace.closeWorkspace] backend rejected:", e);
    }
    set({ rootPath: null, name: null, tree: {}, expanded: new Set<string>() });
    // The backend resets the `.typstpro` cache on close (broadcasts null); clear
    // the path + candidate list here too so the panel shows its empty state.
    useProjectConfigStore.setState({ config: null, configPath: null, typFiles: [] });
  },

  ensureLoaded: async (rel) => {
    if (get().tree[rel] !== undefined) return;
    await get().refresh(rel);
  },

  refresh: async (rel) => {
    const { rootPath } = get();
    if (rootPath === null) return;
    set({ loading: true });
    try {
      const entries = await readDirBE(rel);
      set((s) => ({ tree: { ...s.tree, [rel]: entries } }));
    } catch (e) {
      console.warn(`[workspace.refresh] read_dir "${rel}" failed:`, e);
    } finally {
      set({ loading: false });
    }
  },

  refreshAll: async () => {
    const { tree } = get();
    // Re-read every loaded directory + the root.
    const dirs = Object.keys(tree);
    await Promise.all(dirs.map((d) => get().refresh(d)));
  },

  toggleExpand: async (rel) => {
    const expanded = new Set(get().expanded);
    if (expanded.has(rel)) {
      expanded.delete(rel);
    } else {
      expanded.add(rel);
      await get().ensureLoaded(rel);
    }
    set({ expanded });
  },

  collapseAll: () => {
    set({ expanded: new Set<string>() });
  },

  expandAll: async () => {
    // The tree is lazy: only loaded directories appear as keys. Expand each
    // loaded directory and every directory child within it. Deeper, unloaded
    // folders stay collapsed until the user opens them (no recursive load storm).
    const { tree } = get();
    const expanded = new Set(get().expanded);
    const visit = (dirRel: string) => {
      const entries = tree[dirRel];
      if (!entries) return;
      expanded.add(dirRel);
      for (const e of entries) {
        if (e.kind === "dir") visit(e.relative);
      }
    };
    visit("");
    set({ expanded });
  },

  createEntry: async (rel, kind) => {
    await createEntryBE(rel, kind);
    await get().refresh(parentRel(rel));
  },

  renameEntry: async (from, to) => {
    await renameEntryBE(from, to);
    await get().refresh(parentRel(from));
    await get().refresh(parentRel(to));
  },

  deleteEntry: (rel) => deleteEntryCommon(rel, deleteEntryBE),

  deleteEntryPermanent: (rel) => deleteEntryCommon(rel, deleteEntryPermanentBE),

  copyEntry: async (from, to) => {
    await copyEntryBE(from, to);
    await get().refresh(parentRel(from));
    await get().refresh(parentRel(to));
  },
}));
