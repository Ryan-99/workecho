/**
 * Web Search 工具：让 AI 能联网搜索。
 * 用 DuckDuckGo HTML 端点（无需 API key），解析结果标题/链接/摘要返回。
 * 只请求固定搜索引擎域名（无 SSRR 面）；结果里的 URL 仅作为文本返回，
 * Agent 要读原文时走 web_fetch（那边有完整 SSRF 校验）。
 */
import { defineTool, toolOk as okResult, toolErr as errResult } from "./pi-compat";
import { htmlToText } from "./web-fetch-tool";

const SEARCH_URL = "https://html.duckduckgo.com/html/";
const TIMEOUT_MS = 20_000;
const MAX_RESULTS = 8;

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** 解码 DDG 结果链接：//duckduckgo.com/l/?uddg=<encoded>&rut=... → 原始 URL（导出供单测） */
export function decodeDdgHref(href: string): string {
  const h = href.replace(/&amp;/g, "&");
  if (h.includes("uddg=")) {
    try {
      const u = new URL("https://duckduckgo.com" + (h.startsWith("//") ? h : "/" + h));
      const target = u.searchParams.get("uddg");
      if (target) return target;
    } catch {
      /* 解析失败按原样返回 */
    }
  }
  return h;
}

/** 从 DDG HTML 提取结果列表（导出供单测；失败/空返回 []） */
export function parseDuckDuckGoHtml(html: string): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const linkRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  const snippets: string[] = [];
  for (const s of html.matchAll(snippetRe)) snippets.push(htmlToText(s[1]));
  let idx = 0;
  for (const m of html.matchAll(linkRe)) {
    const title = htmlToText(m[2]);
    const url = decodeDdgHref(m[1]);
    if (!title || !url) continue;
    results.push({ title, url, snippet: snippets[idx] ?? "" });
    idx++;
    if (results.length >= MAX_RESULTS) break;
  }
  return results;
}

export function createWebSearchTool() {
  return defineTool(
    "web_search",
    "联网搜索。输入查询词，返回前几条结果的标题/链接/摘要。需要最新信息、外部资料、时效性问题先用它，再用 web_fetch 读具体原文。",
    {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索关键词（中英文均可）" },
        limit: { type: "number", description: "返回条数（默认 8，最多 8）" },
      },
      required: ["query"],
    },
    async (_id, params: any, signal) => {
      const query = String(params.query ?? "").trim();
      if (!query) return errResult("搜索关键词不能为空");
      const limit = Math.min(Math.max(Number(params.limit) || MAX_RESULTS, 1), MAX_RESULTS);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error("timeout")), TIMEOUT_MS);
      if (signal) {
        if (signal.aborted) controller.abort();
        else signal.addEventListener("abort", () => controller.abort(), { once: true });
      }
      controller.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
      try {
        const resp = await fetch(`${SEARCH_URL}?q=${encodeURIComponent(query)}`, {
          signal: controller.signal,
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Workbench/1.0",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
          },
        });
        if (!resp.ok) return errResult(`搜索失败: HTTP ${resp.status}`);
        const html = (await resp.text()).slice(0, 1024 * 1024);
        const results = parseDuckDuckGoHtml(html).slice(0, limit);
        if (results.length === 0) {
          return errResult(`没有搜到"${query}"的结果。可换关键词重试，或改用 web_fetch 直接读已知网址。`);
        }
        const lines = results.map(
          (r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet.slice(0, 160)}` : ""}`,
        );
        return okResult(`搜索"${query}"的结果：\n\n${lines.join("\n\n")}\n\n需要深入某条时用 web_fetch 读原文。`, results);
      } catch (e) {
        if ((e as Error).name === "AbortError") return errResult("搜索被中止或超时");
        return errResult(`搜索失败: ${(e as Error).message}`);
      }
    },
  );
}
