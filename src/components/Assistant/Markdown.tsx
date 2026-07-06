import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Thin react-markdown wrapper; inherits theme via .assistant-markdown CSS. */
export function Markdown({ children }: { children: string }) {
  return (
    <div className="assistant-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}
