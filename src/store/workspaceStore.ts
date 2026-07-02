import { create } from "zustand";
import type { DirEntry, EntryKind } from "../lib/types";
import {
  closeWorkspace as closeWorkspaceBE,
  createEntry as createEntryBE,
  deleteEntry as deleteEntryBE,
  getWorkspace as getWorkspaceBE,
  openDefaultWorkspace as openDefaultWorkspaceBE,
  openWorkspace as openWorkspaceBE,
  openWorkspaceByPath as openWorkspaceByPathBE,
  readDir as readDirBE,
  renameEntry as renameEntryBE,
} from "../lib/tauri";
import { recordWorkspace, loadSession } from "../lib/session";

/**
 * Workspace store: the open folder, its lazily-loaded file tree, and the file
 * operations (create/rename/delete) that mutate it.
 *
 * The tree is stored as a map from a directory's relative path to its immediate
 * children (`DirEntry[]`). The root is keyed by `""`. A directory not yet in the
 * map hasn't been expanded. This keeps large workspaces cheap: only expanded
 * folders are loaded (via the backend's lazy `read_dir`).
 *
 * This store deliberately does NOT own document content — that's `tabsStore`.
 * A tree click loads the file's content via `openFileByPath` and hands the
 * resulting `OpenedDocument` to `tabsStore.openPath`, keeping the two stores
 * decoupled.
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
  renameEntry: (from: string, to: string) => Promise<void>;
  deleteEntry: (rel: string) => Promise<void>;
}

/** The parent directory of a workspace-relative path ("" if at root). */
function parentRel(rel: string): string {
  if (rel === "" || rel === ".") return "";
  const idx = rel.lastIndexOf("/");
  return idx < 0 ? "" : rel.slice(0, idx);
}

/** Whether a relative path points inside the open workspace root. */
function inWorkspace(rootPath: string | null, absPath: string): boolean {
  return rootPath !== null && (absPath === rootPath || absPath.startsWith(rootPath + "/"));
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

  deleteEntry: async (rel) => {
    await deleteEntryBE(rel);
    await get().refresh(parentRel(rel));
  },
}));

/** Re-exported for callers that just need the helper. */
export { inWorkspace };
