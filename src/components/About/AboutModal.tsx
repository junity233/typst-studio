import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { ExternalLink } from "lucide-react";
import { useAboutModalStore } from "../../store/aboutModalStore";
import { openExternalUrl } from "../../lib/openLink";
import { APP_NAME, APP_VERSION } from "../../lib/appInfo";
import { useEscapeToClose } from "../../hooks/useEscapeToClose";

/** Official Typst site — the one external link in the dialog (see README). */
const TYPST_URL = "https://typst.app";

/**
 * About dialog — a presentation-only modal showing the app icon, name, version,
 * tagline, the tech it's built with, copyright + license, and a link to Typst.
 *
 * Open/close is driven by {@link useAboutModalStore} so multiple entry points
 * (Help → About menu item, the `open-about` command) open the same dialog.
 * Rendered once at the app root; renders nothing when closed. Mirrors the
 * FormulaModal/ConfirmDialog pattern: portal to `document.body`, reuses
 * `.dialog-overlay` / `.dialog` chrome, and Esc / overlay-click / Close all
 * dismiss.
 *
 * The version comes from `APP_VERSION` (read from package.json at build time —
 * see src/lib/appInfo.ts) so it never drifts from the shipped release.
 *
 * Unlike FormulaModal there's no autofocus field, so Esc is handled at the
 * window level (a focused input is not guaranteed to receive the key).
 */
export function AboutModal() {
  const { t } = useTranslation("about");
  const open = useAboutModalStore((s) => s.isOpen);
  const close = useAboutModalStore((s) => s.close);

  // Esc closes. Listener is attached only while open (see useEscapeToClose).
  useEscapeToClose(open, close);

  if (!open) return null;

  return createPortal(
    <div
      className="dialog-overlay"
      role="presentation"
      onClick={close}
    >
      <div
        className="dialog about-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t("title", { defaultValue: "About {{name}}", name: APP_NAME })}
        onClick={(e) => e.stopPropagation()}
      >
        <img
          className="about-icon"
          src="/icon.svg"
          alt=""
          draggable={false}
        />

        <h2 className="about-name">{APP_NAME}</h2>
        <p className="about-version">
          {t("version", {
            defaultValue: "Version {{version}}",
            version: APP_VERSION,
          })}
        </p>

        <p className="about-tagline">
          {t("tagline", {
            defaultValue: "A Typst visual editor with live preview.",
          })}
        </p>

        <div className="about-divider" />

        <p className="about-built">
          {t("builtWith", {
            defaultValue: "Built with Tauri · React · Rust · Typst",
          })}
        </p>
        <p className="about-copyright">
          {t("copyright", {
            defaultValue: "Copyright © 2026 Junity",
          })}
        </p>
        <p className="about-license">
          {t("license", {
            defaultValue: "Released under the MIT License",
          })}
        </p>

        <button
          type="button"
          className="about-link"
          onClick={() => void openExternalUrl(TYPST_URL)}
        >
          {t("learnTypst", { defaultValue: "Learn more about Typst" })}
          <ExternalLink size={13} strokeWidth={2} />
        </button>

        <div className="dialog-actions">
          <button type="button" className="btn-utility" onClick={close}>
            {t("close", { defaultValue: "Close" })}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
