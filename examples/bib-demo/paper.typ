// ──────────────────────────────────────────────────────────────
// Bibliography panel demo — click a reference in the sidebar's
// Bibliography view to insert #cite(<key>) at the caret, then
// recompile to see the rendered reference list below.
//
// How to test:
//   1. Open this FOLDER (examples/bib-demo) as a workspace:
//      File → Open Folder → select bib-demo
//   2. Click the Bibliography icon in the Activity Bar.
//   3. Try switching between refs.bib and refs.yml in the dropdown.
//   4. Click any reference to insert a citation here 👇

#set page(paper: "a4", margin: (x: 2.4cm, y: 2.5cm))
#set text(font: "New Computer Modern", size: 11pt)
#set par(justify: true, leading: 0.8em)

= A Brief Tour of Typesetting

The history of digital typesetting begins with the seminal work of
Knuth #cite(<knuth1984>), who created TeX to address the shortcomings
of mechanical typesetting. Decades later, Shannon's information theory
#cite(<shannon1948>) had already laid groundwork for how we think about
information encoding.

== Relativity and Beyond

Einstein's 1905 paper #cite(<einstein1905>) fundamentally reshaped
physics. For an overview of the LaTeX ecosystem, the second edition of
the companion #cite(<latex-companion>) remains indispensable.

== The Modern Era

The Typst typesetting system #cite(<typst-docs>) represents a modern
approach, combining a markup language with a reactive compiler. For
the curious, even Turing's early work #cite(<turing1938>) on logic
remains relevant.

// Render the bibliography from refs.bib (switch to "refs.yml" to test
// the Hayagriva format). The panel auto-discovers both files.
#bibliography("refs.bib")