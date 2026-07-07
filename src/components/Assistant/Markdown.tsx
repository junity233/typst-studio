import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { MarkdownLink } from "../common/ExternalLink";

/** Thin react-markdown wrapper; inherits theme via .assistant-markdown CSS. */
export function Markdown({ children }: { children: string }) {
  return (
    <div className="assistant-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{ a: MarkdownLink }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
