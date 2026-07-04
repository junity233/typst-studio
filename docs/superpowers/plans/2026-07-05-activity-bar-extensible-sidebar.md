# VSCode 风格 Activity Bar + 可扩展 Sidebar（含 Explorer / Search / Git / Outline）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把当前"硬编码 Explorer 单视图"的 Sidebar 改造成 VSCode 风格的 Activity Bar + 可扩展多视图架构，并提供四个视图：Explorer（迁移）、Search（跨文件搜索）、Source Control（Git，gix 后端）、Outline（从 typst introspector 抽 heading）。重模块化、可扩展，但不引入运行时插件加载机制。

**Architecture:**
- **ActivityBar + Sidebar 分离**：左侧固定窄列 `ActivityBar`（lucide 图标）+ 右侧可缩放 `Sidebar`（按 `activeViewId` 渲染）。沿用 Allotment 的 `min/max/preferredSize 常量 + visible 切换 + snap` 模式。
- **视图注册表（前端）**：新增 `src/extensions/` 目录抽象——`ViewRegistry`/`CommandRegistry`/`MenuItemRegistry`（单例 Map + `useSyncExternalStore`，不用 zustand 存注册表）。`activeViewId` 等会变的状态仍进 `uiStore`。
- **内置扩展**：每个视图一个目录 `src/extensions/<id>/`，由 `import.meta.glob` 静态收集 + 组件 `lazy()` code-split。
- **命令系统**：`useAppCommands.dispatch(id)` 从 hardcoded `switch` 改查 `CommandRegistry`。
- **Outline**：后端编译时用 `PagedDocument::introspector().query(Selector::can::<HeadingElem>())` 抽 heading，随 `compiled` 事件下发。
- **Git（gix）**：`gix = "0.85" features=["status","index"]`。Repository 非 Sync，每次命令调用重新 discover，全走 `spawn_blocking`。
- **Search**：后端 `walkdir + regex`（不引入 ripgrep）。**不做跨文件替换**。

**Tech Stack:** Tauri 2 / React 19 / TypeScript 5.8 / Zustand 5 / Allotment / lucide-react / Monaco；Rust 后端：gix 0.85、walkdir 2、regex 1、typst 0.15 既有 crates。

**Worktree:** `D:/code/typst-studio/.worktrees/activity-bar-extensible-sidebar`，分支 `activity-bar-extensible-sidebar`。

---

## Pre-Task 0：修复 Rust 基线编译错误（预先存在的 Windows 编译破坏）

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/domain/disk_version.rs:113-138`
- Test: `src-tauri/src/domain/disk_version.rs` (existing `#[cfg(test)]` block)

**Problem:** master 分支在 Windows stable Rust 上无法编译：
- `src-tauri/src/domain/disk_version.rs:127-128` 使用 `MetadataExt::volume_serial_number()` / `file_index()`，这两个方法受 unstable feature `windows_by_handle` 门控（仅 nightly 可用）。
- `:129` 把 `u32` 传给期望 `u64` 的 `hash_pair`（因为 `file_index()` 实际返回 `u32`）。

**Fix:** 用 `windows-sys` 的 `GetFileInformationByHandle` 直接拿 `BY_HANDLE_FILE_INFORMATION`，从中读 `dwVolumeSerialNumber`（`u32`）和 `nFileIndexHigh/Low`（合成 `u64`）。这是 Windows 上获取稳定文件标识的标准稳定 API，与原作者意图完全一致（只是绕开 unstable std 特性）。

- [ ] **Step 1: 添加 windows-sys 依赖（仅 windows target）**

修改 `src-tauri/Cargo.toml`，在 `[dependencies]` 末尾、`ts-rs` 之前添加：

```toml
# Stable FFI for GetFileInformationByHandle — used by FileIdentity on Windows
# (std's volume_serial_number/file_index are nightly-only behind windows_by_handle).
[target.'cfg(windows)'.dependencies]
windows-sys = { version = "0.59", features = ["Win32_Storage_FileSystem", "Win32_Foundation"] }
```

- [ ] **Step 2: 重写 `FileIdentity::from_path` 的 windows 分支**

把 `src-tauri/src/domain/disk_version.rs:113-137` 的 `from_path` 函数整体替换为：

```rust
    /// Read a file's identity from its metadata. Returns [`FileIdentity::UNKNOWN`]
    /// on any failure (missing file, unsupported platform) — never panics.
    pub fn from_path(path: &Path) -> Self {
        std::fs::symlink_metadata(path)
            .ok()
            .and_then(|m| Self::from_metadata(path, &m))
            .unwrap_or(Self::UNKNOWN)
    }

    #[cfg(unix)]
    fn from_metadata(_path: &Path, m: &std::fs::Metadata) -> Option<Self> {
        use std::os::unix::fs::MetadataExt;
        // (dev, ino) uniquely identifies a file on a Unix volume.
        Some(Self(hash_pair(m.dev(), m.ino())))
    }

    #[cfg(windows)]
    fn from_metadata(path: &Path, _m: &std::fs::Metadata) -> Option<Self> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        };

        // Open the file with FILE_FLAG_BACKUP_SEMANTICS so we can get a handle on
        // directories too (matching the Unix branch's symlink_metadata semantics).
        let file = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(0x02000000) // FILE_FLAG_BACKUP_SEMANTICS
            .open(path)
            .ok()?;
        let handle = file.as_raw_handle() as isize;
        if handle == INVALID_HANDLE_VALUE as _ {
            return None;
        }
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        let ok = unsafe { GetFileInformationByHandle(handle as _, &mut info) };
        // CloseHandle happens when `file` drops; explicit close is redundant but
        // kept for clarity per the FFI contract.
        unsafe { CloseHandle(handle as _) };
        if ok == 0 {
            return None;
        }
        let vol = info.dwVolumeSerialNumber as u64;
        let idx_high = info.nFileIndexHigh as u64;
        let idx_low = info.nFileIndexLow as u64;
        let idx = (idx_high << 32) | idx_low;
        Some(Self(hash_pair(vol, idx)))
    }

    #[cfg(not(any(unix, windows)))]
    fn from_metadata(_path: &Path, _m: &std::fs::Metadata) -> Option<Self> {
        None
    }
```

注意：`OpenOptions::custom_flags` 在 `std::os::windows::fs::OpenOptionsExt` 上是稳定的。`as_raw_handle` 是稳定的。`windows-sys` 是 `*-sys` crate，返回 raw `BOOL`/`HANDLE`，无 unsafe 之外的额外抽象。

- [ ] **Step 3: 验证编译**

Run: `cd src-tauri && cargo build`
Expected: 编译通过（可能有无关的 unused warning，无 error）。

- [ ] **Step 4: 跑 cargo test**

Run: `cd src-tauri && cargo test --quiet`
Expected: 所有现有测试通过（包括 `disk_version.rs` 里的 `equal_content_produces_equal_version` 等）。

- [ ] **Step 5: 提交**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/domain/disk_version.rs
git commit -m "fix(windows): use GetFileInformationByHandle for stable FileIdentity

The std volume_serial_number/file_index methods are nightly-only (feature
gated behind windows_by_handle). Replace with the equivalent windows-sys
FFI call so the project compiles on stable Rust on Windows."
```

---

## 阶段 1：Activity Bar + View Registry 骨架 + Explorer 迁移

**Goal:** 左侧出现 Activity Bar，Explorer 走 registry，文件树功能零回归。

**Files:**
- Create: `src/extensions/registry.ts`
- Create: `src/extensions/api.ts`
- Create: `src/extensions/index.ts`
- Create: `src/extensions/hooks.ts`
- Create: `src/extensions/explorer/index.ts`
- Create: `src/extensions/explorer/extension.json`
- Create: `src/components/Shell/ActivityBar.tsx`
- Create: `src/components/Sidebar/ViewContainer.tsx`（替代硬编码 Sidebar.tsx，但保留 Sidebar.tsx 文件名以减少 import 改动 —— 实际上是改写 Sidebar.tsx 的内容）
- Modify: `src/store/uiStore.ts`
- Modify: `src/components/Shell/Workbench.tsx`
- Modify: `src/hooks/useAppCommands.ts`
- Modify: `src/styles/global.css`
- Modify: `src/App.tsx`（启动时调 activateAll）
- Test: `src/extensions/__tests__/registry.test.ts`（新增）
- Test: `src/store/__tests__/uiStore.view.test.ts`（新增）

- [ ] **Step 1: 写 registry 测试（TDD）**

Create `src/extensions/__tests__/registry.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { viewRegistry, commandRegistry } from "../registry";

describe("ViewRegistry", () => {
  beforeEach(() => {
    // registry 是单例，测试间清理
    for (const v of viewRegistry.all()) viewRegistry.unregister(v.id);
  });

  it("registers and retrieves a view by id", () => {
    const view = {
      id: "test.view",
      title: "Test",
      icon: () => null,
      component: () => Promise.resolve({ default: () => null }),
      order: 0,
      when: "always" as const,
    };
    viewRegistry.register(view);
    expect(viewRegistry.get("test.view")).toBe(view);
  });

  it("returns views sorted by order", () => {
    viewRegistry.register({ id: "b", title: "B", icon: () => null, component: () => Promise.resolve({ default: () => null }), order: 20, when: "always" });
    viewRegistry.register({ id: "a", title: "A", icon: () => null, component: () => Promise.resolve({ default: () => null }), order: 10, when: "always" });
    const ids = viewRegistry.all().map((v) => v.id);
    expect(ids).toEqual(["a", "b"]);
  });

  it("ignores duplicate id with a warning", () => {
    const v = { id: "dup", title: "Dup", icon: () => null, component: () => Promise.resolve({ default: () => null }), order: 0, when: "always" as const };
    viewRegistry.register(v);
    viewRegistry.register({ ...v, title: "Dup2" });
    expect(viewRegistry.get("dup")?.title).toBe("Dup");
  });

  it("notifies subscribers on register/unregister", () => {
    let calls = 0;
    const unsub = viewRegistry.subscribe(() => calls++);
    viewRegistry.register({ id: "x", title: "X", icon: () => null, component: () => Promise.resolve({ default: () => null }), order: 0, when: "always" });
    viewRegistry.unregister("x");
    expect(calls).toBe(2);
    unsub();
  });
});

describe("CommandRegistry", () => {
  beforeEach(() => {
    for (const c of commandRegistry.all()) commandRegistry.unregister(c.id);
  });

  it("registers and retrieves a command by id", () => {
    const cmd = { id: "test.cmd", title: "Test", handler: () => {} };
    commandRegistry.register(cmd);
    expect(commandRegistry.get("test.cmd")).toBe(cmd);
  });
});
```

- [ ] **Step 2: 跑测试验证失败**

Run: `npx vitest run src/extensions/__tests__/registry.test.ts`
Expected: FAIL — "Cannot find module '../registry'"

- [ ] **Step 3: 实现 registry.ts**

Create `src/extensions/registry.ts`:

```typescript
import type { ComponentType } from "react";
import type { LucideIcon } from "lucide-react";

/** View contribution — 注册到 Activity Bar 的一个侧边栏视图。 */
export interface ViewContribution {
  /** 全局唯一 id，如 "workbench.explorer" */
  readonly id: string;
  /** hover tooltip / header 标题 */
  readonly title: string;
  /** lucide 图标组件 */
  readonly icon: LucideIcon;
  /** lazy 加载的视图组件工厂（Vite code-split） */
  readonly component: () => Promise<{ default: ComponentType<{ viewId: string }> }>;
  /** 排序权重，越小越靠上 */
  readonly order?: number;
  /** 激活条件：workspace = 仅工作区打开时可用；always = 任何时候 */
  readonly when?: "workspace" | "always";
}

/** Command contribution — 可被命令面板/菜单/快捷键调用的动作。 */
export interface CommandContribution {
  readonly id: string;
  readonly title: string;
  readonly category?: string;
  readonly keybinding?: string;
  readonly handler: (api: import("./api").HostApi) => void | Promise<void>;
  readonly enablement?: (api: import("./api").HostApi) => boolean;
}

/** Menu contribution — 把一个 command 注入到某个菜单位置。 */
export interface MenuItemContribution {
  readonly command: string;
  readonly location:
    | "editor/context"
    | "explorer/context"
    | "commandPalette"
    | "view/title";
  readonly group?: string;
  readonly order?: number;
}

type Listener = () => void;

class Registry<T extends { id: string }> {
  private items = new Map<string, T>();
  private listeners = new Set<Listener>();

  register(item: T): void {
    if (this.items.has(item.id)) {
      console.warn(`[extensions] duplicate id "${item.id}", ignored`);
      return;
    }
    this.items.set(item.id, item);
    this.emit();
  }

  unregister(id: string): void {
    if (this.items.delete(id)) this.emit();
  }

  get(id: string): T | undefined {
    return this.items.get(id);
  }

  has(id: string): boolean {
    return this.items.has(id);
  }

  /** 按 order 升序返回所有项（无 order 视为 100）。 */
  all(): T[] {
    return [...this.items.values()].sort(
      (a, b) =>
        ((("order" in a ? (a as { order?: number }).order : 100) ?? 100)) -
        ((("order" in b ? (b as { order?: number }).order : 100) ?? 100)),
    );
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}

export const viewRegistry = new Registry<ViewContribution>();
export const commandRegistry = new Registry<CommandContribution>();
export const menuItemRegistry = new Registry<MenuItemContribution>();
```

- [ ] **Step 4: 跑测试验证通过**

Run: `npx vitest run src/extensions/__tests__/registry.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: 实现 api.ts**

Create `src/extensions/api.ts`:

```typescript
import type { ViewContribution, CommandContribution, MenuItemContribution } from "./registry";
import { viewRegistry, commandRegistry, menuItemRegistry } from "./registry";

/**
 * 宿主暴露给扩展的 API。MVP 阶段内置扩展同源信任，不做权限校验，
 * 但接口形状按"未来可加权限代理"设计。
 */
export interface HostApi {
  /** 扩展自己的 id（由 host 注入） */
  readonly extensionId: string;

  // ---- 注册贡献（write-only，扩展 activate 时调用）----
  readonly registerView: (v: ViewContribution) => void;
  readonly registerCommand: (c: CommandContribution) => void;
  readonly registerMenuItem: (m: MenuItemContribution) => void;
}

/**
 * 创建一个绑定到指定 extensionId 的 HostApi 实例。
 * 注册贡献时自动带上 extensionId（便于未来按扩展卸载）。
 */
export function createHostApi(extensionId: string): HostApi {
  return {
    extensionId,
    registerView: (v) => viewRegistry.register(v),
    registerCommand: (c) => commandRegistry.register(c),
    registerMenuItem: (m) => menuItemRegistry.register(m),
  };
}
```

- [ ] **Step 6: 实现 hooks.ts**

Create `src/extensions/hooks.ts`:

```typescript
import { useSyncExternalStore } from "react";
import { viewRegistry, commandRegistry, type ViewContribution, type CommandContribution } from "./registry";

/** 订阅 viewRegistry，返回按 order 排序的视图列表。 */
export function useViews(): ViewContribution[] {
  return useSyncExternalStore(
    viewRegistry.subscribe.bind(viewRegistry),
    () => viewRegistry.all(),
    () => viewRegistry.all(),
  );
}

/** 订阅 commandRegistry，返回所有命令。 */
export function useCommands(): CommandContribution[] {
  return useSyncExternalStore(
    commandRegistry.subscribe.bind(commandRegistry),
    () => commandRegistry.all(),
    () => commandRegistry.all(),
  );
}
```

- [ ] **Step 7: 实现 index.ts（activateAll）**

Create `src/extensions/index.ts`:

```typescript
import { createHostApi, type HostApi } from "./api";

/**
 * 加载并激活所有内置扩展。
 *
 * 用 import.meta.glob 静态收集 src/extensions/<id>/index.ts，
 * 每个模块 default export 一个 activate(ctx) 函数。
 *
 * 单个扩展 activate 失败不会拖垮整个 app（VSCode 同策略）。
 */
export async function activateAll(): Promise<void> {
  const modules = import.meta.glob("./extensions/*/index.ts", {
    eager: true,
  });

  for (const [path, mod] of Object.entries(modules)) {
    const extensionId = path.split("/")[2];
    const activate = (mod as { default?: (ctx: HostApi) => void }).default;
    if (typeof activate !== "function") {
      console.warn(`[extensions] ${path} has no default export activate(), skipping`);
      continue;
    }
    try {
      const ctx = createHostApi(extensionId);
      activate(ctx);
      console.debug(`[extensions] activated ${extensionId}`);
    } catch (e) {
      console.error(`[extensions] ${extensionId} activate failed:`, e);
    }
  }
}
```

**重要：** 路径 `./extensions/*/index.ts` 是相对于**当前文件** `src/extensions/index.ts` 的。所以扩展目录是 `src/extensions/explorer/index.ts`、`src/extensions/search/index.ts` 等。

- [ ] **Step 8: 写 uiStore activeViewId 测试**

Create `src/store/__tests__/uiStore.view.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { useUiStore } from "../uiStore";

describe("uiStore activeViewId", () => {
  beforeEach(() => {
    useUiStore.getState().setActiveView(null);
    useUiStore.getState().setSidebar(true);
  });

  it("setActiveView sets the active view id and shows sidebar", () => {
    useUiStore.getState().setSidebar(false);
    useUiStore.getState().setActiveView("workbench.search");
    expect(useUiStore.getState().activeViewId).toBe("workbench.search");
    expect(useUiStore.getState().sidebarVisible).toBe(true);
  });

  it("toggleView on inactive view activates it and shows sidebar", () => {
    useUiStore.getState().setActiveView("workbench.explorer");
    useUiStore.getState().toggleView("workbench.search");
    expect(useUiStore.getState().activeViewId).toBe("workbench.search");
    expect(useUiStore.getState().sidebarVisible).toBe(true);
  });

  it("toggleView on already-active view hides sidebar", () => {
    useUiStore.getState().setActiveView("workbench.explorer");
    useUiStore.getState().setSidebar(true);
    useUiStore.getState().toggleView("workbench.explorer");
    expect(useUiStore.getState().sidebarVisible).toBe(false);
  });

  it("toggleView on inactive view when sidebar is hidden shows sidebar", () => {
    useUiStore.getState().setActiveView("workbench.explorer");
    useUiStore.getState().setSidebar(false);
    useUiStore.getState().toggleView("workbench.search");
    expect(useUiStore.getState().activeViewId).toBe("workbench.search");
    expect(useUiStore.getState().sidebarVisible).toBe(true);
  });
});
```

- [ ] **Step 9: 跑测试验证失败**

Run: `npx vitest run src/store/__tests__/uiStore.view.test.ts`
Expected: FAIL — "setActiveView is not a function"

- [ ] **Step 10: 修改 uiStore.ts**

Modify `src/store/uiStore.ts` — 加 `activeViewId`/`setActiveView`/`toggleView`，保留现有 `sidebarVisible`/`toggleSidebar`/`setSidebar`（兼容现有调用）。

```typescript
import { create } from "zustand";

export interface UiState {
  sidebarVisible: boolean;
  previewVisible: boolean;
  /** 当前激活的 Sidebar 视图 id（null = 无激活视图） */
  activeViewId: string | null;
  toggleSidebar: () => void;
  togglePreview: () => void;
  setSidebar: (v: boolean) => void;
  setPreview: (v: boolean) => void;
  /** 直接设置激活视图，并显示 sidebar。 */
  setActiveView: (id: string | null) => void;
  /** VSCode 语义：若已是激活视图且 sidebar 可见 → 隐藏 sidebar；
   *  否则切换到该视图并显示 sidebar。 */
  toggleView: (id: string) => void;
}

export const useUiStore = create<UiState>((set, get) => ({
  sidebarVisible: true,
  previewVisible: true,
  activeViewId: "workbench.explorer", // 默认 Explorer

  toggleSidebar: () => set((s) => ({ sidebarVisible: !s.sidebarVisible })),
  togglePreview: () => set((s) => ({ previewVisible: !s.previewVisible })),
  setSidebar: (v) => set({ sidebarVisible: v }),
  setPreview: (v) => set({ previewVisible: v }),

  setActiveView: (id) => set({ activeViewId: id, sidebarVisible: id !== null }),
  toggleView: (id) =>
    set((s) => {
      if (s.activeViewId === id && s.sidebarVisible) {
        // 已激活且可见 → 隐藏
        return { sidebarVisible: false };
      }
      // 切换到该视图并显示
      return { activeViewId: id, sidebarVisible: true };
    }),
}));
```

- [ ] **Step 11: 跑测试验证通过**

Run: `npx vitest run src/store/__tests__/uiStore.view.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 12: 创建 explorer 扩展**

Create `src/extensions/explorer/index.ts`:

```typescript
import { lazy } from "react";
import { Files } from "lucide-react";
import type { HostApi } from "../api";

// Vite 在构建时把这个 chunk 分出来
const ExplorerView = lazy(() =>
  import("../../components/Sidebar/Explorer").then((m) => ({ default: m.Explorer })),
);

export default function activate(ctx: HostApi): void {
  ctx.registerView({
    id: "workbench.explorer",
    title: "Explorer",
    icon: Files,
    component: () => Promise.resolve({ default: ExplorerView }),
    order: 0,
    when: "workspace",
  });
}
```

Create `src/extensions/explorer/extension.json`（声明性元数据，MVP 不强制消费，但保留给未来静态分析/权限审计）:

```json
{
  "name": "explorer",
  "version": "0.1.0",
  "displayName": "Explorer",
  "description": "File browser for the open workspace",
  "main": "./index.ts",
  "contributes": {
    "views": [
      {
        "id": "workbench.explorer",
        "title": "Explorer",
        "icon": "files",
        "order": 0,
        "when": "workspace"
      }
    ]
  }
}
```

**关键约束：** `Explorer` 组件本身**不要改任何业务逻辑**——它已经是零 props、纯 store 驱动。这次只是被 registry 引用。

- [ ] **Step 13: 创建 ActivityBar 组件**

Create `src/components/Shell/ActivityBar.tsx`:

```typescript
import { useViews } from "../../extensions/hooks";
import { useUiStore } from "../../store/uiStore";
import { useWorkspaceStore } from "../../store/workspaceStore";

export function ActivityBar() {
  const views = useViews();
  const activeViewId = useUiStore((s) => s.activeViewId);
  const toggleView = useUiStore((s) => s.toggleView);
  const hasWorkspace = useWorkspaceStore((s) => s.rootPath !== null);

  return (
    <nav className="activity-bar" role="toolbar" aria-label="Views">
      {views.map((v) => {
        const disabled = v.when === "workspace" && !hasWorkspace;
        const isActive = activeViewId === v.id;
        const Icon = v.icon;
        return (
          <button
            key={v.id}
            className={`activity-item${isActive ? " active" : ""}`}
            title={v.title}
            disabled={disabled}
            aria-pressed={isActive}
            onClick={() => toggleView(v.id)}
          >
            <Icon size={22} />
          </button>
        );
      })}
    </nav>
  );
}
```

- [ ] **Step 14: 重写 Sidebar.tsx 为 ViewContainer**

完全替换 `src/components/Sidebar/Sidebar.tsx` 内容。把硬编码 `<Explorer/>` 改成按 `activeViewId` 从 registry 取组件 lazy 渲染。

```typescript
import { Suspense, lazy } from "react";
import { viewRegistry } from "../../extensions/registry";
import { useUiStore } from "../../store/uiStore";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { onFsChanged } from "../../lib/tauri";
import { useWorkspaceStore as useWs } from "../../store/workspaceStore";
import { useEffect } from "react";
import { EmptyWorkspace } from "./EmptyWorkspace";

export function Sidebar() {
  const activeViewId = useUiStore((s) => s.activeViewId);
  const rootPath = useWs((s) => s.rootPath);
  const refreshAll = useWs((s) => s.refreshAll);

  // 保留原 Sidebar 的 fs_changed 订阅
  useEffect(() => {
    const off = onFsChanged(() => {
      void refreshAll();
    });
    return off;
  }, [refreshAll]);

  if (rootPath === null) {
    return (
      <aside className="sidebar">
        <EmptyWorkspace />
      </aside>
    );
  }

  const view = activeViewId ? viewRegistry.get(activeViewId) : undefined;
  if (!view) {
    return <aside className="sidebar sidebar-empty-active" />;
  }

  const ViewComponent = lazy(view.component);
  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <span className="sidebar-title">{view.title}</span>
      </div>
      <div className="sidebar-body">
        <Suspense fallback={<div className="sidebar-loading">Loading…</div>}>
          <ViewComponent viewId={view.id} />
        </Suspense>
      </div>
    </aside>
  );
}
```

**注意**：Explorer 组件签名是 `() => JSX`（无 props）。但 ViewContribution 要求 `ComponentType<{ viewId: string }>`。Explorer 忽略 props 即可——TypeScript 上需要小改 Explorer 的签名让它接受可选 props：

Modify `src/components/Sidebar/Explorer.tsx` 顶部签名（仅类型，零运行时改动）：

把 `export function Explorer() {` 改成 `export function Explorer(_props: { viewId: string }) {`（如果原来是 `export const Explorer = () =>`，则改成 `export const Explorer = (_props: { viewId: string }) =>`）。

- [ ] **Step 15: 修改 Workbench.tsx 引入 ActivityBar**

Modify `src/components/Shell/Workbench.tsx`：

把 return 从：
```tsx
<div className="workbench">
  <Allotment ...>
    <Allotment.Pane ... visible={showSidebar} snap><Sidebar /></Allotment.Pane>
    <Allotment.Pane ...><EditorArea /></Allotment.Pane>
  </Allotment>
</div>
```
改成：
```tsx
<div className="workbench">
  <ActivityBar />
  <Allotment ...>
    <Allotment.Pane ... visible={showSidebar} snap><Sidebar /></Allotment.Pane>
    <Allotment.Pane ...><EditorArea /></Allotment.Pane>
  </Allotment>
</div>
```
（即：在 `<Allotment>` 之前加 `<ActivityBar />`，并把 workbench 的 `display:flex` 让 ActivityBar 成为左侧 fixed-width item）。

import 加：`import { ActivityBar } from "./ActivityBar";`

- [ ] **Step 16: App.tsx 启动时调 activateAll**

Modify `src/App.tsx`：在 `App` 组件内或模块顶层加：

```typescript
import { activateAll } from "./extensions";

// 模块加载时激活（同步 glob eager，activate 是同步的）
void activateAll();
```

放最稳妥的位置：在 `App` 函数体的 `useEffect` 里调一次（StrictMode 安全）：

```typescript
useEffect(() => {
  void activateAll();
}, []);
```

- [ ] **Step 17: 修改 useAppCommands.ts 的 toggle-sidebar**

把现有 `case "toggle-sidebar": ui.toggleSidebar(); break;` 保留——它翻转 `sidebarVisible`。但 Activity Bar 的语义是 `toggleView`，所以二者协调：用户点菜单 toggle-sidebar → 翻转 sidebarVisible（不改变 activeViewId）。用户点 Activity Bar → toggleView。

**不改 useAppCommands**（阶段 1 保持现状，阶段 2 才整体重构 dispatch）。

- [ ] **Step 18: 加 CSS 样式**

Modify `src/styles/global.css`，在 `.sidebar` 选择器附近添加：

```css
.activity-bar {
  flex: 0 0 auto;
  width: 48px;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 8px 0;
  background: var(--color-canvas-parchment);
  border-right: 1px solid var(--color-hairline);
  gap: 4px;
}

.activity-item {
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  border-radius: var(--radius-sm);
  position: relative;
  transition: background-color 80ms ease, color 80ms ease;
}

.activity-item:hover:not(:disabled) {
  background: var(--color-hover);
  color: var(--color-text);
}

.activity-item.active {
  color: var(--color-text);
}

.activity-item.active::before {
  content: "";
  position: absolute;
  left: -8px;
  top: 6px;
  bottom: 6px;
  width: 2px;
  background: var(--color-accent);
  border-radius: 1px;
}

.activity-item:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.sidebar-header {
  flex: 0 0 auto;
  height: 35px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 12px;
  border-bottom: 1px solid var(--color-hairline);
}

.sidebar-title {
  font: var(--text-caption-strong);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--color-text-muted);
}

.sidebar-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.sidebar-loading {
  padding: 12px;
  color: var(--color-text-muted);
  font: var(--text-caption);
}

.sidebar-empty-active {
  /* 当激活视图不存在时的占位 */
}
```

注意：现有 `.explorer-header`（如果存在）和 `.sidebar-header` 会并存。如果 Explorer 内部已有自己的 header，需要决定：阶段 1 暂时保留 Explorer 内部 header（不强求统一），新 header 是 ViewContainer 的。**或者**：如果原 Sidebar 没有 header，这样新加是合理的。读原 Sidebar.tsx 确认。

- [ ] **Step 19: 跑全部前端测试**

Run: `npx vitest run`
Expected: 所有测试通过（包括原有 248 个 + 新增 registry 4 个 + uiStore.view 4 个 = 256）。

- [ ] **Step 20: 手动 smoke test（可选，需 GUI）**

Run: `npm run tauri dev`
验证：
- 左侧出现 48px 宽的 Activity Bar，含 Files 图标
- 点击 Files 图标 → sidebar 显示 Explorer
- 再点 Files 图标 → sidebar 隐藏
- 文件树所有功能（新建/重命名/删除/右键）正常
- 无工作区时 Files 图标灰显，sidebar 显示 EmptyWorkspace

- [ ] **Step 21: 提交**

```bash
git add src/extensions/ src/components/Shell/ActivityBar.tsx src/components/Sidebar/Sidebar.tsx src/components/Sidebar/Explorer.tsx src/store/uiStore.ts src/hooks/useAppCommands.ts src/components/Shell/Workbench.tsx src/App.tsx src/styles/global.css
git commit -m "feat: Activity Bar + extensible view registry (Phase 1)

Add ActivityBar component on the left edge of the workbench, backed by a
ViewRegistry/CommandRegistry singleton abstraction under src/extensions/.
Explorer is migrated to the first in-tree extension that registers its view
declaratively. uiStore gains activeViewId/setActiveView/toggleView with
VSCode-style toggle semantics (click active icon to hide sidebar).

The extension directory layout (src/extensions/<id>/index.ts + extension.json)
is the modular foundation for upcoming Search, Source Control, and Outline
views — no runtime plugin loading, just static import.meta.glob collection."
```

---

## 阶段 2：命令系统 registry 化 + 抽 workbench 内置扩展

**Goal:** `dispatch(id)` 从 hardcoded switch 改查 `CommandRegistry`，为后续视图注册命令铺路。所有现有菜单/快捷键行为不变。

**Files:**
- Create: `src/extensions/workbench/index.ts`
- Modify: `src/hooks/useAppCommands.ts`
- Test: `src/extensions/__tests__/workbench.commands.test.ts`

- [ ] **Step 1: 读现有 dispatch switch，提取所有命令**

Read `src/hooks/useAppCommands.ts` 的 `dispatch` switch（约 line 97-181）。把每个 case 的逻辑封装成 `CommandContribution`。

- [ ] **Step 2: 写 workbench 命令注册测试**

Create `src/extensions/__tests__/workbench.commands.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { commandRegistry } from "../registry";

// 触发 workbench 扩展 activate（模块加载时注册）
import "../workbench";

describe("workbench commands", () => {
  beforeEach(() => {
    // 注意：activate 在模块加载时执行一次，这里只验证结果
  });

  it("registers all expected command ids", () => {
    const ids = commandRegistry.all().map((c) => c.id);
    expect(ids).toContain("new-tab");
    expect(ids).toContain("open-file");
    expect(ids).toContain("open-folder");
    expect(ids).toContain("save");
    expect(ids).toContain("save-as");
    expect(ids).toContain("close-tab");
    expect(ids).toContain("toggle-sidebar");
    expect(ids).toContain("toggle-preview");
    expect(ids).toContain("export-pdf");
    expect(ids).toContain("export-png");
    expect(ids).toContain("export-svg");
  });

  it("each command has a title", () => {
    for (const c of commandRegistry.all()) {
      expect(c.title).toBeTruthy();
      expect(typeof c.title).toBe("string");
    }
  });
});
```

- [ ] **Step 3: 跑测试验证失败**

Run: `npx vitest run src/extensions/__tests__/workbench.commands.test.ts`
Expected: FAIL — "Cannot find module '../workbench'"

- [ ] **Step 4: 实现 workbench 扩展**

Create `src/extensions/workbench/index.ts`。把 `useAppCommands.ts` 现有 dispatch case 的逻辑抽出来。**关键**：handler 不能直接调用 store hooks，要用 `useXxxStore.getState()` 模式（dispatch 本身就是这么做的）。

参考实现（具体内容需要读 useAppCommands.ts 确认）：

```typescript
import type { HostApi } from "../api";
import { useUiStore } from "../../store/uiStore";
import { useTabsStore } from "../../store/tabsStore";
import * as tauri from "../../lib/tauri";
import { saveTab, closeTabWithConfirm } from "../../lib/commands";

export default function activate(ctx: HostApi): void {
  ctx.registerCommand({
    id: "new-tab",
    title: "New Tab",
    category: "File",
    keybinding: "CmdOrCtrl+T",
    handler: async () => {
      await tauri.newTab();
    },
  });

  ctx.registerCommand({
    id: "open-file",
    title: "Open File…",
    category: "File",
    keybinding: "CmdOrCtrl+O",
    handler: async () => {
      await tauri.openFile();
    },
  });

  ctx.registerCommand({
    id: "open-folder",
    title: "Open Folder…",
    category: "File",
    keybinding: "CmdOrCtrl+Shift+O",
    handler: async () => {
      await useTabsStore.getState().openWorkspace?.();
      // 或 tauri.openWorkspace() — 读原 dispatch 确认
    },
  });

  ctx.registerCommand({
    id: "save",
    title: "Save",
    category: "File",
    keybinding: "CmdOrCtrl+S",
    handler: async () => {
      const { activeId } = useTabsStore.getState();
      if (activeId) await saveTab(activeId);
    },
    enablement: () => useTabsStore.getState().activeId !== null,
  });

  ctx.registerCommand({
    id: "save-as",
    title: "Save As…",
    category: "File",
    keybinding: "CmdOrCtrl+Shift+S",
    handler: async () => {
      const { activeId } = useTabsStore.getState();
      if (activeId) await saveTab(activeId, { saveAs: true });
    },
    enablement: () => useTabsStore.getState().activeId !== null,
  });

  ctx.registerCommand({
    id: "close-tab",
    title: "Close Tab",
    category: "View",
    keybinding: "CmdOrCtrl+W",
    handler: async () => {
      const { activeId } = useTabsStore.getState();
      if (activeId) await closeTabWithConfirm(activeId);
    },
    enablement: () => useTabsStore.getState().activeId !== null,
  });

  ctx.registerCommand({
    id: "toggle-sidebar",
    title: "Toggle Sidebar",
    category: "View",
    keybinding: "CmdOrCtrl+B",
    handler: () => useUiStore.getState().toggleSidebar(),
  });

  ctx.registerCommand({
    id: "toggle-preview",
    title: "Toggle Preview",
    category: "View",
    keybinding: "CmdOrCtrl+\\",
    handler: () => useUiStore.getState().togglePreview(),
  });

  ctx.registerCommand({
    id: "export-pdf",
    title: "Export PDF",
    category: "File",
    handler: async () => {
      const { activeId } = useTabsStore.getState();
      if (activeId) await tauri.exportPdf(activeId);
    },
    enablement: () => useTabsStore.getState().activeId !== null,
  });

  ctx.registerCommand({
    id: "export-png",
    title: "Export PNG",
    category: "File",
    handler: async () => {
      const { activeId } = useTabsStore.getState();
      if (activeId) await tauri.exportPng(activeId);
    },
    enablement: () => useTabsStore.getState().activeId !== null,
  });

  ctx.registerCommand({
    id: "export-svg",
    title: "Export SVG",
    category: "File",
    handler: async () => {
      const { activeId } = useTabsStore.getState();
      if (activeId) await tauri.exportSvg(activeId);
    },
    enablement: () => useTabsStore.getState().activeId !== null,
  });
}
```

**注意**：上面的 handler 内容是**模板**，实施时必须读 `useAppCommands.ts` 的实际 case 实现，逐字搬过来（包括错误处理、open-recent 等）。如果有 case 调了 `handleOpenRecent`，那些要一并搬。

- [ ] **Step 5: 跑测试验证通过**

Run: `npx vitest run src/extensions/__tests__/workbench.commands.test.ts`
Expected: PASS

- [ ] **Step 6: 重写 dispatch 函数**

Modify `src/hooks/useAppCommands.ts`：

把现有 `export async function dispatch(menuId: string)` 内部的 switch 替换为查表：

```typescript
import { commandRegistry } from "../extensions/registry";

export async function dispatch(menuId: string): Promise<void> {
  // 1. 优先查 registry（workbench 扩展注册的命令）
  const cmd = commandRegistry.get(menuId);
  if (cmd) {
    if (cmd.enablement && !cmd.enablement(hostApi)) return;
    try {
      await cmd.handler(hostApi);
    } catch (e) {
      const ipc = toIpcError(e);
      if (ipc.code === "cancelled") return;
      console.warn(`[cmd:${menuId}] failed:`, ipc.code, ipc.message);
      window.alert(`${cmd.title}: ${ipc.message}`);
    }
    return;
  }

  // 2. open-recent:<i> 前缀（保留现有特殊处理）
  if (menuId.startsWith("open-recent:")) {
    await handleOpenRecent(menuId);
    return;
  }

  // 3. 未知 id（predefined Cut/Copy/Quit 等）静默忽略
}
```

**注意**：
- `hostApi` 需要创建一个模块级单例 `const hostApi = createHostApi("workbench.dispatch");`
- `handleOpenRecent` 保留为模块内函数
- `onMenuEvent` listener、`close_requested` guard、keydown 捕获器**全部保留不动**
- `toIpcError` 保留

- [ ] **Step 7: 跑全部前端测试**

Run: `npx vitest run`
Expected: 全部通过。特别注意 `useAppCommands.export.test.ts` 和 `commands.conflict.test.ts`、`commands.discard.test.ts` 不能回归。

- [ ] **Step 8: 提交**

```bash
git add src/extensions/workbench/ src/extensions/__tests__/workbench.commands.test.ts src/hooks/useAppCommands.ts
git commit -m "refactor: route dispatch through CommandRegistry (Phase 2)

The hardcoded switch in dispatch() is replaced with a registry lookup.
Existing save/open/export/toggle commands are extracted into the in-tree
'workbench' extension, registering them declaratively. All menu accelerators
and keydown capture behavior is preserved."
```

---

## 阶段 3：Search 视图（跨文件搜索，不含替换）

**Goal:** Cmd+Shift+F 唤起底部面板，搜工作区内 .typ 文件，点击命中跳转。

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Create: `src-tauri/src/domain/search.rs`
- Create: `src-tauri/src/fs/search.rs`
- Modify: `src-tauri/src/domain/mod.rs`
- Modify: `src-tauri/src/fs/mod.rs`
- Modify: `src-tauri/src/fs/tree.rs`（IGNORED_DIRS 改 pub(crate)）
- Modify: `src-tauri/src/service/workspace_service.rs`
- Modify: `src-tauri/src/ipc/fs_commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Create: `src/store/searchStore.ts`
- Create: `src/components/Search/SearchPanel.tsx`
- Create: `src/lib/openFile.ts`
- Create: `src/extensions/search/index.ts`
- Create: `src/extensions/search/extension.json`
- Modify: `src/components/Shell/Workbench.tsx`
- Modify: `src/lib/tauri.ts`
- Modify: `src-tauri/src/ipc/menu.rs`
- Modify: `src/hooks/useAppCommands.ts`
- Modify: `src/styles/global.css`

- [ ] **Step 1: 添加后端依赖**

Modify `src-tauri/Cargo.toml`，在 `[dependencies]` 加：

```toml
walkdir = "2"
regex = "1"
```

- [ ] **Step 2: 写 SearchQuery/SearchHit 类型**

Create `src-tauri/src/domain/search.rs`:

```rust
use serde::{Deserialize, Serialize};

/// 跨文件搜索请求。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "export-types", derive(ts_rs::TS), ts(export_to = "../../src/lib/types.ts"))]
pub struct SearchQuery {
    pub pattern: String,
    #[serde(default)]
    pub is_regex: bool,
    #[serde(default)]
    pub case_sensitive: bool,
    #[serde(default)]
    pub whole_word: bool,
    /// 可选的 include glob，如 "*.typ"。None = 所有非忽略文件。
    #[serde(default)]
    pub include_glob: Option<String>,
    /// 单文件命中上限（防爆）。
    #[serde(default = "default_max_per_file")]
    pub max_per_file: usize,
    /// 总命中上限。
    #[serde(default = "default_max_total")]
    pub max_total: usize,
}

fn default_max_per_file() -> usize {
    200
}
fn default_max_total() -> usize {
    2000
}

/// 单条搜索命中。
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "export-types", derive(ts_rs::TS), ts(export_to = "../../src/lib/types.ts"))]
pub struct SearchHit {
    /// 相对工作区根的路径。
    pub relative: String,
    /// 1-indexed 行号。
    pub line: u32,
    /// 1-indexed 列号（Unicode scalar value）。
    pub column: u32,
    /// 整行文本（用于 UI 显示，会截断超长行）。
    pub line_text: String,
    /// 命中在 line_text 里的起始字节偏移。
    pub match_start: u32,
    /// 命中在 line_text 里的结束字节偏移。
    pub match_end: u32,
}
```

- [ ] **Step 3: 声明模块 + 改 IGNORED_DIRS 可见性**

Modify `src-tauri/src/domain/mod.rs`: 加 `pub mod search;`

Modify `src-tauri/src/fs/mod.rs`: 加 `pub mod search;`

Modify `src-tauri/src/fs/tree.rs`: 找到 `IGNORED_DIRS` 常量，把可见性从 `const`/`pub(super)` 改成 `pub(crate) const`。如果原本是 `const IGNORED_DIRS: &[&str]`，改成 `pub(crate) const IGNORED_DIRS: &[&str]`。

- [ ] **Step 4: 实现 fs/search.rs**

Create `src-tauri/src/fs/search.rs`:

```rust
use crate::domain::search::{SearchHit, SearchQuery};
use anyhow::{Context, Result};
use regex::Regex;
use std::path::Path;
use std::collections::HashSet;

/// 在 root 下递归搜索匹配 query 的行。
///
/// - 跳过 `IGNORED_DIRS`（与 Explorer 文件树一致）
/// - 跳过非 UTF-8 / 读取失败的文件
/// - 限制每文件 max_per_file + 总数 max_total
pub fn search(root: &Path, query: &SearchQuery) -> Result<Vec<SearchHit>> {
    let matcher = build_matcher(query)?;
    let ignored: HashSet<&'static str> = crate::fs::tree::IGNORED_DIRS.iter().copied().collect();
    let include = query.include_glob.as_deref();
    let mut hits: Vec<SearchHit> = Vec::new();

    for entry in walkdir::WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            if let Some(name) = e.file_name() {
                let s = name.to_string_lossy();
                // 用文件名而非全路径判断 ignored dir（与 tree.rs 一致）
                if e.file_type().is_dir() && ignored.contains(s.as_ref()) {
                    return false;
                }
            }
            true
        })
    {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        if !entry.file_type().is_file() {
            continue;
        }
        // include glob 过滤
        if let Some(glob) = include {
            let name = entry.file_name().to_string_lossy();
            if !matches_glob(glob, &name) {
                continue;
            }
        }
        let path = entry.path();
        let rel = match path.strip_prefix(root) {
            Ok(r) => r.to_string_lossy().replace('\\', "/").to_string(),
            Err(_) => continue,
        };
        let text = match std::fs::read_to_string(path) {
            Ok(t) => t,
            Err(_) => continue, // 非 UTF-8 或读取失败，跳过
        };

        let mut file_hits = 0;
        for (line_idx, line) in text.lines().enumerate() {
            if file_hits >= query.max_per_file {
                break;
            }
            if hits.len() >= query.max_total {
                return Ok(hits);
            }
            for m in matcher.find_iter(line) {
                let col = line[..m.start()].chars().count() as u32 + 1;
                let line_text = truncate_line(line, 500);
                // 注意 match_start/end 基于 line_text，但 truncate 只在右侧截断，
                // 所以 m.start() 在 line_text 范围内仍然有效（除非命中本身超长）
                let end = m.end().min(line_text.len()) as u32;
                hits.push(SearchHit {
                    relative: rel.clone(),
                    line: line_idx as u32 + 1,
                    column: col,
                    line_text,
                    match_start: m.start() as u32,
                    match_end: end,
                });
                file_hits += 1;
                if file_hits >= query.max_per_file || hits.len() >= query.max_total {
                    break;
                }
            }
        }
    }

    Ok(hits)
}

fn build_matcher(query: &SearchQuery) -> Result<Matcher> {
    if query.is_regex {
        let mut b = RegexBuilder::new(&query.pattern);
        b.case_insensitive(!query.case_sensitive);
        if query.whole_word {
            // 简单的 word boundary 包装
            let pat = format!(r"\b(?:{})\b", query.pattern);
            b = RegexBuilder::new(&pat);
            b.case_insensitive(!query.case_sensitive);
        }
        Ok(Matcher::Regex(b.build().context("invalid regex pattern")?))
    } else {
        // 字面量匹配
        Ok(Matcher::Literal {
            needle: query.pattern.clone(),
            case_sensitive: query.case_sensitive,
            whole_word: query.whole_word,
        })
    }
}

enum Matcher {
    Regex(Regex),
    Literal {
        needle: String,
        case_sensitive: bool,
        whole_word: bool,
    },
}

impl Matcher {
    fn find_iter<'a>(&'a self, haystack: &'a str) -> Vec<std::ops::Range<usize>> {
        match self {
            Matcher::Regex(r) => r.find_iter(haystack).map(|m| m.range()).collect(),
            Matcher::Literal { needle, case_sensitive, whole_word } => {
                let (haystack_lower, needle_lower);
                let (h, n): (&str, &str) = if *case_sensitive {
                    (haystack, needle.as_str())
                } else {
                    haystack_lower = haystack.to_lowercase();
                    needle_lower = needle.to_lowercase();
                    (haystack_lower.as_str(), needle_lower.as_str())
                };
                let mut out = Vec::new();
                let mut start = 0;
                while let Some(idx) = h[start..].find(n) {
                    let abs_start = start + idx;
                    let abs_end = abs_start + n.len();
                    if *whole_word && !is_word_boundary(haystack, abs_start, abs_end) {
                        start = abs_end;
                        continue;
                    }
                    out.push(abs_start..abs_end);
                    start = abs_end;
                    if n.is_empty() {
                        break; // 防 empty needle 无限循环
                    }
                }
                out
            }
        }
    }
}

fn is_word_boundary(s: &str, start: usize, end: usize) -> bool {
    let before = start > 0 && s.as_bytes().get(start - 1).map(|b| b.is_ascii_alphanumeric()).unwrap_or(false);
    let after = s.as_bytes().get(end).map(|b| b.is_ascii_alphanumeric()).unwrap_or(false);
    !before && !after
}

fn truncate_line(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    // 按 char 边界截断
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    let mut t = s[..end].to_string();
    t.push('…');
    t
}

fn matches_glob(glob: &str, name: &str) -> bool {
    // 极简 glob：仅支持 * 通配。复杂场景用 glob crate，但 MVP 够用。
    if !glob.contains('*') {
        return name == glob;
    }
    // 单个 * 前缀/后缀场景
    if let Some(suffix) = glob.strip_prefix('*') {
        return name.ends_with(suffix);
    }
    if let Some(prefix) = glob.strip_suffix('*') {
        return name.starts_with(prefix);
    }
    name == glob
}
```

- [ ] **Step 5: WorkspaceService::search() 转发**

Modify `src-tauri/src/service/workspace_service.rs`，在 `read_file_text` 附近加：

```rust
pub fn search(&self, query: &crate::domain::search::SearchQuery) -> anyhow::Result<Vec<crate::domain::search::SearchHit>> {
    let root = self.root.read().clone().ok_or_else(|| anyhow::anyhow!("no workspace open"))?;
    crate::fs::search::search(&root, query)
}

pub fn root(&self) -> Option<std::path::PathBuf> {
    self.root.read().clone()
}
```

注意：如果 `WorkspaceService` 已有 `root()` 方法返回 `Option<PathBuf>`，**不要重复定义**——只加 `search()`。读现有代码确认。

- [ ] **Step 6: 加 IPC 命令**

Modify `src-tauri/src/ipc/fs_commands.rs`，在 `read_dir` 附近加：

```rust
use crate::domain::search::{SearchHit, SearchQuery};

#[tauri::command]
pub async fn search_workspace(
    state: State<'_, AppState>,
    query: SearchQuery,
) -> Result<Vec<SearchHit>> {
    let ws = state.workspace.clone();
    tauri::async_runtime::spawn_blocking(move || ws.search(&query))
        .await
        .map_err(|e| AppError::Other(format!("join error: {e}")))?
}
```

注意：`ws.search` 在 workspace 未打开时会返回 `Err`（"no workspace open"），前端会拿到 error。也可以改成返回 `Option`（None 表示无 workspace）。读现有 `read_dir` 命令的错误处理风格保持一致。

- [ ] **Step 7: 注册命令 + 重生类型**

Modify `src-tauri/src/lib.rs`，在 `generate_handler!` 列表里加 `ipc::fs_commands::search_workspace,`（紧挨 `read_dir`）。

Run: `cd src-tauri && cargo test --features export-types --quiet`
Expected: 编译通过 + `types.ts` 自动追加 `SearchQuery`/`SearchHit`。

- [ ] **Step 8: 前端 invoke wrapper**

Modify `src/lib/tauri.ts`，在 `readDir` 附近加：

```typescript
import type { SearchHit, SearchQuery } from "./types";

export async function searchWorkspace(query: SearchQuery): Promise<SearchHit[]> {
  return invoke<SearchHit[]>("search_workspace", { query });
}
```

- [ ] **Step 9: 实现 searchStore.ts**

Create `src/store/searchStore.ts`:

```typescript
import { create } from "zustand";
import type { SearchHit, SearchQuery } from "../lib/types";
import { searchWorkspace } from "../lib/tauri";

export interface SearchState {
  query: string;
  isRegex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
  results: SearchHit[];
  searching: boolean;
  error: string | null;
  visible: boolean;

  setQuery: (q: string) => void;
  setOption: (key: "isRegex" | "caseSensitive" | "wholeWord", v: boolean) => void;
  run: () => Promise<void>;
  clear: () => void;
  toggle: () => void;
  show: () => void;
  hide: () => void;
}

export const useSearchStore = create<SearchState>((set, get) => ({
  query: "",
  isRegex: false,
  caseSensitive: false,
  wholeWord: false,
  results: [],
  searching: false,
  error: null,
  visible: false,

  setQuery: (q) => set({ query: q }),
  setOption: (key, v) => set({ [key]: v } as Pick<SearchState, typeof key>),

  run: async () => {
    const { query, isRegex, caseSensitive, wholeWord } = get();
    if (!query.trim()) {
      set({ results: [], error: null });
      return;
    }
    set({ searching: true, error: null });
    try {
      const req: SearchQuery = {
        pattern: query,
        isRegex,
        caseSensitive,
        wholeWord,
        maxPerFile: 200,
        maxTotal: 2000,
      };
      const hits = await searchWorkspace(req);
      set({ results: hits, searching: false });
    } catch (e) {
      set({ results: [], searching: false, error: e instanceof Error ? e.message : String(e) });
    }
  },

  clear: () => set({ query: "", results: [], error: null }),
  toggle: () => set((s) => ({ visible: !s.visible })),
  show: () => set({ visible: true }),
  hide: () => set({ visible: false }),
}));
```

- [ ] **Step 10: 抽 openFile 共享 helper**

Create `src/lib/openFile.ts`（从 Explorer.tsx:198-218 抽出来）：

```typescript
import { useTabsStore } from "../store/tabsStore";
import { openFileByPath } from "./tauri";
import { toIpcError } from "./ipc-error";

/**
 * 打开工作区内一个文件：若已开则激活，否则新开 tab。
 * 抽自 Explorer.handleDoubleClick。
 */
export async function openFile(absPath: string): Promise<void> {
  try {
    const { readOrderedDocuments, activate, openPath } = useTabsStore.getState();
    const existing = readOrderedDocuments().find((t) => t.path === absPath);
    if (existing) {
      activate(existing.id);
    } else {
      await openPath(absPath);
    }
  } catch (e) {
    const ipc = toIpcError(e);
    if (ipc.code === "cancelled") return;
    window.alert(ipc.message);
  }
}
```

注意：读 Explorer.tsx:198-218 确认实际实现，可能用的是 `openFileByPath` 而不是 `openPath`，照搬原代码。`toIpcError` 的实际路径读现有 import 确认。

- [ ] **Step 11: 实现 SearchPanel 组件**

Create `src/components/Search/SearchPanel.tsx`:

```typescript
import { useEffect, useMemo, useState } from "react";
import { useSearchStore } from "../../store/searchStore";
import { useWorkspaceStore } from "../../store/workspaceStore";

export function SearchPanel() {
  const { query, isRegex, caseSensitive, wholeWord, results, searching, error, setQuery, setOption, run, clear, hide } = useSearchStore();
  const rootPath = useWorkspaceStore((s) => s.rootPath);

  // 防抖搜索（300ms）
  useEffect(() => {
    if (!query.trim()) return;
    const t = setTimeout(() => void run(), 300);
    return () => clearTimeout(t);
  }, [query, isRegex, caseSensitive, wholeWord, run]);

  // 按文件分组
  const grouped = useMemo(() => {
    const m = new Map<string, typeof results>();
    for (const h of results) {
      const arr = m.get(h.relative) ?? [];
      arr.push(h);
      m.set(h.relative, arr);
    }
    return [...m.entries()];
  }, [results]);

  return (
    <div className="search-panel">
      <div className="search-header">
        <input
          className="search-input"
          placeholder="Search in workspace…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void run();
            if (e.key === "Escape") hide();
          }}
          autoFocus
        />
        <div className="search-options">
          <button className={caseSensitive ? "active" : ""} onClick={() => setOption("caseSensitive", !caseSensitive)} title="Match Case">Aa</button>
          <button className={wholeWord ? "active" : ""} onClick={() => setOption("wholeWord", !wholeWord)} title="Whole Word">W</button>
          <button className={isRegex ? "active" : ""} onClick={() => setOption("isRegex", !isRegex)} title="Regex">.*</button>
        </div>
        <button className="search-close" onClick={hide} title="Close">×</button>
      </div>
      <div className="search-results">
        {searching && <div className="search-status">Searching…</div>}
        {error && <div className="search-error">{error}</div>}
        {!searching && !error && results.length === 0 && query.trim() && (
          <div className="search-status">No results</div>
        )}
        {grouped.map(([file, hits]) => (
          <div key={file} className="search-file-group">
            <div className="search-file-name">{file} <span className="search-hit-count">({hits.length})</span></div>
            {hits.map((h, i) => (
              <button
                key={i}
                className="search-hit-row"
                onClick={() => handleHitClick(rootPath, h.relative, h.line, h.column)}
              >
                <span className="search-hit-line">L{h.line}</span>
                <span className="search-hit-text">{renderHitText(h.lineText, h.matchStart, h.matchEnd)}</span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function renderHitText(line: string, start: number, end: number) {
  return (
    <>
      {line.slice(0, start)}
      <mark>{line.slice(start, end)}</mark>
      {line.slice(end)}
    </>
  );
}

async function handleHitClick(rootPath: string | null, relative: string, line: number, column: number) {
  if (!rootPath) return;
  const abs = joinPath(rootPath, relative);
  await import("../../lib/openFile").then((m) => m.openFile(abs));
  // 跳转到行 — 通过全局 editorApiRef
  const { editorApiRef } = await import("../Editor/editorApiRef");
  editorApiRef.current?.revealLine(line, column);
}

function joinPath(root: string, rel: string): string {
  // 简单 join，跨平台
  const sep = root.includes("/") && !root.includes("\\") ? "/" : "\\";
  return root + sep + rel.replace(/\//g, sep);
}
```

注意：`editorApiRef` 需要从 `EditorArea` 暴露出来。读现有代码确认它是否已经存在 module-level ref，或者需要新建。如果不存在，需要新建 `src/components/Editor/editorApiRef.ts`（一个 `createRef<MonacoEditorApi>`）并在 MonacoEditor 里赋值。

- [ ] **Step 12: 创建 search 扩展**

Create `src/extensions/search/index.ts`:

```typescript
import { Search } from "lucide-react";
import { lazy } from "react";
import type { HostApi } from "../api";
import { useSearchStore } from "../../store/searchStore";

// SearchPanel 是底部面板，不是 sidebar 视图，但仍注册一个 view（点击会显示底部面板）
const SearchView = lazy(() =>
  import("../../components/Search/SearchPanel").then((m) => ({ default: m.SearchPanel })),
);

export default function activate(ctx: HostApi): void {
  // 注意：Search 是底部面板，不走 Activity Bar 的标准 sidebar 渲染。
  // 这里注册一个 view 只是为了在 Activity Bar 有图标入口。
  // Workbench 渲染时需要识别 search view 并把它放到底部面板而非 sidebar。
  // MVP 简化：注册 view，但实际渲染由 Workbench 特殊处理。
  ctx.registerView({
    id: "workbench.search",
    title: "Search",
    icon: Search,
    component: () => Promise.resolve({ default: SearchView }),
    order: 10,
    when: "workspace",
  });

  ctx.registerCommand({
    id: "workbench.action.findInFiles",
    title: "Find in Files",
    category: "Search",
    keybinding: "CmdOrCtrl+Shift+F",
    handler: () => useSearchStore.getState().toggle(),
  });
}
```

Create `src/extensions/search/extension.json`:

```json
{
  "name": "search",
  "version": "0.1.0",
  "displayName": "Search",
  "description": "Cross-file search in the workspace",
  "main": "./index.ts",
  "contributes": {
    "views": [{ "id": "workbench.search", "title": "Search", "icon": "search", "order": 10, "when": "workspace" }],
    "commands": [{ "id": "workbench.action.findInFiles", "title": "Find in Files", "category": "Search" }]
  }
}
```

- [ ] **Step 13: Workbench 集成底部面板**

Modify `src/components/Shell/Workbench.tsx`。把 return 改成嵌套 vertical Allotment：

```tsx
import { Allotment } from "allotment";
import { ActivityBar } from "./ActivityBar";
import { Sidebar } from "../Sidebar/Sidebar";
import { EditorArea } from "./EditorArea";
import { SearchPanel } from "../Search/SearchPanel";
import { useUiStore } from "../../store/uiStore";
import { useSearchStore } from "../../store/searchStore";

export function Workbench() {
  // ... 现有 hooks
  const searchVisible = useSearchStore((s) => s.visible);

  return (
    <div className="workbench">
      <ActivityBar />
      <Allotment vertical proportionalLayout={false}>
        <Allotment.Pane minSize={200}>
          <Allotment proportionalLayout={false}>
            <Allotment.Pane minSize={0} preferredSize={220} maxSize={520} visible={showSidebar} snap>
              <Sidebar />
            </Allotment.Pane>
            <Allotment.Pane minSize={320}>
              <EditorArea />
            </Allotment.Pane>
          </Allotment>
        </Allotment.Pane>
        <Allotment.Pane minSize={100} preferredSize={240} visible={searchVisible} snap>
          <SearchPanel />
        </Allotment.Pane>
      </Allotment>
    </div>
  );
}
```

**关键**：保留原 Allotment 的 `min/max/preferredSize 常量 + visible + snap` 模式（Workbench.tsx:94-102 注释的陷阱）。

- [ ] **Step 14: ActivityBar 点击 search 时显示底部面板（特殊处理）**

ActivityBar 点击 search 时，应该调 `searchStore.toggle()` 而不是 setActiveView。修改 ActivityBar：

```tsx
// 在 onClick 里加特判
onClick={() => {
  if (v.id === "workbench.search") {
    useSearchStore.getState().toggle();
  } else {
    toggleView(v.id);
  }
}}
```

或者更干净：让 search 扩展注册 view 时带一个标记 `panelLocation: "bottom"`，ActivityBar 读这个标记决定行为。MVP 用特判即可。

- [ ] **Step 15: 菜单 + 快捷键**

Modify `src-tauri/src/ipc/menu.rs`，在 `ids` 模块加 `pub const FIND_IN_FILES: &str = "workbench.action.findInFiles";`，在 View 菜单或 Edit 菜单加：

```rust
&MenuItem::with_id(app, ids::FIND_IN_FILES, "Find in Files", true, Some("CmdOrCtrl+Shift+F"))?,
```

Modify `src/hooks/useAppCommands.ts` 的 keydown 捕获器，加：

```typescript
if (mod && e.shiftKey && e.key.toLowerCase() === "f") {
  e.preventDefault();
  e.stopPropagation();
  await dispatch("workbench.action.findInFiles");
  return;
}
```

注意 dispatch 会查 registry 找到 search 扩展注册的命令。

- [ ] **Step 16: 加 CSS**

Modify `src/styles/global.css`，参考 `.diagnostics*` 风格加：

```css
.search-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--color-canvas);
  border-top: 1px solid var(--color-hairline);
}

.search-header {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--color-hairline);
}

.search-input {
  flex: 1 1 auto;
  font: var(--text-body);
  padding: 4px 8px;
  border: 1px solid var(--color-hairline);
  border-radius: var(--radius-sm);
  background: var(--color-canvas);
}

.search-options {
  display: flex;
  gap: 4px;
}

.search-options button {
  width: 24px;
  height: 24px;
  border: 1px solid transparent;
  background: transparent;
  border-radius: var(--radius-sm);
  cursor: pointer;
  font: var(--text-caption);
  color: var(--color-text-muted);
}

.search-options button.active {
  background: var(--color-accent-soft);
  border-color: var(--color-accent);
  color: var(--color-text);
}

.search-close {
  width: 24px;
  height: 24px;
  border: none;
  background: transparent;
  cursor: pointer;
  color: var(--color-text-muted);
  font-size: 18px;
}

.search-results {
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 4px 0;
}

.search-file-group {
  margin-bottom: 4px;
}

.search-file-name {
  font: var(--text-caption-strong);
  padding: 4px 12px;
  color: var(--color-text);
}

.search-hit-count {
  color: var(--color-text-muted);
  font-weight: normal;
}

.search-hit-row {
  display: flex;
  width: 100%;
  text-align: left;
  border: none;
  background: transparent;
  padding: 2px 12px 2px 24px;
  cursor: pointer;
  gap: 8px;
  font: var(--text-mono);
  font-size: 12px;
}

.search-hit-row:hover {
  background: var(--color-hover);
}

.search-hit-line {
  flex: 0 0 auto;
  color: var(--color-text-muted);
}

.search-hit-text {
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.search-hit-text mark {
  background: var(--color-accent-soft);
  color: inherit;
}

.search-status, .search-error {
  padding: 8px 12px;
  color: var(--color-text-muted);
  font: var(--text-caption);
}

.search-error {
  color: var(--color-error);
}
```

注意：上面用到的 `--color-accent-soft`、`--text-mono` 等 token 需要确认存在。读 `global.css` 顶部 `:root` token 定义，不存在则用最接近的替代。

- [ ] **Step 17: 编译 + 测试**

Run: `cd src-tauri && cargo build`
Run: `npx vitest run`
Expected: 编译通过 + 所有前端测试通过。

- [ ] **Step 18: 提交**

```bash
git add -A
git commit -m "feat: Search view with cross-file search backend (Phase 3)

Adds walkdir+regex based search_workspace Tauri command, a SearchStore
(debounced query), a bottom SearchPanel (Allotment vertical layout in
Workbench), and a 'search' in-tree extension registering the view and the
Find-in-Files command (Cmd/Ctrl+Shift+F). Clicking a hit opens the file and
reveals the line. No cross-file replace in this phase."
```

---

## 阶段 4：Source Control（Git）视图

**Goal:** Cmd+Shift+G 唤起，展示变更列表、stage/unstage、提交、最近 log。

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Create: `src-tauri/src/domain/git_status.rs`
- Create: `src-tauri/src/git/mod.rs`
- Create: `src-tauri/src/git/status.rs`
- Create: `src-tauri/src/git/operations.rs`
- Create: `src-tauri/src/ipc/git_commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/domain/mod.rs`（如有）
- Create: `src/store/gitStore.ts`
- Create: `src/components/SourceControl/SourceControlPanel.tsx`
- Create: `src/extensions/source-control/index.ts`
- Create: `src/extensions/source-control/extension.json`
- Modify: `src/lib/tauri.ts`
- Modify: `src-tauri/src/ipc/menu.rs`
- Modify: `src/hooks/useAppCommands.ts`
- Modify: `src/styles/global.css`

- [ ] **Step 1: 添加 gix 依赖 + 验证无重复**

Modify `src-tauri/Cargo.toml`:

```toml
# Pure-Rust Git implementation for the Source Control view (§…).
# Repository is Send but NOT Sync — never stored in AppState; re-discover per call.
gix = { version = "0.85", features = ["status", "index"] }
```

Run: `cd src-tauri && cargo tree -d 2>&1 | grep -i gix`
Expected: 不应该出现两套不同版本的 gix 子 crate（若有重复，需要 pin 版本对齐）。

- [ ] **Step 2: 写 Git domain 类型**

Create `src-tauri/src/domain/git_status.rs`:

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default, PartialEq, Eq)]
#[cfg_attr(feature = "export-types", derive(ts_rs::TS), ts(export_to = "../../src/lib/types.ts"))]
#[serde(rename_all = "kebab-case")]
pub enum GitStatusKind {
    #[default]
    Unchanged,
    Modified,
    Added,
    Deleted,
    Untracked,
    Renamed,
    TypeChanged,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "export-types", derive(ts_rs::TS), ts(export_to = "../../src/lib/types.ts"))]
pub struct GitFileStatus {
    /// 相对工作区根的路径（正斜杠分隔）。
    pub path: String,
    pub staged: GitStatusKind,
    pub unstaged: GitStatusKind,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "export-types", derive(ts_rs::TS), ts(export_to = "../../src/lib/types.ts"))]
pub struct CommitLog {
    /// 完整 40 字符 hex（或短 hash）。
    pub id: String,
    pub message: String,
    pub author: String,
    /// Unix timestamp (seconds)。
    pub time: i64,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "export-types", derive(ts_rs::TS), ts(export_to = "../../src/lib/types.ts"))]
pub struct GitState {
    /// 当前 HEAD 的简短引用名（如 "main" / "master"），detached 时为 commit 短 hash。
    pub head: Option<String>,
    pub changes: Vec<GitFileStatus>,
    pub recent_log: Vec<CommitLog>,
}
```

- [ ] **Step 3: 声明模块**

Modify `src-tauri/src/domain/mod.rs`: 加 `pub mod git_status;`

Create `src-tauri/src/git/mod.rs`:

```rust
pub mod status;
pub mod operations;
```

- [ ] **Step 4: 原型验证 gix status API（先小步确认变体名）**

Create `src-tauri/src/git/status.rs`，先用最小骨架编译通过，然后原型验证：

```rust
use crate::domain::git_status::{GitFileStatus, GitStatusKind};
use anyhow::Result;
use std::collections::HashMap;
use std::path::Path;

/// 收集工作区 git status。返回 None 表示不是 git 仓库。
pub fn collect_status(root: &Path) -> Result<Option<Vec<GitFileStatus>>> {
    let repo = match gix::discover(root) {
        Ok(r) => r,
        Err(_) => return Ok(None),
    };
    let mut by_path: HashMap<String, GitFileStatus> = HashMap::new();

    // TODO: 原型验证 — 用 repo.status(...) 实际跑一次，打印 Item 变体名
    // 先写一个能编译的骨架，跑起来后根据实际输出调整 match 分支
    let platform = repo.status(gix::status::UntrackedFiles::Default)?;
    for item_result in platform.into_iter(None)? {
        let item = item_result?;
        // 这里需要根据 gix 0.85 的实际 Item 枚举 match
        // 原型期先用 todo!() 让编译通过，运行时 panic 后看实际类型
        let _ = item.location();
        // 临时占位
    }

    Ok(Some(by_path.into_values().collect()))
}
```

**实施时**：这一步要让 implementer **实际跑一次** `cargo run` 或写一个临时测试，打印出 `gix::status::Item` 的实际变体，然后**逐字**写出正确的 match 分支映射到 `GitStatusKind`。不要凭记忆写——gix 的内部变体名跨版本变动大。

参考映射逻辑（来自调研）：
- `Item::TreeIndex(Change)` → 填 `staged` 字段：
  - `Change::Add` → `Added`
  - `Change::Delete` → `Deleted`
  - `Change::Modification` → `Modified`
  - 其他 → `Modified`（fallback）
- `Item::IndexWorktree(entry)` → 填 `unstaged` 字段：
  - 内部 EntryStatus 变体（Modified/Added/Deleted/Untracked/...）

- [ ] **Step 5: 实现 operations.rs**

Create `src-tauri/src/git/operations.rs`:

```rust
use anyhow::{Context, Result};
use std::path::Path;

pub fn stage(root: &Path, path: &str) -> Result<()> {
    let repo = gix::discover(root).context("not a git repository")?;
    let mut index = repo.index()?;
    // gix 的 stage API — 实施时验证确切方法名
    // 可能是 index.upsert(...) 或 repo.stage_file(path, ...)
    // 占位：let _ = (repo, index, path);
    Ok(())
}

pub fn unstage(root: &Path, path: &str) -> Result<()> {
    let repo = gix::discover(root).context("not a git repository")?;
    let mut index = repo.index()?;
    // index.delete_entry 或等价
    // 占位：let _ = (repo, index, path);
    Ok(())
}

pub fn commit(root: &Path, message: &str) -> Result<String> {
    let repo = gix::discover(root).context("not a git repository")?;
    let _ = (repo, message);
    // 1. index.write_tree()
    // 2. repo.head_commit() 收集 parents
    // 3. repo.commit("HEAD", author, author, msg, tree, parents)
    // 返回 commit id hex
    todo!("implement after status prototype verified")
}

pub fn log(root: &Path, n: usize) -> Result<Vec<crate::domain::git_status::CommitLog>> {
    let repo = gix::discover(root).context("not a git repository")?;
    let _ = (repo, n);
    todo!("implement after status prototype verified")
}
```

**实施约束**：stage/unstage/commit/log 都需要实际跑通验证。status 是最关键的（决定 UI 能否展示），其他可以渐进实现。如果时间紧，可以只做 status + commit，log/stage/unstage 留作 follow-up（但要诚实标记）。

- [ ] **Step 6: 加 IPC 命令**

Create `src-tauri/src/ipc/git_commands.rs`:

```rust
use crate::domain::git_status::{CommitLog, GitFileStatus, GitState};
use crate::error::AppError;
use crate::ipc::state::AppState;
use tauri::State;

fn no_workspace() -> AppError {
    AppError::Other("no workspace open".into())
}

#[tauri::command]
pub async fn git_status(state: State<'_, AppState>) -> Result<Vec<GitFileStatus>, AppError> {
    let root = state.workspace.root().ok_or_else(no_workspace)?;
    tauri::async_runtime::spawn_blocking(move || {
        crate::git::status::collect_status(&root)
            .map_err(|e| AppError::Other(format!("git status failed: {e}")))?
            .ok_or_else(|| AppError::Other("not a git repository".into()))
    })
    .await
    .map_err(|e| AppError::Other(format!("join error: {e}")))?
}

#[tauri::command]
pub async fn git_stage(state: State<'_, AppState>, path: String) -> Result<(), AppError> {
    let root = state.workspace.root().ok_or_else(no_workspace)?;
    tauri::async_runtime::spawn_blocking(move || {
        crate::git::operations::stage(&root, &path)
            .map_err(|e| AppError::Other(format!("git stage failed: {e}")))
    })
    .await
    .map_err(|e| AppError::Other(format!("join error: {e}")))?
}

#[tauri::command]
pub async fn git_unstage(state: State<'_, AppState>, path: String) -> Result<(), AppError> {
    let root = state.workspace.root().ok_or_else(no_workspace)?;
    tauri::async_runtime::spawn_blocking(move || {
        crate::git::operations::unstage(&root, &path)
            .map_err(|e| AppError::Other(format!("git unstage failed: {e}")))
    })
    .await
    .map_err(|e| AppError::Other(format!("join error: {e}")))?
}

#[tauri::command]
pub async fn git_commit(state: State<'_, AppState>, message: String) -> Result<String, AppError> {
    let root = state.workspace.root().ok_or_else(no_workspace)?;
    tauri::async_runtime::spawn_blocking(move || {
        crate::git::operations::commit(&root, &message)
            .map_err(|e| AppError::Other(format!("git commit failed: {e}")))
    })
    .await
    .map_err(|e| AppError::Other(format!("join error: {e}")))?
}

#[tauri::command]
pub async fn git_log(state: State<'_, AppState>, limit: Option<usize>) -> Result<Vec<CommitLog>, AppError> {
    let root = state.workspace.root().ok_or_else(no_workspace)?;
    let n = limit.unwrap_or(50);
    tauri::async_runtime::spawn_blocking(move || {
        crate::git::operations::log(&root, n)
            .map_err(|e| AppError::Other(format!("git log failed: {e}")))
    })
    .await
    .map_err(|e| AppError::Other(format!("join error: {e}")))?
}
```

Modify `src-tauri/src/lib.rs`：在 `generate_handler!` 加：
```rust
ipc::git_commands::git_status,
ipc::git_commands::git_stage,
ipc::git_commands::git_unstage,
ipc::git_commands::git_commit,
ipc::git_commands::git_log,
```

并在模块声明处加 `mod git;` 和把 `git_commands` 加到 ipc 模块。

- [ ] **Step 7: 前端 store + invoke wrapper**

Modify `src/lib/tauri.ts`:

```typescript
import type { CommitLog, GitFileStatus } from "./types";

export async function gitStatus(): Promise<GitFileStatus[]> {
  return invoke<GitFileStatus[]>("git_status");
}
export async function gitStage(path: string): Promise<void> {
  await invoke<void>("git_stage", { path });
}
export async function gitUnstage(path: string): Promise<void> {
  await invoke<void>("git_unstage", { path });
}
export async function gitCommit(message: string): Promise<string> {
  return invoke<string>("git_commit", { message });
}
export async function gitLog(limit?: number): Promise<CommitLog[]> {
  return invoke<CommitLog[]>("git_log", { limit: limit ?? null });
}
```

Create `src/store/gitStore.ts`:

```typescript
import { create } from "zustand";
import type { CommitLog, GitFileStatus } from "../lib/types";
import { gitStatus, gitStage, gitUnstage, gitCommit, gitLog } from "../lib/tauri";
import { onFsChanged } from "../lib/tauri";

export interface GitState {
  changes: GitFileStatus[];
  recentLog: CommitLog[];
  loading: boolean;
  error: string | null;
  isRepo: boolean;

  refresh: () => Promise<void>;
  stage: (path: string) => Promise<void>;
  unstage: (path: string) => Promise<void>;
  commit: (message: string) => Promise<void>;
}

export const useGitStore = create<GitState>((set, get) => ({
  changes: [],
  recentLog: [],
  loading: false,
  error: null,
  isRepo: true,

  refresh: async () => {
    set({ loading: true, error: null });
    try {
      const [changes, recentLog] = await Promise.all([
        gitStatus().catch(() => []),  // 非 repo 返回空，不报错
        gitLog(5).catch(() => []),
      ]);
      const isRepo = changes !== null;
      set({ changes: changes ?? [], recentLog: recentLog ?? [], isRepo, loading: false });
    } catch (e) {
      set({ loading: false, error: e instanceof Error ? e.message : String(e) });
    }
  },

  stage: async (path) => {
    await gitStage(path);
    await get().refresh();
  },

  unstage: async (path) => {
    await gitUnstage(path);
    await get().refresh();
  },

  commit: async (message) => {
    await gitCommit(message);
    await get().refresh();
  },
}));

// 订阅 fs_changed 自动刷新（工作区文件变化时）
let fsChangedOff: (() => void) | null = null;
export function initGitAutoRefresh() {
  if (fsChangedOff) return;
  fsChangedOff = onFsChanged(() => {
    void useGitStore.getState().refresh();
  });
}
```

注意：`gitStatus` 在非 repo 时后端返回 Err，前端 catch 成空数组。如果后端改成返回 Option，前端相应调整。

- [ ] **Step 8: 实现 SourceControlPanel**

Create `src/components/SourceControl/SourceControlPanel.tsx`:

```typescript
import { useEffect, useState } from "react";
import { useGitStore } from "../../store/gitStore";

export function SourceControlPanel() {
  const { changes, recentLog, loading, error, isRepo, refresh, stage, unstage, commit } = useGitStore();
  const [message, setMessage] = useState("");

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!isRepo && !loading) {
    return (
      <div className="scm-empty">
        <p>Not a git repository.</p>
        <p className="scm-hint">Open a folder containing a .git directory to enable source control.</p>
      </div>
    );
  }

  const staged = changes.filter((c) => c.staged !== "unchanged" && c.staged !== "untracked" || c.staged === "added");
  const unstaged = changes.filter((c) => c.unstaged !== "unchanged");

  return (
    <div className="scm-panel">
      <div className="scm-header">
        <span className="scm-title">Source Control</span>
        <button className="scm-refresh" onClick={() => void refresh()} title="Refresh">⟳</button>
      </div>
      <div className="scm-commit-box">
        <textarea
          className="scm-message"
          placeholder="Message (press Ctrl+Enter to commit)"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && message.trim()) {
              void commit(message).then(() => setMessage(""));
            }
          }}
          rows={2}
        />
        <button
          className="scm-commit-btn"
          disabled={!message.trim() || staged.length === 0}
          onClick={() => void commit(message).then(() => setMessage(""))}
        >
          Commit
        </button>
      </div>

      {error && <div className="scm-error">{error}</div>}

      <div className="scm-changes">
        {loading && <div className="scm-status">Loading…</div>}

        {unstaged.length > 0 && (
          <div className="scm-section">
            <div className="scm-section-title">Changes ({unstaged.length})</div>
            {unstaged.map((c) => (
              <div key={c.path} className="scm-row">
                <span className={`scm-status-badge scm-status-${c.unstaged}`}>{letterFor(c.unstaged)}</span>
                <span className="scm-path">{c.path}</span>
                <button className="scm-action" onClick={() => void stage(c.path)} title="Stage">+</button>
              </div>
            ))}
          </div>
        )}

        {staged.length > 0 && (
          <div className="scm-section">
            <div className="scm-section-title">Staged Changes ({staged.length})</div>
            {staged.map((c) => (
              <div key={c.path} className="scm-row">
                <span className={`scm-status-badge scm-status-${c.staged}`}>{letterFor(c.staged)}</span>
                <span className="scm-path">{c.path}</span>
                <button className="scm-action" onClick={() => void unstage(c.path)} title="Unstage">−</button>
              </div>
            ))}
          </div>
        )}

        {!loading && changes.length === 0 && (
          <div className="scm-status">No changes</div>
        )}
      </div>

      {recentLog.length > 0 && (
        <div className="scm-log">
          <div className="scm-section-title">Recent Commits</div>
          {recentLog.map((c) => (
            <div key={c.id} className="scm-log-row">
              <span className="scm-log-msg">{c.message}</span>
              <span className="scm-log-author">{c.author}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function letterFor(kind: string): string {
  switch (kind) {
    case "modified": return "M";
    case "added": return "A";
    case "deleted": return "D";
    case "untracked": return "U";
    case "renamed": return "R";
    case "type-changed": return "T";
    default: return " ";
  }
}
```

- [ ] **Step 9: 创建 source-control 扩展**

Create `src/extensions/source-control/index.ts`:

```typescript
import { GitBranch } from "lucide-react";
import { lazy } from "react";
import type { HostApi } from "../api";
import { useGitStore, initGitAutoRefresh } from "../../store/gitStore";

const SourceControlView = lazy(() =>
  import("../../components/SourceControl/SourceControlPanel").then((m) => ({ default: m.SourceControlPanel })),
);

export default function activate(ctx: HostApi): void {
  ctx.registerView({
    id: "workbench.scm",
    title: "Source Control",
    icon: GitBranch,
    component: () => Promise.resolve({ default: SourceControlView }),
    order: 20,
    when: "workspace",
  });

  ctx.registerCommand({
    id: "workbench.view.scm",
    title: "Show Source Control",
    category: "View",
    keybinding: "CmdOrCtrl+Shift+G",
    handler: () => {
      // 激活 SCM 视图
      const { setActiveView } = require("../../store/uiStore").useUiStore.getState();
      setActiveView("workbench.scm");
      // 首次激活时初始化 auto refresh
      initGitAutoRefresh();
    },
  });

  ctx.registerCommand({
    id: "git.refresh",
    title: "Git: Refresh",
    category: "Git",
    handler: () => useGitStore.getState().refresh(),
  });

  ctx.registerCommand({
    id: "git.commit",
    title: "Git: Commit",
    category: "Git",
    handler: () => {
      // Commit 需要消息，UI 里走 textarea；这里只 focus 到输入框
      // 简化：让用户在面板里操作
    },
  });
}
```

注意：上面用了 `require`，应该改成 ESM `import`。修正：在文件顶部 `import { useUiStore } from "../../store/uiStore";`。

Create `src/extensions/source-control/extension.json`:

```json
{
  "name": "source-control",
  "version": "0.1.0",
  "displayName": "Source Control",
  "description": "Git integration for the workspace",
  "main": "./index.ts",
  "contributes": {
    "views": [{ "id": "workbench.scm", "title": "Source Control", "icon": "git-branch", "order": 20, "when": "workspace" }],
    "commands": [
      { "id": "workbench.view.scm", "title": "Show Source Control", "category": "View" },
      { "id": "git.refresh", "title": "Git: Refresh", "category": "Git" },
      { "id": "git.commit", "title": "Git: Commit", "category": "Git" }
    ]
  }
}
```

- [ ] **Step 10: 菜单 + 快捷键**

Modify `src-tauri/src/ipc/menu.rs`：加 `pub const SOURCE_CONTROL: &str = "workbench.view.scm";` 到 ids，在 View 菜单加 `&MenuItem::with_id(app, ids::SOURCE_CONTROL, "Source Control", true, Some("CmdOrCtrl+Shift+G"))?`。

Modify `src/hooks/useAppCommands.ts` keydown 捕获器加 Cmd+Shift+G 分支。

- [ ] **Step 11: 加 CSS**

Modify `src/styles/global.css`，参考 `.diagnostics*` 风格加 `.scm-*` 样式（status badges 用颜色区分：M 黄、A 绿、D 红、U 灰、R 蓝、T 紫）。

- [ ] **Step 12: 编译 + 提交**

Run: `cd src-tauri && cargo build && cargo test --features export-types --quiet`
Run: `npx vitest run`

```bash
git add -A
git commit -m "feat: Source Control (Git) view with gix backend (Phase 4)

Adds git_status/git_stage/git_unstage/git_commit/git_log Tauri commands
backed by gix 0.85 (pure-Rust). Repository is re-discovered per call
(Send but not Sync), all gix I/O on spawn_blocking. SourceControlPanel
shows staged/unstaged changes, commit box, recent log. Non-git workspace
shows a friendly empty state. Cmd/Ctrl+Shift+G activates the view."
```

---

## 阶段 5：Outline 视图

**Goal:** Cmd+Shift+O 唤起大纲，展示当前文档 heading 树，点击跳转。

**Files:**
- Create: `src-tauri/src/domain/outline.rs`
- Create: `src-tauri/src/render/outline.rs`
- Modify: `src-tauri/src/domain/mod.rs`
- Modify: `src-tauri/src/render/mod.rs`
- Modify: `src-tauri/src/ipc/events.rs`（CompiledPayload 加 outline）
- Modify: `src-tauri/src/service/editor_service.rs`（emit_compiled 签名）
- Modify: `src-tauri/src/service/compile_service.rs`（调用 build_outline）
- Modify: `src/store/documentsStore.ts`
- Modify: `src/store/tabsStore.ts`
- Modify: `src/hooks/useTypstCompile.ts`
- Create: `src/components/Outline/OutlinePanel.tsx`
- Create: `src/extensions/outline/index.ts`
- Create: `src/extensions/outline/extension.json`
- Modify: `src-tauri/src/ipc/menu.rs`
- Modify: `src/hooks/useAppCommands.ts`
- Modify: `src/styles/global.css`

- [ ] **Step 1: 写 OutlineNode 类型**

Create `src-tauri/src/domain/outline.rs`:

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "export-types", derive(ts_rs::TS), ts(export_to = "../../src/lib/types.ts"))]
pub struct OutlineNode {
    /// 1-indexed 源码行号（与 LineRect.line / Diagnostic 同口径）。
    pub line: u32,
    /// 绝对层级（1 = H1）。
    pub level: u32,
    /// 标题纯文本。
    pub title: String,
    /// 编号文本（如 "1.2.3"），无编号则 None。
    pub numbering: Option<String>,
    /// 在同一 Vec 内的父节点索引；顶层为 None。
    pub parent: Option<u32>,
}
```

- [ ] **Step 2: 声明模块**

Modify `src-tauri/src/domain/mod.rs`: 加 `pub mod outline;`
Modify `src-tauri/src/render/mod.rs`: 加 `pub mod outline;`

- [ ] **Step 3: 实现 build_outline**

Create `src-tauri/src/render/outline.rs`:

```rust
use crate::domain::outline::OutlineNode;
use crate::typst_engine::world::EditorWorld;

/// 从编译后的文档抽取 heading 列表。
///
/// 用 introspector query 拿所有 HeadingElem（已在 Synthesize 阶段计算出
/// 绝对 level），过滤 outlined:false，用 span_to_line 拿行号，单调栈算 parent。
pub fn build_outline(
    doc: &typst_layout::PagedDocument,
    world: &EditorWorld,
) -> Vec<OutlineNode> {
    // 原型验证：先确认 Selector::can::<HeadingElem>() 在 typst 0.15 的确切 API
    // 可能是 Selector::can::<T>() 或 Selector::elem::<T>()
    // 占位实现，实施时验证
    let _ = (doc, world);
    Vec::new()
}
```

**实施时**：先写一个临时测试或 `cargo run` 例子，确认 `doc.introspector()` 返回的对象有 `query` 方法，且 `Selector::can::<HeadingElem>()` 构造成功。然后实现：

```rust
use typst::foundations::Selector;
use typst_library::model::HeadingElem;

pub fn build_outline(
    doc: &typst_layout::PagedDocument,
    world: &EditorWorld,
) -> Vec<OutlineNode> {
    let introspector = doc.introspector();
    let selector = Selector::can::<HeadingElem>(); // 验证确切 API
    let mut nodes: Vec<OutlineNode> = Vec::new();
    // 单调栈：stack 里存 (level, index)
    let mut stack: Vec<(u32, u32)> = Vec::new();

    for content in introspector.query(&selector) {
        // 从 Content 拿 HeadingElem 的字段
        // content.to_packed::<HeadingElem>() 或等价
        // let level = heading.resolve_level(...).get() as u32;
        // let title = heading.body.plain_text().to_string();
        // let numbering = heading.numbers...
        // let outlined = heading.outlined...; if !outlined continue;
        // let span = content.span();
        // let line = span_to_line(span, world)?;
        let _ = content;
        // TODO: 实际实现
    }

    nodes
}
```

**实施约束**：这一步是整个 outline 功能的核心，需要 implementer 实际跑通验证 typst 0.15 的确切 API。读 `~/.cargo/registry/src/.../typst-library-0.15.0/src/model/heading.rs` 确认 `HeadingElem` 字段名（`level`/`body`/`numbers`/`outlined`）和 `Selector` 构造方式。

- [ ] **Step 4: CompiledPayload 加 outline 字段**

Modify `src-tauri/src/ipc/events.rs`：

找到 `CompiledPayload` 结构体，加字段：
```rust
pub outline: Vec<crate::domain::outline::OutlineNode>,
```

同步更新 `compiled_payload_is_camel_case` 测试（在测试里加 outline 字段）。

- [ ] **Step 5: emit_compiled 签名 + 所有 impl 同步**

Modify `src-tauri/src/service/editor_service.rs`：

找到 `Emitter` trait 的 `emit_compiled` 方法签名，加 `outline: Vec<crate::domain::outline::OutlineNode>` 参数。

更新所有实现：`CapturingEmitter`、`RecordingEmitter`、真实的 emitter。每个实现里把 outline 字段塞进 payload。

- [ ] **Step 6: compile_service 调用 build_outline**

Modify `src-tauri/src/service/compile_service.rs`：

在 `build_source_map` 调用处旁（约 line 298），加：

```rust
let outline = crate::render::outline::build_outline(&doc, &tab.world);
```

然后传给 `emit_compiled`：

```rust
emit_compiled(..., outline);
```

- [ ] **Step 7: 重生类型 + 编译**

Run: `cd src-tauri && cargo build && cargo test --features export-types --quiet`
Expected: 编译通过 + `types.ts` 追加 `OutlineNode`。

- [ ] **Step 8: 前端 Document 接口加 outline**

Modify `src/store/documentsStore.ts`：

找到 `Document` 接口定义，加字段：
```typescript
import type { OutlineNode } from "../lib/types";

// 在 Document 接口里加：
outline: OutlineNode[];
```

`documentFromOpened` 初值 `outline: []`。
`setPages` 签名加 `outline: OutlineNode[]` 参数，赋值给 document。

- [ ] **Step 9: tabsStore.setPages 转发**

Modify `src/store/tabsStore.ts`：

`setPages` 签名加 `outline` 参数，转发给 `documentsStore.setPages`。

- [ ] **Step 10: useTypstCompile 透传 outline**

Modify `src/hooks/useTypstCompile.ts`：

`onCompiled` 回调里，把 `p.outline` 透传给 `setPages`。

- [ ] **Step 11: 实现 OutlinePanel**

Create `src/components/Outline/OutlinePanel.tsx`:

```typescript
import { useMemo } from "react";
import { useTabsStore } from "../../store/tabsStore";
import { readOrderedDocuments } from "../../store/tabsStore";
import type { OutlineNode } from "../../lib/types";

export function OutlinePanel() {
  const activeId = useTabsStore((s) => s.activeId);
  const documents = useTabsStore((s) => s.documents);

  const outline = useMemo(() => {
    if (!activeId) return [];
    const doc = (readOrderedDocuments as never)?.(documents) ?? [];
    const found = doc.find((d: { id: string }) => d.id === activeId);
    return found?.outline ?? [];
  }, [activeId, documents]);

  if (outline.length === 0) {
    return <div className="outline-empty">No headings</div>;
  }

  return (
    <div className="outline-panel">
      {outline.map((node, i) => (
        <button
          key={i}
          className="outline-row"
          style={{ paddingLeft: 12 + (node.level - 1) * 16 }}
          onClick={() => handleOutlineClick(node.line)}
        >
          {node.numbering && <span className="outline-numbering">{node.numbering}</span>}
          <span className="outline-title">{node.title}</span>
        </button>
      ))}
    </div>
  );
}

async function handleOutlineClick(line: number) {
  const { editorApiRef } = await import("../Editor/editorApiRef");
  editorApiRef.current?.revealLine(line, 1);
}
```

注意：`documents` 的访问方式需要读现有 `documentsStore` 确认。`readOrderedDocuments` 可能不是 store 的部分而是 helper。读现有代码确认正确访问方式。

- [ ] **Step 12: 创建 outline 扩展**

Create `src/extensions/outline/index.ts`:

```typescript
import { List } from "lucide-react";
import { lazy } from "react";
import type { HostApi } from "../api";
import { useUiStore } from "../../store/uiStore";

const OutlineView = lazy(() =>
  import("../../components/Outline/OutlinePanel").then((m) => ({ default: m.OutlinePanel })),
);

export default function activate(ctx: HostApi): void {
  ctx.registerView({
    id: "workbench.outline",
    title: "Outline",
    icon: List,
    component: () => Promise.resolve({ default: OutlineView }),
    order: 30,
    when: "always",
  });

  ctx.registerCommand({
    id: "workbench.view.outline",
    title: "Show Outline",
    category: "View",
    keybinding: "CmdOrCtrl+Shift+O",
    handler: () => useUiStore.getState().setActiveView("workbench.outline"),
  });
}
```

Create `src/extensions/outline/extension.json`:

```json
{
  "name": "outline",
  "version": "0.1.0",
  "displayName": "Outline",
  "description": "Document heading tree",
  "main": "./index.ts",
  "contributes": {
    "views": [{ "id": "workbench.outline", "title": "Outline", "icon": "list", "order": 30, "when": "always" }],
    "commands": [{ "id": "workbench.view.outline", "title": "Show Outline", "category": "View" }]
  }
}
```

- [ ] **Step 13: 菜单 + 快捷键 + CSS**

Modify `src-tauri/src/ipc/menu.rs`：加 `pub const OUTLINE: &str = "workbench.view.outline";`，View 菜单加项。
Modify `src/hooks/useAppCommands.ts` keydown 捕获器加 Cmd+Shift+O 分支。
Modify `src/styles/global.css` 加 `.outline-panel`/`.outline-row`/`.outline-numbering`/`.outline-title`/`.outline-empty`。

- [ ] **Step 14: 编译 + 测试 + 提交**

Run: `cd src-tauri && cargo build && cargo test --quiet`
Run: `npx vitest run`

```bash
git add -A
git commit -m "feat: Outline view from typst introspector (Phase 5)

Adds build_outline() in the render pipeline that queries the typst
introspector for HeadingElem (filtered by outlined=true), resolves source
lines via span_to_line, and ships the heading tree as part of the compiled
event payload (same revision as source_map). Frontend OutlinePanel renders
the flat array with parent indices as an indented tree; clicking a heading
reveals the line in the editor. Cmd/Ctrl+Shift+O activates the view."
```

---

## 风险与对策

- **Allotment visible 陷阱**：min/max/preferredSize 必须常量，只切 visible。
- **gix Repository 非 Sync**：绝不存 AppState，每次 discover，全 spawn_blocking。
- **gix `index_worktree::Item` 变体名**：阶段 4 Step 4 先原型验证，不凭记忆写。
- **typst `Selector::can` API**：阶段 5 Step 3 先原型验证。
- **菜单 check 单向同步**：阶段 1 暂不加 set_checked IPC。
- **Activity Bar when 条件**：MVP 只支持 'workspace' | 'always'。
- **ts-rs 类型同步**：每阶段后跑 `cargo test --features export-types`。

## 不在范围

- 运行时第三方插件加载
- 跨文件替换
- 多 main 文档/typst.toml 包管理
- 命令面板（阶段 6，未列入本计划）
