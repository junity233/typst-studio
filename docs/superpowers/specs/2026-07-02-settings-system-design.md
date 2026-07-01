# Typst Studio — 设置系统与设置窗设计

> **状态**：设计已确认，待实现。
> **日期**：2026-07-02
> **项目目录**：`/Users/junity/code/typst-studio`
> **依赖**：复用既有未接线的 `src-tauri/src/settings/` scaffold（`config.rs` / `store.rs`）。

---

## 1. 目标

为 Typst Studio 引入统一的用户偏好系统：

- 配置持久化到一份 **JSON 文件**（平台 config 目录）。
- 程序通过**路径式统一接口**读写，例如 `prefs.get::<u64>("compiler.debounceMs", 300)`。
- 接口支持多种数据类型：数值（含整数）、字符串、布尔、路径数组、枚举。
- 提供独立的**设置窗口**（macOS 系统设置风格），可视化编辑。
- 改动 **live-apply**：即时落盘并广播，消费方响应式更新。

---

## 2. 关键技术决策

### 2.1 动态 JSON 配置 + 共享 manifest（非固定 Rust 结构体）

**背景**：既有 scaffold 用 `AppConfig` 结构体固化字段。经讨论否决——每加一个设置都要改 Rust、重导 ts-rs 类型、重编译后端，schema 被"固化"。

**决策**：持久化层**无结构体 schema**，运行时配置就是一份自由 `serde_json::Value`。设置项的"目录"是一份独立的 **manifest 数据文件**，前后端 build 时各加载一份（后端 `include_str!` 编译期嵌入，前端 Vite JSON import）。新增设置 = 改一行 manifest 数据，不动后端代码、不触发类型重导出。

| 方面 | 选型 |
|---|---|
| 运行时存储 | `serde_json::Value`（整份 JSON 文档） |
| 读写接口 | 路径式 `get<T>(path, default)` / `set(path, value)`，点号分隔键 |
| 默认值来源 | manifest 内每个 setting 的 `default` 字段 |
| 设置目录 | `src-tauri/settings/manifest.json`（前后端共享） |
| UI 驱动 | 前端遍历 manifest 渲染控件 |
| 后端校验 | `set` 时按 manifest 校验 type/min/max/options |

**取舍**：放弃编译期类型安全（键拼写错误运行时返回 default）。可接受——后端几乎不读设置（仅字体加载、编译 debounce），主要消费者在前端。

### 2.2 设置窗形态：独立原生窗口

类 macOS 系统设置的独立 OS 窗口（非 modal、非 sidebar）。Tauri 多窗口 + 单 bundle 路由区分：设置窗加载 `index.html?window=settings`，`main.tsx` 据此分支渲染 `<SettingsApp/>`。已存在则聚焦，避免重复打开。

### 2.3 生效方式：live-apply everything

无 Apply/OK 提交按钮、无草稿态。控件 onChange 直接 `setSetting` → 后端校验+落盘+广播 `settings_changed` → 两窗口的 store 同步更新 → 消费方 `useSetting` 响应式重渲染。

### 2.4 前端访问 API：`useSetting<T>(path)` 返回 `[value, setter]`

useState 式 hook，默认值自动从 manifest 兜底。等价于用户期望的 `UserPreference.get("a.b.c", default)`，但响应式。

---

## 3. manifest 格式

`src-tauri/settings/manifest.json`，自定义描述符（比完整 JSON Schema 轻、专为驱动 UI）：

```json
{
  "version": 1,
  "categories": [
    { "id": "compiler", "label": "Compiler", "settings": [
        { "key": "compiler.extraFontDirs", "type": "paths",   "label": "Extra font directories", "default": [] },
        { "key": "compiler.debounceMs",    "type": "integer", "label": "Compile debounce (ms)",  "default": 300, "min": 0, "max": 5000 }
    ]},
    { "id": "editor", "label": "Editor", "settings": [
        { "key": "editor.fontSize",   "type": "number",  "label": "Font size",    "default": 14, "min": 8, "max": 32 },
        { "key": "editor.fontFamily", "type": "string",  "label": "Font family",  "default": "" },
        { "key": "editor.tabSize",    "type": "integer", "label": "Tab size",     "default": 2, "min": 1, "max": 16 },
        { "key": "editor.wordWrap",   "type": "boolean", "label": "Word wrap",    "default": false },
        { "key": "editor.lineNumbers","type": "boolean", "label": "Line numbers", "default": true },
        { "key": "editor.minimap",    "type": "boolean", "label": "Minimap",      "default": false }
    ]},
    { "id": "preview", "label": "Preview", "settings": [
        { "key": "preview.autoRefresh", "type": "boolean", "label": "Auto refresh", "default": true },
        { "key": "preview.zoomLevel",   "type": "number",  "label": "Zoom level",   "default": 1.0, "min": 0.25, "max": 4.0, "step": 0.25 },
        { "key": "preview.background",  "type": "select",  "label": "Background",   "default": "light", "options": ["light", "dark"] }
    ]},
    { "id": "window", "label": "Window", "settings": [
        { "key": "window.sidebarVisible",   "type": "boolean", "label": "Show sidebar on startup", "default": true },
        { "key": "window.previewVisible",   "type": "boolean", "label": "Show preview on startup", "default": true },
        { "key": "window.recentWorkspaces", "type": "paths",   "label": "Recent workspaces",       "default": [], "readonly": true }
    ]}
  ]
}
```

**支持的 `type`**：`number` / `integer` / `string` / `boolean` / `paths`（路径字符串数组）/ `select`（带 `options`）。可选约束：`min` / `max` / `step` / `readonly`。`version: 1` 预留迁移，v1 不做迁移。

---

## 4. 后端架构

### 4.1 `settings/manifest.rs`（新）

```rust
#[derive(Debug, Clone, Deserialize)]
pub struct Manifest { pub version: u32, pub categories: Vec<Category> }

#[derive(Debug, Clone, Deserialize)]
pub struct Category { pub id: String, pub label: String, pub settings: Vec<SettingDef> }

#[derive(Debug, Clone, Deserialize)]
pub struct SettingDef {
    pub key: String,
    #[serde(rename = "type")]
    pub setting_type: String,   // "number" | "integer" | "string" | "boolean" | "paths" | "select"
    pub label: String,
    pub default: serde_json::Value,
    #[serde(flatten)] pub extra: serde_json::Map<String, serde_json::Value>, // min/max/step/options/readonly
}

impl Manifest {
    pub fn embedded() -> Self {
        serde_json::from_str(include_str!("../../settings/manifest.json"))
            .expect("settings manifest must be valid JSON")
    }
    pub fn find(&self, key: &str) -> Option<&SettingDef> { /* 按 key 查找 */ }
}
```

### 4.2 `settings/store.rs`（改造既有 scaffold）

把 `JsonFileStore` 从写死 `AppConfig` 改为存取 `serde_json::Value`：提供 `load_value() -> Value`（缺文件/解析失败返回空对象 `{}`）与 `save_value(&Value)`（自动建父目录、pretty 打印）。**删除 `ConfigStore` trait**——它原本为单一实现过度设计，动态模型下 `SettingsService` 直接持有 `JsonFileStore` 即可。删掉 `#![allow(dead_code)]`。原 scaffold 未被任何代码引用，改造安全。

### 4.3 `settings/config.rs`（删除或清空）

`AppConfig` 结构体不再需要（动态模型无 schema）。删除该文件，或仅保留模块占位。`mod.rs` 更新导出。

### 4.4 `settings/service.rs`（新）

镜像 `WorkspaceService` 模式：状态在 `parking_lot::RwLock` 后、`JsonFileStore` 持久化、`on_change` 回调解耦广播。

```rust
pub struct SettingsService {
    data: RwLock<serde_json::Value>,
    manifest: Manifest,
    store: JsonFileStore,
    on_change: Box<dyn Fn(&serde_json::Value) + Send + Sync>,
}

impl SettingsService {
    pub fn new(store: JsonFileStore, manifest: Manifest,
               on_change: impl Fn(&serde_json::Value) + Send + Sync + 'static) -> Result<Self>;

    pub fn get_all(&self) -> serde_json::Value;
    pub fn manifest(&self) -> &Manifest;

    // 显式 default
    pub fn get<T: DeserializeOwned>(&self, path: &str, default: T) -> T;
    // 从 manifest 兜底 default
    pub fn get_or_default<T: DeserializeOwned>(&self, path: &str) -> T;

    pub fn set(&self, path: &str, value: serde_json::Value) -> Result<()>;
}
```

**路径解析**：`editor.fontSize` → JSON pointer `/editor/fontSize`，用 `Value::pointer` 取/写。点号→斜杠是内部细节。

**`set` 流程**：① 按 manifest 校验（type 匹配、min/max/options 合法性；不合法返回 `AppError`）→ ② 写入 `self.data`(path) → ③ `store.save` → ④ `on_change(&self.data)` 广播。

### 4.5 `settings/window.rs`（新）

```rust
pub fn open_or_focus(app: &AppHandle) -> Result<()> {
    if let Some(win) = app.get_webview_window("settings") {
        win.set_focus()?;
        return Ok(());
    }
    WebviewWindowBuilder::new(app, "settings",
        WebviewUrl::App("index.html?window=settings".into()))
        .title("Settings").inner_size(760.0, 520.0).resizable(true).build()?;
    Ok(())
}
```

### 4.6 IPC 命令（新 `ipc/settings_commands.rs`）

| 命令 | 参数 | 返回 | 说明 |
|---|---|---|---|
| `get_all_settings` | `{}` | `Value` | 整份运行时配置 |
| `get_setting` | `{ path, default? }` | `Value` | 单值读取（无 default 时走 manifest） |
| `set_setting` | `{ path, value }` | `()` | 校验+落盘+广播 |
| `get_settings_manifest` | `{}` | `Manifest` | 前端启动拉一份描述符 |
| `open_settings` | `{}` | `()` | 创建/聚焦设置窗 |

注册到 `lib.rs:40` 的 `generate_handler!`。`AppState`（`ipc/state.rs:62`）加 `pub settings: Arc<SettingsService>`。

### 4.7 启动接线（`lib.rs::setup`）

```rust
let cfg_dir = app.path().app_config_dir()?;
let store = JsonFileStore::new(cfg_dir.join("settings.json"));
let manifest = Manifest::embedded();
let app_for_settings = app.handle().clone();
let settings = Arc::new(SettingsService::new(
    store, manifest,
    move |data| { let _ = app_for_settings.emit("settings_changed", data.clone()); },
)?);
app.manage(AppState { editor, export, lsp, workspace, settings });
```

`emit` 广播到所有窗口，主窗与设置窗均收到。配置目录用 Tauri identifier（`~/Library/Application Support/<id>/settings.json` 等平台对应位置）。

---

## 5. 前端架构

### 5.1 IPC 封装（`lib/tauri.ts`）

加四个 typed wrapper：`getAllSettings` / `setSetting(path, value)` / `getSettingsManifest()` / `openSettings()`。沿用现有 invoke 封装惯例。

### 5.2 类型（新 `lib/settings-types.ts`，手写）

动态模型下 settings 不走 ts-rs（无 Rust 结构体导出）。`Manifest` / `Category` / `SettingDef` 为手写 TS 接口，对应 manifest JSON。

### 5.3 `store/settingsStore.ts`（Zustand）

```ts
interface SettingsState {
  data: Record<string, unknown>;      // 整份运行时配置
  manifest: Manifest | null;
  hydrate: () => Promise<void>;         // getSettingsManifest + getAllSettings + listen("settings_changed")
  set: (path: string, value: unknown) => Promise<void>;
}
```

`hydrate()` 两窗口启动各调一次。`set()` → `setSetting` IPC → 后端广播 → `settings_changed` 事件回填 `data`（不乐观更新，保证两窗一致）。

### 5.4 核心 hook `useSetting`（`hooks/useSetting.ts`）

```ts
const [fontSize, setFontSize] = useSetting<number>("editor.fontSize");
const [wordWrap, setWordWrap] = useSetting<boolean>("editor.wordWrap");
```

订阅 `settingsStore.data` 按 path 取值；取不到用 manifest 内该 key 的 `default` 兜底；setter 调 `settingsStore.set`。值变自动重渲染。

### 5.5 窗口分支（`main.tsx`）

按 `?window=settings` 渲染 `<SettingsApp/>`，否则 `<App/>`。单 bundle，不加 Vite 多入口。

### 5.6 设置窗组件（`components/Settings/`）

- `SettingsApp.tsx`：左栏分类列表（parchment 背景），右栏控件区（白底）。遍历 `manifest.categories[].settings` 按 `type` 渲染。
- `Toggle.tsx`：本项目首个开关组件。
- 控件映射：number/integer → `<input type=number>`；string → `<input type=text>`；boolean → `<Toggle/>`；select → `<select>`；paths → 路径列表（`readonly` 项禁用编辑）。
- 每个 onChange 直接 `setSetting(path, value)`。

### 5.7 主窗消费方接线

- `MonacoEditor`：`useSetting` 读 `editor.*`（fontSize/fontFamily/tabSize/wordWrap/lineNumbers/minimap）喂 Monaco options，值变重配。
- `PreviewPane`：读 `preview.autoRefresh/zoomLevel/background`。
- `Workbench`：启动时读一次 `window.sidebarVisible/previewVisible` 播种 `uiStore`（非响应式）。`uiStore` 现有 ephemeral 状态改为从 settings 播种初始值。

### 5.8 菜单集成

原生菜单加 "Settings…" 项（`ipc/menu.rs`），menu id `open_settings`，`useAppCommands.ts` dispatch → `openSettings()` IPC。macOS 放应用菜单，Win/Linux 放 Edit。

---

## 6. UI 设计语言（对齐 DESIGN.md）

严格遵循 `DESIGN.md`（Apple 设计系统分析）与 `src/styles/global.css` token。

**铁律**：
- **单 accent**：仅 Action Blue `#0066cc`（`--color-primary`）作交互色。Toggle 开启态用它。
- **零阴影 chrome**：唯一系统阴影 `rgba(0,0,0,0.22) 3px 5px 30px` 只给产品图。设置窗全平，分隔靠**表面色变化**（color change IS the divider）。
- **字重阶梯 300/400/600/700，禁用 500**。
- **负字距**：≥17px 标题带 `-0.12 → -0.374px`。
- **不文档化 hover**：CSS 只写 default + active（`transform: scale(0.95)` 系统微交互）。

**布局/表面**：
- 左栏分类 → `{canvas-parchment}` `#f5f5f7`；右栏控件 → `{canvas}` 白。parchment↔白色变即左右分隔，无竖线。
- 行间 1px `{hairline}` `#e0e0e0` 分隔（类 iOS 设置列表）。
- 760×520 可缩放。

**字体映射**：分类名 → `{tagline}` 21px/600；setting label → `{body}` 17px/400；帮助/单位 → `{caption}` 14px；输入框 → `{body}`。

**新增组件**（本系统首个，需自造 CSS）：

| 组件 | 设计 |
|---|---|
| `.toggle` | 44×24px 胶囊轨道 `rounded.full`；开启 `{primary}` 实心、关闭 `{surface-chip-translucent}` `#d2d2d7`；白色圆钮 `rounded.full`，开启时滑右；按下 `scale(0.95)` |
| `.setting-input` | 1px `{hairline}` 边、`rounded.sm` 8px、内边距 8×12、`{body}` 字；聚焦 2px `{primary-focus}` 描边 |
| `.setting-row` | label 左/控件右、`min-height 44px`（触控底线）、行间 hairline 分隔 |
| `.path-list` | 每项 `{canvas-parchment}` 胶囊 + `{hairline}` 边 + `rounded.sm`；移除按钮 `button-ghost` 风（Action Blue 文字） |

复用现有：`button-dark-utility`（关闭/完成）、`text-link`（"Reset to default"）。**无 Save 按钮**（live-apply）。所有色/间距/圆角一律用 token，禁止内联 hex。

---

## 7. 事件流（live-apply 全链路）

```
设置窗改控件
  → settingsStore.set(path, value)
  → set_setting IPC
  → SettingsService.set：manifest 校验 → 写 data → JsonFileStore.save → on_change
  → emit("settings_changed", data)  广播所有窗口
  → 主窗 + 设置窗 settingsStore.data 更新
  → useSetting 重渲染（Monaco 重配 / Preview 重绘）
```

---

## 8. 验证

**后端单测**：
- 路径 get/set（`editor.fontSize` ↔ `/editor/fontSize`）。
- manifest 校验：非法 type / 越界 min-max / 非法 option 返回 `AppError`。
- 空配置文件兜底（缺文件、空对象均能正常 get manifest default）。
- 嵌套路径写入不覆盖兄弟键。

**构建**：`cd src-tauri && cargo build` / `cargo test`；`npm run build`（tsc 严格模式 + vite）。`Manifest`/`SettingDef` TS 接口须写全类型。

**手动**：
- 设置窗改值 → 主窗即时生效（字体/换行/缩放等）。
- 检查 `~/Library/Application Support/<id>/settings.json` 已落盘、内容正确。
- 重开应用，值仍在；未设置项走 manifest 默认。
- 设置项传非法值（超界数字、非枚举字符串）被拒。
- 关闭设置窗再从菜单开 → 聚焦既有窗口，不重复创建。

---

## 9. 实现阶段

| 阶段 | 内容 | 关键文件 |
|---|---|---|
| **1. 后端存储 + manifest** | `manifest.rs`；`store.rs` 泛型化；删 `config.rs` 的 `AppConfig`；`service.rs` | `src-tauri/src/settings/*`、`src-tauri/settings/manifest.json` |
| **2. 后端 IPC + 接线** | 5 个命令；`AppState` 加 `settings`；`lib.rs::setup` 构建 service；菜单加 "Settings…"；`window.rs` | `ipc/settings_commands.rs`、`ipc/state.rs`、`lib.rs`、`ipc/menu.rs`、`settings/window.rs` |
| **3. 前端 store + hook** | `settings-types.ts`；4 个 invoke wrapper；`settingsStore`；`useSetting`；`main.tsx` 窗口分支 | `lib/{settings-types,tauri}.ts`、`store/settingsStore.ts`、`hooks/useSetting.ts`、`main.tsx` |
| **4. 设置窗 UI** | `SettingsApp`；`Toggle`；按 type 渲染控件；CSS（对齐 DESIGN.md） | `components/Settings/*`、`styles/global.css` |
| **5. 主窗消费方** | MonacoEditor 读 `editor.*`；PreviewPane 读 `preview.*`；Workbench 播种 `window.*` | `components/Editor/*`、`Preview/*`、`Shell/*` |
| **6. 验证** | 后端单测；cargo build/test；npm run build；手动 live-apply/落盘/默认值/拒非法值 | — |

阶段 1、2 在后端有依赖（2 依赖 1 的 service）；阶段 3 依赖 2 的 IPC；阶段 4、5 依赖 3 的 hook。5 的三个消费方彼此独立可并行。

---

## 10. 取舍与风险

- **放弃编译期类型安全**：键拼写错误运行时返回 default，静默失败。缓解：manifest 是单一真相源，键集中；`useSetting` 可选地针对 manifest 校验键存在性（实现期酌情）。
- **动态模型不需要 ts-rs**：settings 不导出 Rust 类型，`Manifest`/`SettingDef` 手写 TS。这是相对原 typed-struct 方案的简化，但要求前后端手写类型与 manifest JSON 保持一致（实现期以 manifest 为准）。
- **manifest 存放位置**：定 `src-tauri/settings/manifest.json`，后端 `include_str!("../../settings/manifest.json")`、前端 tsconfig 别名 `@manifest` + Vite JSON import。若跨边界 import 在前端引发路径问题，实现期回来确认备选（前端拥有、后端 `include_str!`）。
- **`recentWorkspaces` 标 `readonly`**：由程序写入（打开 workspace 时追加），不在设置页编辑。
