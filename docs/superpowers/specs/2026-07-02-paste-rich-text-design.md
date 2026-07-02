# Typst Studio — 粘贴富文本自动转 Typst 设计

> **状态**：设计已确认，待实现。
> **日期**：2026-07-02
> **项目目录**：`/Users/junity/code/typst-studio`
> **依赖**：复用既有 Monaco 编辑器（`src/components/Editor/MonacoEditor.tsx`）、设置系统（`src-tauri/settings/manifest.json` + `useSetting` hook）、文件系统命令（`src-tauri/src/ipc/fs_commands.rs`）。

---

## 1. 目标

为 Monaco 编辑器加入 Cmd/Ctrl+V 粘贴时**自动把富文本（HTML）转为 Typst 源码**的能力：

- **来源**：网页/浏览器复制（语义化 HTML）+ Microsoft Word/Excel（含 `mso-` 私有样式的脏乱 HTML）。
- **元素**：内联格式、标题/段落/列表、表格、图片（落盘嵌入）、代码块/引用。
- **交互**：静默自动转换；Cmd/Ctrl+Shift+V 退回原生粘贴（escape hatch）。
- **失败回退**：转换失败或无 `text/html` 时不拦截，走原生粘贴。

**明确排除**：Google Docs / Notion / 飞书 等自研富文本格式的专门适配（HTML 通用解析覆盖即可，不做针对性优化）；粘贴纯 Markdown 文本的转换（用户暂不需要）。

---

## 2. 关键技术决策

### 2.1 架构：混合方案（前端转换 + 后端 net 模块）

**背景**：转换器可放前端（TS + DOMParser）或后端（Rust + scraper）。

**决策**：混合方案 C——转换逻辑、宏展开都在前端；后端只新增一个可复用的 `net` 模块处理远程图片下载。

| 方面 | 选型 |
|---|---|
| HTML 解析 | 浏览器原生 `DOMParser`（前端） |
| 转换器位置 | 前端 `src/lib/htmlToTypst/`（纯函数） |
| 宏引擎位置 | 前端 `src/lib/pathMacros/`（纯函数） |
| 远程图片下载 | 后端 `src-tauri/src/net/`（基于 `reqwest`，可复用） |
| 本地图片写入 | 复用既有 Tauri fs 命令（`writeBinaryFile`） |

**理由**：
- Monaco 在前端、剪贴板到达前端、路径宏所有输入（workspace/filePath）都在前端 store——零 IPC 往返。
- 浏览器 `DOMParser` 对 HTML 解析足够强；Word 清洗是纯 DOM 变换，无 Rust 优势。
- 不引入 `html5ever`/`scraper` 这类重 Rust 依赖（~2MB 编译时间）。
- 远程图片用纯前端在 Tauri webview 内基本走不通（CSP 跨域限制），必须经后端——这是方案 A 升级到 C 的唯一增量。

### 2.2 编辑器插入：一律走 `editor.executeEdits`

**决策**：转换后的 Typst 文本通过 `editor.executeEdits("paste-convert", [{ range: sel, text }])` 插入，绝不用 `model.setValue`。

**理由**（依据既有代码 `MonacoEditor.tsx:210-221, 264-269` 的实践）：
- `executeEdits` 保留 undo 历史（用户可 Cmd+Z 撤销整次粘贴转换）。
- 自动触发 Monaco `onChange` → 100ms debounce 的 `updateText` IPC → 后端编译器（SVG 预览 + status）。
- 自动触发 `monaco-languageclient` 的 `textDocument/didChange` → tinymist（诊断 + 补全 + hover）。
- 两条下游管线天然接收，无需任何特殊接线。

### 2.3 粘贴事件接入：capture-phase document 监听

**决策**：在 `MonacoEditor.tsx` 的 mount effect 里注册 `document.addEventListener("paste", handler, true)`（capture 阶段），镜像既有 `useAppCommands.ts:42-56` 的 Cmd+S 拦截模式。

**理由**：
- capture 阶段抢在 Monaco 内部 paste 处理之前；`preventDefault()` 后原生菜单的 `PredefinedMenuItem::paste`（`menu.rs:84`）也被拦截——单一代码路径。
- 不需要 Monaco 命令注册（项目当前无 `editor.addCommand` 先例，capture 监听更轻、跨 tab 共享编辑器实例更简单）。

### 2.4 单次插入流水线（非"先插入后落盘"）

**决策**：所有图片解析完成后再一次性 `executeEdits`，避免二次修补。

**理由**：远程图片失败时需回退到原 URL——若先插入本地路径、失败后再 fixup，undo 栈与编辑历史会变脏。单次插入把图片解析全部前置，文本一次落地。

**取舍**：插入会等图片就绪。但纯文本粘贴零等待；`data:` 图片毫秒级；仅多张远程图有延迟（状态栏显示「下载 N 张图片…」）。

### 2.5 宏引擎：独立可复用纯函数模块

**决策**：路径模板的宏替换抽象为 `src/lib/pathMacros/`，独立于粘贴功能。

**理由**：未来 `export.pdfPath`、`session.snapshotPath`、snippet 模板变量都能复用同一套。约 40 行纯函数，但写好测试覆盖。本次仅前端实现（所有输入都在前端 store）。

---

## 3. 模块布局

```
src/lib/
├── htmlToTypst/
│   ├── index.ts          # 主入口 htmlToTypst(html, ctx) → ConvertResult
│   ├── wordCleanup.ts    # 剥 mso-/条件注释/<o:p>/重建 Word 伪列表（幂等）
│   ├── inline.ts         # <b>/<strong> → *..* 等内联映射
│   ├── blocks.ts         # <h1-6> → =, <ul>/<ol> → -/+, <p>, <pre>, <blockquote>
│   ├── tables.ts         # <table> → #table(columns: N, ...)
│   ├── images.ts         # 收集 <img> → 占位符 + pendingImages
│   ├── escape.ts         # Typst 特殊字符转义
│   └── types.ts          # ConvertResult / PendingImage / ConvertContext
├── pathMacros/
│   ├── index.ts          # expandTemplate(tpl, ctx) → string（纯函数）
│   └── types.ts          # MacroContext
src/components/Editor/
└── MonacoEditor.tsx      # 新增 paste 监听 + insertTypst() API 扩展
src-tauri/src/net/
├── mod.rs                # 模块导出
├── client.rs             # HttpClient 封装：超时/重定向/大小上限
├── fetch.rs              # fetch_to_file(url, dest, opts) / fetch_bytes(url, opts)
└── error.rs              # NetError
src-tauri/src/ipc/
└── net_commands.rs       # fetch_url_to_file Tauri 命令
```

---

## 4. 数据结构

```ts
// src/lib/htmlToTypst/types.ts

/** 转换器主输出 */
export interface ConvertResult {
  /** 主 Typst 文本（含 #image() 占位） */
  typst: string;
  /** 待解析的图片清单（占位符尚未替换为最终路径） */
  pendingImages: PendingImage[];
  /** 转换过程中的非致命警告 */
  warnings: string[];
}

/** 转换器输入上下文 */
export interface ConvertContext {
  /** 当前工作区根目录绝对路径（无工作区时 undefined） */
  workspace?: string;
  /** 当前文件绝对路径（未保存 tab 时 undefined） */
  filePath?: string;
  /** 图片路径模板，如 "${fileDir}/assets/pasted-${hash}.${ext}" */
  imageTemplate: string;
  /** 是否下载远程图片（false 时远程 URL 直接保留） */
  fetchRemote: boolean;
}

/** 单张待解析图片 */
export interface PendingImage {
  /** 在 typst 文本中的占位符，形如 `\u0000IMG0\u0000` */
  placeholder: string;
  /** 原始 src：data: 或 http(s): */
  src: string;
  /** <img alt> 文本，可选 */
  alt?: string;
  /** 同次粘贴内的序号（0 起），用于 ${index} 宏 */
  index: number;
}

/** paste handler 解析完每张图后用于替换占位符 */
export interface ResolvedImage {
  /** 占位符（与 PendingImage.placeholder 对应） */
  placeholder: string;
  /** 最终用于 #image() 的路径或 URL */
  finalSrc: string;
  /** 是否成功落盘到本地 */
  written: boolean;
  /** 落盘时的绝对路径（written=true 时有值） */
  resolvedPath?: string;
}
```

---

## 5. 粘贴流水线

```
paste 事件 (capture phase)
  │
  ├─ Cmd/Ctrl+Shift+V              → 不拦截（escape hatch，原生粘贴）
  ├─ 无 text/html                  → 不拦截（纯文本路径）
  ├─ editor.pasteConvertRichText=false → 不拦截
  ├─ text/plain 已是合法 Typst      → 不拦截（见 §10.4 启发式）
  │
  ├─ preventDefault()
  ├─ const cleaned = wordCleanup(html)              # 幂等
  ├─ const { typst, pendingImages, warnings } =
  │     htmlToTypst(cleaned, ctx)
  ├─ 状态栏：「正在处理 N 张图片…」
  ├─ 并行解析每张 pendingImage（Promise.all）：
  │     • data:image/...;base64,... → atob → Uint8Array → 算 hash
  │         → expandTemplate(imageTemplate, ctx) → resolvedPath
  │         → exists? hash 相同 → 跳过；不同 → -2/-3 后缀
  │         → writeBinaryFile(resolvedPath, bytes)
  │         → 成功: finalSrc = resolvedPath
  │     • http(s)://... 且 fetchRemote=true
  │         → expandTemplate → resolvedPath
  │         → invoke("fetch_url_to_file", { url, dest: resolvedPath })
  │         → 成功: finalSrc = resolvedPath
  │         → 失败: finalSrc = 原 URL + warning
  │     • http(s)://... 且 fetchRemote=false
  │         → finalSrc = 原 URL（不下载）
  ├─ 占位符替换：typst 中 \u0000IMGi\u0000 → #image("finalSrc_i")
  ├─ editor.executeEdits("paste-convert", [{ range: selection, text: typst }])
  └─ warnings 非空 → 状态栏「粘贴转换：N 个警告」（详情 console.warn）
```

### 5.1 未保存 tab 的 fallback 链

`${fileDir}` 宏在未保存 tab 时无值：

1. 工作区已开 → 用 `${workspace}/assets/pasted-${hash}.${ext}`
2. 都没有 → 用后端 tempdir 命令获取 OS temp 目录
3. 状态栏提示「图片存入临时目录，保存文档后建议迁移」

> MVP 不做「保存文档后自动迁移临时图片」——超出本次范围。

---

## 6. HTML→Typst 映射规则

### 6.1 Word/Excel 清洗（`wordCleanup.ts`，幂等）

干净 HTML 直通，仅对 Word 输出做处理。**检测启发式**：HTML 含 `<meta name="ProgId" content="Word.Document">` 或 `mso-` 子串 → 走完整清洗。

按序执行：

1. **剥条件注释**：`<!--[if gte mso ...]>...<![endif]-->` 整段移除（含 `<![if !mso]>`/`<![endif]>`）。
2. **剥 Office 标签**：移除所有 `<o:p>`、`<w:*>`、`<v:*>`、`<m:*>`、`<st1:*>` 命名空间标签（保留内部文本）。
3. **剥 mso 样式**：`style` 属性里删除所有 `mso-*` 属性；删除 `class="Mso*"`、`class="MsoListParagraph*"` 类名。
4. **Word 伪列表重建**（最关键）：Word 不用语义化 `<ul>/<ol>`，而是 `<p class="MsoListParagraph">` 配合：
   - `mso-list: l0 level1 lfo0`（藏在 style 里）→ 提取 level 作为缩进层级。
   - 或段落开头是符号字符（`·`、`o`、`§`、`▪`、Wingdings 字符）→ 识别为无序/有序。
   - 重建为真正的 `<ul>/<ol>` + 嵌套 `<li>`，交给后续 `blocks.ts` 处理。
5. **Word 表格清理**：剥 `<table>` 的 `border/cellpadding/cellspacing/style`、单元格的 `class="MsoNormal"`、空 `<p class="MsoNormal">` 占位（仅含 `<br>` 或空白）。
6. **HTML 实体规范化**：`&nbsp;`、`&hellip;`、smart quotes（`"`/`"`/`'`/`'`）、`–`/`—` 映射到对应字符。

### 6.2 内联格式（`inline.ts`）

| HTML | Typst | 备注 |
|---|---|---|
| `<b>` `<strong>` | `*text*` | Typst emphasis |
| `<i>` `<em>` | `_text_` | |
| `<u>` | `#underline[text]` | Typst 无下划线语法，用函数 |
| `<s>` `<del>` `<strike>` | `#strike[text]` | |
| `<code>` | `` `code` `` | 反引号 |
| `<mark>` | `#highlight[text]` | |
| `<sub>` | `#sub text` | |
| `<sup>` | `#super text` | |
| `<a href="X">t</a>` | `#link("X")[t]` | href 与文本相同 → `#link("X")` |
| `<br>` | `\` + 换行 | Typst 软换行 |
| `<span style="...">` | 视样式而定 | 仅识别 `font-weight:bold/italic`、`text-decoration`、`vertical-align:super/sub`；其他 style 忽略 |

**嵌套处理**：DOM 递归，子节点按序输出。`<b><i>x</i></b>` → `*_x_*`。

### 6.3 块级元素（`blocks.ts`）

| HTML | Typst |
|---|---|
| `<h1>`..`<h6>` | `= Heading` / `== Heading` / ... |
| `<p>` | 文本 + 空行（空行分隔段落） |
| `<ul><li>` | `- item`（嵌套靠缩进 2 空格） |
| `<ol><li>` | `+ item`（Typst 自动编号） |
| `<blockquote>` | `#quote[ ... ]` |
| `<pre>` | ` ```lang\n...\n``` `（lang 从 `<code class="language-X">` 提取） |
| `<hr>` | `#line(length: 100%)` |

列表嵌套由 DOM 树深度决定缩进层级；Word 重建出来的列表已是正确结构。

### 6.4 表格（`tables.ts`，最复杂）

- **列数推断**：扫描所有行，取最大单元格数；`colspan` 展开为 N 个等价格。
- **合并单元格**：Typst `#table()` 原生不支持 `colspan`/`rowspan`。MVP 策略：
  - `colspan=N` → 第一格填内容、其余空格。
  - `rowspan=N` → 拍平（后续行少一格对齐），`warnings` 记录。
- **表头**：`<th>` 或首行用 `table.header(..cells)` 包裹（Typst 0.15 API）。
- **单元格内递归**：每个 `[cell]` 内部递归走 `inline.ts`（保留粗体/链接等）；含块级（`<p>`/`<ul>`）的单元格用 `[#text]` 形式。

**输出模板**：
```
#table(
  columns: N,
  align: center,
  table.header([A], [B], [C]),
  [1], [2], [3],
)
```

### 6.5 转义规则（`escape.ts`）

- 仅转义「文本」节点的内容（属性、标签名不处理）。
- 需转义字符：`\ * _ ` [ ] $ # @ ~`
- 反引号代码块内容、`#raw()` 内**不转义**。
- 反斜杠转义：`\*` `\#` `\_` 等。

---

## 7. 宏引擎（`pathMacros/`）

```ts
// src/lib/pathMacros/types.ts
export interface MacroContext {
  workspace?: string;     // 工作区根目录绝对路径
  fileDir?: string;       // 当前文件所在目录绝对路径
  fileName?: string;      // 当前文件名（不带扩展名）
  filePath?: string;      // 当前文件绝对路径
  hash?: string;          // 内容短哈希（12 位 sha1）
  ext?: string;           // 文件扩展名（png/jpg/svg/gif/webp）
  timestamp?: string;     // ISO 8601 日期（YYYYMMDD）
  index?: number;         // 同次粘贴内的图片序号（0 起）
}

// src/lib/pathMacros/index.ts
export interface ExpandOptions {
  /** 未知宏的行为，默认 "keep" */
  unknown?: "keep" | "drop" | "throw";
}

export function expandTemplate(
  template: string,
  ctx: MacroContext,
  options?: ExpandOptions
): string;
```

**支持的语法**：
- `${name}` — 简单替换。
- `${name:default}` — 带默认值：`${fileDir:/tmp}/x.png`。
- `${name?}` — 缺失时抛错（严格模式）。

**规则**：
- 未知宏默认保留原样（`${foo}` → `${foo}`），避免部分上下文导致崩溃。
- `unknown: "throw"` 用于「必须可解析」的场合。
- 转义：`$${...}` 输出字面 `${...}`。
- 仅做字符串替换；绝对化由调用方负责（`path.join(workspace, expanded)`）。

---

## 8. 图片流水线细节

### 8.1 占位符策略

DOM 遍历遇到 `<img>` 时：
1. 读 `src`（data: 或 http(s):）。
2. 读 `alt`（作为 `#image` 的 caption 备选，MVP 不用）。
3. 产出占位符 token `\u0000IMG${index}\u0000` 插入文本流。
4. 推入 `pendingImages[index]`。

最终插入前：把占位符替换为 `#image("finalSrc")`。

### 8.2 扩展名推断

- `data:image/png;base64,...` → `png`
- `data:image/jpeg;base64,...` → `jpg`
- `data:image/svg+xml;base64,...` → `svg`
- `data:image/gif;base64,...` → `gif`
- `data:image/webp;base64,...` → `webp`
- URL 末尾扩展名（`http://x/y.png` → `png`），无扩展名默认 `png`。

### 8.3 去重

写入前 `exists(resolvedPath)`：
- 不存在 → 直接写。
- 存在且内容 hash 相同 → 跳过写入。
- 存在但 hash 不同 → 追加 `-2`、`-3` 后缀直到不冲突。

### 8.4 远程图片失败回退

`fetch_url_to_file` 返回 `NetError` → `finalSrc = 原 URL`，插入 `#image("http://...")`，`warnings` 记录。Typst 编译时会尝试拉取（可能成功也可能失败）——至少保留正确的语义引用。

---

## 9. 后端 net 模块（基于 reqwest，可复用）

```
src-tauri/src/net/
├── mod.rs        # 模块导出
├── client.rs     # HttpClient 封装
├── fetch.rs      # fetch_to_file / fetch_bytes
└── error.rs      # NetError
```

### 9.1 HttpClient

```rust
pub struct HttpClient {
    client: reqwest::Client,
}

pub struct FetchOptions {
    pub timeout: Duration,        // 默认 30s
    pub max_bytes: u64,           // 默认 50MB
    pub follow_redirects: bool,   // 默认 true，最多 10 次
}

impl HttpClient {
    pub fn new() -> Self { /* reqwest::Client::builder() 配置 */ }
    pub async fn fetch_to_file(&self, url: &str, dest: &Path, opts: &FetchOptions) -> Result<u64>;
    pub async fn fetch_bytes(&self, url: &str, opts: &FetchOptions) -> Result<Bytes>;
}
```

**安全**：`dest` 经现有 `FileResolver`/workspace scope 校验，不允许跳出工作区根（除非在 temp dir）。URL scheme 必须 `http`/`https`。

### 9.2 Tauri 命令

```rust
#[tauri::command]
async fn fetch_url_to_file(
    url: String,
    dest: String,
    state: State<'_, AppState>,
) -> Result<u64, AppError> {
    // 校验 dest 在 workspace scope 或 temp 内
    // state.net.fetch_to_file(&url, &Path::new(&dest), &default_opts()).await
}
```

注册到 `lib.rs` 的 `invoke_handler`，并加入 `capabilities/default.json` 的权限。

**可复用**：未来字体下载、包管理、更新检查都能复用 `HttpClient`。

---

## 10. 设置项新增

`src-tauri/settings/manifest.json` 的 `editor` 类目下新增：

```jsonc
{
  "key": "editor.pasteConvertRichText",
  "type": "boolean",
  "default": true,
  "label": "将粘贴的富文本转为 Typst",
  "description": "粘贴来自 Word/网页的富文本时，自动转为 Typst 语法"
},
{
  "key": "editor.pasteImagePath",
  "type": "string",
  "default": "${fileDir}/assets/pasted-${hash}.${ext}",
  "label": "粘贴图片保存路径",
  "description": "支持宏：${workspace} ${fileDir} ${fileName} ${hash} ${ext} ${timestamp} ${index}"
},
{
  "key": "editor.pasteImageFetchRemote",
  "type": "boolean",
  "default": true,
  "label": "粘贴时下载远程图片",
  "description": "对 http(s) 图片，下载到本地；关闭则保留远程 URL"
}
```

设置 UI 自动渲染 boolean toggle 与 string input——无需改 `SettingsApp.tsx`。

---

## 11. 错误处理

| 场景 | 行为 |
|---|---|
| 转换抛异常（DOM 损坏等） | 不 `preventDefault`，退回原生粘贴；`console.error` |
| 某元素无映射规则（如 `<embed>`、`<iframe>`） | 跳过 + warning；不阻塞其余转换 |
| Word 清洗遇异常 | 回退到「未清洗 HTML」继续转换；warning |
| 图片落盘失败（磁盘满/权限） | `finalSrc` 退回原 URL 或 data: 内联；warning |
| 远程图片 fetch 失败 | `finalSrc` = 原 URL；warning |
| 路径宏未知且 `unknown=throw` | 整次粘贴退回原生 + 状态栏报「路径模板错误」 |
| `editor.pasteConvertRichText=false` | 完全跳过，原生粘贴 |
| Cmd/Ctrl+Shift+V | 完全跳过（escape hatch） |
| 无 `text/html` flavor | 完全跳过（纯文本路径） |

状态栏单条消息：`粘贴转换：N 个警告（查看详情）`——详情走 `console.warn`。

---

## 12. 测试策略

### 12.1 单元测试（Vitest——需新增，项目当前无测试脚本）

```
src/lib/htmlToTypst/__tests__/
├── inline.test.ts        # <b>/<i>/嵌套/链接/转义
├── blocks.test.ts        # 标题/段落/列表嵌套/代码块
├── tables.test.ts        # 简单表/colspan/rowspan 拍平/表头
├── wordCleanup.test.ts   # 条件注释/mso- 样式/伪列表重建（用真实 Word 粘贴样本）
├── escape.test.ts        # 特殊字符在各类上下文
└── fixtures/
    ├── word-article.html       # 真实 Word 文档粘贴样本
    ├── word-table.html
    ├── excel-sheet.html
    ├── web-article.html        # 博客/Wikipedia 风格
    └── web-with-images.html

src/lib/pathMacros/__tests__/
├── expand.test.ts        # 简单/默认值/未知宏/转义/严格模式
└── integration.test.ts   # 真实 workspace+filePath 上下文
```

### 12.2 Rust 测试（`cargo test`）

- `net::fetch_to_file` 用 `mockito`（mock HTTP server）测：超时、重定向、大文件截断、非 2xx、协议不允许。

### 12.3 集成测试（手动清单）

- Word 文档（含表格、嵌套列表、图片）粘贴 → Typst 结构正确。
- Excel 表格粘贴 → `#table()` 列数对齐。
- 网页文章（MDN/Wikipedia）粘贴 → 标题层级、链接、代码块正确。
- 未保存 tab 粘贴图片 → 落入 temp 目录 + 状态栏提示。
- Cmd+Shift+V → 原生粘贴。
- 关闭 `pasteConvertRichText` 设置 → 原生粘贴。

---

## 13. 边界情况

- **空剪贴板** / `text/html` 与 `text/plain` 内容相同（纯文本复制带 html flavor）→ 检测：若两者文本一致，按纯文本处理，不做转换。
- **超深嵌套列表**（>6 层）→ 截断到 6 层 + warning。
- **表格单元格里嵌表格** → 内表格退化为文本拼接 + warning（Typst 不支持表中表）。
- **HTML 实体**：`&amp;` `&lt;` `&gt;` `&nbsp;` 全部解码。
- **已是 Typst 文本**：若 `text/plain` 含 `#image(`、`= Heading`、`*text*`、`+ item` 等启发式标志 → 跳过转换，按 `text/plain` 插入。
- **嵌套 `<a>`/`<b>` 互套** → DOM 递归天然处理。
- **远程图片是 SVG** → Typst 支持 `#image("x.svg")`，正常处理。

---

## 14. 分阶段交付

| 阶段 | 范围 | 验收 |
|---|---|---|
| **P1** | 宏引擎 + 内联 + 块级 + 转义（无表格、无图片） | 网页文本粘贴正确 |
| **P2** | Word 清洗（含伪列表重建）+ 表格映射 | Word 文档粘贴结构正确 |
| **P3** | 图片流水线（data: + 远程 + 后端 net 模块）+ 设置项 | Word/网页图片落盘 + `#image()` 正确 |
| **P4** | Vitest 测试套件 + 边界情况 | 全部测试通过 |

---

## 15. 实现笔记（随实现更新）

> 本节记录实现过程中与设计的偏差及原因，类似主设计文档 §9 的做法。

- 待填。
