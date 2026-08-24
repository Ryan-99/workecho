import { useEffect, useState } from "react";

/**
 * Mermaid 图表块：markdown 里 ```mermaid 代码块渲染为 SVG。
 * mermaid 包很大（~1MB），动态 import 懒加载；渲染失败退回普通代码块。
 */

let mermaidPromise: Promise<typeof import("mermaid").default> | null = null;

function loadMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((m) => {
      m.default.initialize({
        startOnLoad: false,
        theme: "neutral",
        securityLevel: "strict",
        fontFamily: "inherit",
      });
      return m.default;
    });
  }
  return mermaidPromise;
}

let renderSeq = 0;

export function MermaidBlock({ chart }: { readonly chart: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    const id = `workecho-mmd-${++renderSeq}`;
    loadMermaid()
      .then(async (mermaid) => {
        const { svg } = await mermaid.render(id, chart);
        if (alive) setSvg(svg);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [chart]);

  if (failed) {
    return (
      <pre className="mermaid-fallback">
        <code>{chart}</code>
      </pre>
    );
  }
  if (svg === null) return <div className="mermaid-loading">正在渲染图表…</div>;
  return <div className="mermaid-block" dangerouslySetInnerHTML={{ __html: svg }} />;
}
