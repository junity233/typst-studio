import type { ComponentProps } from "react";
import type { ExtraProps } from "react-markdown";
import { isExternalHref, openExternalUrl } from "../../lib/openLink";

type AnchorProps = ComponentProps<"a"> & ExtraProps;

/**
 * Shared `<a>` override for react-markdown. External links (http/https/mailto/
 * tel) are intercepted and routed to the system default browser via
 * `openExternalUrl`; the webview itself never navigates away (and its CSP would
 * block external navigation anyway). Non-external hrefs (anchors, relative
 * paths) keep their default behavior.
 *
 * Pass to `<ReactMarkdown>` as `components={{ a: MarkdownLink }}`. Used by the
 * markdown preview, the AI assistant panel, and package READMEs so all three
 * share one code path.
 */
export function MarkdownLink({
  href,
  children,
  node: _node,
  ...rest
}: AnchorProps): React.JSX.Element {
  const external = isExternalHref(href);
  return (
    <a
      {...rest}
      href={href}
      // Only set target/rel on external links. Applying them to every link
      // breaks in-page anchors and relative links: in Tauri's webview a
      // `target=_blank` click raises a new-window request that gets blocked,
      // so the anchor never resolves. (For external links these attributes are
      // a best-effort fallback; the onClick handler below is the real path.)
      target={external ? "_blank" : undefined}
      rel={external ? "noopener noreferrer" : undefined}
      onClick={(e) => {
        if (!external) return;
        e.preventDefault();
        void openExternalUrl(href);
      }}
    >
      {children}
    </a>
  );
}
