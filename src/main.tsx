import { useEffect } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { SettingsApp } from "./components/Settings/SettingsApp";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { useSettingsStore } from "./store/settingsStore";
import { useThemeStore } from "./store/themeStore";
import { useTheme } from "./hooks/useTheme";
import { useLanguage } from "./hooks/useLanguage";
// Side-effect import: initializes i18next + registers React bindings. Must run
// before any component that calls `useTranslation` renders.
import "./i18n";
import "./styles/global.css";

/**
 * Detect whether this bundle loaded as the dedicated settings window
 * (`index.html?window=settings`). A single Vite bundle serves both; the query
 * param selects which root component renders.
 */
const isSettingsWindow =
  new URLSearchParams(window.location.search).get("window") === "settings";

/**
 * Root: hydrates the settings + theme stores once (both windows need them —
 * the settings window renders the manifest/theme picker, the main window feeds
 * future consumers), applies the current theme to this window's document, then
 * branches to the settings UI or the app shell.
 */
function Root() {
  useEffect(() => {
    void useSettingsStore.getState().hydrate();
    void useThemeStore.getState().hydrate();
  }, []);
  // Apply the current theme in BOTH windows so the settings window matches.
  useTheme();
  // Apply the current UI language in BOTH windows. Reads `appearance.language`
  // and re-runs `i18n.changeLanguage` whenever the persisted setting changes
  // (including cross-window, via the `settings_changed` broadcast).
  useLanguage();
  return isSettingsWindow ? <SettingsApp /> : <App />;
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <ErrorBoundary>
    <Root />
  </ErrorBoundary>,
);
