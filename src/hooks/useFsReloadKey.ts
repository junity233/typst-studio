import { useState } from "react";
import { onFsChanged } from "../lib/tauri";
import { fsChangeAffectsPath } from "../lib/viewerByteCache";
import { useTauriListener } from "./useTauriListener";

/**
 * Reload key for a binary viewer (image/pdf): bumped whenever the backend
 * watcher reports this file changed — or a generic refresh (empty `paths`) —
 * so the viewer's load effect re-runs with fresh bytes. The byte-cache entry
 * itself is dropped globally in App.tsx; bumping here just re-runs the load.
 */
export function useFsReloadKey(path: string): number {
  const [reloadKey, setReloadKey] = useState(0);
  useTauriListener(onFsChanged, ({ paths }) => {
    if (paths.length === 0 || fsChangeAffectsPath(path, paths)) {
      setReloadKey((k) => k + 1);
    }
  });
  return reloadKey;
}
