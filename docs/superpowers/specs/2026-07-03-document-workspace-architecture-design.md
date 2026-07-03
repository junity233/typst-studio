# Typst Studio 文档与工作区架构设计

> 日期：2026-07-03
> 状态：已确认
> 范围：建立支持 Untitled、工作区文件和工作区外文件的统一文档模型，并为后续通用编辑器功能提供稳定基础。

## 1. 产品定位

Typst Studio 是完全本地运行的通用 Typst 编辑器，同时服务首次接触 Typst 的用户和需要项目级能力的专业用户。

产品采用渐进式工作台，而不是维护“简单模式”和“专业模式”两套界面：

- 默认界面只展示编辑、预览、保存和导出等高频操作。
- 工作区、命令面板、语言服务和项目级工具按上下文出现。
- 高级能力通过快捷键、命令面板和上下文菜单提供，不长期占用界面。
- 不引入账户、云同步或多人协作。

本设计优先解决文档身份、资源解析、并发结果和磁盘一致性问题。模板、全局搜索和多分栏等功能建立在该基础上，但不属于本阶段实现范围。

## 2. 设计目标

1. Untitled、工作区文件和工作区外文件都是一等文档类型。
2. 文档身份不依赖标签页或当前路径，保存和移动时保持稳定。
3. 编译器、Tinymist、保存、导出和文件监听观察同一份内存文本。
4. 工作区外文件能够解析同目录资源。
5. 异步编译结果不能覆盖更新版本的预览和诊断。
6. 外部磁盘修改不能静默覆盖未保存内容。
7. 迁移期间保留现有编辑、预览、导出、LSP 和滚动同步行为。

## 3. 非目标

本阶段不实现：

- 插件系统；
- Git 图形界面；
- 所见即所得编辑；
- 账户、云同步和协作；
- 模板中心；
- 全局搜索与替换；
- 多分栏 UI；
- 通用项目配置格式。

内部可以建立命令注册和设置 schema 等稳定边界，但不提前开放第三方扩展 API。

## 4. 核心领域模型

```text
Application
├── ActiveWorkspace?          当前在资源管理器中显示的文件夹
├── DocumentRegistry          所有已打开文档及路径索引
│   ├── UntitledDocument
│   ├── WorkspaceFile
│   └── LooseFile
└── Views                     标签页、编辑器视图和预览视图
```

### 4.1 Document

`Document` 表示一份可编辑内容，不表示标签页。

```text
Document
├── id: DocumentId
├── origin: DocumentOrigin
├── buffer: TextBuffer
├── revision: u64
├── dirty: bool
├── diskVersion: DiskVersion?
└── compileState: CompileState
```

约束：

- `DocumentId` 在文档的整个打开周期内稳定。
- Untitled 保存、Save As 和解析范围变化不会更换 `DocumentId`。
- 相同 canonical path 在 `DocumentRegistry` 中最多对应一个文档。
- 标签页和未来的分栏都是 `DocumentView`，通过 `DocumentId` 引用文档。
- 关闭最后一个 view 后，是否释放文档由文档生命周期策略决定；本阶段保持与现有“关闭 tab 即关闭文档”一致。

本文的 canonical path 指用于文档身份比较的绝对规范路径：

- 已存在文件通过解析符号链接和 `.`、`..` 获得；
- 新建目标先规范化已存在的父目录，再拼接目标文件名；
- Windows 比较时还要采用平台一致的盘符和大小写规则；
- 路径规范化失败时不创建文档或修改现有路径索引。

### 4.2 DocumentOrigin

```text
DocumentOrigin
├── Untitled
├── WorkspaceFile { path, workspaceId }
└── LooseFile { path, root }
```

| 类型 | 磁盘路径 | 相对资源解析 | 文件监听 |
|---|---|---|---|
| Untitled | 无 | 不允许 | 无 |
| WorkspaceFile | 工作区内 | 工作区根目录 | 工作区 watcher |
| LooseFile | 工作区外 | 文件所在目录 | 单文件或目录 watcher |

#### Untitled

- 默认完全独立，即使当前打开了工作区也不隐式继承工作区解析范围。
- 可以编译不依赖本地相对资源的 Typst 内容。
- 使用相对 `#include`、图片或其他本地资源时返回明确诊断：“保存文档后才能解析相对路径”。
- 保存后根据目标路径转换为 `WorkspaceFile` 或 `LooseFile`。

#### WorkspaceFile

- canonical path 位于当前工作区根目录下。
- 相对资源和 `#include` 以工作区解析边界运行。
- 共享工作区的文件快照、磁盘 watcher、字体和包缓存。

#### LooseFile

- 文件没有位于当前工作区内，或当前没有工作区。
- 以文件父目录作为解析根，使同目录 `#include`、图片和其他资源正常工作。
- UI 提供“打开所在文件夹为工作区”，但不要求用户这样操作。

### 4.3 ActiveWorkspace 与文档解耦

应用最多有一个可见的 `ActiveWorkspace`，但可以同时打开任意数量的 LooseFile 和 Untitled 文档。

关闭工作区时：

- 不强制关闭已打开文档；
- 原 `WorkspaceFile` 转换为以各自父目录为根的 `LooseFile`；
- 重建其解析上下文、watcher 和 LSP 归属；
- 保持 `DocumentId`、buffer、dirty 状态和 view 不变。

打开或切换工作区时，已打开 LooseFile 若位于新工作区内，则转换为 `WorkspaceFile`。

## 5. 解析与编译模型

不同入口文档拥有不同的 Typst main file，因此不能简单使用“每工作区一个 `EditorWorld`”。设计拆分为共享解析上下文和每文档编译会话：

```text
ResolutionContext
├── root / access policy
├── shared file snapshots
├── fonts
├── package/cache resources
└── watcher integration

CompileSession per Document
├── main source
├── revision
├── incremental compiler state
├── last successful document
└── last diagnostics
```

上下文分配：

- 同一工作区的文档共享一个 `ResolutionContext`。
- LooseFile 使用父目录级 `ResolutionContext`；父目录相同的 LooseFile 共享同一个 context。
- Untitled 使用不允许本地磁盘解析的 scratch context。

所有打开文档的内存 buffer 构成统一 VFS。解析依赖时，VFS 中已打开且有未保存修改的文件优先于磁盘内容。这样主文档编译能够看到被 include 文件尚未保存的编辑。

## 6. 服务边界

### 6.1 DocumentService

负责：

- 文档身份和 `DocumentRegistry`；
- buffer、dirty、revision 和 disk version；
- 路径 canonicalization 与去重；
- Untitled、WorkspaceFile、LooseFile 之间的转换；
- 外部修改冲突状态；
- 为编译、LSP、保存和导出提供不可变快照。

不负责 Typst 编译、界面 view 或文件树展示。

### 6.2 WorkspaceService

负责：

- 当前工作区生命周期；
- 工作区文件树和文件操作；
- 工作区 watcher；
- 工作区级 `ResolutionContext`；
- 判断路径是否位于工作区内。

它不拥有打开文档。工作区变化通过明确命令要求 `DocumentService` 重新分类受影响文档。

### 6.3 CompileService

负责：

- 每文档 `CompileSession`；
- 编译调度与连续更新合并；
- 获取带 revision 的不可变文档快照；
- 生成预览、源码映射和编译诊断；
- 保存当前 revision 的成功编译产物供导出使用；
- 丢弃过期 revision 的结果。

Typst 运算不要求支持抢占式取消。若文档在编译期间变化，允许旧任务完成，但其结果不能发布。

### 6.4 LanguageService

负责：

- Tinymist 进程及重启策略；
- `DocumentId`、磁盘 URI 和 Untitled 虚拟 URI 的映射；
- `didOpen`、`didChange`、`didSave` 和 workspace folder 更新；
- LSP 可用性与降级状态。

初始方案保持单 Tinymist 进程：

- 当前工作区注册为主 workspace folder；
- LooseFile 的父目录按需注册为附加 root；
- Untitled 使用稳定虚拟 URI；
- 如果实际集成测试证明 Tinymist 多 root 隔离不可靠，再改为每个 `ResolutionContext` 一个进程。

Tinymist 失败不影响 Typst 编译、预览、保存和导出。

## 7. Revision 与事件一致性

每次 buffer 内容变化后：

1. `DocumentService` 原子更新文本；
2. `revision` 加一；
3. `CompileService` 获取 `{documentId, revision, snapshot}`；
4. 编译完成后发布带相同 revision 的结果；
5. 前端和后端都只接受与当前 revision 一致的结果。

IPC 命令和事件使用统一 envelope：

```text
EventEnvelope<T>
├── eventVersion
├── documentId
├── revision?
└── payload: T
```

`compiled`、`diagnostics` 和 compile status 必须携带 revision。文件树和全局服务事件可以不带文档 revision。

这套机制替代依赖事件抵达顺序的隐式一致性，避免旧预览、旧诊断和旧状态覆盖新内容。

## 8. 文件生命周期

### 8.1 打开文件

1. canonicalize 所选路径；
2. 查询路径索引；
3. 已打开时激活已有 view；
4. 未打开时读取磁盘并记录 `DiskVersion`；
5. 根据当前工作区分类为 `WorkspaceFile` 或 `LooseFile`；
6. 创建解析上下文、编译会话、watcher 订阅和 LSP 文档。

文件对话框、工作区树和会话恢复必须复用同一条打开路径，不分别创建文档。

### 8.2 Save

- Untitled 的 Save 转为 Save As。
- 已绑定路径的文档保存当前 buffer snapshot。
- 保存使用同目录临时文件、flush、原子替换；失败时保留原文件。
- 成功后更新 `DiskVersion`、清除 dirty，并发送 LSP `didSave`。
- watcher 对本应用保存产生的事件通过 disk version 识别，不触发冲突。

### 8.3 Save As

1. 选择目标路径，规范化其已存在父目录并生成目标 canonical path；
2. 检查目标是否已对应另一个打开文档；
3. 原子写入当前 buffer；
4. 计算新的 `DocumentOrigin` 和 `ResolutionContext`；
5. 保持 `DocumentId` 不变，重建编译会话；
6. 更新 watcher 和 LSP URI；
7. 触发当前 revision 的重新编译；
8. 更新路径索引、标题和会话数据。

当前仅修改 metadata/path 的 `assign_path` 行为必须被替换，因为它会让保存后的文档继续使用旧解析器。

若目标路径已打开，不允许产生两个独立 buffer。第一阶段直接拒绝并激活目标文档；不实现自动合并。

### 8.4 外部修改

watcher 事件到达后读取磁盘版本并与 `DiskVersion` 比较：

- buffer 未修改：自动重新加载，revision 加一；
- buffer 已修改：进入 conflict 状态，不覆盖内容；
- 文件被删除：保留 buffer，标记为磁盘缺失，允许 Save 重建或 Save As；
- 仅时间戳变化但内容未变：更新 disk version，不触发重编译。

冲突需要提供“比较、使用磁盘版本、覆盖磁盘”三个动作。第一阶段的比较功能可以调用简化 diff 视图，但其状态模型必须支持保留双方内容。

## 9. 导出语义

导出必须对应用户当前看到的 revision：

- 当前 revision 已成功编译时直接使用其产物；
- 当前 revision 正在编译时等待该 revision 完成；
- 当前 revision 编译失败时明确返回诊断，不使用旧产物；
- 文档在等待期间再次变化时，导出请求仍绑定发起时的 revision，界面明确显示该行为。

不得静默使用 `last_doc` 导出较旧内容。

## 10. 前端状态

前端状态分为领域状态和 UI 状态。

### 10.1 领域状态

由后端权威状态驱动：

- documents by id；
- origin、path、dirty、revision；
- compile status、diagnostics、preview；
- conflict 和磁盘缺失状态。

### 10.2 UI 状态

仅保留：

- views / tabs；
- active view；
- sidebar、panel 和 split 布局；
- selection、scroll anchor 等瞬时状态；
- dialog 和 context menu。

view 通过 `documentId` 引用文档，不复制 content、path、dirty 和编译结果。后续支持同一文档多视图时无需改变领域模型。

## 11. 渐进式界面行为

- 没有工作区时不显示空的资源管理器，保持编辑器与预览为主。
- WorkspaceFile 面包屑使用工作区相对路径。
- LooseFile 显示父目录，并提供“打开所在文件夹为工作区”。
- Untitled 显示未保存状态；相对资源错误提示先保存文档。
- 状态栏显示当前文档范围，例如“独立文件 · `/docs/report`”或“工作区 · `book`”。
- 高级命令进入命令面板、快捷键和上下文菜单，不增加常驻工具栏。

## 12. 错误处理与降级

- 编译错误进入文档诊断，不弹模态框。
- 文件冲突、覆盖、删除和目标路径占用需要用户决策。
- Tinymist、watcher 等辅助服务失败时降级运行，在状态栏提示。
- 单个文档会话恢复失败时跳过该文档，不阻塞应用启动。
- Typst panic 被隔离到编译任务，当前 revision 标记失败，后续编辑仍可重新编译。
- IPC 错误包含稳定错误码和用户可读信息，不要求前端解析字符串。

## 13. 会话恢复

会话持久化：

- 当前工作区；
- 打开的磁盘文件路径；
- Untitled 的 buffer 内容；
- view 顺序和 active view；
- dirty 状态；
- 必要的 UI 布局。

恢复顺序：

1. 恢复工作区；
2. 通过统一打开路径恢复磁盘文件并去重；
3. 恢复 Untitled buffer；
4. 恢复 views 和 active view；
5. 对每个文档触发当前 revision 编译；
6. 对不存在或无权限的文件生成单文档恢复提示。

不持久化编译产物和诊断，它们在启动后重新生成。

## 14. 迁移计划

### 阶段一：引入领域模型

- 增加 `DocumentOrigin`、`ResolutionContextId`、revision 和 canonical path 索引；
- 在保持现有 tab UI 的情况下建立 `DocumentRegistry`；
- 为现有 IPC 事件增加 revision；
- 添加路径去重测试。

### 阶段二：修复文件生命周期

- LooseFile 使用父目录解析器；
- Save As 完整重绑定；
- 工作区打开/关闭时重新分类文档；
- 实现外部修改冲突状态；
- 扩展会话恢复。

### 阶段三：统一一致性

- 建立统一内存 VFS；
- 编译器和 Tinymist 使用同一文档快照；
- 导出绑定 revision；
- watcher 使用 disk version 识别自身保存和外部修改。

### 阶段四：拆分服务和前端状态

- 将现有 `EditorService` 渐进拆为 `DocumentService` 与 `CompileService`；
- 保持 IPC facade，在内部迁移调用方；
- 将 Zustand 文档状态与 view 状态分离；
- 删除旧的 per-tab 数据所有权。

每个阶段都必须保持应用可构建和现有核心流程可用，不进行一次性重写。

## 15. 测试策略

### 15.1 领域与服务测试

- Untitled 默认无磁盘解析范围；
- Untitled 保存到工作区内和工作区外的转换；
- WorkspaceFile 与 LooseFile 双向 Save As；
- LooseFile 解析同目录 Typst 文件和图片；
- canonical path 去重；
- 工作区关闭和重新打开后的分类；
- dirty、revision 和 disk version 状态转换；
- 旧 revision 编译结果被丢弃；
- 导出拒绝旧 revision；
- Tinymist 和 watcher 故障降级。

### 15.2 集成测试

- 编辑 → 编译 → 预览；
- 连续编辑期间不存在旧预览覆盖；
- 打开的 include 文件未保存时，主文档编译看到内存版本；
- 文件对话框、工作区树、会话恢复打开同一路径时只有一个文档；
- dirty 文档遇到外部修改不被覆盖；
- 关闭工作区后文件仍可编辑、编译和保存；
- Save As 后相对资源按新目录解析；
- Tinymist 缺失或崩溃时编译预览继续工作；
- 会话恢复 WorkspaceFile、LooseFile、Untitled 和 active view。

### 15.3 回归要求

- PDF、PNG、SVG 导出；
- 编译诊断；
- 双向滚动同步和点击预览跳转源码；
- 多标签关闭确认；
- 设置窗口；
- 富文本粘贴和远程图片保存。

## 16. 第一阶段验收标准

1. 三类文档在领域模型中显式存在，并有稳定的转换测试。
2. 打开同一 canonical path 不会创建第二个文档。
3. LooseFile 能解析其父目录内的 Typst 文件和图片。
4. Save As 后解析范围、编译会话、watcher 和 LSP URI 全部更新。
5. 所有编译相关事件携带 revision，旧结果不会更新 UI。
6. 外部修改不会静默覆盖 dirty buffer。
7. 关闭工作区不关闭文档，原工作区文件继续以 LooseFile 工作。
8. 会话恢复覆盖 WorkspaceFile、LooseFile 和 Untitled。
9. 现有 Rust 测试与新增测试通过，前端核心流程通过集成验证。
