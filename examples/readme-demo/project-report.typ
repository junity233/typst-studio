#set page(margin: (x: 1.8cm, y: 2cm))
#set text(font: ("Georgia", "Times New Roman", "Noto Serif CJK SC"))
#set par(justify: true, leading: 0.72em)

#let accent = rgb("#245c73")

#show heading.where(level: 1): it => block[
  #set text(size: 21pt, weight: "bold", fill: accent)
  #it.body
  #v(0.25em)
  #line(length: 100%, stroke: (paint: accent, thickness: 1.2pt))
]

= Product Review Snapshot

#set text(size: 11pt)

This demo file is intentionally longer so the preview pane shows a more realistic multi-section layout. It is a good candidate for README screenshots because it contains headings, a compact KPI table, and a second page.

== Highlights

- Local-first editing with no cloud dependency
- Native desktop shell built on Tauri 2
- Embedded Typst compilation for preview and export

== KPI Overview

#table(
  columns: (3fr, 1.2fr, 4fr),
  inset: 8pt,
  stroke: rgb("#d8dde3"),
  fill: (x, y) => if y == 0 { rgb("#edf4f7") } else { white },
  [Metric], [Status], [Notes],
  [Preview latency], [Good], [Fast enough for everyday writing and iteration],
  [Workspace navigation], [Good], [Explorer, search, and outline already form a coherent loop],
  [Theme support], [Improving], [Built-in themes are present and custom CSS themes hot-reload],
)

== Notes

The point of this sample is not the prose itself. It gives the application a visually interesting document to render so we can verify editor, preview, and documentation assets together.

#pagebreak()

== Second Page

The second page exists mainly to show that Typst Studio is handling multi-page preview instead of a single static canvas.

You can tweak margins, headings, or paragraph text here and immediately confirm the result in the preview pane.
