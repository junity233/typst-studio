# Typst Studio — IPC 契约（前后端共享）

> 这是 Phase 4+5（Rust 实现）和 Phase 6b（前端接线）的共同契约。
> 任何偏离必须同步更新此文档。

## 命令（`#[tauri::command]`）

Rust 端函数名 snake_case；ts-rs 通过 `#[tauri::command(rename_all = "snake_case")]` 暴露给 invoke，前端 `invoke("new_tab", {...})`。

| Rust 命令 | invoke 参数 | 返回 | 说明 |
|---|---|---|---|
| `new_tab(content: Option<String>)` | `{ content?: string }` | `OpenedDocument` | 创建 untitled tab；不传 content 用默认模板 |
| `open_file()` | `{}` | `Option<OpenedDocument>` | 弹文件对话框、读盘、建 world；取消返回 None |
| `close_tab(id: DocumentId)` | `{ id }` | `()` | 关 tab，释放 world/comemo 缓存 |
| `update_text(id: DocumentId, content: String)` | `{ id, content }` | `()` | 更新源码 + 触发 300ms 防抖编译 |
| `save_file(id: DocumentId)` | `{ id }` | `()` | 写回磁盘（untitled 报错） |
| `export_pdf(id: DocumentId)` | `{ id }` | `String`（保存路径） | 弹保存框 + typst-pdf + 写盘 |
| `export_png(id: DocumentId)` | `{ id }` | `Vec<String>`（每页路径） | 弹保存框 + typst-render + 写盘 |
| `get_diagnostics(id: DocumentId)` | `{ id }` | `Vec<Diagnostic>` | 拉取当前诊断（初次加载用） |

错误统一走 `Result<T, AppError>` → 前端 invoke reject。

## 事件（`app.emit(name, payload)`）

事件名 snake_case；payload 字段 ts-rs 用 `#[serde(rename_all = "camelCase")]` 让 JS 拿到 camelCase。

### `compiled` — 编译成功
```ts
interface CompiledPayload {
  id: DocumentId;          // string (UUID)
  pages: string[];         // 每页一个完整 SVG 字符串
  durationMs: number;
}
```

### `diagnostics` — 编译失败
```ts
interface DiagnosticsPayload {
  id: DocumentId;
  diagnostics: Diagnostic[];
}
```

### `status` — 编译状态变更
```ts
type CompileStatus = "idle" | "compiling" | "success" | "error";
interface StatusPayload {
  id: DocumentId;
  status: CompileStatus;
  durationMs?: number;     // 仅在 success/error 时携带
}
```

## 类型（ts-rs 自动生成到 `src/lib/types.ts`）

Domain 类型已在 Phase 1 生成：`DocumentId`、`DocumentMeta`、`Diagnostic`、`Severity`、`Range`、`CompileOutcome`。

Phase 5 在 `ipc/events.rs` 新增 `OpenedDocument`、`CompiledPayload`、`DiagnosticsPayload`、`StatusPayload`、`CompileStatus` 五个 IPC 类型，全部加 `#[derive(TS)]` + payload 用 `#[serde(rename_all = "camelCase")]` + `#[ts(export_to = "../../src/lib/types.ts")]`。

`OpenedDocument` 用 `#[serde(flatten)]` 内联 `DocumentMeta` 字段 + 加 `content: String`，让前端拿到一次性拿全元数据和文本（避免再读一次盘）。

## 编译时序

```
按键 → Monaco onChange → 前端 tabsStore.updateContent(id, content)（本地状态立即更新）
                      → invoke("update_text", {id, content})
后端:
  1. EditorService.update_text(id, content)
     → 锁 tab，world.set_text(content)
  2. CompileScheduler：取消该 tab 上次待编译任务，新建 300ms 后执行的任务
  3. 任务触发：emit("status", {id, status: "compiling"})
  4. compile(&mut world) → (CompileOutcome, Option<PagedDocument>)
  5a. 成功：SvgRenderer.render(doc) → emit("compiled", {id, pages, durationMs})
                                      emit("status", {id, status: "success", durationMs})
  5b. 失败：emit("diagnostics", {id, diagnostics})
             emit("status", {id, status: "error", durationMs})
```

## Tab 生命周期

- 前端 tabsStore.openTab 必须**先**调 `invoke("new_tab", {content?})` 拿真实 `DocumentMeta`（含后端 UUID），用返回的 meta 初始化 store 条目（不能用客户端生成的 ID）。
- 前端 tabsStore.closeTab 调 `invoke("close_tab", {id})` 后再移除本地条目。
- 默认启动时前端调一次 `invoke("new_tab", {})` 创建首个 untitled tab。
