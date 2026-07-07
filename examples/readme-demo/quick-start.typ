#set page(margin: (x: 2.2cm, y: 2.6cm))
#set text(lang: "zh", font: ("Microsoft YaHei", "Noto Sans CJK SC", "Source Han Sans SC"))
#set par(justify: true, leading: 0.75em)

= Typst Studio 快速预览

这份文档用于 README 截图与本地联调，内容刻意覆盖了 Typst Studio 当前已经做得比较完整的几个场景：

- 左侧源码编辑
- 右侧多页实时预览
- 标题与目录结构
- 列表、强调与简单表格

== 为什么做这份示例

Typst Studio 的目标不是把 Typst 塞进一个通用编辑器里，而是提供更舒服的本地写作体验。

#quote[
  当你希望「一边写源码，一边看排版结果」时，桌面应用的即时反馈会非常顺手。
]

== 一个小表格

#table(
  columns: (2.8cm, 4.2cm, 5.2cm),
  inset: 10pt,
  stroke: rgb("#d9dee7"),
  fill: (x, y) => if y == 0 { rgb("#eef3fb") } else if calc.even(y) { rgb("#fafbfd") } else { white },
  [能力], [现状], [说明],
  [实时预览], [可用], [编辑后会自动刷新 SVG 预览],
  [工作区], [可用], [支持目录树、搜索与大纲导航],
  [导出], [可用], [支持 PDF、PNG 与 SVG],
)

== 下一步可以测试什么

1. 在左侧修改这里的一句话。
2. 观察右侧预览是否即时更新。
3. 再打开同目录下的另一份文档，确认标签页切换和预览表现。
