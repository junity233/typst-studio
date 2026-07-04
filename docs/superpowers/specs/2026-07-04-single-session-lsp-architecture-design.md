# Typst Studio 单 Session LSP 架构设计

> 日期：2026-07-04
> 状态：已确认
> 范围：单 Tinymist 进程、所有打开文档持续同步、唯一主工作区
> 取代：`2026-07-01-lsp-integration-design.md`
> 依赖：`2026-07-03-document-workspace-architecture-design.md`

## 1. 背景

现有 LSP 集成采用一个 WebSocket relay 和一个 Tinymist 子进程，但前端把所有文档表示为 `file:///typst-studio-mem/<DocumentId>.typ`，并在标签页切换时关闭旧 model、打开新 model。Tinymist 因此只能持续维护活动标签页，无法可靠获得：

- 磁盘文件的真实 URI；
- 所有打开文件的未保存内容；
- 工作区外文件的真实父目录；
- Save As 后的新身份；
- 工作区切换后的新 root。

文档/工作区架构已经提供稳定 `DocumentId`、`DocumentOrigin`、revision、canonical path registry、统一内存 VFS，以及分离的 document/view 状态。本设计在此基础上重构 LSP，不引入多个 workspace 或多个 Tinymist session。

## 2. 已确认的产品约束

1. 应用最多只有一个主工作区。
2. 整个应用只运行一个 Tinymist LSP session。
3. 所有打开文档持续保持 `didOpen`，包括非活动标签页。
4. 工作区外文件仍可打开，但不成为第二 workspace。
5. 磁盘文件使用真实 `file:` URI。
6. Untitled 使用虚拟 URI，且默认没有本地相对资源范围。
7. 工作区打开、关闭或切换时允许重启 Tinymist 并 replay 文档。
8. Typst 编译/预览管线独立于 LSP；Tinymist 故障不能阻止编辑、保存、编译和导出。

## 3. Tinymist 能力边界

### 3.1 原生多文档 VFS

Tinymist 在单个 server state 内维护多份打开源码：

```text
didOpen   → create_source(path, text)
didChange → edit_source(path, changes)
didClose  → remove_source(path)
```

打开文档以路径为键保存在内存 VFS。一个文档引用另一个已打开但未保存的文档时，Tinymist 可以使用内存版本而不是磁盘版本。

### 3.2 初始化时的 workspace roots

Tinymist 能读取标准 LSP `InitializeParams.workspaceFolders`。其 entry resolver 对具体文件：

1. 优先选择包含该文件的 workspace root；
2. 否则向上查找 `typst.toml`；
3. 最后退化到文件父目录。

因此工作区外文件可以与主工作区文件共享同一个 session，不需要额外 workspace。

### 3.3 动态 workspace 变化

Tinymist 声明支持 workspace folder change notification，但当前实现不能作为可靠的动态更新契约。因此本设计不依赖 `workspace/didChangeWorkspaceFolders`。

主工作区变化时完整重启 Tinymist，并使用当前 workspace 配置重新 initialize。

### 3.4 Primary entry 限制

Tinymist 可以保存并查询所有打开文档，但普通 LSP session 主要使用一个 primary compilation entry。它不保证多个互不相关入口始终并行编译并持续发布完整项目诊断。

本项目接受该限制：

- 内置 Typst 编译管线负责每个文档的实时编译、预览和确定性编译诊断；
- Tinymist 负责 completion、hover、definition、references、rename、semantic tokens 等编辑辅助；
- LSP diagnostics 作为语言服务诊断，不替代内置编译结果的权威地位。

## 4. 目标与非目标

### 4.1 目标

- 所有打开文档的未保存内容持续同步给 Tinymist。
- 标签页切换不重启 client，不产生 `didClose/didOpen`。
- 磁盘文件的跳转、引用和 workspace edit 使用真实 URI。
- Save As、重命名和工作区变化具有明确、可测试的 URI 生命周期。
- Tinymist 崩溃后自动重建，并 replay 所有打开文档。
- 后端保持透明 LSP relay，不解析或代理 JSON-RPC 语义。
- LSP 生命周期脱离 React editor 组件。

### 4.2 非目标

- 多工作区或 multi-root UI；
- 多个 Tinymist 进程；
- 每个文档独立 Tinymist compiler；
- Rust 后端 LSP broker；
- 后端 request ID 重写或 URI 内容路由；
- 将 Tinymist 作为 Rust library 嵌入；
- 保证多个独立入口同时持续编译；
- 在 Save As 后保留跨 model 的完整 undo stack。

## 5. 总体架构

```text
React application
├── documentsStore                   领域文档状态
├── tabsStore                        view 顺序和 active view
├── MonacoModelRegistry              所有打开 model
└── AppLanguageClient                唯一 LanguageClient
       │
       │ WebSocket: /lsp/main/<generation>
       ▼
Rust LspService
├── 一个 loopback TcpListener
├── 一个 active relay
└── 一个 Tinymist child
       │
       └── tinymist lsp (stdio)
```

控制面通过 Tauri IPC/事件传递：

- 当前 endpoint；
- generation；
- availability；
- connection/server status；
- restart reason。

数据面保持标准 LSP JSON-RPC：

```text
LanguageClient ↔ WebSocket ↔ framing relay ↔ Tinymist stdio
```

后端不解析 JSON-RPC payload。

## 6. 后端设计

### 6.1 LspEndpoint

```rust
struct LspEndpoint {
    generation: u64,
    ws_url: String,
    status: LspStatusKind,
    available: bool,
}

enum LspStatusKind {
    Disabled,
    Unavailable,
    Starting,
    AwaitingClient,
    Running,
    Restarting,
    Failed,
}
```

endpoint 格式：

```text
ws://127.0.0.1:<port>/lsp/main/<generation>?token=<capability-token>
```

约束：

- 进程生命周期内只创建一个 listener 和一个端口。
- 每次 Tinymist generation 重建时 generation 递增。
- 旧 generation 的 handshake 被拒绝。
- path 必须严格匹配 `/lsp/main/<generation>`。
- query token 为应用启动时随机生成的短期 capability，不写入磁盘。
- 同时保留 Origin allowlist；token 不是 Origin 校验的替代品。

### 6.2 LspManager 生命周期

```text
start listener
→ publish AwaitingClient endpoint
→ frontend connects
→ validate path/origin/token/generation
→ spawn tinymist lsp
→ relay standard LSP frames
→ child/connection ends
→ publish Failed or AwaitingClient
```

单连接规则：

- 一个 generation 只允许一个活动 WebSocket。
- 新连接只有在旧连接已明确关闭或被 restart supersede 后才能接管。
- 连接断开后结束对应 Tinymist child，避免在无 client 时保留失联 server。
- child stderr 必须持续 drain 到本地 tracing，避免 pipe 填满阻塞。
- 应用退出时停止 listener、关闭连接并回收 child。

### 6.3 Restart

以下情况触发 generation restart：

- 打开、关闭或切换主工作区；
- Tinymist 配置中需要 initialize-time 生效的字段变化；
- Tinymist child 崩溃；
- relay 发生不可恢复错误；
- 用户执行 Restart Language Server；
- endpoint generation 与前端不一致。

restart 流程：

```text
status = Restarting
→ 关闭旧 relay/child
→ generation += 1
→ 发布新 endpoint
→ 前端连接并 initialize
→ 前端 replay 所有打开文档
→ status = Running
```

普通文档打开、关闭、编辑、保存和 Save As 不重启 Tinymist。

### 6.4 Status 事件

`lsp_status` 扩展为：

```text
LspStatusPayload
├── available
├── enabled
├── status
├── generation
├── wsUrl
├── restartReason?
└── message?
```

前端只接受不小于当前 generation 的状态事件。

## 7. Initialize 配置

### 7.1 有主工作区

LanguageClient 发送：

```json
{
  "rootUri": "file:///absolute/workspace",
  "workspaceFolders": [
    {
      "name": "workspace-name",
      "uri": "file:///absolute/workspace"
    }
  ]
}
```

### 7.2 无主工作区

```json
{
  "rootUri": null,
  "workspaceFolders": null
}
```

### 7.3 禁止全局 rootPath 覆盖

删除当前：

```json
{
  "initializationOptions": {
    "rootPath": "/some/path"
  }
}
```

原因：

- `rootPath` 是 Tinymist 的全局强制 root；
- 会覆盖标准 workspace/文件父目录选择；
- 工作区外文件会被错误套用主工作区范围；
- 工作区变化只能通过重启并重新 initialize 生效。

保留与 workspace 无关的 initialization options：

```json
{
  "triggerSuggest": true,
  "triggerParameterHints": true,
  "supportHtmlInMarkdown": true
}
```

## 8. MonacoModelRegistry

### 8.1 职责

`MonacoModelRegistry` 是模块级应用服务，不属于 `MonacoEditor` React 组件：

```text
DocumentId → ModelEntry

ModelEntry
├── model
├── uri
├── documentId
├── viewState?
├── lastSyncedRevision
└── dispose()
```

负责：

- 文档打开时创建 model；
- 文档内容变化时保持 model 与 documentsStore 一致；
- 标签页切换时保存/恢复 view state；
- Save As 或重命名时迁移 URI；
- 文档关闭时 dispose；
- LSP 重连时提供当前全部 model 快照。

### 8.2 URI 规则

WorkspaceFile 与 LooseFile：

```text
file:///canonical/absolute/path.typ
```

Untitled：

```text
untitled:/<DocumentId>.typ
```

Untitled model 通过 Monaco `createModel` 直接创建，不要求 VS Code file service 将其解析为磁盘文件。

URI 到 DocumentId 的映射由 registry 维护，不能通过字符串前缀猜测。

### 8.3 所有 model 长期存活

- model 生命周期等于文档打开生命周期。
- active tab 只决定 editor 当前 `setModel()` 的目标。
- 标签页切换不创建或销毁 model。
- 非活动 model 继续接收 diagnostics、semantic tokens 和 workspace edits。
- 关闭文档时才 dispose model。

### 8.4 外部状态同步

Monaco model 是前端编辑文本的即时来源，documentsStore 保存对应领域快照。

```text
用户编辑 Monaco
→ documentsStore.updateContent
→ backend update_text
→ LanguageClient 自动 didChange
```

后端自动 reload 磁盘文件时：

```text
backend revision/content event
→ documentsStore 更新
→ registry 对 model 应用受控 replace
→ LanguageClient didChange
```

受控 replace 必须防止把自身更新再次作为用户编辑重复发送给 backend。

## 9. AppLanguageClient

### 9.1 生命周期

LanguageClient 由模块级 `AppLanguageClient` 管理，不再由 `MonacoEditor` mount/unmount 决定：

```text
AppLanguageClient
├── start(endpoint, workspace)
├── stop()
├── restart(endpoint, workspace)
├── replayDocuments(models)
├── state
└── generation
```

React 只订阅其状态。

### 9.2 唯一 client

整个应用只注册一个：

```text
languageId = "typst"
documentSelector =
  - language: typst, scheme: file
  - language: typst, scheme: untitled
```

不再需要：

- 多 LanguageClient manager；
- context-specific language ID；
- root glob routing；
- URI middleware；
- LSP RPC broker。

### 9.3 启动与 replay

启动顺序：

1. 初始化 Monaco/VS Code services。
2. 创建所有恢复文档的 model。
3. 获取后端 LSP endpoint。
4. 建立 WebSocket。
5. 发送 initialize/initialized。
6. LanguageClient 对所有匹配且已存在的 model 发送 `didOpen`。
7. 标记 LSP ready。

如果依赖库不会自动同步 client 启动前已有的所有 model，`AppLanguageClient` 必须显式 replay `didOpen`。实现不得假设只有 active model。

### 9.4 重连

generation 变化时：

- 停止并 dispose 旧 LanguageClient；
- 保留所有 Monaco model；
- 使用新 endpoint 创建全新 client；
- 使用当前工作区重新 initialize；
- replay 所有 model 的完整文本；
- diagnosticsStore 清除旧 generation 的 LSP diagnostics；
- 新 diagnostics 到达后重新填充。

编辑器在此期间继续工作；内置编译和预览不暂停。

## 10. 文档生命周期

### 10.1 Open

```text
后端打开/创建文档
→ 返回 DocumentMeta + content
→ documentsStore 插入
→ MonacoModelRegistry 创建真实/虚拟 URI model
→ 已运行 LanguageClient 自动 didOpen
```

路径去重仍由 DocumentRegistry 权威保证。

### 10.2 Edit

```text
Monaco edit
├── documentsStore revision +1
├── update_text IPC → 内置编译/VFS
└── didChange → Tinymist VFS
```

两条路径使用同一文本 revision，但 LSP 协议本身只传 document version。前端 model version 与后端 revision 需要维护映射，用于丢弃关闭、迁移或重连前的过期结果。

### 10.3 Save

原子保存成功后：

```text
backend mark_saved
→ documentsStore dirty=false
→ LanguageClient didSave
```

保存失败或外部冲突时不得发送 `didSave`。

### 10.4 Close

```text
dirty guard
→ LanguageClient didClose
→ MonacoModelRegistry dispose model
→ documentsStore remove
→ backend close_document
```

必须保证 `didClose` 发生在 model dispose 前。

### 10.5 Tab switch

```text
save old viewState
→ editor.setModel(target model)
→ restore target viewState
```

不发送任何 LSP document lifecycle notification。

## 11. Save As 与 URI 迁移

Monaco model URI 不可原地修改，因此 Save As 使用 model replacement：

```text
1. 后端完成原子写入与 DocumentOrigin rebind
2. 返回新的 canonical path
3. 暂停该文档的前端 edit forwarding
4. 保存旧 model 文本、selection、viewState
5. 创建真实新 file URI model
6. 旧 model 触发 didClose
7. 新 model 触发 didOpen(full text)
8. active 时 editor.setModel(new model)
9. 恢复 selection 和 viewState
10. dispose old model
11. 恢复 edit forwarding
```

约束：

- `DocumentId` 和后端 revision 不变。
- 新 model 的 LSP document version 从 1 重新开始。
- URI→DocumentId 映射原子切换。
- 迁移期间到达的旧 URI diagnostics 被丢弃。
- Save As 失败时不触碰旧 model。
- 目标路径已打开时激活已有文档，不创建第二 model。

第一版明确接受：Save As、磁盘重命名或跨 URI 迁移后清空 Monaco undo/redo 历史。必须保留正文、selection、scroll position 和 view state。

## 12. 文件重命名与 workspace edit

### 12.1 应用文件树重命名

应用发起重命名后：

- 后端完成磁盘和 DocumentOrigin 更新；
- model registry 对受影响文档执行 URI migration；
- Tinymist 接收旧 URI close、新 URI open；
- session、recovery、breadcrumb 和 diagnostics 映射同步更新。

目录重命名必须批量迁移所有打开的子文档。

### 12.2 Tinymist workspace edit

rename/code action 返回的 `WorkspaceEdit` 可能包含：

- 当前打开 model 的文本编辑；
- 未打开磁盘文件的文本编辑；
- create/rename/delete file operation。

处理规则：

- 打开文档应用到 Monaco model，并进入正常 dirty/revision 流程。
- 未打开文件必须通过后端安全文件 API 和原子写入。
- 文件操作经过 DocumentService、registry、watcher 和 recovery 协调。
- 任何会覆盖 dirty/conflict 文档的 edit 必须要求确认。

## 13. Diagnostics

### 13.1 来源

Problems UI 区分：

```text
DiagnosticSource
├── Compiler
└── Tinymist
```

- Compiler diagnostics 来自内置 Typst 编译，与 backend revision 对齐。
- Tinymist diagnostics 来自 Monaco marker service，与 LSP generation 和 URI 对齐。
- 两者可以同时展示，不能互相覆盖。
- 相同位置和消息可以在 UI 层去重，但必须保留来源。

### 13.2 路由

```text
publishDiagnostics(uri)
→ Monaco marker service
→ MonacoModelRegistry.resolveDocumentId(uri)
→ diagnosticsStore[documentId].tinymist
```

旧 URI、已关闭文档和旧 generation 的 diagnostics 被丢弃。

## 14. 工作区变化

### 14.1 打开工作区

```text
WorkspaceService.open
→ DocumentService reclassify
→ 请求 LSP restart
→ initialize(workspaceFolders=[new root])
→ replay 所有 WorkspaceFile、LooseFile、Untitled
```

LooseFile 仍以真实路径 didOpen。Tinymist 根据文件位置退化到 `typst.toml` 或父目录，不把它升级为第二 workspace。

### 14.2 关闭工作区

```text
WorkspaceService.close
→ WorkspaceFile 转 LooseFile
→ 请求 LSP restart
→ initialize(workspaceFolders=null)
→ replay 所有文档
```

### 14.3 切换工作区

关闭旧 workspace 与打开新 workspace 作为单一事务，最终只 restart 一次。

工作区变化不重建 Monaco model，因为真实文件 URI 没有改变；只重启 LanguageClient。

## 15. Untitled

Untitled：

- URI 为 `untitled:/<DocumentId>.typ`；
- 持续 didOpen/didChange；
- 支持语法、completion、hover 等不依赖本地路径的能力；
- 不承诺本地相对 include/image 解析；
- Save As 后迁移为真实 `file:` URI；
- 在 session/recovery 中通过 DocumentId 与正文恢复。

如果 Tinymist 对 `untitled:` scheme 的兼容性验证失败，fallback 为应用私有虚拟 file URI：

```text
file:///<app-private-virtual-root>/<DocumentId>.typ
```

fallback 仍不得映射到用户工作区，也不能授予真实相对文件访问。

## 16. 状态与故障恢复

### 16.1 前端状态

```text
LspClientState
├── Disabled
├── WaitingForEndpoint
├── Connecting
├── Initializing
├── Replaying
├── Ready
└── Failed
```

状态栏显示：

- Tinymist unavailable；
- connecting/restarting；
- ready；
- failed，可重试。

### 16.2 崩溃与退避

- child 异常退出后 generation 递增并自动重启。
- 自动重试采用有界指数退避。
- 连续失败达到阈值后停止自动重试，保留手动 Restart。
- 重启失败不弹阻塞模态框。
- stderr 和退出码进入本地诊断日志。

### 16.3 降级

LSP 不可用时仍保留：

- TextMate 语法高亮；
- Monaco 基础编辑；
- 内置 Typst 编译诊断；
- SVG 预览和源码映射；
- 保存、导出、session 和 recovery。

## 17. 前端模块调整

新增：

```text
src/components/Editor/
├── monacoModelRegistry.ts
├── appLanguageClient.ts
├── documentUri.ts
└── lspDiagnosticsBridge.ts
```

调整：

- `MonacoEditor.tsx`：只绑定 active model 和 editor imperative API。
- `lspClient.ts`：保留 VS Code services、grammar 和 LanguageClient 配置 helper；删除 per-tab URI 和组件生命周期逻辑。
- `documentsStore.ts`：保存 authoritative `origin`，并公开 model lifecycle 所需 selector。
- `tabsStore.ts`：继续只保存 view 顺序与 active view。
- `lspStore.ts`：保存 generation-aware client/server 状态。
- `useStartupSession.ts`：先恢复 documents/models，再启动/replay LSP。

移除：

- `MEM_ROOT` 作为所有文档 URI；
- `registerTypstMemFile(tab.id, ...)` 的 per-active-tab 注册方式；
- `editorKey = lsp-${wsUrl}` 驱动组件 remount；
- tab switch 的 `triggerReprocessConfig` model 生命周期；
- `rootPathRef` 和 initialize-time root 猜测；
- LanguageClient 生命周期对 `MonacoEditor` mount 的依赖。

## 18. 后端模块调整

保留：

```text
src-tauri/src/lsp/
├── framing.rs
├── relay.rs
└── manager.rs
```

调整：

- `manager.rs`：严格 path/generation/token handshake，明确 restart state。
- `relay.rs`：继续透明传输标准 LSP body。
- `lsp_service.rs`：提供 endpoint/status/restart facade。
- `ipc/events.rs`：扩展 generation-aware status payload。
- workspace commands：成功变更后请求 LSP restart。
- settings command：仅 initialize-time LSP 设置变更触发 restart。

不允许 LSP service 依赖 React view/tab 状态。打开文档 replay 由前端 model registry 完成。

## 19. 实施阶段

### 阶段 A：长期 Monaco models

1. 引入 `MonacoModelRegistry`。
2. 磁盘文件改用真实 URI。
3. 所有打开 model 持续存在。
4. tab switch 改为 `editor.setModel`。
5. 保持现有单 client 暂不改后端 endpoint。

### 阶段 B：LanguageClient 脱离 React

1. 引入 `AppLanguageClient`。
2. 移除 wrapper 对 client 生命周期的控制。
3. 验证启动时所有已有 model 都发送 didOpen。
4. diagnostics 按 URI 映射 DocumentId。
5. 断连时保留 model。

### 阶段 C：后端 generation endpoint

1. endpoint 改为 `/lsp/main/<generation>`。
2. 添加 token、path 和 generation 校验。
3. 扩展 status payload。
4. 实现 restart/reconnect/replay。
5. 工作区变化统一触发一次 restart。

### 阶段 D：URI migration

1. Save As model replacement。
2. 文件/目录重命名批量 migration。
3. 旧 URI diagnostics 清理。
4. workspace edit 与 DocumentService 协调。

## 20. 测试策略

### 20.1 单元测试

- DocumentOrigin → URI 转换；
- file URI 跨 macOS/Windows/Linux 编码；
- URI → DocumentId 映射；
- duplicate URI 拒绝；
- model registry open/activate/close；
- Save As migration 成功和回滚；
- generation 状态丢弃旧事件；
- endpoint path/token/origin/generation 校验；
- workspace initialize params；
- `rootPath` 不再出现在 initialization options。

### 20.2 前端集成测试

- 同时打开三个文档，只有切换 active model，不发生 didClose。
- 编辑非活动 model 后 Tinymist 收到 didChange。
- 主文档引用未保存的已打开依赖，definition/diagnostics 使用内存版本。
- WorkspaceFile 与 LooseFile 同时打开并获得 completion/hover。
- Save As 后旧 URI close、新 URI open，正文和 view state 保留。
- 关闭文档只发送一次 didClose 并 dispose model。
- LSP 重启后 replay 所有打开文档，不只 active tab。
- 旧 generation diagnostics 不更新 store。

### 20.3 后端集成测试

- 一个 listener 只接受正确 main path。
- 旧 generation 被拒绝。
- 错误 token/origin 被拒绝。
- 一个 generation 只有一个活动连接。
- restart 回收旧 Tinymist。
- child crash 更新 status 并生成新 generation。
- stderr 持续 drain。
- shutdown 不遗留 child process。

### 20.4 真实 Tinymist 验证

使用真实 Tinymist 二进制验证：

1. 一个 session 同时 didOpen 多文档。
2. 非活动文档编辑后查询返回新内容。
3. 主 workspace 与外部 LooseFile 共存。
4. Untitled scheme 支持；失败则验证 fallback。
5. 工作区重启并 replay 后 completion/definition 恢复。
6. Save As URI migration 后 rename/workspace edit 指向新路径。
7. 反复切换 tab 不重启 Tinymist。

## 21. 验收标准

1. 应用只运行一个 Tinymist child。
2. 所有打开文档持续存在于 Monaco 和 Tinymist VFS。
3. 标签切换不发送 didClose/didOpen。
4. 磁盘文件使用 canonical real file URI。
5. LooseFile 与主工作区共享 session，并以自身路径获得 LSP 能力。
6. Untitled 使用隔离虚拟 URI。
7. 工作区变化只触发一次 restart，并 replay 全部文档。
8. Save As 保持 DocumentId、正文、selection、scroll/view state。
9. Save As 后允许清空 undo，但行为有测试和文档说明。
10. Tinymist 崩溃后编辑、编译、预览和保存继续工作。
11. 重连后 diagnostics/completion/definition 恢复。
12. 后端 relay 不解析 JSON-RPC。
13. 当前 `initializationOptions.rootPath` 已移除。
14. 旧 generation 的连接、状态和 diagnostics 不影响当前 session。
