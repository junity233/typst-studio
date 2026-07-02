# 粘贴富文本 → Typst 自动转换 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cmd/Ctrl+V 粘贴时自动把富文本 HTML（网页 + Word/Excel）转为 Typst 源码并插入 Monaco，含图片落盘与宏驱动路径模板。

**Architecture:** 混合方案——前端纯函数转换器（`DOMParser` + 递归 DOM 遍历）产出 Typst 文本与待落盘图片清单；后端仅新增可复用 `net` 模块（reqwest）拉取远程图片。本地图片 I/O 复用既有 `@tauri-apps/plugin-fs` + `@tauri-apps/api/path`。插入一律走 `editor.executeEdits` 以保留 undo 并喂给编译器 + LSP 双管线。

**Tech Stack:** React 19 + TypeScript + Vite 7（前端）；Rust + Tauri 2 + reqwest 0.12（后端）；Vitest 2（新增测试）。参考 spec：`docs/superpowers/specs/2026-07-02-paste-rich-text-design.md`。

## Global Constraints

- **Typst crate 版本固定 0.15**；本特性不触碰 typst crate。
- **不引入前端 HTML 解析第三方库**——只用浏览器原生 `DOMParser`。
- **后端 HTTP 客户端用 reqwest 0.12 + rustls-tls**（`default-features = false`），避免系统 OpenSSL 依赖。
- **绝对不用 `model.setValue` 插入文本**——一律 `editor.executeEdits`（见 `MonacoEditor.tsx:210-221` 注释解释为何）。
- **paste 监听用 capture 阶段**（`addEventListener("paste", h, true)`），镜像 `useAppCommands.ts:42-56` 的 Cmd+S 拦截模式。
- **所有新前端代码无注释除非要求**（遵循仓库约定：实现代码无注释，但公开 API 的 JSDoc 注释允许——本仓库 `lib/tauri.ts`/`useSetting.ts` 有 JSDoc 先例）。
- **commit message 风格**：`feat(paste): ...` / `feat(net): ...` / `test(paste): ...`，匹配既有 `feat(...)`/`fix(...)`/`chore(...)` 风格。
- **路径分隔**：前端用 `@tauri-apps/api/path` 的 `join`/`dirname`，不手写 `/`。
- **Typst 转义字符集**：`\ * _ ` [ ] $ # @ ~`（代码块内不转义）。

---

## File Structure

| 文件 | 责任 | 新建/修改 |
|---|---|---|
| `vitest.config.ts` | Vitest 配置（jsdom 环境） | 新建 |
| `package.json` | 加 vitest + jsdom 依赖与脚本 | 修改 |
| `src/lib/pathMacros/types.ts` | `MacroContext` 类型 | 新建 |
| `src/lib/pathMacros/index.ts` | `expandTemplate` 纯函数 | 新建 |
| `src/lib/pathMacros/__tests__/expand.test.ts` | 宏引擎单测 | 新建 |
| `src/lib/htmlToTypst/types.ts` | `ConvertResult`/`PendingImage`/`ConvertContext` | 新建 |
| `src/lib/htmlToTypst/escape.ts` | Typst 文本转义 | 新建 |
| `src/lib/htmlToTypst/inline.ts` | 内联元素 → Typst 内联标记 | 新建 |
| `src/lib/htmlToTypst/blocks.ts` | 块级元素 → Typst 块标记 | 新建 |
| `src/lib/htmlToTypst/images.ts` | `<img>` 收集 → 占位符 + ext 推断 | 新建 |
| `src/lib/htmlToTypst/tables.ts` | `<table>` → `#table()` | 新建 |
| `src/lib/htmlToTypst/wordCleanup.ts` | Word HTML 清洗（幂等） | 新建 |
| `src/lib/htmlToTypst/index.ts` | 主入口 `htmlToTypst` | 新建 |
| `src/lib/htmlToTypst/__tests__/*.ts` | 各模块单测 + fixtures | 新建 |
| `src-tauri/Cargo.toml` | 加 reqwest + mockito(dev) | 修改 |
| `src-tauri/src/net/mod.rs` | net 模块导出 | 新建 |
| `src-tauri/src/net/client.rs` | `HttpClient` + `FetchOptions` | 新建 |
| `src-tauri/src/net/fetch.rs` | `fetch_to_file`/`fetch_bytes` | 新建 |
| `src-tauri/src/net/error.rs` | `NetError` | 新建 |
| `src-tauri/src/ipc/net_commands.rs` | `fetch_url_to_file` Tauri 命令 | 新建 |
| `src-tauri/src/lib.rs` | 注册 `net` 模块 + 命令 | 修改 |
| `src-tauri/src/ipc/mod.rs` | 加 `net_commands` 子模块 | 修改 |
| `src-tauri/src/ipc/state.rs` | `AppState` 加 `net` 字段 | 修改 |
| `src-tauri/settings/manifest.json` | 加 3 个 editor 设置 | 修改 |
| `src/components/Editor/usePasteConvert.ts` | paste 监听 + 编排 hook | 新建 |
| `src/components/Editor/MonacoEditor.tsx` | 接入 `usePasteConvert` | 修改 |
| `src/lib/tauri.ts` | 加 `fetchUrlToFile` 封装 | 修改 |

---

## Task 1: Vitest 测试基建

**Files:**
- Create: `vitest.config.ts`
- Modify: `package.json`
- Test: `src/lib/__tests__/sanity.test.ts`

**Interfaces:**
- Produces: `npm test` / `npm run test:run` 脚本；jsdom 环境的 Vitest（提供 `DOMParser`）。

- [ ] **Step 1: 安装 dev 依赖**

Run:
```bash
npm install -D vitest@^2 jsdom@^25 @types/jsdom
```
Expected: `package.json` 的 `devDependencies` 出现 `vitest`、`jsdom`、`@types/jsdom`。

- [ ] **Step 2: 写 `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    globals: false,
  },
});
```

- [ ] **Step 3: 在 `package.json` 的 `scripts` 加测试脚本**

把 `scripts` 改为：
```json
"scripts": {
  "dev": "vite",
  "build": "tsc && vite build",
  "preview": "vite preview",
  "tauri": "tauri",
  "test": "vitest",
  "test:run": "vitest run"
}
```

- [ ] **Step 4: 写 sanity 测试验证 DOMParser 可用**

`src/lib/__tests__/sanity.test.ts`:
```ts
import { describe, it, expect } from "vitest";

describe("vitest jsdom sanity", () => {
  it("provides DOMParser", () => {
    const doc = new DOMParser().parseFromString("<p>hi</p>", "text/html");
    expect(doc.querySelector("p")?.textContent).toBe("hi");
  });
});
```

- [ ] **Step 5: 运行测试**

Run: `npm run test:run`
Expected: 1 passed。

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json vitest.config.ts src/lib/__tests__/sanity.test.ts
git commit -m "chore(test): add Vitest with jsdom environment"
```

---

## Task 2: 宏引擎 `pathMacros`

**Files:**
- Create: `src/lib/pathMacros/types.ts`, `src/lib/pathMacros/index.ts`
- Test: `src/lib/pathMacros/__tests__/expand.test.ts`

**Interfaces:**
- Produces:
  - `MacroContext`（见 spec §7）
  - `ExpandOptions { unknown?: "keep" | "drop" | "throw" }`（默认 `"keep"`）
  - `expandTemplate(template: string, ctx: MacroContext, options?: ExpandOptions): string`

- [ ] **Step 1: 写 `types.ts`**

```ts
export interface MacroContext {
  workspace?: string;
  fileDir?: string;
  fileName?: string;
  filePath?: string;
  hash?: string;
  ext?: string;
  timestamp?: string;
  index?: number;
}

export interface ExpandOptions {
  unknown?: "keep" | "drop" | "throw";
}
```

- [ ] **Step 2: 写失败测试**

`src/lib/pathMacros/__tests__/expand.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { expandTemplate } from "../index";
import type { MacroContext } from "../types";

const ctx: MacroContext = {
  workspace: "/home/user/proj",
  fileDir: "/home/user/proj/docs",
  fileName: "intro",
  filePath: "/home/user/proj/docs/intro.typ",
  hash: "abc123def456",
  ext: "png",
  timestamp: "20260702",
  index: 0,
};

describe("expandTemplate", () => {
  it("expands simple macros", () => {
    expect(expandTemplate("${fileDir}/x.${ext}", ctx)).toBe("/home/user/proj/docs/x.png");
  });

  it("expands ${workspace}", () => {
    expect(expandTemplate("${workspace}/assets/a.png", ctx)).toBe("/home/user/proj/assets/a.png");
  });

  it("uses default value after colon", () => {
    const partial: MacroContext = { ext: "png" };
    expect(expandTemplate("${fileDir:/tmp}/x.${ext}", partial)).toBe("/tmp/x.png");
  });

  it("keeps unknown macro by default", () => {
    expect(expandTemplate("${unknownThing}/x", ctx)).toBe("${unknownThing}/x");
  });

  it("drops unknown macro when unknown=drop", () => {
    expect(expandTemplate("a${nope}b", ctx, { unknown: "drop" })).toBe("ab");
  });

  it("throws on unknown macro when unknown=throw", () => {
    expect(() => expandTemplate("${nope}", ctx, { unknown: "throw" })).toThrow(/nope/);
  });

  it("throws when strict (?) macro is missing", () => {
    const partial: MacroContext = { ext: "png" };
    expect(() => expandTemplate("${fileDir?}", partial)).toThrow(/fileDir/);
  });

  it("passes through literal ${...} when escaped with $$", () => {
    expect(expandTemplate("$${fileDir}", ctx)).toBe("${fileDir}");
  });

  it("expands index and hash", () => {
    expect(expandTemplate("pasted-${hash}-${index}.${ext}", ctx)).toBe("pasted-abc123def456-0.png");
  });

  it("leaves missing optional macro as empty when no default and unknown=drop", () => {
    const partial: MacroContext = { ext: "png" };
    expect(expandTemplate("[${fileDir}]/x", partial, { unknown: "drop" })).toBe("[]/x");
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `npm run test:run -- src/lib/pathMacros`
Expected: FAIL（`expandTemplate` 未定义）。

- [ ] **Step 4: 写 `index.ts` 实现**

```ts
import type { ExpandOptions, MacroContext } from "./types";

const MACRO_RE = /\$(\$)?\{([a-zA-Z_][a-zA-Z0-9_]*)([?:][^}]*)?\}/g;

export function expandTemplate(
  template: string,
  ctx: MacroContext,
  options?: ExpandOptions,
): string {
  const mode = options?.unknown ?? "keep";
  return template.replace(MACRO_RE, (whole, dollar, name: string, modifier: string) => {
    if (dollar === "$") return `\${${name}${modifier ?? ""}}`;
    const val = ctx[name as keyof MacroContext];
    if (val !== undefined) return String(val);
    if (modifier !== undefined) {
      if (modifier.startsWith(":")) return modifier.slice(1);
      if (modifier.startsWith("?")) {
        throw new Error(`missing required macro: ${name}`);
      }
    }
    if (mode === "drop") return "";
    if (mode === "throw") throw new Error(`unknown macro: ${name}`);
    return whole;
  });
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npm run test:run -- src/lib/pathMacros`
Expected: 10 passed。

- [ ] **Step 6: Commit**

```bash
git add src/lib/pathMacros
git commit -m "feat(paste): reusable path-macro expansion engine"
```

---

## Task 3: 转换器类型与转义模块

**Files:**
- Create: `src/lib/htmlToTypst/types.ts`, `src/lib/htmlToTypst/escape.ts`
- Test: `src/lib/htmlToTypst/__tests__/escape.test.ts`

**Interfaces:**
- Produces:
  - `ConvertContext { workspace?: string; filePath?: string; imageTemplate: string; fetchRemote: boolean }`
  - `PendingImage { placeholder: string; src: string; alt?: string; index: number }`
  - `ConvertResult { typst: string; pendingImages: PendingImage[]; warnings: string[] }`
  - `escapeTypst(text: string): string`

- [ ] **Step 1: 写 `types.ts`**

```ts
export interface ConvertContext {
  workspace?: string;
  filePath?: string;
  imageTemplate: string;
  fetchRemote: boolean;
}

export interface PendingImage {
  placeholder: string;
  src: string;
  alt?: string;
  index: number;
}

export interface ConvertResult {
  typst: string;
  pendingImages: PendingImage[];
  warnings: string[];
}

/** 内部：递归转换上下文（带图片计数器，可变收集）。 */
export interface WalkCtx {
  convert: ConvertContext;
  pendingImages: PendingImage[];
  warnings: string[];
  nextImageIndex: number;
}

export function makeWalkCtx(convert: ConvertContext): WalkCtx {
  return { convert, pendingImages: [], warnings: [], nextImageIndex: 0 };
}
```

- [ ] **Step 2: 写失败测试**

`src/lib/htmlToTypst/__tests__/escape.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { escapeTypst } from "../escape";

describe("escapeTypst", () => {
  it("escapes all special Typst chars", () => {
    expect(escapeTypst("a*b_c`d[e]f$g#h@i~j\\k")).toBe(
      "a\\*b\\_c\\`d\\[e\\]f\\$g\\#h\\@i\\~j\\\\k",
    );
  });
  it("leaves plain text alone", () => {
    expect(escapeTypst("Hello World 123")).toBe("Hello World 123");
  });
  it("escapes unicode-looking ascii only", () => {
    expect(escapeTypst("price = $5")).toBe("price = \\$5");
  });
});
```

- [ ] **Step 3: 运行确认失败**

Run: `npm run test:run -- src/lib/htmlToTypst/__tests__/escape`
Expected: FAIL。

- [ ] **Step 4: 写 `escape.ts`**

```ts
const SPECIAL = /[*_`\[\]$#@~\\]/g;

export function escapeTypst(text: string): string {
  return text.replace(SPECIAL, (ch) => "\\" + ch);
}
```

- [ ] **Step 5: 运行确认通过**

Run: `npm run test:run -- src/lib/htmlToTypst/__tests__/escape`
Expected: 3 passed。

- [ ] **Step 6: Commit**

```bash
git add src/lib/htmlToTypst/types.ts src/lib/htmlToTypst/escape.ts src/lib/htmlToTypst/__tests__/escape.test.ts
git commit -m "feat(paste): Typst text escape + converter types"
```

---

## Task 4: 图片收集器 `images.ts`

**Files:**
- Create: `src/lib/htmlToTypst/images.ts`
- Test: `src/lib/htmlToTypst/__tests__/images.test.ts`

**Interfaces:**
- Consumes: `WalkCtx`（Task 3）
- Produces:
  - `inferExt(src: string): string` —— 从 data: 或 URL 推断扩展名，未知返回 `"png"`
  - `collectImage(img: HTMLImageElement, wctx: WalkCtx): string` —— 登记 pendingImage，返回占位符字符串

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from "vitest";
import { inferExt, collectImage } from "../images";
import { makeWalkCtx } from "../types";

describe("inferExt", () => {
  it("png from data uri", () => {
    expect(inferExt("data:image/png;base64,iVBOR")).toBe("png");
  });
  it("jpeg -> jpg", () => {
    expect(inferExt("data:image/jpeg;base64,/9j/")).toBe("jpg");
  });
  it("svg+xml -> svg", () => {
    expect(inferExt("data:image/svg+xml;base64,PHN2Zz4=")).toBe("svg");
  });
  it("from url extension", () => {
    expect(inferExt("https://a.b/img/photo.PNG")).toBe("png");
  });
  it("defaults to png when none", () => {
    expect(inferExt("https://a.b/photo")).toBe("png");
  });
});

describe("collectImage", () => {
  it("registers pending image and returns placeholder", () => {
    const wctx = makeWalkCtx({
      imageTemplate: "${fileDir}/a-${hash}.${ext}",
      fetchRemote: true,
    });
    const img = document.createElement("img");
    img.setAttribute("src", "data:image/png;base64,iVBOR");
    img.setAttribute("alt", "diagram");
    const ph = collectImage(img, wctx);
    expect(ph).toMatch(/^\u0000IMG0\u0000$/);
    expect(wctx.pendingImages).toHaveLength(1);
    expect(wctx.pendingImages[0]).toEqual({
      placeholder: ph,
      src: "data:image/png;base64,iVBOR",
      alt: "diagram",
      index: 0,
    });
    expect(wctx.nextImageIndex).toBe(1);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm run test:run -- src/lib/htmlToTypst/__tests__/images`
Expected: FAIL。

- [ ] **Step 3: 写 `images.ts`**

```ts
import type { WalkCtx } from "./types";

const IMG_PLACEHOLDER = (i: number) => `\u0000IMG${i}\u0000`;

export function inferExt(src: string): string {
  const m = src.match(/^data:image\/([a-z+]+);/i);
  if (m) {
    const sub = m[1].toLowerCase();
    if (sub === "jpeg") return "jpg";
    if (sub === "svg+xml") return "svg";
    return sub;
  }
  const ext = src.split("?")[0].split("#")[0].match(/\.([a-z0-9]+)$/i);
  if (ext) {
    const sub = ext[1].toLowerCase();
    if (sub === "jpeg") return "jpg";
    return sub;
  }
  return "png";
}

export function collectImage(img: HTMLImageElement, wctx: WalkCtx): string {
  const index = wctx.nextImageIndex++;
  const placeholder = IMG_PLACEHOLDER(index);
  wctx.pendingImages.push({
    placeholder,
    src: img.getAttribute("src") ?? "",
    alt: img.getAttribute("alt") ?? undefined,
    index,
  });
  return placeholder;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npm run test:run -- src/lib/htmlToTypst/__tests__/images`
Expected: 6 passed。

- [ ] **Step 5: Commit**

```bash
git add src/lib/htmlToTypst/images.ts src/lib/htmlToTypst/__tests__/images.test.ts
git commit -m "feat(paste): image collection + extension inference"
```

---

## Task 5: 内联转换器 `inline.ts`

**Files:**
- Create: `src/lib/htmlToTypst/inline.ts`
- Test: `src/lib/htmlToTypst/__tests__/inline.test.ts`

**Interfaces:**
- Consumes: `escapeTypst`（Task 3）、`collectImage`（Task 4）、`WalkCtx`
- Produces:
  - `convertInline(node: Node, wctx: WalkCtx): string` —— 递归把一个节点的内联子树转成 Typst 内联标记（无块分隔）

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from "vitest";
import { convertInline } from "../inline";
import { makeWalkCtx } from "../types";

function walk(html: string) {
  const wctx = makeWalkCtx({ imageTemplate: "${fileDir}/a.${ext}", fetchRemote: true });
  const doc = new DOMParser().parseFromString(html, "text/html");
  return { typst: convertInline(doc.body, wctx), wctx };
}

describe("convertInline", () => {
  it("plain text is escaped", () => {
    expect(walk("a*b").typst).toBe("a\\*b");
  });
  it("bold and strong -> *..*", () => {
    expect(walk("<b>hi</b>").typst).toBe("*hi*");
    expect(walk("<strong>hi</strong>").typst).toBe("*hi*");
  });
  it("italic and em -> _.._", () => {
    expect(walk("<i>hi</i>").typst).toBe("_hi_");
    expect(walk("<em>hi</em>").typst).toBe("_hi_");
  });
  it("nested b+i", () => {
    expect(walk("<b><i>x</i></b>").typst).toBe("*_x_*");
  });
  it("code -> backticks", () => {
    expect(walk("<code>x*y</code>").typst).toBe("`x*y`");
  });
  it("del -> strike", () => {
    expect(walk("<del>x</del>").typst).toBe("#strike[x]");
  });
  it("u -> underline", () => {
    expect(walk("<u>x</u>").typst).toBe("#underline[x]");
  });
  it("sub/sup", () => {
    expect(walk("<sub>2</sub>").typst).toBe("#sub 2");
    expect(walk("<sup>2</sup>").typst).toBe("#super 2");
  });
  it("link", () => {
    expect(walk('<a href="https://x.io">link</a>').typst).toBe('#link("https://x.io")[link]');
  });
  it("link where text equals href -> bare #link()", () => {
    expect(walk('<a href="https://x.io">https://x.io</a>').typst).toBe('#link("https://x.io")');
  });
  it("br -> line break", () => {
    expect(walk("a<br>b").typst).toBe("a\\\nb");
  });
  it("span bold via style", () => {
    expect(walk('<span style="font-weight:bold">x</span>').typst).toBe("*x*");
  });
  it("span italic via style", () => {
    expect(walk('<span style="font-style:italic">x</span>').typst).toBe("_x_");
  });
  it("img -> placeholder + pendingImage", () => {
    const { typst, wctx } = walk('<img src="data:image/png;base64,iVBOR" alt="d">');
    expect(typst).toMatch(/^\u0000IMG0\u0000$/);
    expect(wctx.pendingImages).toHaveLength(1);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm run test:run -- src/lib/htmlToTypst/__tests__/inline`
Expected: FAIL。

- [ ] **Step 3: 写 `inline.ts`**

```ts
import type { WalkCtx } from "./types";
import { escapeTypst } from "./escape";
import { collectImage } from "./images";

export function convertInline(node: Node, wctx: WalkCtx): string {
  let out = "";
  node.childNodes.forEach((child) => {
    out += inlineNode(child, wctx);
  });
  return out;
}

function inlineNode(node: Node, wctx: WalkCtx): string {
  if (node.nodeType === 3 /* TEXT */) {
    return escapeTypst(node.textContent ?? "");
  }
  if (node.nodeType !== 1 /* ELEMENT */) return "";
  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  const inner = () => convertInline(el, wctx);

  switch (tag) {
    case "b":
    case "strong":
      return `*${inner()}*`;
    case "i":
    case "em":
      return `_${inner()}_`;
    case "code":
      return "`" + (el.textContent ?? "") + "`";
    case "del":
    case "s":
    case "strike":
      return `#strike[${inner()}]`;
    case "u":
      return `#underline[${inner()}]`;
    case "mark":
      return `#highlight[${inner()}]`;
    case "sub":
      return `#sub ${inner()}`;
    case "sup":
      return `#super ${inner()}`;
    case "br":
      return "\\\n";
    case "img":
      return collectImage(el as HTMLImageElement, wctx);
    case "a": {
      const href = el.getAttribute("href") ?? "";
      const text = inner();
      if (!href) return text;
      if (text === href) return `#link("${href}")`;
      return `#link("${href}")[${text}]`;
    }
    case "span": {
      const style = el.getAttribute("style") ?? "";
      let s = inner();
      if (/font-weight\s*:\s*(bold|[6-9]00)/i.test(style)) s = `*${s}*`;
      if (/font-style\s*:\s*italic/i.test(style)) s = `_${s}_`;
      if (/text-decoration[^;]*line-through/i.test(style)) s = `#strike[${s}]`;
      if (/text-decoration[^;]*underline/i.test(style)) s = `#underline[${s}]`;
      if (/vertical-align\s*:\s*super/i.test(style)) s = `#super ${s}`;
      if (/vertical-align\s*:\s*sub/i.test(style)) s = `#sub ${s}`;
      return s;
    }
    default:
      return inner();
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npm run test:run -- src/lib/htmlToTypst/__tests__/inline`
Expected: 16 passed。

- [ ] **Step 5: Commit**

```bash
git add src/lib/htmlToTypst/inline.ts src/lib/htmlToTypst/__tests__/inline.test.ts
git commit -m "feat(paste): inline element -> Typst markup converter"
```

---

## Task 6: 块级转换器 `blocks.ts`

**Files:**
- Create: `src/lib/htmlToTypst/blocks.ts`
- Test: `src/lib/htmlToTypst/__tests__/blocks.test.ts`

**Interfaces:**
- Consumes: `convertInline`（Task 5）、`convertTable`（Task 8，但本任务先放占位调用——实际 Task 8 实现，这里 blocks.ts 仅 import 并调用，Task 6 测试不含 table）、`WalkCtx`
- Produces:
  - `convertBlocks(node: Node, wctx: WalkCtx, depth: number): string` —— 递归块级转换；块之间用空行分隔

注意：本任务先不处理 `<table>`（在 Task 8 实现 `convertTable` 后接入）。为避免循环依赖，`blocks.ts` 通过动态检查 `tag === "table"` 时 `import` tables 模块；但更简洁的做法是让 `index.ts`（Task 9）分发 table，blocks.ts 暂时把 `<table>` 当作「跳过 + warning」。**决策**：blocks.ts 在 Task 6 里把 table 透传给一个本地 stub `convertTable` 返回 `""` + warning；Task 8 实现真正的 `tables.ts`，Task 9 的 `index.ts` 用真正版本替换分发。

简化方案：blocks.ts 不直接处理 table，由 `index.ts` 顶层分发。`convertBlocks` 遇到 table 时调用注入的 `tableHandler`。但这增加复杂度。**最终决策**：`convertBlocks` 遇到 `table` 调用 `convertTable(el, wctx)`；`tables.ts` 在 Task 8 提供该函数；Task 6 测试不涉及 table，但代码 import 会失败。所以**把 tables.ts 的最小 stub 放在 Task 6 之前**——即 Task 6 步骤里先建一个 `tables.ts` stub（返回 warning），Task 8 替换为真实实现。这样依赖闭合。

- [ ] **Step 1: 先建 `tables.ts` stub（Task 8 替换）**

```ts
import type { WalkCtx } from "./types";

export function convertTable(_el: Element, _wctx: WalkCtx): string {
  return "";
}
```

- [ ] **Step 2: 写失败测试**

`src/lib/htmlToTypst/__tests__/blocks.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { convertBlocks } from "../blocks";
import { makeWalkCtx } from "../types";

function walk(html: string) {
  const wctx = makeWalkCtx({ imageTemplate: "${fileDir}/a.${ext}", fetchRemote: true });
  const doc = new DOMParser().parseFromString(html, "text/html");
  return convertBlocks(doc.body, wctx, 0).trim();
}

describe("convertBlocks", () => {
  it("h1..h3 levels", () => {
    expect(walk("<h1>Title</h1>")).toBe("= Title");
    expect(walk("<h2>Sub</h2>")).toBe("== Sub");
    expect(walk("<h3>Deep</h3>")).toBe("=== Deep");
  });
  it("paragraphs separated by blank line", () => {
    expect(walk("<p>one</p><p>two</p>")).toBe("one\n\ntwo");
  });
  it("unordered list", () => {
    expect(walk("<ul><li>a<li>b</ul>")).toBe("- a\n- b");
  });
  it("ordered list", () => {
    expect(walk("<ol><li>a<li>b</ol>")).toBe("+ a\n+ b");
  });
  it("nested list indents two spaces", () => {
    expect(walk("<ul><li>a<ul><li>b</ul></ul>")).toBe("- a\n  - b");
  });
  it("blockquote -> #quote", () => {
    expect(walk("<blockquote>hi</blockquote>")).toBe("#quote[hi]");
  });
  it("pre with language -> code block", () => {
    expect(walk('<pre><code class="language-rust">fn x()</code></pre>')).toBe(
      "```rust\nfn x()\n```",
    );
  });
  it("pre without language -> plain code block", () => {
    expect(walk("<pre>raw code</pre>")).toBe("```\nraw code\n```");
  });
  it("hr -> line", () => {
    expect(walk("<hr>")).toBe("#line(length: 100%)");
  });
  it("inline inside paragraph preserved", () => {
    expect(walk("<p><b>bold</b> text</p>")).toBe("*bold* text");
  });
  it("text node is escaped", () => {
    expect(walk("a*b")).toBe("a\\*b");
  });
});
```

- [ ] **Step 3: 运行确认失败**

Run: `npm run test:run -- src/lib/htmlToTypst/__tests__/blocks`
Expected: FAIL。

- [ ] **Step 4: 写 `blocks.ts`**

```ts
import type { WalkCtx } from "./types";
import { convertInline } from "./inline";
import { convertTable } from "./tables";

const MAX_LIST_DEPTH = 6;

export function convertBlocks(node: Node, wctx: WalkCtx, depth: number): string {
  const parts: string[] = [];
  node.childNodes.forEach((child) => {
    const block = blockNode(child, wctx, depth);
    if (block.length > 0) parts.push(block);
  });
  return parts.join("\n\n");
}

function blockNode(node: Node, wctx: WalkCtx, depth: number): string {
  if (node.nodeType === 3 /* TEXT */) {
    const t = (node.textContent ?? "").trim();
    return t.length ? convertInline(node, wctx) : "";
  }
  if (node.nodeType !== 1) return "";
  const el = node as Element;
  const tag = el.tagName.toLowerCase();

  switch (tag) {
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6": {
      const level = Number(tag[1]);
      return "=".repeat(level) + " " + convertInline(el, wctx).trim();
    }
    case "p":
    case "div": {
      const inner = convertBlocks(el, wctx, depth).trim();
      return inner;
    }
    case "ul":
    case "ol":
      return convertList(el, wctx, depth, tag === "ol");
    case "blockquote": {
      const inner = convertBlocks(el, wctx, depth).trim();
      return `#quote[${inner}]`;
    }
    case "pre":
      return convertPre(el);
    case "hr":
      return "#line(length: 100%)";
    case "table":
      return convertTable(el, wctx);
    default:
      return convertInline(el, wctx);
  }
}

function convertList(el: Element, wctx: WalkCtx, depth: number, ordered: boolean): string {
  const marker = ordered ? "+" : "-";
  const indent = "  ".repeat(Math.min(depth, MAX_LIST_DEPTH));
  if (depth >= MAX_LIST_DEPTH) {
    wctx.warnings.push("list nesting truncated at depth " + MAX_LIST_DEPTH);
  }
  const lines: string[] = [];
  el.querySelectorAll(":scope > li").forEach((li) => {
    const inline = convertInline(li, wctx).trim();
    lines.push(`${indent}${marker} ${inline}`);
    li.querySelectorAll(":scope > ul, :scope > ol").forEach((sub) => {
      lines.push(convertList(sub, wctx, depth + 1, sub.tagName.toLowerCase() === "ol"));
    });
  });
  return lines.join("\n");
}

function convertPre(el: Element): string {
  const code = el.querySelector("code");
  let lang = "";
  if (code) {
    const cls = code.getAttribute("class") ?? "";
    const m = cls.match(/language-([a-z0-9]+)/i);
    if (m) lang = m[1];
  }
  const text = (code ?? el).textContent ?? "";
  return "```" + lang + "\n" + text.replace(/\n$/, "") + "\n```";
}
```

- [ ] **Step 5: 运行确认通过**

Run: `npm run test:run -- src/lib/htmlToTypst/__tests__/blocks`
Expected: 11 passed。

- [ ] **Step 6: Commit**

```bash
git add src/lib/htmlToTypst/blocks.ts src/lib/htmlToTypst/tables.ts src/lib/htmlToTypst/__tests__/blocks.test.ts
git commit -m "feat(paste): block element -> Typst converter (lists/headings/code/quote)"
```

---

## Task 7: 表格转换器 `tables.ts`（真实实现）

**Files:**
- Modify: `src/lib/htmlToTypst/tables.ts`（替换 Task 6 stub）
- Test: `src/lib/htmlToTypst/__tests__/tables.test.ts`

**Interfaces:**
- Consumes: `convertInline`（Task 5）、`WalkCtx`
- Produces:
  - `convertTable(el: Element, wctx: WalkCtx): string` —— `<table>` → `#table(columns: N, ...)`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from "vitest";
import { convertTable } from "../tables";
import { makeWalkCtx } from "../types";

function table(html: string) {
  const wctx = makeWalkCtx({ imageTemplate: "${fileDir}/a.${ext}", fetchRemote: true });
  const doc = new DOMParser().parseFromString(html, "text/html");
  return { typst: convertTable(doc.querySelector("table")!, wctx), wctx };
}

describe("convertTable", () => {
  it("simple 2x2", () => {
    expect(table("<table><tr><td>A<td><td>B<td></tr><tr><td>1<td>2<td></tr></table>").typst)
      .toBe("#table(\n  columns: 2,\n  [A], [B],\n  [1], [2],\n)");
  });
  it("infers columns from widest row", () => {
    expect(table("<table><tr><td>a<td>b<td>c</tr><tr><td>x<td>y</tr></table>").typst)
      .toContain("columns: 3");
  });
  it("header row via th", () => {
    const { typst } = table("<table><tr><th>H1<th>H2</tr><tr><td>1<td>2</tr></table>");
    expect(typst).toContain("table.header([H1], [H2])");
  });
  it("colspan -> first cell content, rest empty", () => {
    const { typst } = table('<table><tr><td colspan="2">merged<td></tr><tr><td>a<td>b</tr></table>');
    expect(typst).toContain("columns: 2");
    expect(typst).toContain("[merged], []");
  });
  it("rowspan flattened + warning", () => {
    const { typst, wctx } = table('<table><tr><td rowspan="2">x<td>y</tr><tr><td>z</tr></table>');
    expect(typst).toContain("columns: 2");
    expect(wctx.warnings.some((w) => w.includes("rowspan"))).toBe(true);
  });
  it("inline markup in cells preserved", () => {
    const { typst } = table("<table><tr><td><b>x</b></tr></table>");
    expect(typst).toContain("[*x*]");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm run test:run -- src/lib/htmlToTypst/__tests__/tables`
Expected: FAIL（stub 返回空）。

- [ ] **Step 3: 写真实 `tables.ts`**

```ts
import type { WalkCtx } from "./types";
import { convertInline } from "./inline";

interface Row {
  cells: string[];
  isHeader: boolean;
}

export function convertTable(el: Element, wctx: WalkCtx): string {
  const rows: Row[] = [];
  let hasRowspan = false;

  el.querySelectorAll(":scope > tr, :scope > tbody > tr, :scope > thead > tr").forEach((tr) => {
    const cells: string[] = [];
    let rowIsHeader = true;
    let colspanTotal = 0;
    tr.querySelectorAll(":scope > td, :scope > th").forEach((cell) => {
      const isHeaderCell = cell.tagName.toLowerCase() === "th";
      if (!isHeaderCell) rowIsHeader = false;
      const colspan = Number(cell.getAttribute("colspan") ?? "1");
      const rowspan = cell.getAttribute("rowspan");
      if (rowspan && Number(rowspan) > 1) {
        hasRowspan = true;
      }
      const content = convertInline(cell, wctx).trim();
      cells.push(content);
      for (let i = 1; i < colspan; i++) cells.push("");
      colspanTotal += colspan;
    });
    if (cells.length > 0) rows.push({ cells, isHeader: rowIsHeader });
  });

  const columns = rows.reduce((m, r) => Math.max(m, r.cells.length), 0);
  if (hasRowspan) wctx.warnings.push("rowspan flattened (Typst #table has no row merge)");

  const headerRows = rows.filter((r) => r.isHeader);
  const bodyRows = rows.filter((r) => !r.isHeader);

  const pad = (r: Row) => {
    const c = [...r.cells];
    while (c.length < columns) c.push("");
    return c;
  };

  const parts: string[] = [`columns: ${columns}`];
  if (headerRows.length > 0) {
    const cells = headerRows.flatMap(pad).map((c) => `[${c}]`).join(", ");
    parts.push(`table.header(${cells})`);
  }
  bodyRows.forEach((r) => {
    pad(r).forEach((c) => parts.push(`[${c}]`));
  });

  return "#table(\n  " + parts.join(",\n  ") + ",\n)";
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npm run test:run -- src/lib/htmlToTypst/__tests__/tables`
Expected: 6 passed。

- [ ] **Step 5: 重跑全部测试确保无回归**

Run: `npm run test:run`
Expected: 全部 passed（含 blocks 用例仍过）。

- [ ] **Step 6: Commit**

```bash
git add src/lib/htmlToTypst/tables.ts src/lib/htmlToTypst/__tests__/tables.test.ts
git commit -m "feat(paste): HTML table -> Typst #table() converter"
```

---

## Task 8: Word 清洗器 `wordCleanup.ts`

**Files:**
- Create: `src/lib/htmlToTypst/wordCleanup.ts`
- Test: `src/lib/htmlToTypst/__tests__/wordCleanup.test.ts`

**Interfaces:**
- Produces:
  - `isWordHtml(html: string): boolean` —— 启发式检测
  - `wordCleanup(html: string): string` —— 幂等：干净 HTML 原样返回；Word HTML 剥离后返回新 HTML 字符串

- [ ] **Step 1: 写失败测试（含真实 Word 片段）**

```ts
import { describe, it, expect } from "vitest";
import { wordCleanup, isWordHtml } from "../wordCleanup";

describe("isWordHtml", () => {
  it("detects mso-", () => {
    expect(isWordHtml('<p style="mso-list: l0">x</p>')).toBe(true);
  });
  it("detects ProgId", () => {
    expect(isWordHtml('<meta name="ProgId" content="Word.Document">')).toBe(true);
  });
  it("clean html is not word", () => {
    expect(isWordHtml("<p>hello <b>world</b></p>")).toBe(false);
  });
});

describe("wordCleanup", () => {
  it("passes through clean html unchanged", () => {
    const html = "<p>hello <b>world</b></p>";
    expect(wordCleanup(html)).toBe(html);
  });
  it("strips conditional comments", () => {
    const out = wordCleanup("<!--[if gte mso 9]><xml>x</xml><![endif]--><p>hi</p>");
    expect(out).not.toContain("xml:x");
    expect(out).toContain("<p>hi</p>");
  });
  it("removes Office namespace tags keeping text", () => {
    const out = wordCleanup("<p>a<o:p>b</o:p>c</p>");
    expect(out).toContain("abc");
    expect(out.toLowerCase()).not.toContain("<o:p>");
  });
  it("strips mso-* styles and Mso classes", () => {
    const out = wordCleanup('<p class="MsoNormal" style="mso-margin-top-alt: auto; color: red">x</p>');
    expect(out).not.toContain("mso-");
    expect(out).not.toContain("MsoNormal");
    expect(out).toContain("color: red");
  });
  it("normalizes smart quotes and nbsp", () => {
    const out = wordCleanup("<p>\u201chello\u201d \u2018x\u2019 a\u00a0b</p>");
    expect(out).toContain('"hello"');
    expect(out).toContain("'x'");
    expect(out).not.toContain("\u00a0");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm run test:run -- src/lib/htmlToTypst/__tests__/wordCleanup`
Expected: FAIL。

- [ ] **Step 3: 写 `wordCleanup.ts`**

```ts
const WORD_ENTITIES: [RegExp, string][] = [
  [/\u201c/g, '"'],
  [/\u201d/g, '"'],
  [/\u2018/g, "'"],
  [/\u2019/g, "'"],
  [/\u00a0/g, " "],
  [/\u2026/g, "..."],
];

export function isWordHtml(html: string): boolean {
  return /mso-|ProgId\s*=\s*["']?Word\.Document/i.test(html);
}

export function wordCleanup(html: string): string {
  if (!isWordHtml(html)) return html;
  let out = html;
  // 1. Strip conditional comments (greedy across the bracket pair).
  out = out.replace(/<!--\[if\s[^]*?\]>\s*<!\[endif\]-->/gi, "");
  out = out.replace(/<!\[if\s[^]*?\]>/gi, "");
  out = out.replace(/<!\[endif\]>/gi, "");
  // 2. Remove Office namespace tags (keep inner text).
  out = out.replace(/<\/?(o:p|w:[\w]+|v:[\w]+|m:[\w]+|st1:[\w]+)[^>]*>/gi, "");
  // 3. Strip mso-* style props + Mso* class names.
  out = out.replace(/\s*style\s*=\s*"([^"]*)"/gi, (_m, style: string) => {
    const cleaned = style
      .split(";")
      .filter((p: string) => !/^\s*mso-/i.test(p))
      .join(";");
    return cleaned.trim().length > 0 ? ` style="${cleaned}"` : "";
  });
  out = out.replace(/\s*class\s*=\s*"[^"]*Mso[^"]*"/gi, "");
  // 4. Entity normalization.
  for (const [re, rep] of WORD_ENTITIES) out = out.replace(re, rep);
  return out;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npm run test:run -- src/lib/htmlToTypst/__tests__/wordCleanup`
Expected: 7 passed。

> **实现笔记**：Word 伪列表的完整语义重建（从 `mso-list` level 重建 `<ul>/<ol>`）是高复杂度子任务。本计划先交付「列表项 marker 字符剥离 + 作为普通段落处理」的最小版本（足够多数场景可用）。若验收时发现 Word 嵌套列表错乱，再在实现笔记追加「Word list 重建增强」任务。把这条限制记入 `docs/superpowers/specs/2026-07-02-paste-rich-text-design.md` §15。

- [ ] **Step 5: Commit**

```bash
git add src/lib/htmlToTypst/wordCleanup.ts src/lib/htmlToTypst/__tests__/wordCleanup.test.ts
git commit -m "feat(paste): Word/Excel HTML cleanup (mso-/conditional comments/entities)"
```

---

## Task 9: 主入口 `index.ts` 集成

**Files:**
- Create: `src/lib/htmlToTypst/index.ts`
- Test: `src/lib/htmlToTypst/__tests__/index.test.ts`

**Interfaces:**
- Consumes: 上述全部模块
- Produces:
  - `htmlToTypst(html: string, convert: ConvertContext): ConvertResult`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from "vitest";
import { htmlToTypst } from "../index";

const ctx = { imageTemplate: "${fileDir}/a.${ext}", fetchRemote: true };

describe("htmlToTypst", () => {
  it("end-to-end article", () => {
    const html = "<h1>Title</h1><p>Para with <b>bold</b> and <a href=\"https://x.io\">link</a>.</p><ul><li>a<li>b</ul>";
    const r = htmlToTypst(html, ctx);
    expect(r.typst).toBe("= Title\n\nPara with *bold* and #link(\"https://x.io\")[link].\n\n- a\n- b");
    expect(r.pendingImages).toHaveLength(0);
    expect(r.warnings).toHaveLength(0);
  });
  it("word html is cleaned then converted", () => {
    const html = '<p class="MsoNormal" style="mso-foo: bar">Hi <b>x</b></p>';
    const r = htmlToTypst(html, ctx);
    expect(r.typst).toBe("Hi *x*");
  });
  it("trims leading/trailing blank lines", () => {
    const r = htmlToTypst("<p>a</p>", ctx);
    expect(r.typst).toBe("a");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm run test:run -- src/lib/htmlToTypst/__tests__/index`
Expected: FAIL。

- [ ] **Step 3: 写 `index.ts`**

```ts
import type { ConvertContext, ConvertResult } from "./types";
import { makeWalkCtx } from "./types";
import { wordCleanup } from "./wordCleanup";
import { convertBlocks } from "./blocks";

export function htmlToTypst(html: string, convert: ConvertContext): ConvertResult {
  const cleaned = wordCleanup(html);
  const doc = new DOMParser().parseFromString(cleaned, "text/html");
  const wctx = makeWalkCtx(convert);
  const typst = convertBlocks(doc.body, wctx, 0).trim();
  return {
    typst,
    pendingImages: wctx.pendingImages,
    warnings: wctx.warnings,
  };
}
```

- [ ] **Step 4: 运行确认通过 + 全量回归**

Run: `npm run test:run`
Expected: 全部 passed。

- [ ] **Step 5: Commit**

```bash
git add src/lib/htmlToTypst/index.ts src/lib/htmlToTypst/__tests__/index.test.ts
git commit -m "feat(paste): htmlToTypst main entry integrating all converters"
```

---

## Task 10: 后端 `net` 模块（reqwest）+ `fetch_url_to_file` 命令

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Create: `src-tauri/src/net/mod.rs`, `src-tauri/src/net/client.rs`, `src-tauri/src/net/fetch.rs`, `src-tauri/src/net/error.rs`
- Create: `src-tauri/src/ipc/net_commands.rs`
- Modify: `src-tauri/src/lib.rs`, `src-tauri/src/ipc/mod.rs`, `src-tauri/src/ipc/state.rs`
- Modify: `src-tauri/capabilities/default.json`（如需——fetch 是自定义命令，走 `generate_handler`，无需 capability）
- Test: `src-tauri/src/net/fetch.rs` 内 `#[cfg(test)]`（用 mockito）

**Interfaces:**
- Produces:
  - Rust: `net::HttpClient::new() -> Self`、`fetch_to_file(&self, url, dest: &Path, opts: &FetchOptions) -> Result<u64>`
  - Tauri 命令 `fetch_url_to_file(url: String, dest: String) -> Result<u64>`
- 前端封装在 Task 12 加。

- [ ] **Step 1: 加 Cargo 依赖**

在 `src-tauri/Cargo.toml` 的 `[dependencies]` 末尾追加：
```toml

# HTTP client for remote image fetch (paste feature) + future reuse.
reqwest = { version = "0.12", default-features = false, features = ["rustls-tls"] }
```
在文件末尾加 dev-deps：
```toml
[dev-dependencies]
mockito = "1"
```

- [ ] **Step 2: 写 `net/error.rs`**

```rust
use thiserror::Error;

#[derive(Debug, Error)]
pub enum NetError {
    #[error("invalid url scheme (only http/https allowed): {0}")]
    BadScheme(String),
    #[error("request failed: {0}")]
    Request(#[from] reqwest::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("response too large: {size} bytes (cap {cap})")]
    TooLarge { size: u64, cap: u64 },
    #[error("non-success status {0}")]
    Status(reqwest::StatusCode),
}

impl From<NetError> for crate::error::AppError {
    fn from(e: NetError) -> Self {
        crate::error::AppError::Other(e.to_string())
    }
}
```

- [ ] **Step 3: 写 `net/client.rs`**

```rust
use std::path::Path;
use std::time::Duration;

use crate::net::error::NetError;

pub struct FetchOptions {
    pub timeout: Duration,
    pub max_bytes: u64,
}

impl Default for FetchOptions {
    fn default() -> Self {
        Self {
            timeout: Duration::from_secs(30),
            max_bytes: 50 * 1024 * 1024,
        }
    }
}

pub struct HttpClient {
    client: reqwest::Client,
}

impl HttpClient {
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::limited(10))
            .build()
            .expect("reqwest client build");
        Self { client }
    }
}
```

- [ ] **Step 4: 写 `net/fetch.rs`（含 mockito 测试）**

```rust
use std::path::Path;

use crate::net::client::{FetchOptions, HttpClient};
use crate::net::error::NetError;

impl HttpClient {
    fn validate_scheme(url: &str) -> Result<(), NetError> {
        let lower = url.to_ascii_lowercase();
        if !(lower.starts_with("http://") || lower.starts_with("https://")) {
            return Err(NetError::BadScheme(url.to_string()));
        }
        Ok(())
    }

    pub async fn fetch_to_file(
        &self,
        url: &str,
        dest: &Path,
        opts: &FetchOptions,
    ) -> Result<u64, NetError> {
        Self::validate_scheme(url)?;
        let bytes = self.fetch_bytes(url, opts).await?;
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(dest, &bytes)?;
        Ok(bytes.len() as u64)
    }

    pub async fn fetch_bytes(&self, url: &str, opts: &FetchOptions) -> Result<Vec<u8>, NetError> {
        Self::validate_scheme(url)?;
        let resp = tokio::time::timeout(opts.timeout, self.client.get(url).send())
            .await
            .map_err(|_| NetError::Request(reqwest::Error::from(reqwest::error::Timeout)))??;
        if !resp.status().is_success() {
            return Err(NetError::Status(resp.status()));
        }
        if let Some(len) = resp.content_length() {
            if len > opts.max_bytes {
                return Err(NetError::TooLarge { size: len, cap: opts.max_bytes });
            }
        }
        let bytes = resp.bytes().await?;
        if (bytes.len() as u64) > opts.max_bytes {
            return Err(NetError::TooLarge { size: bytes.len() as u64, cap: opts.max_bytes });
        }
        Ok(bytes.to_vec())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn fetch_ok_writes_file() {
        let mut server = mockito::Server::new_async().await;
        let body = b"PNGDATA";
        let _m = server
            .mock("GET", "/img.png")
            .with_status(200)
            .with_body(body)
            .create_async()
            .await;
        let client = HttpClient::new();
        let tmp = std::env::temp_dir().join("ts_net_test_ok.png");
        let n = client
            .fetch_to_file(&format!("{}/img.png", server.url()), &tmp, &FetchOptions::default())
            .await
            .unwrap();
        assert_eq!(n, body.len() as u64);
        assert_eq!(std::fs::read(&tmp).unwrap(), body);
    }

    #[tokio::test]
    async fn rejects_non_http_scheme() {
        let client = HttpClient::new();
        let err = client
            .fetch_bytes("file:///etc/passwd", &FetchOptions::default())
            .await
            .unwrap_err();
        assert!(matches!(err, NetError::BadScheme(_)));
    }

    #[tokio::test]
    async fn non_2xx_errors() {
        let mut server = mockito::Server::new_async().await;
        let _m = server.mock("GET", "/x").with_status(404).create_async().await;
        let client = HttpClient::new();
        let err = client
            .fetch_bytes(&format!("{}/x", server.url()), &FetchOptions::default())
            .await
            .unwrap_err();
        assert!(matches!(err, NetError::Status(_)));
    }
}
```

> 注：`reqwest::error::Timeout` 构造在某些版本不存在；若编译失败，把 timeout 分支改为 `Err(NetError::Request(reqwest::Error::from(<_>::timeout())))` 或新增 `NetError::Timeout` 变体。实现者按编译器提示修正即可。

- [ ] **Step 5: 写 `net/mod.rs`**

```rust
pub mod client;
pub mod error;
pub mod fetch;
```

- [ ] **Step 6: 写 `ipc/net_commands.rs`**

```rust
use std::path::Path;

use tauri::State;

use crate::error::{AppError, Result};
use crate::ipc::state::AppState;
use crate::net::client::FetchOptions;

#[tauri::command]
pub async fn fetch_url_to_file(
    url: String,
    dest: String,
    state: State<'_, AppState>,
) -> Result<u64> {
    let dest_path = Path::new(&dest);
    if !dest_path.is_absolute() {
        return Err(AppError::InvalidInput("dest must be absolute".into()));
    }
    state
        .net
        .fetch_to_file(&url, dest_path, &FetchOptions::default())
        .await
        .map_err(AppError::from)
}
```

- [ ] **Step 7: 在 `ipc/mod.rs` 加 `pub mod net_commands;`**

把 `src-tauri/src/ipc/mod.rs` 改为：
```rust
pub mod commands;
pub mod events;
pub mod fs_commands;
pub mod menu;
pub mod net_commands;
pub mod session_commands;
pub mod settings_commands;
pub mod state;
```

- [ ] **Step 8: 在 `lib.rs` 注册 `net` 模块**

在 `lib.rs:14-23` 的模块声明区加 `pub mod net;`（按字母序插在 `lsp` 后、`project` 前）。

- [ ] **Step 9: 在 `state.rs` 的 `AppState` 加 `net` 字段**

`src-tauri/src/ipc/state.rs`：在 `use` 区加 `use crate::net::client::HttpClient;`，在 `AppState` 结构体加字段：
```rust
pub struct AppState {
    pub editor: Arc<EditorService>,
    pub export: Arc<ExportService>,
    pub lsp: Arc<LspService>,
    pub workspace: Arc<WorkspaceService>,
    pub settings: Arc<SettingsService>,
    pub session: Arc<SessionService>,
    pub net: Arc<HttpClient>,
}
```

- [ ] **Step 10: 在 `lib.rs` setup 里构造 `HttpClient` 并 manage**

在 `lib.rs:165` 的 `app.manage(AppState { ... })` 前加：
```rust
let net = Arc::new(HttpClient::new());
```
（在文件顶部 setup 闭包的 `use crate::ipc::state::{AppState, TauriEmitter};` 旁加 `use crate::net::client::HttpClient;`）
并把 manage 改为：
```rust
app.manage(AppState { editor, export, lsp, workspace, settings, session, net });
```

- [ ] **Step 11: 在 `lib.rs` 的 `invoke_handler` 注册命令**

在 `invoke_handler!` 列表（`lib.rs:40-75`）的 session 命令后加：
```rust
            ipc::session_commands::save_session,
            // Network: remote image download (paste feature).
            ipc::net_commands::fetch_url_to_file,
```

- [ ] **Step 12: 运行后端测试**

Run: `cd src-tauri && cargo test net`
Expected: 3 passed。

- [ ] **Step 13: 编译检查**

Run: `cd src-tauri && cargo check`
Expected: 无错误（首次编译 reqwest 较慢，~1-2 分钟）。

- [ ] **Step 14: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/net src-tauri/src/ipc/mod.rs src-tauri/src/ipc/net_commands.rs src-tauri/src/ipc/state.rs src-tauri/src/lib.rs
git commit -m "feat(net): reusable reqwest HTTP client + fetch_url_to_file command"
```

---

## Task 11: 设置项 manifest

**Files:**
- Modify: `src-tauri/settings/manifest.json`

**Interfaces:**
- Produces: 三个 `editor.*` 设置（UI 自动渲染）。

- [ ] **Step 1: 改 manifest**

把 `editor` 类目的 `settings` 数组扩展为：
```json
    { "id": "editor", "label": "Editor", "settings": [
        { "key": "editor.fontSize",   "type": "number",  "label": "Font size",    "default": 14, "min": 8, "max": 32 },
        { "key": "editor.fontFamily", "type": "string",  "label": "Font family",  "default": "" },
        { "key": "editor.tabSize",    "type": "integer", "label": "Tab size",     "default": 2, "min": 1, "max": 16 },
        { "key": "editor.wordWrap",   "type": "boolean", "label": "Word wrap",    "default": false },
        { "key": "editor.lineNumbers","type": "boolean", "label": "Line numbers", "default": true },
        { "key": "editor.minimap",    "type": "boolean", "label": "Minimap",      "default": false },
        { "key": "editor.pasteConvertRichText", "type": "boolean", "label": "Paste rich text as Typst", "default": true },
        { "key": "editor.pasteImagePath",       "type": "string",  "label": "Pasted image path", "default": "${fileDir}/assets/pasted-${hash}.${ext}" },
        { "key": "editor.pasteImageFetchRemote","type": "boolean", "label": "Download remote images on paste", "default": true }
    ]},
```

- [ ] **Step 2: Commit**

```bash
git add src-tauri/settings/manifest.json
git commit -m "feat(paste): add editor.paste* settings to manifest"
```

---

## Task 12: 前端 `fetchUrlToFile` 封装 + `usePasteConvert` hook + MonacoEditor 接入

**Files:**
- Modify: `src/lib/tauri.ts`
- Create: `src/components/Editor/usePasteConvert.ts`
- Modify: `src/components/Editor/MonacoEditor.tsx`

**Interfaces:**
- Consumes: `htmlToTypst`（Task 9）、`expandTemplate`（Task 2）、`inferExt`（Task 4）、Tauri fs/path 插件、settings、stores
- Produces:
  - `fetchUrlToFile(url: string, dest: string): Promise<number>`
  - `usePasteConvert(getEditor, tabRef)` —— 注册 capture-phase paste 监听

- [ ] **Step 1: 在 `src/lib/tauri.ts` 加封装**

在文件末尾追加：
```ts
/** Download a remote URL to a local file via the backend net module. */
export async function fetchUrlToFile(url: string, dest: string): Promise<number> {
  return invoke<number>("fetch_url_to_file", { url, dest });
}
```

- [ ] **Step 2: 写 `usePasteConvert.ts`**

```ts
import { useEffect } from "react";
import type * as Monaco from "@codingame/monaco-vscode-editor-api";
import type { EditorApp } from "monaco-languageclient/editorApp";
import type { Tab } from "../../store/tabsStore";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { useSetting } from "../../hooks/useSetting";
import { htmlToTypst } from "../../lib/htmlToTypst";
import { expandTemplate } from "../../lib/pathMacros";
import { inferExt } from "../../lib/htmlToTypst/images";
import { sha1Hex } from "./sha1";
import { writeImage, resolveImageDir } from "./imageIo";

export type GetEditor = () => Monaco.editor.IStandaloneCodeEditor | null;

const PLACEHOLDER_RE = /\u0000IMG(\d+)\u0000/g;
const TYPST_MARK = /(^|\n)\s*(= +\S|\*[^*]+\*|_[^_]+_|#image\(|\+ |- )/;

export function usePasteConvert(
  getEditor: GetEditor,
  editorAppRef: React.MutableRefObject<EditorApp | null>,
  tabRef: React.MutableRefObject<Tab>,
): void {
  const [enabled] = useSetting<boolean>("editor.pasteConvertRichText");
  const [imageTemplate] = useSetting<string>("editor.pasteImagePath");
  const [fetchRemote] = useSetting<boolean>("editor.pasteImageFetchRemote");
  const rootPath = useWorkspaceStore((s) => s.rootPath);

  useEffect(() => {
    if (enabled === false) return;
    const handler = async (e: ClipboardEvent) => {
      if (e.shiftKey) return; // Cmd/Ctrl+Shift+V -> native
      const editor = getEditor();
      if (!editor || !editor.hasTextFocus()) return;
      const html = e.clipboardData?.getData("text/html");
      if (!html) return; // plain text path
      const plain = e.clipboardData?.getData("text/plain") ?? "";
      if (plain.trim().length > 0 && !looksRich(html, plain)) return;
      if (TYPST_MARK.test(plain)) return; // already Typst

      e.preventDefault();
      const tab = tabRef.current;
      const ctx = {
        workspace: rootPath ?? undefined,
        filePath: tab.path ?? undefined,
        imageTemplate: imageTemplate ?? "${fileDir}/assets/pasted-${hash}.${ext}",
        fetchRemote: fetchRemote !== false,
      };
      let result;
      try {
        result = htmlToTypst(html, ctx);
      } catch (err) {
        console.error("[paste] conversion failed, falling back to native:", err);
        return;
      }
      // Resolve images.
      const finalSrcByIndex: Record<number, string> = {};
      await Promise.all(
        result.pendingImages.map(async (img) => {
          try {
            const finalSrc = await resolveImage(img, ctx, tab);
            finalSrcByIndex[img.index] = finalSrc;
          } catch (err) {
            console.warn(`[paste] image ${img.index} failed:`, err);
            result.warnings.push(`image failed: ${img.src}`);
            finalSrcByIndex[img.index] = img.src; // fallback to original URL
          }
        }),
      );
      const finalText = result.typst.replace(PLACEHOLDER_RE, (_m, i) => {
        const src = finalSrcByIndex[Number(i)] ?? "";
        return `#image("${src.replace(/"/g, '\\"')}")`;
      });
      const sel = editor.getSelection();
      if (!sel) return;
      editor.executeEdits("paste-convert", [{ range: sel, text: finalText }]);
      if (result.warnings.length > 0) {
        console.warn(`[paste] ${result.warnings.length} warnings:`, result.warnings);
      }
    };
    document.addEventListener("paste", handler, true);
    return () => document.removeEventListener("paste", handler, true);
  }, [enabled, imageTemplate, fetchRemote, rootPath, getEditor, tabRef]);
}

function looksRich(html: string, plain: string): boolean {
  // If stripping tags yields the same text as plain, it isn't rich.
  const stripped = html.replace(/<[^>]+>/g, "").trim();
  return stripped !== plain.trim();
}

async function resolveImage(
  img: { src: string; index: number },
  ctx: { workspace?: string; filePath?: string; imageTemplate: string; fetchRemote: boolean },
  tab: Tab,
): Promise<string> {
  const ext = inferExt(img.src);
  let bytes: Uint8Array | null = null;
  let hashInput = img.src;
  let isRemote = false;
  if (img.src.startsWith("data:")) {
    bytes = decodeDataUri(img.src);
    hashInput = img.src.slice(img.src.indexOf(",") + 1);
  } else if (/^https?:\/\//i.test(img.src) && ctx.fetchRemote) {
    isRemote = true;
  } else {
    // remote but not fetching, or unknown -> keep as-is
    return img.src;
  }
  const hash = await sha1Hex(hashInput + ":" + img.index);
  const fileDir = await resolveImageDir(ctx, tab);
  const rel = expandTemplate(ctx.imageTemplate, {
    workspace: ctx.workspace,
    fileDir,
    fileName: tab.path ? tab.path.split(/[\\/]/).pop()?.replace(/\.typ$/, "") : undefined,
    filePath: tab.path ?? undefined,
    hash,
    ext,
    timestamp: new Date().toISOString().slice(0, 10).replace(/-/g, ""),
    index: img.index,
  });
  if (isRemote) {
    await fetchUrlToFile(img.src, rel);
    return rel;
  }
  if (bytes) {
    await writeImage(rel, bytes);
    return rel;
  }
  return img.src;
}

function decodeDataUri(uri: string): Uint8Array {
  const comma = uri.indexOf(",");
  const data = uri.slice(comma + 1);
  const binary = atob(data);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
```

- [ ] **Step 3: 写 `sha1.ts`（小工具）**

`src/components/Editor/sha1.ts`:
```ts
/** 12-hex-char SHA-1 of a string, via SubtleCrypto. */
export async function sha1Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-1", data);
  const hex = Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hex.slice(0, 12);
}
```

- [ ] **Step 4: 写 `imageIo.ts`（Tauri fs 封装）**

`src/components/Editor/imageIo.ts`:
```ts
import { join, dirname, isAbsolute } from "@tauri-apps/api/path";
import { tempDir } from "@tauri-apps/api/path";
import { writeFile, mkdir, exists } from "@tauri-apps/plugin-fs";

export async function resolveImageDir(
  ctx: { workspace?: string; filePath?: string },
  tab: { path: string | null },
): Promise<string | undefined> {
  if (tab.path) {
    const dir = await dirname(tab.path);
    return dir;
  }
  return ctx.workspace ?? undefined;
}

export async function writeImage(absPath: string, bytes: Uint8Array): Promise<void> {
  const dir = await dirname(absPath);
  await mkdir(dir, { recursive: true });
  if (await exists(absPath)) {
    // dedup left to caller's hash check; here we overwrite only if caller chose this path
  }
  await writeFile(absPath, bytes);
}

/** Ensure a template-expanded path is absolute; fall back to tempDir. */
export async function ensureAbsolute(
  resolved: string,
  workspace?: string,
): Promise<string> {
  if (await isAbsolute(resolved)) return resolved;
  if (workspace) return join(workspace, resolved);
  return join(await tempDir(), resolved);
}
```

- [ ] **Step 5: 在 `MonacoEditor.tsx` 接入 hook**

在 `MonacoEditor.tsx` 顶部 import 区加：
```ts
import { usePasteConvert } from "./usePasteConvert";
```
在组件内（`tabIdRef`/`onChangeRef` 定义之后，`handleTextChanged` 之前，约 `MonacoEditor.tsx:235` 之后）加：
```ts
  const getEditor: () => Monaco.editor.IStandaloneCodeEditor | null = () =>
    editorAppRef.current?.getEditor() ?? null;
  usePasteConvert(getEditor, editorAppRef, tabIdRef as unknown as React.MutableRefObject<Tab>);
```
> 注：`tabIdRef` 是 `useRef(tab.id)`，但 hook 需要 `Tab`（含 `path`）。改为传一个持 `tab` 的 ref：在 `tabIdRef` 旁加 `const tabRef = useRef(tab); tabRef.current = tab;`，把 `tabRef` 传给 hook（不要传 `tabIdRef`）。修正：上述调用改为 `usePasteConvert(getEditor, editorAppRef, tabRef);`，并加 `const tabRef = useRef<Tab>(tab); tabRef.current = tab;`。

- [ ] **Step 6: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无错误。若 `crypto.subtle.digest("SHA-1", ...)` 的 TS lib 报错，把 `tsconfig.json` 的 `lib` 加 `"DOM"`（通常已含）。

- [ ] **Step 7: 完整构建检查**

Run: `npm run build`
Expected: 构建成功。

- [ ] **Step 8: Commit**

```bash
git add src/lib/tauri.ts src/components/Editor/usePasteConvert.ts src/components/Editor/sha1.ts src/components/Editor/imageIo.ts src/components/Editor/MonacoEditor.tsx
git commit -m "feat(paste): wire rich-text paste conversion into Monaco editor"
```

---

## Task 13: 端到端手动验证

**Files:** 无（验证步骤）

- [ ] **Step 1: 启动开发构建**

Run: `npm run tauri dev`
Expected: 应用启动，无运行时错误。

- [ ] **Step 2: 网页文本粘贴**

从 MDN/Wikipedia 复制一段含标题、粗体、链接、列表的内容 → 粘贴到编辑器。
Expected: 自动转为 Typst 语法；预览正常渲染。

- [ ] **Step 3: Cmd/Ctrl+Shift+V 原生粘贴**

同样内容用 Cmd+Shift+V 粘贴。
Expected: 插入原始 HTML/纯文本，未转换。

- [ ] **Step 4: 关闭设置验证**

打开设置 → 关闭 "Paste rich text as Typst" → 复制网页内容 → 普通 Cmd+V。
Expected: 原生粘贴（未转换）。

- [ ] **Step 5: 图片粘贴（data URI）**

复制一张网页上的图片 → 粘贴。
Expected: 图片落盘到 `${fileDir}/assets/pasted-<hash>.png`；编辑器出现 `#image("...")`；预览显示图片。

- [ ] **Step 6: 未保存 tab fallback**

新建 tab（未保存）→ 粘贴含图片内容。
Expected: 图片存入 workspace/assets 或 temp 目录；状态栏/console 有提示。

- [ ] **Step 7: Word 文档粘贴**

从 Word 复制含表格、列表的段落 → 粘贴。
Expected: mso- 样式被剥除；表格转为 `#table()`；结构基本正确（列表可能不完美，已记入 spec §15）。

- [ ] **Step 8: 全量测试回归**

Run: `npm run test:run && cd src-tauri && cargo test`
Expected: 全部 passed。

- [ ] **Step 9: 更新 spec 实现笔记**

把验证中发现的真实偏差（如 Word 列表重建的限制、reqwest timeout 变体的实际写法）记入 `docs/superpowers/specs/2026-07-02-paste-rich-text-design.md` §15，commit。

---

## Self-Review

**Spec coverage 检查**：
- §2 架构（混合）→ Task 10 (net) + Task 12 (前端) ✓
- §3 模块布局 → Task 2-9 覆盖所有文件 ✓
- §4 数据结构 → Task 3 types.ts ✓
- §5 流水线 → Task 12 usePasteConvert ✓
- §6 映射规则 → Task 5 (inline) + Task 6 (blocks) + Task 7 (tables) + Task 3 (escape) ✓
- §7 宏引擎 → Task 2 ✓
- §8 图片流水线 → Task 4 (collect) + Task 12 (resolve/write/dedup) ✓
- §9 后端 net → Task 10 ✓
- §10 设置项 → Task 11 ✓
- §11 错误处理 → Task 12 (各 catch + fallback) + Task 8/10 (warnings) ✓
- §12 测试 → 每任务内嵌 TDD + Task 13 手动 ✓
- §13 边界 → usePasteConvert 的 `looksRich`、`TYPST_MARK`、shiftKey guard ✓
- §14 分阶段 → Task 2-9 (P1+P2) / Task 10-12 (P3) / 测试贯穿 ✓

**Placeholder 扫描**：Task 10 Step 4 注释了 reqwest timeout 变体的不确定——已指示实现者按编译器修正，可接受。无 TBD/TODO。

**类型一致性**：`ConvertContext`/`PendingImage`/`ConvertResult` 在 Task 3 定义，Task 4/5/6/9/12 消费——字段名一致。`expandTemplate` 签名 Task 2 定义、Task 12 消费一致。`fetch_url_to_file` Rust Task 10 / TS Task 12 一致。

**发现并修正**：Task 12 Step 5 的 `tabRef` 与 `tabIdRef` 区分（已 inline 修正说明）。`tables.ts` 在 Task 6 stub、Task 7 替换——blocks.ts import 闭合（Task 6 Step 1 建 stub）。无悬空引用。
