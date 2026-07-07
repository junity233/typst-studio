import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Rendered-markdown preview pane for `DocumentKind === "markdown"` tabs.
 *
 * The source comes straight from the document's in-memory buffer (no IPC), so
 * edits in the Monaco editor on the left are reflected here after a short
 * debounce. Reuses the same `react-markdown` + `remark-gfm` stack as the AI
 * Assistant panel (the only other markdown surface in the app), but under a
 * distinct `.markdown-preview` class so it can be styled like a reading pane
 * rather than a chat bubble.
 *
 * The debounce keeps re-render cheap while the user types fast: react-markdown
 * parses the whole document on each render, and a large doc re-parsed on every
 * keystroke would jank the editor.
 */
export function MarkdownPreview({
  source,
  debounceMs = 150,
}: {
  source: string;
  debounceMs?: number;
}): React.JSX.Element {
  const [debounced, setDebounced] = useState(source);

  useEffect(() => {
    const handle = setTimeout(() => setDebounced(source), debounceMs);
    return () => clearTimeout(handle);
  }, [source, debounceMs]);

  return (
    <div className="markdown-preview pane-scroll">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{debounced}</ReactMarkdown>
    </div>
  );
}
