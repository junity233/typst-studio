# Typst Studio — Implementation Plan (Phase 1)

> 每个 Stage 以「绿灯闸门」收尾，红灯不前进。Rust 阶段以 `cargo build`/`cargo test` 为闸门。

## Stage 0 — 环境 ✅
Node 22 / pnpm 10 / Rust 1.96（Homebrew）。Tauri CLI 待以 `@tauri-apps/cli` devDep 引入。

## Stage 1 — 脚手架基线
**目标**：可编译可运行的 Tauri2 + React18 + TS + Vite 空壳。
- pnpm；app name `Typst Studio`，identifier `com.typststudio.app`。
- `src-tauri/`（Cargo.toml、main.rs、lib.rs、build.rs、tauri.conf.json、capabilities）+ Vite/React/TS 前端（src/、index.html、vite.config.ts、tsconfig）+ package.json（dev/build 脚本，`@tauri-apps/cli` devDep）。
- **注意**：项目根已有 `docs/`、`.omc/`，不得删除/移动。
- **闸门**：`pnpm install` ok；`cargo build` ok；`pnpm tauri dev` 能起窗口（后台起、确认无 panic、再 kill）。
- 产出：文件树 + pinned 版本 + Tauri2 配置要点（capabilities、beforeDevCommand、devUrl/frontendDist）。

## Stage 2 — typst crate 接入（去风险）
- 在 `src-tauri/Cargo.toml` 加 `typst=0.15.0` 及 `typst-svg/typst-pdf/typst-render/typst-kit`（版本互配）。
- 处理 feature flag（typst-kit 字体后端等）。
- **闸门**：`cargo build` 带 typst 依赖通过。

## Stage 3 — 后端：domain + engine + render
**前置**：Stage 3 开工前先拿到 typst 0.15.0 API 核验结果（见 spec「必须先核验」）。
- `domain/`：document、diagnostics、compile_result。
- `typst_engine/`：world（impl World，核心）、source_provider（`SingleFileSource`：主源内存 + 其余磁盘）、compiler（compile 编排 + 收集诊断）、font_loader（typst-kit）。
- `render/`：pipeline（trait）、svg（`typst_svg::svg`）、pdf（`typst_pdf::pdf`）、png（`typst_render::render`）。
- **闸门**：单测——compile `#Hello` → 1 页 → svg 非空；pdf 字节非空；失败路径产生诊断。

## Stage 4 — 后端：service + IPC
- `service/`：editor_service（编排）、compile_scheduler（300ms，串行，丢弃 pending）、export_service。
- `ipc/`：commands（update_text / open_file / save_file / export_pdf / export_png / new_file）、events（compiled、diagnostics、status）、state（AppState 组合各 Service）。
- **闸门**：前端桩 invoke `update_text` → 后端 emit `compiled`。

## Stage 5 — 前端
- SplitPane（可拖动、可隐藏一侧）；Monaco（`@monaco-editor/react` + 自接 typst 语法）；diagnostics→IMarkerData 转换。
- PreviewPane + SvgPage（inline SVG，`dangerouslySetInnerHTML`，**失败时保留上次成功 SVG**）；DiagnosticsPanel（点击跳转）；StatusBar。
- hooks：useTypstCompile（invoke + listen）、useDebounce（仅 IPC 轻量节流，不参与编译门控）。
- 打开/保存/导出接线 + 菜单与快捷键（Cmd+O/S/Shift+E 等）。
- **闸门**：完整 MVP 闭环——打字→预览 ~300ms 更新；错误→波浪线；导出 PDF/PNG。

## Stage 6 — QA
`cargo test`、`pnpm build`、手动冒烟（打开样例 .typ、编辑、保存、导出）。修到绿。

## Stage 7 — Validation
architect（功能完整性）、security-reviewer（inline SVG 信任面 / IPC 输入校验）、code-reviewer（质量）。驳回→修→重验。

## 执行注记
- typst 0.15.0 API 核验（Stage 3 前置）与 Stage 1/2 **并行**（document-specialist，只读）。
- 每个 Rust Stage：`cargo build`/`test` 为闸门，红灯不进。
