# The `.typstpro` Project Config

A workspace (a folder you opened as the workspace root) may carry a
`.typstpro` file at its root. It stores per-project metadata: the main
compile file, declared bibliographies, compile sandbox settings, and export
defaults. The file is optional — every field may be omitted — and it is
managed by the **Project** panel in the sidebar. You can also hand-edit it;
changes are picked up live (the file is watched).

The format is TOML with camelCase keys:

```toml
schemaVersion = 2
main = "paper.typ"
title = "My Paper"
bibliography = ["refs.bib"]
newFileTemplate = "templates/chapter.typ"
exclude = ["build/**", "out/**"]

[compile]
root = "src"
extraFontDirs = ["fonts"]

[export]
format = "pdf"
outputPath = "build/${title}.pdf"
```

## Fields

| Field | Type | Description |
|---|---|---|
| `schemaVersion` | number | Schema version. Written automatically on every save; used to migrate older files forward. Don't hand-edit. |
| `main` | string | Workspace-relative path to the project's main compile file (the file single-file preview/compile targets). |
| `title` | string | Human-readable project title. Also feeds the `${title}` macro in `[export] outputPath`. |
| `bibliography` | string[] | Declared bibliography files (workspace-relative). When set, the Bibliography panel prefers these over scan-discovery. |
| `newFileTemplate` | string | Workspace-relative file whose contents seed new documents. Precedence: explicit content > this > the global `document.defaultTemplate` setting. |
| `exclude` | string[] | Per-project ignore globs (matched against workspace-relative paths with forward slashes), applied to workspace search and the main-file picker. |
| `compile.root` | string | Workspace-relative directory Typst treats as `--root` for absolute-path / `#image()` resolution. Omit to use the workspace root. |
| `compile.extraFontDirs` | string[] | Workspace-relative font directories (e.g. a `fonts/` folder checked into the project). Takes effect after restart. |
| `export.format` | string | Default export format: `"pdf"`, `"png"`, or `"svg"`. |
| `export.outputPath` | string | Output path pattern (e.g. `"build/${title}.pdf"`). When set, export writes directly there instead of opening a save dialog. Macros (e.g. `${title}`) are expanded by the frontend. |

## Rules worth knowing

- **All path fields are workspace-relative.** Absolute paths, `..`, and
  Windows drive letters are rejected on save, and a hand-edited file with an
  escaping path has that field dropped when loaded. Paths may point at files
  that don't exist yet.
- **Unknown keys are ignored on load** (forward compatibility), but saving
  from the Project panel rewrites the whole file — unknown keys and TOML
  comments are not preserved.
- **Removed fields:** earlier schema versions supported `template` and
  `typstVersion`; they are ignored on load and dropped on the next save.
