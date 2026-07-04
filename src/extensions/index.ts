import { createHostApi, type HostApi } from "./api";

// Load and activate all in-tree extensions.
//
// Uses import.meta.glob to statically collect every
// src/extensions/<id>/index.ts module whose default export is an
// activate(ctx) function. A single extension's failure does not bring
// down the rest of the app (mirrors VSCode's policy).
//
// Note: import.meta.glob paths resolve relative to the current module's
// directory (src/extensions/), so "./*/index.ts" matches
// src/extensions/explorer/index.ts. The extension id is the directory name
// (the first segment after ./).
export async function activateAll(): Promise<void> {
  const modules = import.meta.glob("./*/index.ts", {
    eager: true,
  });

  for (const [path, mod] of Object.entries(modules)) {
    const extensionId = path.split("/")[1];
    const activate = (mod as { default?: (ctx: HostApi) => void }).default;
    if (typeof activate !== "function") {
      console.warn(`[extensions] ${path} has no default export activate(), skipping`);
      continue;
    }
    try {
      const ctx = createHostApi(extensionId);
      activate(ctx);
      console.debug(`[extensions] activated ${extensionId}`);
    } catch (e) {
      console.error(`[extensions] ${extensionId} activate failed:`, e);
    }
  }
}
