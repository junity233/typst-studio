# Typst Studio

> 面向 Typst 的原生桌面编辑器，强调本地优先、实时预览和写作流畅度。

[English README](README.md)

![status](https://img.shields.io/badge/status-WIP-yellow)
![license](https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-blue)
![platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey)

![Typst Studio icon](app-icon.png)

## 项目简介

**Typst Studio** 是一个为 [Typst](https://typst.app) 打造的跨平台桌面编辑器。它使用 `Tauri 2 + React + Rust` 构建，并直接内嵌官方 Typst 编译器，因此你在编辑、预览和导出文档时，不需要额外依赖 Typst CLI。

它的目标不是把 Typst 塞进一个通用代码编辑器里，而是提供一套更适合写作、排版和文档整理的桌面体验：左侧代码编辑，右侧实时多页预览，同时带有工作区、搜索、大纲、导出、恢复和主题能力。

## 适合谁

- 希望用桌面应用写 Typst，而不是浏览器或纯命令行的用户
- 想要一边写源码一边看排版结果的用户
- 需要本地文件夹、文档搜索、大纲导航和导出能力的用户
- 想保留“文件就在本机上”的工作方式，不依赖云同步的用户

## 核心亮点

- **内嵌官方 Typst 编译器**  
  打开应用即可编译、预览和导出 Typst 文档，无需先安装 Typst CLI。

- **实时多页预览**  
  编辑内容后会自动刷新预览，并支持多页 SVG 预览。

- **预览与源码联动**  
  支持编辑器与预览同步滚动，预览中双击可跳回对应源码行。

- **工作区体验**  
  可打开整个文件夹进行写作，使用资源管理器浏览文件、创建、重命名或删除条目，并支持最近工作区。

- **写作导航**  
  内置大纲视图，可按标题结构浏览文档；支持跨文件搜索。

- **导出能力**  
  支持导出 `PDF`、`PNG` 和 `SVG`。

- **更安全的保存与恢复**  
  提供自动保存模式、会话恢复、崩溃恢复，以及外部文件变更冲突处理。

- **主题与语言**  
  提供内置主题、可热重载的自定义 CSS 主题，以及英文/简体中文界面。

## 你现在可以做什么

- 打开单个 `.typ` 文件或整个 Typst 项目文件夹
- 在多标签页中编辑多个文档
- 使用格式工具栏快速插入标题、列表、表格、链接和图片
- 将富文本粘贴内容转换为 Typst 标记
- 查看诊断信息，并在问题位置之间跳转
- 打开 `.typ` 文件时复用已运行实例，而不是反复启动新窗口

## 快速开始

### 1. 打开文档或文件夹

- 如果你只是修改单个文档，可以直接打开 `.typ` 文件
- 如果你在写完整项目，推荐打开整个文件夹

### 2. 在左侧编辑，在右侧预览

- 左侧是 Monaco 编辑器
- 右侧是多页预览区域
- 你可以按需隐藏或显示侧边栏、预览区

### 3. 使用侧边栏完成导航

- `Explorer`：浏览工作区文件
- `Search`：全文搜索
- `Outline`：按文档标题结构跳转

### 4. 导出成最终文档

从原生菜单中可以导出为：

- `PDF`
- `PNG`
- `SVG`

## 常用快捷键

> macOS 使用 `Cmd`，Windows/Linux 使用 `Ctrl`。

- `Cmd/Ctrl + S`：保存当前文档
- `Cmd/Ctrl + Shift + S`：另存为
- `Cmd/Ctrl + B`：切换侧边栏
- `Cmd/Ctrl + Shift + F`：在文件中搜索
- `Cmd/Ctrl + Shift + O`：打开大纲

## 安装方式

### 方式一：使用发布包

当仓库的 [Releases](../../releases) 页面提供安装包时，直接下载对应平台版本即可。

支持的目标平台：

- macOS
- Windows
- Linux

> 仓库已经包含跨平台打包工作流。如果当前还没有可下载版本，请使用下面的源码方式运行。

### 方式二：从源码运行

#### 依赖

- `Node.js 20+`
- `Rust 1.92+`
- 对应平台的 Tauri 运行/编译依赖

请先查看官方 Tauri 依赖说明：

- [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)

#### 开发运行

```bash
npm install
npm run tauri dev
```

#### 打包构建

```bash
npm run tauri build
```

构建产物会生成在 `src-tauri/target/release/bundle/`。

## 可选组件

### Tinymist 语言服务

Typst Studio 内置了对 Tinymist 的语言服务接入，但 Tinymist 本身并不是随应用一起打包的。

如果你希望获得更完整的语言服务体验，请单独安装 `tinymist`，并确保它可以在系统 `PATH` 中被找到。

## 个性化设置

### 主题

项目提供多种内置主题，也支持用户自定义主题文件夹。自定义主题保存后会自动热重载，不需要重启应用。

主题文档见：

- [docs/themes.md](docs/themes.md)

### 语言

目前界面支持：

- English
- 简体中文

### 可调设置

可以在设置窗口中调整的内容包括：

- 编辑器字体、字号、行高、换行、缩略图、空白字符显示
- 编译与编辑防抖
- 自动保存策略
- 预览缩放、背景和页边距
- 搜索结果上限
- 导出 PNG 分辨率
- 额外字体目录

## 数据与隐私

Typst Studio 是本地优先应用。你的文档仍然保存在本机文件系统中。

应用还会在本地保存少量辅助数据，用于提升可恢复性和使用体验，例如：

- 设置
- 最近工作区
- 上次会话状态
- 崩溃恢复快照
- 用户主题

### 崩溃恢复数据位置

恢复快照默认位于应用私有数据目录下的 `recovery/` 子目录：

| Platform | Path |
| --- | --- |
| macOS | `~/Library/Application Support/com.typststudio.app/recovery/` |
| Windows | `%APPDATA%\com.typststudio.app\recovery\` |
| Linux | `~/.local/share/com.typststudio.app/recovery/` |

这些恢复数据不会因为卸载应用而自动删除；你可以在设置里手动清除。

## 当前状态

Typst Studio 目前仍然是一个快速演进中的项目，适合愿意尝鲜的用户。

当前已经有较完整的本地编辑体验，但它还不是一个“所有高级功能都已打磨完毕”的成熟 Typst IDE。

## 已知限制

- 语言服务体验依赖外部 `tinymist` 是否可用
- 自定义主题目前主要作用于应用界面，Monaco 和预览的主题联动还不算完整
- 项目级功能已经可用，但整体体验还在持续完善中
- 这不是云端协作文档工具，当前定位仍然是本地桌面编辑器

## 路线方向

这个项目正在朝着“更像专用 Typst 工作台，而不是泛用代码编辑器”的方向推进。

重点方向包括更稳定的项目工作流、更完整的语言服务体验、更好的主题体系，以及继续打磨桌面端写作细节。

## 许可证

本项目采用 **MIT OR Apache-2.0** 双许可证，与 Typst 项目保持一致。

## 致谢

- [Typst](https://github.com/typst/typst)
- [Tauri](https://tauri.app)
- [Monaco Editor](https://microsoft.github.io/monaco-editor/)
