# Typst Studio 稳定性基线设计

> 日期：2026-07-04
> 状态：待实施
> 范围：数据安全、异常恢复、文件冲突、资源失控和桌面应用连续性
> 依赖：[文档与工作区架构设计](./2026-07-03-document-workspace-architecture-design.md)

## 1. 背景

Typst Studio 已经具备实时编译、预览、多标签、工作区、Tinymist、设置、正常关闭确认和会话恢复。下一阶段的目标不是继续增加显眼功能，而是建立用户愿意长期保存重要文档所需的稳定性基线。

稳定性基线回答五个问题：

1. 应用、系统或机器异常退出后，未保存内容是否仍能找回？
2. 保存过程中发生断电、磁盘满或权限错误时，原文件是否保持完整？
3. 文件被其他程序修改、移动或删除时，是否由用户决定如何处理？
4. 编译器、Tinymist、watcher 或单个配置损坏时，应用是否还能继续工作？
5. 重启、升级和重复打开文件时，用户能否回到可预测的工作状态？

## 2. 设计原则

1. **不丢数据优先**：宁可保留可清理的恢复数据，也不能静默丢失用户文本。
2. **明确确认优先**：覆盖、丢弃和永久删除必须是用户可理解的显式动作。
3. **故障隔离**：辅助服务失败不能拖垮编辑、保存和导出主路径。
4. **状态可解释**：dirty、conflict、recoverable、saving、read-only 等状态必须有唯一含义。
5. **失败后可继续**：错误界面必须提供重试、另存为、恢复或降级路径。
6. **默认安全**：崩溃恢复始终启用；自动写回原文件由用户选择。
7. **最小敏感数据**：日志不记录文档正文；恢复正文只保存在本机应用数据目录。

## 3. 当前基线与缺口

| 能力 | 当前状态 | 主要缺口 |
|---|---|---|
| 关闭 dirty 标签页提醒 | 已有 | 需要覆盖系统退出和保存中途失败 |
| 应用退出 Save All | 已有 | 异常退出不经过该流程 |
| 会话恢复 | 已有 | 磁盘文件只保存路径和 dirty，未保存正文会丢失 |
| Untitled 恢复 | 已有 | 需要与统一恢复日志合并 |
| 文档 revision | 已有 | 恢复快照和导出也要绑定 revision |
| canonical path 去重 | 已有 | 需要单实例避免两个进程同时编辑 |
| 外部修改检测 | 后端已有 | 缺少完整冲突处理 UI 和保存门禁 |
| LooseFile watcher | 已有 | watcher 失败需要可见降级 |
| Session/Settings 持久化 | 已有 | 当前直接覆盖 JSON，不是原子写入 |
| 用户文件保存 | 已有 | 当前直接写目标路径，可能截断原文件 |
| 编译 panic 隔离 | 部分已有 | 缺少 worker 健康状态、重启和并发限制 |
| 文件删除 | 已有 | 当前永久删除，缺少废纸篓与撤销 |

## 4. 总体架构

新增或明确以下稳定性组件：

```text
DocumentService
├── dirty / revision / conflict / read-only
├── RecoveryService
├── SaveCoordinator
└── ExternalChangeCoordinator

Persistence
├── AtomicFileWriter
├── SessionStore v2
├── SettingsStore
└── RecoveryStore

RuntimeSupervision
├── CompileSupervisor
├── LspSupervisor
├── WatcherHealth
└── DiagnosticLog

DesktopIntegration
├── SingleInstanceRouter
├── WindowStateStore
└── TrashService
```

现有 `EditorService` 可以先作为 facade 调用这些组件，不要求一次性重写。

## 5. P0：数据安全

### 5.1 异常退出恢复

#### 5.1.1 目标

无论是应用崩溃、强制结束、操作系统注销还是机器断电，最近一次已进入编辑器的 dirty 文本都应可恢复。

恢复机制与自动保存不同：

- 恢复快照写入应用数据目录，不修改用户文件。
- 默认始终启用。
- 自动保存原文件是独立、可关闭的功能。

#### 5.1.2 RecoveryService

恢复目录：

```text
<app-data>/recovery/
├── manifest.json
├── documents/
│   ├── <document-id>.json
│   └── ...
└── clean-shutdown
```

单文档快照：

```text
RecoverySnapshot
├── schemaVersion
├── documentId
├── origin
├── canonicalPath?
├── title
├── content
├── revision
├── diskVersion?
├── capturedAt
└── appVersion
```

规则：

- 文本变化后 750 ms 防抖写快照。
- 从后端 `DocumentService` 接受新 revision 到快照落盘的恢复点目标不超过 2 秒。
- 窗口失焦、系统休眠通知和正常关闭流程开始时立即 flush 待写快照。
- dirty 文档必须有快照；clean 文档删除快照。
- Untitled 从首次输入开始建立快照。
- 磁盘文件快照必须保存未保存正文，不能只保存 dirty 标志。
- 每次快照使用原子写入。
- 同一文档只保留最新快照；可选保留最近 3 个代际用于快照损坏回退。
- 正常关闭完成全部保存或明确丢弃后，写 `clean-shutdown` 标记。
- 启动时先移除旧的 clean 标记；只有完成正常关闭流程后重新写入。

#### 5.1.3 启动恢复

启动时满足以下任一条件则进入恢复流程：

- 上次没有 clean-shutdown 标记；
- 存在 revision 高于磁盘/会话版本的恢复快照；
- session 文件损坏但恢复目录仍有文档。

恢复界面按文档列出：

- 文件名或 Untitled 名称；
- 原路径；
- 快照时间；
- 当前磁盘是否变化；
- 恢复、比较、丢弃三个动作。

默认选择：

- Untitled：恢复。
- 磁盘未变化：恢复未保存 buffer。
- 磁盘已变化：要求比较，不能自动覆盖任一版本。

恢复只创建内存文档并标记 dirty，不立即写回磁盘。

#### 5.1.4 正常丢弃语义

用户在关闭确认中选择“不保存”后：

1. 明确记录该文档已丢弃；
2. 删除对应恢复快照；
3. 更新 session；
4. 再关闭 view 或应用。

不能在选择“不保存”后又于下次启动恢复同一内容。

### 5.2 原子写入

所有会被覆盖的持久化文件统一使用 `AtomicFileWriter`：

- 用户 `.typ` 文件；
- Save As 目标；
- `session.json`；
- `settings.json`；
- recovery manifest 与快照；
- 未来的窗口状态和最近项目。

写入协议：

```text
校验目标与冲突状态
→ 在目标同目录创建唯一临时文件
→ 写入全部字节
→ flush
→ 保留目标权限
→ 必要时 sync_all
→ 平台原子替换
→ 必要时同步父目录
→ 更新 DiskVersion
→ 清除 dirty
```

约束：

- 临时文件必须和目标位于同一文件系统。
- 任何失败都不得删除或截断原文件。
- dirty 只能在原子替换成功后清除。
- Save As 在完成替换前不得修改文档路径、registry、resolver、watcher 或 LSP URI。
- Windows 替换语义由平台适配层实现，不能假设 `rename` 可覆盖已存在文件。
- 保存后清理遗留临时文件；启动时清理超过 24 小时的本应用临时文件。

Session、Settings 和 recovery manifest 额外保留一份最近成功的 `.bak`。主文件损坏时：

1. 尝试读取 `.bak`；
2. 保留损坏文件并改名为 `.corrupt-<timestamp>`；
3. 记录诊断；
4. 继续启动。

### 5.3 保存协调与错误分类

新增 `SaveCoordinator`，统一 Save、Save As、Save All、关闭保存和自动保存。

保存状态：

```text
SaveState
├── Idle
├── Saving { revision }
├── Saved { revision, diskVersion }
└── Failed { revision, errorCode }
```

结构化错误至少包括：

- `PermissionDenied`
- `ReadOnly`
- `DiskFull`
- `TargetMissing`
- `ParentMissing`
- `PathOccupied`
- `ExternalConflict`
- `AlreadyOpen`
- `InvalidPath`
- `IoTransient`
- `Cancelled`

`Cancelled` 不是错误，不显示失败弹窗。

IPC 以 `{ code, message, details?, recoverable }` 传输错误，不再让前端解析 `AppError::to_string()`。

保存失败 UI 提供与错误匹配的动作：

- 重试；
- 另存为；
- 打开所在目录；
- 重新载入权限；
- 查看磁盘版本；
- 复制技术详情。

Save All 逐个保存，任一文档失败或取消后停止退出；已成功保存的文档保持 saved，其余文档保持 dirty。

### 5.4 外部修改冲突闭环

现有 `ConflictState` 扩展为完整状态机：

```text
ConflictState
├── None
├── Modified { diskVersion, diskContent }
├── Missing
├── PermissionChanged
└── Replaced { identityChanged }
```

规则：

- clean buffer 遇到内容变化可自动重载。
- dirty buffer 遇到任何内容变化不得被覆盖。
- conflict 未解决时，普通 Save 被阻止并打开冲突处理界面。
- 用户继续输入不能自动清除 conflict；只有明确解决动作可以清除。
- 文件删除后保留内存 buffer，并提供重新创建或 Save As。
- 文件被替换为不同 identity 时按外部替换处理，不能只比较时间戳。

冲突处理界面提供：

- **比较**：左右或内联 diff，显示编辑器版本和磁盘版本；
- **使用磁盘版本**：替换 buffer，revision 加一，清除 dirty；
- **覆盖磁盘**：通过原子保存写入当前 buffer；
- **另存为**：保留双方；
- **稍后处理**：保持 conflict，继续编辑但阻止普通保存。

### 5.5 安全删除

工作区删除默认进入系统废纸篓，不直接调用永久删除：

- 文件和目录都通过 `TrashService`。
- 删除前检查目标下是否包含打开或 dirty 文档。
- dirty 文档存在时阻止删除，并要求先保存、关闭或明确丢弃。
- 删除非空目录时显示文件数量和受影响的打开文档。
- 删除成功后显示短暂 Undo；平台支持时从废纸篓恢复。
- 永久删除只作为明确标注的高级动作，不设置默认快捷键。

应用内部创建后尚未保存的空文件可以直接撤销创建，但仍需更新文件树、registry、watcher 和 session。

## 6. P1：运行连续性

### 6.1 单实例与打开文件路由

默认只允许一个 Typst Studio 应用实例。

第二次启动或双击 `.typ` 文件时：

1. 将文件/工作区请求发送给已有实例；
2. canonicalize 路径；
3. 已打开则激活对应 view；
4. 未打开则通过统一文档打开流程创建；
5. 将主窗口恢复并置前。

命令行显式要求独立实例时可以提供高级参数，但必须警告同文件并发编辑风险。

### 6.2 编译监督

现有 per-document compile worker 由 `CompileSupervisor` 管理：

- 限制同时执行的编译数量，默认不超过 CPU 核心数与 4 的较小值。
- 连续编辑合并任务，只保留最新 revision。
- 编译超过 2 秒显示“编译时间较长”。
- worker panic 后标记失败并自动重建，后续编辑可以恢复。
- 应用关闭时停止接收任务并有界等待 worker 结束。
- 已关闭文档的结果不得发布。
- 对单文档连续 panic 采用退避，避免无限重启循环。

第一阶段不承诺强制终止正在运行的 Rust/Typst 线程。若压力测试证明恶意或错误文档能长期占用 CPU/内存，则后续把编译迁入可终止子进程。

### 6.3 Tinymist 与 watcher 降级

Tinymist：

- 启动失败不影响编辑和预览；
- 崩溃后指数退避重启；
- 连续失败后停止自动重试，提供手动重启；
- 状态栏显示不可用、重启中和已降级；
- 关闭应用时回收子进程。

Watcher：

- watcher 创建失败时文档仍可打开和保存；
- 状态栏明确提示外部修改检测不可用；
- 定期轻量校验打开文件的 `DiskVersion` 作为降级补偿；
- watcher 恢复后清除警告。

### 6.4 文件操作联动

在文件树中重命名或移动文件/目录时，事务性更新：

- canonical path registry；
- 所有受影响文档路径和 origin；
- resolver / ResolutionContext；
- watcher；
- Tinymist URI；
- breadcrumb 和 tab title；
- session 与 recovery snapshot；
- include 依赖的重新编译。

任一步失败时回滚文件系统操作或进入明确的 recoverable 状态，不能让文件树与打开文档指向不同路径。

### 6.5 启动隔离

启动按以下顺序分层：

1. 最小窗口和日志；
2. Settings/Session/Recovery 容错加载；
3. 工作区和文档逐项恢复；
4. 编译服务；
5. Tinymist、watcher 等辅助服务。

单个文档、字体扫描、Tinymist、watcher 或设置项失败不能阻止主窗口出现。失败项汇总到非模态“启动问题”面板。

## 7. P2：长期使用体验

### 7.1 自动保存

提供三个选项：

- `off`：默认关闭；
- `afterDelay`：停止输入指定时间后保存；
- `onFocusChange`：编辑器失焦时保存。

自动保存要求：

- 仅保存已有磁盘路径的文档；
- Untitled 不自动弹出 Save As；
- conflict、read-only 或 save failure 状态下暂停；
- 使用同一 `SaveCoordinator` 和原子写入；
- 状态栏短暂显示保存结果，不弹成功提示。

恢复快照不受自动保存开关影响。

### 7.2 Session v2

统一持久化：

- schema version；
- 当前工作区；
- 打开文档和 view 顺序；
- active view；
- Untitled 与 dirty buffer 的恢复引用；
- 窗口大小、位置、最大化和全屏状态；
- 侧栏、诊断面板与预览可见性；
- 分栏尺寸、预览缩放；
- 最近工作区。

窗口位置恢复必须裁剪到当前显示器可见区域，避免外接显示器移除后窗口不可见。

Session 只保存结构和引用；dirty 正文由 RecoveryStore 保存，避免两套正文来源。

### 7.3 Schema 迁移

Session、Settings 和 Recovery 均包含 `schemaVersion`：

- 每个版本提供显式、顺序执行的迁移函数；
- 迁移前保留原文件；
- 新版本无法识别时进入兼容降级，不覆盖原文件；
- 单条文档记录损坏时跳过该条并报告，其他记录继续恢复；
- 迁移测试使用真实旧版本 fixture。

### 7.4 诊断日志

本地滚动日志记录：

- 应用版本和平台；
- 启动阶段；
- session/recovery 迁移；
- 保存和文件操作错误码；
- compile worker panic/重启；
- Tinymist 状态变化；
- watcher 故障；
- 恢复结果。

约束：

- 默认最多 5 个文件，每个 2 MB；
- 不记录文档正文、剪贴板内容、Token 或网络响应正文；
- 路径在导出诊断包时允许用户选择是否脱敏；
- 设置页提供“打开日志目录”和“导出诊断包”；
- 日志失败不能影响主流程。

## 8. 用户界面状态

状态栏使用稳定且可操作的状态，不依赖临时 toast：

| 状态 | 表现 | 可用动作 |
|---|---|---|
| dirty | 文件名圆点 | 保存 |
| saving | 保存进度 | 无 |
| save failed | 红色保存状态 | 重试、另存为 |
| recovered | 恢复徽标 | 查看恢复信息 |
| conflict | 橙色冲突状态 | 比较、解决 |
| missing | 文件缺失状态 | 重新创建、另存为 |
| read-only | 锁图标 | 另存为、检查权限 |
| LSP unavailable | 降级提示 | 重启、设置路径 |
| watcher unavailable | 外部检测关闭 | 重试 |
| long compile | 编译耗时提示 | 查看诊断、未来支持停止 |

模态框只用于会导致数据丢失或覆盖的决策。后台服务故障、恢复结果和普通保存失败优先使用非模态面板或状态入口。

## 9. 安全与隐私

- RecoveryStore 位于应用私有数据目录。
- 诊断日志不包含正文。
- 清除最近记录时可选择同时清除恢复数据。
- 卸载说明明确恢复文件位置。
- 文件系统权限在发布前收紧到用户选择的文件/目录；不能继续使用全局 `**` 作为生产默认范围。
- CSP 在发布构建中必须启用。
- 恢复和日志文件使用当前用户权限创建。

## 10. 实施阶段

### 阶段 A：防止数据丢失

1. `AtomicFileWriter`
2. RecoveryStore 与 dirty buffer 快照
3. clean-shutdown 检测和恢复界面
4. SaveCoordinator 与结构化保存错误
5. 冲突保存门禁和冲突处理 UI

阶段 A 完成前不建议发布给真实文档用户。

### 阶段 B：防止破坏性操作

1. TrashService
2. dirty 文档删除保护
3. 文件移动/重命名联动
4. 单实例与文件打开路由
5. Session/Settings 原子持久化和备份

### 阶段 C：运行监督

1. CompileSupervisor
2. Tinymist 重启与退避
3. watcher 健康状态与轮询降级
4. 启动问题面板
5. 诊断日志

### 阶段 D：长期体验

1. Session v2 和窗口状态
2. schema migration
3. 可选自动保存
4. 最近工作区和恢复数据管理

## 11. 验收测试

### 11.1 恢复

- 编辑磁盘文件后强制结束进程，重启能恢复未保存正文。
- Untitled 强制退出后可恢复。
- 正常选择“不保存”后不再恢复该内容。
- 磁盘和恢复快照都变化时必须进入比较流程。
- 一个损坏快照不影响其他文档恢复。
- session 损坏时可从备份和 recovery manifest 恢复。

### 11.2 原子保存

- 模拟写入中断后原文件字节保持不变。
- 模拟磁盘满、权限不足和只读文件，dirty 保持为 true。
- Save As 失败后路径、origin、resolver 和 LSP URI 不变。
- 保存成功后临时文件被清理且权限保持。
- Session/Settings 主文件损坏后自动读取 `.bak`。

### 11.3 冲突

- clean 文件外部修改后自动重载。
- dirty 文件外部修改后 buffer 不变并显示冲突。
- conflict 状态下普通保存被阻止。
- 使用磁盘、覆盖磁盘和另存为三条路径均正确清除或保留状态。
- 文件被删除后可重新创建。
- 用户继续输入不会静默清除 conflict。

### 11.4 删除与文件操作

- 删除进入废纸篓而不是永久删除。
- 包含 dirty 文档的目录不能被直接删除。
- 重命名目录后所有打开子文档路径同步更新。
- 文件操作失败时 registry、UI 和磁盘保持一致。

### 11.5 运行监督

- compile worker panic 后下一次编辑可恢复编译。
- 多文档同时编辑不超过配置的并行编译数。
- Tinymist 缺失或崩溃时编辑、预览、保存和导出继续工作。
- watcher 失败时显示警告并通过轮询发现外部变化。
- 单实例下重复打开同一路径只产生一个文档。
- 辅助服务启动失败不阻止主窗口出现。

### 11.6 会话与升级

- 恢复标签顺序、active view、工作区、窗口和面板状态。
- 窗口原显示器不存在时仍位于可见区域。
- 旧 schema fixture 可逐级迁移。
- 更新版本无法识别时不覆盖原状态文件。

## 12. 发布门槛

在称为稳定版本前必须满足：

1. 阶段 A 与阶段 B 全部完成。
2. 强制结束进程的恢复测试覆盖 macOS、Windows 和 Linux。
3. 原子保存故障注入测试通过。
4. 外部修改冲突有完整 UI 闭环。
5. 默认删除进入废纸篓。
6. 同一路径不会被两个默认应用实例同时编辑。
7. Tinymist 和 watcher 故障不影响核心编辑流程。
8. 生产配置收紧文件权限并启用 CSP。
9. 真实文档进行至少 8 小时持续编辑/休眠/唤醒测试，无数据丢失。
