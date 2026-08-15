import { describe, expect, it } from "vitest";

// Locale parity gate: the "add every user-visible key to BOTH locales"
// convention from AGENTS.md, enforced as a command instead of prose.
// Fails on namespace drift, per-key drift, shape mismatches, and empty
// values. Comparison is structural (recursive), never flattened to dotted
// paths — locale keys may themselves contain ".".

type Json = Record<string, unknown>;

const enModules = import.meta.glob("../locales/en/*.json", {
  eager: true,
}) as Record<string, Json>;
const zhModules = import.meta.glob("../locales/zh/*.json", {
  eager: true,
}) as Record<string, Json>;

function basename(path: string): string {
  return path.split("/").pop()!.replace(/\.json$/, "");
}

function isPlainObject(v: unknown): v is Json {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function diffKeys(enNode: unknown, zhNode: unknown, path: string, out: string[]): void {
  if (isPlainObject(enNode) !== isPlainObject(zhNode)) {
    out.push(`${path}: shape mismatch (object on one side, leaf on the other)`);
    return;
  }
  if (!isPlainObject(enNode) || !isPlainObject(zhNode)) return;
  const enKeys = Object.keys(enNode);
  const zhKeys = Object.keys(zhNode);
  const at = (k: string) => (path ? `${path}.${k}` : k);
  for (const k of enKeys) {
    if (!zhKeys.includes(k)) out.push(`${at(k)}: missing in zh`);
  }
  for (const k of zhKeys) {
    if (!enKeys.includes(k)) out.push(`${at(k)}: missing in en`);
  }
  for (const k of enKeys) {
    if (zhKeys.includes(k)) diffKeys(enNode[k], zhNode[k], at(k), out);
  }
}

function emptyLeaves(node: unknown, path: string, out: string[]): void {
  if (isPlainObject(node)) {
    for (const [k, v] of Object.entries(node)) {
      emptyLeaves(v, path ? `${path}.${k}` : k, out);
    }
  } else if (typeof node === "string" && node.trim() === "") {
    out.push(path);
  }
}

describe("locale key parity (en ⟷ zh)", () => {
  it("ships the same namespaces in both locales", () => {
    expect(Object.keys(enModules).map(basename).sort())
      .toEqual(Object.keys(zhModules).map(basename).sort());
  });

  it("keeps every key identical across locales (structure-aware)", () => {
    const mismatches: string[] = [];
    for (const [path, json] of Object.entries(enModules)) {
      const ns = basename(path);
      const mirror = Object.entries(zhModules).find(([p]) => basename(p) === ns);
      if (!mirror) continue; // covered by the namespace-set test
      const local: string[] = [];
      diffKeys(json, mirror[1], ns, local);
      mismatches.push(...local);
    }
    expect(mismatches).toEqual([]);
  });

  it("carries no empty translation values", () => {
    const empties: string[] = [];
    for (const [locale, modules] of [["en", enModules], ["zh", zhModules]] as const) {
      for (const [path, json] of Object.entries(modules)) {
        emptyLeaves(json, `${locale}/${basename(path)}`, empties);
      }
    }
    expect(empties).toEqual([]);
  });
});
