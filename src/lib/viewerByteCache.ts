import { readFileBytes } from "./tauri";
import { workspacePathsEqual } from "./workspacePath";

/**
 * Path-keyed cache of file bytes for the binary viewers (`ImageViewer`,
 * `PdfViewer`).
 *
 * ## Why
 * Binary tabs (image/pdf) are conditionally rendered by `EditorArea` based on
 * the active tab kind, so switching away from an image/pdf tab and back
 * unmounts the viewer. On return the viewer's `useEffect` re-ran
 * `readFileBytes(path)` — an IPC round-trip to the backend that re-reads the
 * file from disk and re-serializes it as a JSON number array. For large images
 * and large PDFs this made every tab-switch-back sluggish. This cache makes the
 * return path instant: the bytes are already in memory and only the cheap
 * Blob/pdf.js render rebuilds.
 *
 * ## Cache contents
 * A `Map<string, Uint8Array>` keyed by absolute path. `Uint8Array` is not
 * immutable, but both viewers treat the buffer as read-only:
 *  - `ImageViewer` wraps it in a `Blob` (no in-place mutation).
 *  - `PdfViewer` already defensively `.slice()`-copies the bytes before handing
 *    them to pdf.js (which transfers the buffer to its worker).
 * So the cached `Uint8Array` is stored as-returned by `readFileBytes`. Callers
 * must not mutate the returned buffer in place; if a future caller needs to,
 * it should copy first.
 *
 * ## Eviction
 * Bounded to the last {@link LRU_BOUND} entries with simple LRU semantics: a
 * plain JS `Map` preserves insertion order, so on a hit we delete + re-set the
 * entry to move it to the back (most-recently-used), and on overflow we evict
 * the first key (least-recently-used).
 *
 * ## Invalidation
 * {@link invalidateViewerByteCache} drops a single path or clears the whole
 * cache. Wired to the backend `fs_changed` watcher event via
 * {@link invalidateFsChanged} (subscribed globally in `App.tsx`), so externally
 * modified images/PDFs are re-read from disk instead of showing stale cached
 * bytes. Known limitation: `fs_changed` only covers files inside the open
 * workspace (the loose-file watcher deliberately does not emit it — see the
 * comment on `src-tauri/src/service/tab_store.rs` in the backend), so binary
 * tabs opened from outside the workspace are not covered here.
 */

/** Maximum number of entries kept in the cache (LRU bound). */
const LRU_BOUND = 8;

const cache = new Map<string, Uint8Array>();

/**
 * Returns the cached bytes for `path`, or fetches them via the backend
 * `read_file_bytes` command and caches the result. Cached entries are moved to
 * the back of the map (most-recently-used) on every access.
 */
export async function readFileBytesCached(path: string): Promise<Uint8Array> {
  const cached = cache.get(path);
  if (cached !== undefined) {
    // Refresh LRU order: move this entry to the back (most-recently-used).
    cache.delete(path);
    cache.set(path, cached);
    return cached;
  }

  const bytes = await readFileBytes(path);
  cache.set(path, bytes);
  // Evict the least-recently-used entry (first key) if over the bound.
  if (cache.size > LRU_BOUND) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return bytes;
}

/**
 * Invalidate the cache. If `path` is given, drops that single entry; otherwise
 * clears all entries. Intended to be wired to file-change events in future work.
 */
export function invalidateViewerByteCache(path?: string): void {
  if (path === undefined) {
    cache.clear();
    return;
  }
  cache.delete(path);
}

/**
 * Invalidate cache entries affected by a `fs_changed` payload (absolute paths
 * that changed on disk). An empty `paths` list is the backend's generic
 * "something changed, refresh" signal and clears the whole cache. Otherwise
 * each cached key is compared with every changed path via
 * {@link workspacePathsEqual} — the event's paths and our cache keys may differ
 * in separators/case on Windows, so an exact `cache.delete(path)` would miss.
 */
export function invalidateFsChanged(paths: readonly string[]): void {
  if (paths.length === 0) {
    cache.clear();
    return;
  }
  for (const key of [...cache.keys()]) {
    if (paths.some((changed) => workspacePathsEqual(key, changed))) {
      cache.delete(key);
    }
  }
}

/**
 * Whether a `fs_changed` payload affects the given viewer path: true for an
 * exact/equivalent (Windows separator- and case-insensitive) match, or for an
 * empty payload (generic refresh). Pure — used by viewer components to decide
 * whether to reload the currently shown file.
 */
export function fsChangeAffectsPath(
  viewerPath: string,
  changed: readonly string[],
): boolean {
  return changed.some((p) => workspacePathsEqual(viewerPath, p));
}
