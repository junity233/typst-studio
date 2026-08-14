# Typst Studio

> 面向 [Typst](https://typst.app) 的原生桌面 IDE —— 左手写作,右手编译,本地优先:无需安装 CLI、不依赖云端。

[English README](README.md)

![status](https://img.shields.io/badge/status-WIP-yellow)
![license](https://img.shields.io/badge/license-MIT-blue)
![platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey)

## 为什么选择 Typst Studio

Typst Studio 在 Rust 后端中内嵌了**官方 Typst 编译器**,配合 Monaco 编辑器与实时多页预览 —— 整个写作闭环都在你的机器上完成,边写边编译、所见即所得。

它不是"恰好能打开 `.typ` 文件的通用代码编辑器",而是一个真正的文档工作台:项目级配置、文献与包管理、全工作区搜索、导出管线、会话恢复与主题系统都是一等公民。

## 功能特性

### 写作与编辑

- **Monaco 编辑器 + Typst 语法高亮** —— 完整键盘操作、自动换行开关,字体/字号/行高/小地图皆可配置。
- **格式工具栏** —— 一键插入标题、加粗/斜体/代码、列表、表格、链接与图片;表格提供可视化网格选择器。
- **公式辅助** —— 引导式插入数学公式。
- **富文本粘贴** —— 从浏览器或 Word 粘贴的内容自动转换为 Typst 标记。
- **粘贴图片** —— 截图直接粘贴进编辑器,自动保存到可配置的资源目录并生成引用。
- **多标签编辑** —— 每个标签独立的脏状态、软关闭与随会话恢复。

### 实时预览

- **内嵌编译器** —— 无需安装 Typst CLI,预览即开即用。
- **防抖增量重编译** —— 输入时多页 SVG 预览自动刷新;revision 守卫丢弃乱序的过期结果。
- **预览 ↔ 源码双向同步** —— 双击预览即可跳转到对应源码行。
- **项目预览模式** —— 编辑子文件时预览始终渲染项目主文件。
- **Ctrl + 滚轮** 缩放预览。

### 项目与工作区

- **文件夹工作区** —— 惰性加载的文件资源管理器,支持新建/重命名/复制/删除(优先移入回收站,破坏性操作需确认)。
- **`.typstpro` 项目配置** —— 工作区根目录的小型 TOML 文件,声明主文件、标题、参考文献、编译根目录、附加字体目录、排除 glob、新建文件模板与导出默认值(格式 + 支持 `${title}` 宏的输出路径)。可手编、被监听、实时热重载。见[字段参考](docs/typstpro.md)。
- **全工作区搜索与替换** —— 跨文件全文检索、跳转到行,支持多文件批量替换。
- **大纲视图** —— 按标题结构快速跳转。
- **源代码管理** —— 内置 Git 面板,查看状态与提交。
- **最近工作区** —— 从上次离开的地方继续。

### 文献与包

- **文献面板** —— 解析 `.bib` 与 Hayagriva `.yml`;点击条目即在光标处插入 `#cite(<key>)`。
- **包面板** —— 浏览 Typst Universe 目录、管理已安装的包、一键插入 `#import`。

### 诊断与语言特性

- **诊断面板** —— 编译错误与警告,含严重度、位置与跳转到行。
- **Tinymist 集成** —— 通过 [`tinymist`](https://github.com/Myriad-Dreamin/tinymist) 提供更丰富的语言特性。优先使用 `PATH` 上的 tinymist,其次使用托管安装(`~/.typststudio/`);两者都没有时会自动下载(可在「设置 → 语言服务器」中关闭或手动触发)。

### 导出

- **PDF / PNG / SVG 导出**,锚定当前所见的 revision —— 绝不静默导出旧编译结果。
- **项目级导出默认值** —— 在 `.typstpro` 中声明 `format` 与 `outputPath`,导出完全跳过保存对话框。

### AI 助手

- 内置写作助手 —— 自备 Provider 与密钥(兼容 Anthropic / OpenAI 接口),模型与 token 上限均可配置。

### 安全与恢复

- **自动保存**(间隔/变更时/手动三种模式)与崩溃恢复快照。
- **外部变更感知** —— 应用外修改的文件以冲突对话框呈现而非被覆盖;受影响文档有未保存编辑时删除操作会被阻止。
- **会话恢复** —— 启动时还原标签页、布局与窗口几何状态。

### 个性化

- **主题** —— 内置浅色/深色/羊皮纸/强调色等多套主题,支持热重载的自定义 CSS 主题([编写指南](docs/themes.md))。
- **英文 / 简体中文界面**,运行时切换。
- **命令面板**(`Ctrl+Shift+P`)覆盖所有操作;设置窗口涵盖编辑器、编译、导出、搜索与外观。

## 键盘快捷键

> macOS 使用 `Cmd`,Windows/Linux 使用 `Ctrl`。

| 快捷键 | 操作 |
|---|---|
| `Ctrl+Shift+P` | 命令面板 |
| `Ctrl+T` / `Ctrl+W` | 新建标签 / 关闭标签 |
| `Ctrl+O` | 打开文件 |
| `Ctrl+S` / `Ctrl+Shift+S` | 保存 / 另存为 |
| `Ctrl+Shift+B` | 切换侧栏 |
| `Ctrl+\` | 切换预览 |
| `Ctrl+Shift+F` | 全局搜索 |
| `Ctrl+Shift+G` | 源代码管理 |
| `Ctrl+Shift+O` | 大纲 |
| `Ctrl+滚轮` | 缩放预览 |
| `Shift+Alt+F` | 格式化文档 |

## 安装

### 下载安装包

从 [Releases](../../releases) 页面获取最新安装包:

- **Windows** —— `.msi` 或 NSIS `.exe`(x64)
- **macOS** —— `.dmg`(Apple Silicon 与 Intel)
- **Linux** —— `.deb` / `.AppImage`

### 从源码构建

环境要求:Node.js 20+、Rust 1.92+,以及 [Tauri v2 前置依赖](https://v2.tauri.app/start/prerequisites/)。

```bash
npm install
npm run tauri dev     # 开发调试
npm run tauri build   # 安装包输出到 src-tauri/target/release/bundle/
```

## 文档

- [`.typstpro` 项目配置字段参考](docs/typstpro.md)
- [自定义主题编写指南](docs/themes.md)

## 数据与隐私

Typst Studio 本地优先 —— 文档永远不会离开你的文件系统。应用只在私有数据目录保存少量支撑数据(设置、最近工作区、会话状态、恢复快照、用户主题),路径为:Windows `%APPDATA%\com.typststudio.app\`、macOS `~/Library/Application Support/com.typststudio.app/`、Linux `~/.local/share/com.typststudio.app/`。可选的 AI 助手只会把你明确发送的内容发往你自行配置的接口。

## 项目状态

活跃开发中(`v0.1.x`)。本地编辑工作流已经完善;语言服务深度与主题联动仍在持续打磨。欢迎反馈与提 issue。

## 许可证

[MIT](LICENSE)。基于 [Typst](https://github.com/typst/typst)、[Tauri](https://tauri.app) 与 [Monaco Editor](https://microsoft.github.io/monaco-editor/) 构建。
