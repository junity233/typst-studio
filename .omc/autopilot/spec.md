# Typst Studio — Autopilot Spec (Phase 0)

> 来源：`docs/superpowers/specs/2026-06-30-typst-studio-design.md` + 2026-06-30 对齐的 7 项决定。
> 本文件在二者冲突时以**本文件为准**（设计文档相应章节被覆盖）。

## 目标
Tauri 2.x 桌面应用：左侧 Monaco 编辑 Typst 源码，右侧实时 SVG 预览。Typst 编译器以**官方 Rust crate** 形式嵌入后端（非 CLI、非 WASM），追求 100% 官方一致性与毫秒级响应。

## 锁定的 7 项决定（覆盖设计文档）
1. **防抖只在后端。** `CompileScheduler`（300ms）是唯一权威。前端 `onChange → invoke("update_text")`，每键一次 IPC，**前端不做防抖**。（设计文档 §4 数据流图里前端那道防抖作废，已改为后端。）
2. **`#include` / 资源走混合模式。** 主源（Monaco 中编辑的文件）在内存里**原地更新**；其余文件（`#include`、`#image()`）相对**打开文件所在目录**从磁盘解析。MVP 的 SourceProvider 实现命名为 `SingleFileSource`（设计文档里的 `InMemorySource` 命名作废）。无多文件管理 UI。
3. **`@preview` 包：MVP 不支持。** `World::file()` 对包路径返回 `NotFound`，typst 自然报「包未找到」；前端给「包支持即将到来」的友好提示。**不写下载器/缓存逻辑。**
4. **编译失败：保留上一次成功的 SVG**，同时 emit diagnostics + status=error。新建未命名文档即出错 → 预览空 + 错误面板。
5. **Typst crate 版本锁 0.15.0**，且 `typst / typst-svg / typst-pdf / typst-render / typst-kit` 版本必须互配。
6. **comemo 增量的前提**：用 `Source::replace(text)` 原地更新主源、保持 Source 身份不变；**禁止**每键 `new` 一个 Source（否则全量重编、缓存失效）。
7. **导出**：PDF/PNG 输出路径走**另存为对话框**。

## 默认决定（如不对请纠正）
- 除「打开 .typ」外，MVP 支持「新建未命名文档」；未命名时 Cmd+S 走另存为。
- 平台 macOS 优先；Tauri 天然跨平台，字体由 typst-kit 按系统加载。
- `CompileScheduler` 内部**串行化**编译：新调度到来时丢弃未触发的 pending，保证同一时刻只有一个编译在跑（World `&mut` 安全）。

## MVP 验收（精简，详见设计文档 §7）
打开/编辑/保存 .typ；输入 ~300ms 后右侧 SVG 实时更新；错误→Monaco 波浪线 + 可折叠错误面板（点击跳转）+ 状态栏；导出 PDF/PNG；可拖动分栏（可隐藏一侧）；系统字体自动加载。

## 明确排除
多文件项目 UI；LSP 补全/跳转；自定义包/字体管理 UI；增量 SVG diff。

## 后端实现前必须先核验的技术风险
typst 0.15.0 的**确切 API**（World trait 全部方法、`typst::compile` 签名与返回、`Source::detached/replace` 与行列映射、`typst_svg::svg` / `typst_pdf::pdf` / `typst_render::render` 签名、`typst-kit` 字体加载与 book() 接入、各 crate 所需 feature flag）。**写 Rust 前必须对照真实 0.15.0（docs.rs / GitHub tag v0.15.0）确认**，不能凭记忆。Tauri 2.x 的 command/state/event 与 capabilities 体系同理。
