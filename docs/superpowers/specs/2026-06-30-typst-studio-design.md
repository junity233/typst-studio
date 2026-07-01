# Typst Studio — 双栏可视化编辑器设计文档

> **状态**：MVP 已实现。下方为原始设计；末尾「实现笔记」记录所有偏离与演进。
> **日期**：2026-06-30（设计）/ 2026-07-01（实现完成）
> **项目目录**：`/Users/junity/code/typst-studio`

---

## 1. 项目概述

构建一个 Typst 双栏可视化编辑器：左侧 Monaco 代码编辑器，右侧实时 SVG 预览。基于 Tauri 2.x（Rust 后端）+ React/TypeScript（前端），Typst 编译器以官方 crate 形式嵌入 Rust 后端。

**核心价值**：桌面端原生性能的 Typst 编辑体验，实时预览毫秒级响应，100% 与 typst 官方保持一致。

---

## 2. 关键技术决策（含调研依据）

### 2.1 编辑器形态：代码 + 预览 分屏
左侧 Typst 源码编辑（Monaco），右侧实时渲染的 SVG 预览。类似 typst.app / VS Code + Tinymist 预览，最经典且在 Tauri 上最易做好。

### 2.2 Typst 集成方式：官方 crate 嵌入（非 CLI、非 WASM）

**调研结论（基于 typst 0.15.0 实测）**：
- `typst watch` 的 stdin/stdout 流式模式**不存在**：stdin 作为 input 时 typst 警告 "cannot watch changes for stdin"；stdout 作为 output 时报错 "cannot write document to stdout in watch mode"。
- typst CLI 的 `-` (stdin/stdout) 只支持一次性 `compile`，不适合实时编辑器（每次重启进程，丢增量缓存）。
- **结论**：将 typst 作为 Rust crate 编译进 Tauri 后端。EditorWorld 实例长期存活，comemo 增量编译缓存常驻，毫秒级响应。

### 2.3 渲染方案：全量 SVG + 官方 crate

**核查结论（基于 typst-svg 源码）**：typst 官方 crate（`typst-svg`）**不提供增量 diff 能力**。其 API 仅 `svg(page) -> String` 全量输出。"增量 diff" 是社区项目 reflexo/typst.ts 另加的一层（落后官方 1-2 版本）。

在「100% 官方一致性」与「sub-page 增量 diff 性能」之间，**选择官方一致性**：用 `typst-svg` 全量每页 SVG。端到端延迟预计 10-30ms（编译增量已由 comemo 保证，渲染+传输仅几毫秒），远低于人类感知阈值。

| 组件 | 选型 | 血统 |
|---|---|---|
| 编译器 | `typst` crate | 官方 |
| SVG 渲染 | `typst-svg` crate | 官方 |
| PDF 导出 | `typst-pdf` crate | 官方 |
| PNG 导出 | `typst-render` crate | 官方 |
| 字体/包 | `typst-kit` crate | 官方 |

### 2.4 其余决策
- **前端**：React 19 + TypeScript（编辑器组件生态成熟）
- **编辑器组件**：Monaco（VS Code 同款，桌面端体验最佳；typst 语法用 Monarch tokenizer 自接）
- **编译触发**：前端防抖 100ms + 后端单工作线程零延迟响应（详见实现笔记 §2）
- **SVG 显示**：blob URL `<img>`（异步解码，不阻塞主线程；代价是预览不可选文字）
- **错误展示**：Monaco 波浪线 + 可折叠错误面板 + 状态栏
- **保存**：手动 Cmd/Ctrl+S（内存常驻编译，手动才写盘）
- **布局**：Allotment 可拖动分割条
- **状态管理**：Zustand（tabsStore + diagnosticsStore）
- **类型同步**：ts-rs 自动生成 Rust → TypeScript 类型
- **多标签页**：每 tab 独立 EditorWorld + CompileWorker

---

## 3. 技术栈

| 层 | 选型 |
|---|---|
| 应用框架 | Tauri 2.x |
| 后端 | Rust（typst 0.15 官方 crate） |
| 前端 | React 19 + TypeScript + Vite |
| 编辑器 | Monaco Editor (`@monaco-editor/react`) |
| Typst | 官方 crate（typst, typst-svg, typst-pdf, typst-render, typst-kit, typst-layout） |
| 分割条 | Allotment |
| 状态管理 | Zustand |
| 类型同步 | ts-rs（Rust → TypeScript 自动生成） |
| 异步运行时 | Tokio（rt-multi-thread）|

---

## 4. 整体架构与数据流

```
┌─ Webview (React) ───────────────────────────────────────────┐
│  Monaco onChange → 防抖100ms → invoke(update_text)           │
│       ▲                                                      │
│       │ listen("compiled", pages[])  → blob URL <img> 渲染   │
│       │ listen("diagnostics", errs[]) → Monaco markers       │
│       │ listen("status", state)       → 状态栏               │
│       │ (compiled 包裹在 startTransition 中, 低优先级)         │
└───────┼──────────────────────────────────────────────────────┘
        │  Tauri IPC (全 async, spawn_blocking 包裹 IO)
┌───────┴──────────────────────────────────────────────────────┐
│  Rust 后端                                                    │
│                                                               │
│  EditorService (编排核心)                                      │
│   ├─ tabs: HashMap<DocumentId, Arc<TabState>>                 │
│   │   TabState { world: EditorWorld,  ← 不在 Mutex 里         │
│   │              state: Mutex<TabRuntime> }  ← 短锁           │
│   ├─ workers: HashMap<DocumentId, CompileWorker>              │
│   │   CompileWorker: 单线程, 128MB 栈, channel 信号           │
│   │   ├─ 信号合并: 连续 N 次按键 → 1 次编译                    │
│   │   ├─ 编译期间零 tab 级锁 (world 有自己的 RwLock<Source>)   │
│   │   └─ text_before ≠ text_after → 跳过 SVG 渲染             │
│   └─ ExportService: render_pdf/png → bytes (IO 在 command 层) │
│                                                               │
│  EditorWorld (per-tab, 长期存活)                               │
│   ├─ Source::replace 增量重解析 → comemo 节点身份保持          │
│   ├─ typst::compile::<PagedDocument>(&world) [comemo 增量]    │
│   └─ SvgRenderer 每页 svg() → emit("compiled")               │
└───────────────────────────────────────────────────────────────┘
```

**一次按键的完整旅程**：
```
输入字符 → React onChange → 防抖100ms
  → invoke("update_text", {content})      [async command]
  → world.set_text(content)               [RwLock write, ~μs]
  → worker.recompile()                    [channel send, ~μs]
  → CompileWorker 收到信号
    → compile(&world)  [comemo 增量, ~5-50ms, 零 tab 锁]
    → text 未变?
      → 是: SvgRenderer.render → emit("compiled")
      → 否: 跳过渲染, worker 立即重编译最新文本
  → 失败: emit("diagnostics") → Monaco 波浪线 + 错误面板
```

**延迟预算**：100ms(前端防抖) + 1ms(IPC) + 0ms(worker响应) + 5-50ms(编译) + 5-20ms(SVG) ≈ **111-171ms**

---

## 5. 后端模块设计（分层 + 可扩展）

### 5.1 设计原则
1. **分层**：domain（领域）→ typst_engine（引擎）→ service（编排）→ ipc（对外），每层只依赖下层
2. **面向接口**：SourceProvider / RenderPipeline / LanguageService / Project / ConfigStore 均 trait 抽象，新增实现不改调用方
3. **State 组合**：各 Service 独立管理状态，组合进 AppState

### 5.2 目录结构
```
src-tauri/src/
├── main.rs                      # bootstrap
├── lib.rs                       # 库入口 + Tauri Builder 配置
├── error.rs                     # AppError + Result 别名
│
├── domain/                      # 领域层：纯数据，无 IO
│   ├── document.rs              # DocumentId (UUID), DocumentMeta
│   ├── diagnostics.rs           # Diagnostic, Severity, Range
│   └── compile_result.rs        # CompileOutcome
│
├── typst_engine/                # Typst 引擎层
│   ├── world.rs                 # ★ EditorWorld: impl typst::World
│   ├── compiler.rs              # compile(&EditorWorld) + 诊断转换
│   ├── source_provider.rs       # trait SourceProvider + InMemorySource
│   └── font_loader.rs           # trait FontLoader + SystemFontLoader
│
├── render/                      # 渲染层
│   ├── pipeline.rs              # trait RenderPipeline
│   ├── svg.rs / pdf.rs / png.rs # 三种 renderer
│
├── service/                     # 服务编排层
│   ├── editor_service.rs        # ★ EditorService: 多 tab + worker 管理
│   ├── compile_worker.rs        # ★ CompileWorker: 单线程编译循环
│   ├── export_service.rs        # PDF/PNG 渲染 (不含 IO)
│   └── tab_state.rs             # TabState (world + Mutex<TabRuntime>)
│
├── ipc/                         # IPC 层
│   ├── commands.rs              # #[tauri::command] (全 async)
│   ├── events.rs                # 事件 payload + CompileStatus + OpenedDocument
│   └── state.rs                 # AppState + TauriEmitter
│
├── project/                     # 项目层（MVP stub）
├── languageserver/              # LSP 层（MVP NoopLs stub）
└── settings/                    # 配置层（MVP stub）
```

### 5.3 三个关键可扩展 trait
```rust
// ① 源码来源（MVP 内存 → 未来磁盘多文件）
trait SourceProvider: Send + Sync {
    fn main_source(&self) -> FileResult<Source>;
    fn file(&self, id: FileId) -> FileResult<Bytes>;
}

// ② 渲染管线（全量SVG/PDF/PNG → 未来增量diff/HTML）
trait RenderPipeline {
    type Output;
    fn render(&self, doc: &Document) -> Self::Output;
}

// ③ 语言服务（MVP 空实现 → 未来 typst-ide/tinymist）
trait LanguageService: Send + Sync {
    fn completions(&self, pos: Position) -> Vec<Completion>;
    fn goto_definition(&self, pos: Position) -> Option<Range>;
}
```

### 5.4 扩展映射表
| 扩展方向 | 改动范围 | 不变（隔离） |
|---|---|---|
| 多文件项目管理 | `project/` 新增 DirectoryProject + FileSystemSource | compiler/renderer/domain |
| LSP 语言服务 | `languageserver/` 新增 TypstIdeLs | compiler/World/ipc |
| 设置配置 | `settings/` 扩展 AppConfig + ConfigStore | 核心编译逻辑 |
| 多渲染格式 | `render/` 新增 impl RenderPipeline | compiler/editor_service |

---

## 6. 前端模块设计

```
src/
├── App.tsx                       # 根布局：TitleBar + TabStrip + SplitPane + Diagnostics + StatusBar
├── components/
│   ├── SplitPane/SplitPane.tsx   # Allotment 封装（可拖动分割条）
│   ├── TitleBar/
│   │   ├── TitleBar.tsx          # 菜单：Open / Save / Export PDF|PNG
│   │   └── TabStrip.tsx          # 多标签页（dirty 点 + 关闭按钮）
│   ├── Editor/
│   │   ├── MonacoEditor.tsx      # @monaco-editor/react 封装，每 tab 一个 model
│   │   ├── typstLanguage.ts      # Monarch tokenizer + typst-light 主题
│   │   └── diagnostics.ts        # Diagnostic → IMarkerData 转换
│   ├── Preview/
│   │   ├── PreviewPane.tsx       # 预览容器
│   │   └── SvgPage.tsx           # blob URL <img> + memo（异步解码）
│   ├── Diagnostics/
│   │   └── DiagnosticsPanel.tsx  # 可折叠错误面板（点击跳转）
│   └── StatusBar/
│       └── StatusBar.tsx         # 编译状态 + 错误计数
├── hooks/
│   ├── useTypstCompile.ts        # 事件订阅 (startTransition 包裹预览更新)
│   └── useDebounce.ts            # useDebouncedCallback (100ms)
├── store/
│   ├── tabsStore.ts              # Zustand: tabs + activeId + svgPages
│   └── diagnosticsStore.ts       # Zustand: Map<DocumentId, Diagnostic[]>
├── lib/
│   ├── tauri.ts                  # invoke/listen 封装
│   ├── types.ts                  # ts-rs 自动生成（勿手改）
│   └── ui-types.ts               # 前端专有类型 (CompiledPayload 等)
└── styles/
    └── global.css                # Apple 设计系统（浅色主题）
```

---

## 7. MVP 功能清单与验收标准

| # | 功能 | 验收标准 |
|---|---|---|
| 1 | 打开 .typ 文件 | Cmd/Ctrl+O → 文件对话框 → 内容载入 Monaco |
| 2 | 编辑 + 实时预览 | 输入后 ~150ms → 右侧 SVG 预览更新（100ms 防抖 + ~50ms 编译渲染） |
| 3 | 保存文件 | Cmd/Ctrl+S → 写回磁盘 |
| 4 | 错误高亮 | typst 错误 → Monaco 波浪线 |
| 5 | 错误面板 | 列出所有诊断，点击跳转对应行 |
| 6 | 导出 PDF | Cmd/Ctrl+Shift+E → typst-pdf 生成 |
| 7 | 导出 PNG | 菜单 → typst-render 每页 PNG |
| 8 | 状态栏 | 显示编译中/Xms/N个错误 |
| 9 | 可拖动分栏 | 拖分割条调整宽度，可隐藏一侧 |
| 10 | 系统字体 | typst-kit 自动加载系统字体 |

### 明确排除（后续迭代）
- ❌ 多文件项目 UI（MVP 禁用 `#include`，World 的 `file()` 返回 Err）
- ❌ 语法补全/跳转（LSP）
- ❌ 自定义包/字体管理 UI
- ❌ 预览文字选择（blob URL `<img>` 不支持；未来可加透明文字层）
- ❌ 增量 SVG diff（未来如需极致性能再上 typst-ts）

---

## 8. 风险与对策

| 风险 | 对策 | 状态 |
|---|---|---|
| `World` trait 实现复杂 | 参考 typst-cli 的 SystemWorld + typst-kit FontStore | ✅ 已解决 |
| typst crate 版本 API 变动 | pin typst 0.15；集成测试覆盖 compile + svg + pdf | ✅ 已解决 |
| Monaco 体积大(~5MB) | Tauri 打包后桌面端可接受 | ✅ 可接受 |
| 长文档递归栈溢出 | typst `eval_markup` 递归 766 层溢出 2MB 默认栈 → 编译线程 128MB 栈 | ✅ 已解决 |
| 多 tab comemo 缓存隔离 | 每 tab 独立 EditorWorld，编译结果互不污染 | ✅ 已验证（测试覆盖） |
| sync command 阻塞主线程 | 所有 IO 命令改 async + spawn_blocking | ✅ 已解决 |
| 编辑卡顿（锁竞争） | TabState 拆锁：world 移出 Mutex，编译零 tab 锁 | ✅ 已解决 |
| 前端 SVG DOM 插入阻塞 | blob URL `<img>` 异步解码 + useTransition | ✅ 已解决 |
| `#include` 在 MVP 中 | 禁用（file() 返回 Err），trait 保留 | ✅ 按设计 |
| comemo 缓存随 tab 关闭泄漏 | 暂不清理（MVP 可接受），未来加 evict | ⚠️ 已知 |

---

## 9. 实现笔记（Implementation Notes）

> 以下记录实现过程中偏离原始设计的决策及原因。

### 9.1 typst 0.15 架构变化

原设计假设 typst 0.13.x，实际使用 0.15.0。关键差异：

- **`typst::model::Document` 变为 trait**：0.15 将可渲染文档类型拆到 `typst_layout::PagedDocument`。`typst::compile::<PagedDocument>(world)` 需要显式指定类型参数。
- **`typst::World` trait 签名变化**：`main()` 返回 `FileId`（非 `Source`）；`book()`/`library()` 返回 `&LazyHash<_>`（非 `Prehashed`）；`today()` 接受 `Option<Duration>` 参数。
- **`typst-kit` 无 `Fonts::builder()`**：改用 `FontStore::new()` + `extend(embedded() ∪ system())`。
- **新增 `typst-layout` crate 依赖**：`PagedDocument` / `Page` 类型在此 crate 中定义，需显式声明依赖。

### 9.2 编译流水线演进：防抖调度 → 单工作线程

**初始设计**：`CompileScheduler` 每次防抖后 spawn 一个新的 `spawn_blocking` 线程。

**问题**：
1. 快速打字时多个编译线程并行竞争 CPU
2. 长文档编译期间（~500ms），新编辑仍需等旧编译完成 + 80ms 防抖才能编译
3. `spawn_blocking` 默认 2MB 栈 → 长文档 `eval_markup` 递归 766 层 → 栈溢出崩溃

**最终方案**：`CompileWorker`（`service/compile_worker.rs`）——每个 tab 一个长生命周期线程：

- **128MB 栈**：覆盖 typst 递归求值器
- **channel 信号**：编辑时 `set_text`（即时写 world 的 RwLock）+ `recompile()`（非阻塞 channel send）
- **信号合并**：编译期间 N 次按键的信号在 channel 中排队，编译完成后一次性 drain → 只编译最新文本
- **零防抖延迟**：编译完成后立即重编译（不再等 80ms 防抖）
- **不可中断但无浪费**：Rust 无法安全杀死线程，但旧编译结果通过 `text_before ≠ text_after` 检查完全丢弃（不 emit）

### 9.3 TabState 锁分离

**初始设计**：`Arc<Mutex<TabState>>` 全量锁。

**问题**：编译持有 Mutex 30-500ms 期间，`update_text` 在 async 线程上阻塞等同一个锁 → 编辑卡顿。

**最终方案**：
```rust
pub struct TabState {
    pub world: EditorWorld,              // 不在 Mutex 内！有自己的 RwLock<Source>
    pub state: Mutex<TabRuntime>,        // meta + last_doc + last_outcome（短锁）
}
```

编译全程零 tab 级锁：`compile(&tab.world)` 只触碰 world 内部的 `RwLock<Source>`（μs 级克隆）。结果存储在 `Mutex<TabRuntime>` 中（μs 级写入）。

### 9.4 IPC 命令全异步化

**初始设计**：sync `#[tauri::command] fn`。

**问题**：Tauri 2 的 sync command 跑在**主线程**。`blocking_pick_file()` 阻塞到用户点对话框 → webview 死锁。

**最终方案**：所有含 IO/对话框的命令改为 `async fn`，对话框用 `spawn_blocking(blocking_pick_file)`（阻塞在 worker 线程而非主线程），文件 IO 同理。Service 层变为纯逻辑零 IO。

### 9.5 SVG 渲染：inline DOM → blob URL `<img>`

**初始设计**：`dangerouslySetInnerHTML` 内联 SVG。

**问题**：大文档（几十页）编译完成后，浏览器必须**同步**解析 SVG XML + 构建 DOM 树 + 布局，阻塞 Monaco 按键处理 50-500ms。

**最终方案**：
- `SvgPage` 组件用 `Blob` + `URL.createObjectURL` 生成 blob URL，通过 `<img src>` 渲染
- 浏览器在**独立线程**异步解码图片，主线程只换 `img.src`（μs 级）
- `memo` 包裹：打字时 svgPages 不变 → 页面不重渲染
- `useTransition` 包裹 `setPages`：React 把预览更新标为低优先级

**代价**：预览不可选文字（bitmap 而非 DOM）。MVP 可接受。

### 9.6 typst-svg API 变化

0.15 的 `typst_svg::svg(page, &SvgOptions) -> String` 接受 options 参数（非旧的无参版本）。`typst_pdf::pdf(doc, &PdfOptions)` 同理返回 `SourceResult`。

### 9.7 `time` crate 版本锁定

`time 0.3.39+` 的 `Parsable::parse` 新增了必需的 `defaults` 参数，与 `cookie 0.18.1`（Tauri 的传递依赖）不兼容。Cargo.toml 中 pin `time = "=0.3.36"`。

### 9.8 tauri-plugin-dialog API

Tauri 2 的 `pick_file()` 是 callback-based（非 async/await）。实际使用 `spawn_blocking(blocking_pick_file)` 模式：阻塞调用在 worker 线程，主线程的 webview 事件循环不受影响。
