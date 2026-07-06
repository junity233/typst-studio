# Custom Themes

Typst Studio supports user-authored CSS themes. A theme is a **folder** you
create inside the app's themes directory; it is picked up automatically and
appears in **Settings → Appearance → Theme**. Editing a theme's CSS applies
live — no restart needed.

## Where to put themes

Themes live in `<app-data>/themes/`, where `<app-data>` is the platform config
directory:

| Platform | Path |
| --- | --- |
| macOS | `~/Library/Application Support/com.typststudio.app/themes/` |
| Windows | `%APPDATA%\com.typststudio.app\themes\` |
| Linux | `~/.config/com.typststudio.app/themes/` |

The easiest way to open it: **Settings → Appearance → Themes folder → Open**.

Each **subfolder** is one theme. The folder name is the theme's stable `id`
(what gets stored when you pick it). Inside the folder:

```
themes/
└── my-dark/
    ├── theme.json   # metadata (optional, but recommended)
    └── theme.css    # the stylesheet (required)
```

A folder is recognized as a theme only if it contains **`theme.css`**. If
`theme.json` is missing, the folder name is used as the display name.

### `theme.json`

```json
{
  "name": "My Dark",
  "description": "A calm dark theme",
  "base": "dark"
}
```

All fields are optional:

| Field | Default | Notes |
| --- | --- | --- |
| `name` | the folder name | shown in the picker |
| `description` | `""` | shown under the name |
| `base` | `"all"` | one of `"light"` / `"dark"` / `"all"`. A hint for future linkage with the editor/preview chrome; not yet acted on. |

### `theme.css`

This is plain CSS. The recommended approach is to **override the CSS custom
properties** defined on `:root` in the app stylesheet — that recolors the whole
UI consistently. You may also add any extra selectors for deeper customization.

```css
:root {
  --color-primary: #0a84ff;
  --color-ink: #f5f5f7;
  /* …see the full token list in src/styles/global.css… */
}
```

> The full set of overridable tokens (colors, fonts, spacing, radii, shadows,
> layout heights) lives in `src/styles/global.css` under `:root`. The most
> impactful for theming are the `--color-*` tokens.

## Quick start: a complete dark theme

1. Open **Settings → Appearance → Themes folder → Open**.
2. Create a folder `my-dark/` inside.
3. Add these two files:

**`my-dark/theme.json`**
```json
{
  "name": "My Dark",
  "description": "Example dark theme",
  "base": "dark"
}
```

**`my-dark/theme.css`**
```css
:root {
  /* Accent */
  --color-primary: #0a84ff;
  --color-primary-focus: #409cff;
  --color-primary-on-dark: #2997ff;

  /* Text */
  --color-ink: #f5f5f7;
  --color-body: #e6e6e9;
  --color-body-muted: #9a9a9e;
  --color-ink-muted-80: #d0d0d4;
  --color-ink-muted-48: #86868a;

  /* Surfaces */
  --color-canvas: #1c1c1e;
  --color-paper: #ffffff;
  --color-canvas-parchment: #161617;
  --color-surface-pearl: #242426;
  --color-divider-soft: #2a2a2c;
  --color-hairline: #38383a;
  --color-surface-chip-translucent: #3a3a3c;
  --color-on-primary: #ffffff;

  /* Severity (kept readable on dark) */
  --color-error: #ff453a;
  --color-warning: #ff9f0a;

  /* The document "paper" shadow stays, but you can soften it on dark. */
  --shadow-product: rgba(0, 0, 0, 0.5) 3px 5px 30px 0;
}
```

4. Save both files. The picker in **Settings → Appearance** now lists
   **My Dark** — select it and the UI recolors instantly. Edit `theme.css` and
   save; the change applies immediately (hot reload).

## How it works

- On startup the backend scans `<app-data>/themes/` once and caches the list.
- A filesystem watcher monitors the directory; any add/remove/edit triggers a
  re-scan and a `themes_changed` event, so the picker and the applied CSS
  refresh without a restart.
- Selecting a theme stores its `id` in the `appearance.theme` setting. The
  frontend reads that theme's `theme.css` and injects it as a
  `<style id="user-theme">` element in `<head>`, **after** the app stylesheet,
  so your `:root` overrides win by source order.
- The built-in **Default** (`appearance.theme = "default"`) loads no user CSS —
  the app's light tokens are used as-is.

## Notes & limitations

- A theme must contain `theme.css` to be recognized. A folder with only
  `theme.json` is ignored.
- Unknown/unreadable themes fall back to **Default**: if the selected theme's
  folder is deleted, the app reverts to the built-in light tokens.
- Theme CSS is applied as-is (no sandboxing). You can override any token and
  add arbitrary selectors, but a broken stylesheet can affect layout — delete
  or fix the `theme.css` to recover.
- The active theme's `base` (`light` / `dark`) also drives Monaco's chrome +
  token palette and the preview desk surface, so dark themes now recolor those
  areas as well.
- `--color-canvas` is the app's content-surface color (editor pane, tabs,
  cards, menus). `--color-paper` is the rendered document page color inside the
  preview. Dark themes usually want a dark `--color-canvas` and a light
  `--color-paper`.
