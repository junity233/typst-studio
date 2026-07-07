import type { DirEntry } from "../../lib/types";

/**
 * Pure path + collision helpers for the Explorer file manager. Extracted from
 * `Explorer.tsx` so the name-resolution logic (the trickiest part of Copy /
 * Paste / Duplicate) is unit-testable without mounting the tree.
 *
 * All paths here are workspace-relative with forward slashes; "" denotes the
 * root (never used as an entry relative — entries always have a name).
 */

/** The parent directory of a workspace-relative path ("" if at root). */
export function parentRel(rel: string): string {
  if (rel === "" || rel === ".") return "";
  const idx = rel.lastIndexOf("/");
  return idx < 0 ? "" : rel.slice(0, idx);
}

/** Split a workspace-relative path into (parentDir, baseName). */
export function splitRel(rel: string): { parent: string; base: string } {
  const idx = rel.lastIndexOf("/");
  return idx < 0
    ? { parent: "", base: rel }
    : { parent: rel.slice(0, idx), base: rel.slice(idx + 1) };
}

/** Join a parent dir and a base name into a workspace-relative path. */
export function joinRel(parent: string, base: string): string {
  return parent === "" ? base : `${parent}/${base}`;
}

/** All workspace-relative entry paths currently loaded in the tree. */
export function allLoadedEntries(tree: Record<string, DirEntry[]>): Set<string> {
  const set = new Set<string>();
  for (const entries of Object.values(tree)) {
    for (const e of entries) set.add(e.relative);
  }
  return set;
}

/**
 * Resolve a destination name that may collide with an existing entry. Returns a
 * workspace-relative path whose base is guaranteed not to collide: for
 * `foo.typ` → `foo copy.typ`, `foo copy 2.typ`, …; for a directory `foo` →
 * `foo copy`, `foo copy 2`, … Never returns `desiredRel` unchanged if it
 * collides (so Duplicate always renames; Paste only renames on conflict).
 *
 * `existing` is the set of workspace-relative paths already on disk (taken from
 * the tree snapshot; the backend's `create_new` is the backstop if a race beats
 * the UI).
 */
export function resolveCollision(
  desiredRel: string,
  existing: Set<string>,
): string {
  if (!existing.has(desiredRel)) return desiredRel;
  const { parent, base } = splitRel(desiredRel);
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  // First suffix is bare " copy"; subsequent ones are " copy 2", " copy 3", …
  let n = 1;
  // The collision set is finite, so some non-colliding name exists within
  // `existing.size + 1` candidates at worst — the loop always terminates.
  for (;;) {
    const candidate = joinRel(parent, `${stem} copy${n === 1 ? "" : ` ${n}`}${ext}`);
    if (!existing.has(candidate)) return candidate;
    n++;
  }
}
