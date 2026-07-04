# Task 11 — 真正的 Tinymist 验证门（状态：环境受限，已结构化就绪）

> 日期：2026-07-05
> 关联：`docs/superpowers/specs/2026-07-04-single-session-lsp-architecture-design.md` §20.4
> 状态：**待执行**（本会话环境无法运行真实 tinymist / cargo test）

## 背景

Task 11 是 Phase A–D 重构的最终质量门，按 spec §20.4 用**真实 tinymist 二进制**跑 7 项端到端验证。

## 本会话环境限制（为何 Task 11 不能在此执行）

1. **`tinymist` 二进制不可用**：`which tinymist` 失败；`find` 在 `~`、`/d`、`AppData`、`cargo install --list` 均无结果。应用运行时通过 `which::which("tinymist")` 发现它（`LspConfig::default()`），找不到时进入 §16.3 的“降级”路径（LSP 不可用，但仍保留编辑/编译/预览）。
2. **`cargo test` 无法执行**：测试二进制（~120 MB，链接全部 Tauri + typst）启动即 `STATUS_ENTRYPOINT_NOT_FOUND (0xC0000139)` —— Windows loader 的环境级问题，连 `--list`（仅枚举不跑用例）都失败。`cargo check` 与 `cargo test --no-run`（编译）均通过，因此后端单元测试**已编写并通过编译**，但运行时确认推迟。

## 已就绪、可在具备条件的环境中执行的内容

### 验证脚本（§20.4 七项）
1. **单 session 同时 didOpen 多文档**：tinymist 单 server state 内多源 VFS（spec §3.1）。验证方式：跑应用，开 3 个文档，观察 tinymist 进程数 = 1，且每个文档都收到 completion/hover。
2. **非活动文档编辑后查询返回新内容**：在非活动 tab 编辑，对另一文档中引用该依赖的 `#include` 做 definition/diagnostics，确认走内存版本而非磁盘版本（spec §3.1）。
3. **主 workspace 与外部 LooseFile 共存**：开 workspace + 一个工作区外 LooseFile，两者都能获得 completion/hover（spec §3.2 / §14.1）。
4. **Untitled scheme 探测**：tinymist 对 `untitled:/<id>.typ` 的兼容性。验证步骤：
   - 默认 `UNTITLED_SCHEME = "untitled"`（`src/components/Editor/documentUri.ts`）。
   - 跑应用，开 untitled 文档，确认 tinymist 不报错且 completion 工作。
   - 若失败，调用 `setUntitledSchemeForTest("file")`（或后续运行时配置点）切到 fallback `file:///<APP_PRIVATE_VIRTUAL_ROOT>/<id>.typ`，再确认。
   - 选定的 scheme 写回 `documentUri.ts` 的默认值；为另一 scheme 保留切换能力。
5. **工作区 restart + replay 后 completion/definition 恢复**：触发 workspace open/close/switch（§14），观察 tinymist generation 递增（§6.4 payload），replay 后所有打开文档 completion 可用（§9.3）。
6. **Save As URI migration 后 rename/workspace edit 指向新路径**：对已 Save As 的文档执行 LSP rename symbol，确认 workspace edit 指向新 URI（§11 / §12）。
7. **反复切换 tab 不重启 Tinymist**：连续切换 tab，观察 tinymist 进程不重启、不发 didClose/didOpen（§10.5 / §4.1 目标 2）。

### §21 验收对照（14 条）
代码层面已由 Task 1–10 的单元/集成测试覆盖；运行时确认依赖 Task 11 的真实 tinymist 跑通。本会话内已验证：
- 第 12 条（后端 relay 不解析 JSON-RPC）：`relay.rs`/`framing.rs` 全程未改，仍是透明字节管道。
- 第 13 条（`initializationOptions.rootPath` 已移除）：Task 4 + 断言测试（`appLanguageClient.test.ts` 的 rootPath tripwire）。
- 第 14 条（旧 generation 不影响当前 session）：Task 5 `shouldAcceptStatusEvent` + Task 6 handshake 旧 generation 拒绝 + Task 7 wire payload。

## 推迟到何时

Task 11 需要一个**安装了 tinymist 且能执行 `cargo test`** 的环境（开发者本机或 CI）。一旦具备：
1. `cargo install tinymist`（或 PATH 中放置二进制）。
2. 排查 Windows loader `STATUS_ENTRYPOINT_NOT_FOUND`（常见根因：混合的 MSVC runtime / 缺 redistribution / 杀软注入；可尝试 `cargo test` 在干净的 cmd.exe 而非 git-bash）。
3. 跑上述 7 项；失败项回流对应 Task 修复。
4. 把 untitled scheme 探测结果写回 `documentUri.ts` 默认值。

在此之前，Phase A–D 的实现已通过：390 个 vitest 单元/集成测试全绿、`tsc --noEmit` 0 错误、`cargo check` 0 错误、`cargo test --no-run`（测试编译）通过。
