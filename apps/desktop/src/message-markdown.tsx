import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import { MermaidBlock } from "./mermaid-block";

/** 聊天/wiki 共用的 markdown 渲染配置：GFM + 数学公式（KaTeX）+ Mermaid 图表 */
export const REMARK_PLUGINS = [remarkGfm, remarkMath];
export const REHYPE_PLUGINS = [rehypeKatex];

export const MARKDOWN_COMPONENTS = {
  pre: ({ children }: { children?: React.ReactNode }) => {
    // ```mermaid 代码块整块替换为渲染图，其余照常
    const child = Array.isArray(children) ? children[0] : children;
    const props = (child as { props?: { className?: string; children?: unknown } } | undefined)?.props;
    const className = props?.className ?? "";
    if (typeof className === "string" && className.includes("language-mermaid")) {
      return <MermaidBlock chart={String(props?.children ?? "").replace(/\n$/, "")} />;
    }
    return <pre>{children}</pre>;
  },
  code: ({ className, children }: { className?: string; children?: React.ReactNode }) => {
    const code = String(children).replace(/\n$/, "");
    return <code className={className}>{code}</code>;
  },
  a: ({ href, children }: { href?: string; children?: React.ReactNode }) => (
    <a href={href} rel="noreferrer" target="_blank">
      {children}
    </a>
  ),
} as const;

export function MessageMarkdown({ text }: { readonly text: string }) {
  return (
    <div className="message__content">
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        components={MARKDOWN_COMPONENTS}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
