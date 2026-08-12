/**
 * App identity constants gathered in one place.
 *
 * `APP_VERSION` is read from `package.json` via a named import (tsconfig has
 * `resolveJsonModule: true`). Rollup tree-shakes the named export, so only the
 * version string lands in the bundle — not the whole manifest with its
 * dependency arrays. This keeps {@link "../components/About/AboutModal"} and any
 * other surface in sync with the single source of truth without a runtime IPC
 * round-trip or a hand-maintained constant that drifts on release.
 *
 * `APP_NAME` is the display product name (TitleBar keeps its own `PRODUCT_NAME`
 * copy; duplicated deliberately rather than coupled across unrelated modules).
 */
import { version } from "../../package.json";

export const APP_VERSION: string = version;

export const APP_NAME = "Typst Studio";
