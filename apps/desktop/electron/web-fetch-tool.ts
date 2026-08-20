/**
 * Web Fetch 工具：让 AI 能获取网页内容。
 * 用 Node 的 fetch 抓取 URL，提取纯文本（去 HTML 标签），截断返回。
 *
 * SSRF 防护（工具参数是模型可控的，URL 视为不可信输入）：
 * - 仅允许 http/https 协议；
 * - 禁止环回/私网/链路本地/云元数据地址（按字面量与 DNS 解析结果双重校验）；
 * - 重定向手动逐跳跟随，每一跳重新过校验；
 * - 强制超时与响应体大小上限。
 */
import { lookup } from "node:dns/promises";
import net from "node:net";
import { defineTool, toolOk as okResult, toolErr as errResult } from "./pi-compat";

/** 请求总超时 */
const FETCH_TIMEOUT_MS = 30_000;
/** 响应体读取上限（字节）——超限截断，避免内存被恶意大响应耗尽 */
const MAX_BODY_BYTES = 2 * 1024 * 1024;
/** 重定向上限 */
const MAX_REDIRECTS = 5;

/** 判断 IP 字符串是否属于禁止访问的内网/保留网段 */
function isBlockedIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const octets = ip.split(".").map(Number);
    const a = octets[0];
    const b = octets[1];
    if (a === undefined || b === undefined) return true;
    // 0.0.0.0/8（本网络）、10/8（私网）、127/8（环回）、169.254/16（链路本地/云元数据）、
    // 172.16/12（私网）、192.168/16（私网）、100.64/10（CGNAT）
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === "::" || lower === "::1") return true;
    // IPv4-mapped（::ffff:10.0.0.1 等）
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped?.[1]) return isBlockedIp(mapped[1]);
    // fc00::/7 唯一本地、fe80::/10 链路本地
    if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true;
    if (/^fe[89ab][0-9a-f]:/.test(lower)) return true;
    return false;
  }
  return true; // 无法识别的一律拒绝
}

/** 校验单个 URL：协议白名单 + 主机名/DNS 解析结果网段校验 */
async function assertUrlAllowed(rawUrl: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`无效的 URL: ${rawUrl}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`不允许的协议 ${parsed.protocol}（仅支持 http/https）`);
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error(`不允许访问本机/内网主机: ${host}`);
  }
  // 字面量 IP 直接查网段；域名先 DNS 解析再逐个地址校验（防 DNS 重绑定的第一步）
  if (net.isIP(host)) {
    if (isBlockedIp(host)) throw new Error(`不允许访问内网/保留地址: ${host}`);
  } else {
    const records = await lookup(host, { all: true, verbatim: true }).catch(() => []);
    if (records.length === 0) throw new Error(`域名解析失败: ${host}`);
    for (const { address } of records) {
      if (isBlockedIp(address)) throw new Error(`域名 ${host} 解析到内网/保留地址 ${address}，已拒绝`);
    }
  }
  return parsed;
}

/** 组合外部中止信号与内部超时 */
function timeoutSignal(external: AbortSignal | undefined): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), FETCH_TIMEOUT_MS);
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener("abort", () => controller.abort(), { once: true });
  }
  // 超时/中止后释放定时器引用
  controller.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
  return controller.signal;
}

/** 从 HTML 提取纯文本（简易：去标签+压缩空白） */
function htmlToText(html: string): string {
  return html
    // 去 script/style（含未闭合的起始标签到文件尾，降低残留注入面）
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<script[^>]*>[\s\S]*$/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<style[^>]*>[\s\S]*$/gi, "")
    // 去标签
    .replace(/<[^>]+>/g, " ")
    // 解码常见 HTML 实体
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    // 压缩空白
    .replace(/\s+/g, " ")
    .trim();
}

/** 读取响应体，超过上限字节即停止（返回已读部分） */
async function readBodyCapped(resp: Response): Promise<{ text: string; capped: boolean }> {
  if (!resp.body) return { text: "", capped: false };
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let capped = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.length;
      if (total >= MAX_BODY_BYTES) {
        capped = true;
        await reader.cancel().catch(() => {});
        break;
      }
    }
  }
  const merged = new Uint8Array(Math.min(total, MAX_BODY_BYTES));
  let offset = 0;
  for (const c of chunks) {
    if (offset >= merged.length) break;
    merged.set(c.subarray(0, merged.length - offset), offset);
    offset += c.length;
  }
  return { text: new TextDecoder("utf-8", { fatal: false }).decode(merged), capped };
}

export function createWebFetchTool() {
  return defineTool(
    "web_fetch",
    "获取网页内容。输入 URL，返回页面纯文本（最多 4000 字符）。仅允许公开互联网地址（http/https），内网/本机地址会被拒绝。",
    {
      type: "object",
      properties: {
        url: { type: "string", description: "要获取的网页 URL（如 https://example.com）" },
      },
      required: ["url"],
    },
    async (_id, params: any, signal) => {
      const url = params.url?.trim();
      if (!url) return errResult("URL 不能为空");
      try {
        // 手动跟随重定向：每一跳都重新做 SSRF 校验
        let currentUrl = url;
        for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
          await assertUrlAllowed(currentUrl);
          const resp = await fetch(currentUrl, {
            signal: timeoutSignal(signal),
            headers: { "User-Agent": "Workbench/1.0" },
            redirect: "manual",
          });
          if (resp.status >= 300 && resp.status < 400) {
            const location = resp.headers.get("location");
            if (!location) return errResult(`HTTP ${resp.status}: 重定向缺少 Location`);
            if (hop === MAX_REDIRECTS) return errResult(`重定向次数超过 ${MAX_REDIRECTS} 次`);
            currentUrl = new URL(location, currentUrl).toString();
            continue;
          }
          if (!resp.ok) return errResult(`HTTP ${resp.status}: ${resp.statusText}`);
          const contentType = resp.headers.get("content-type") ?? "";
          const { text: body, capped } = await readBodyCapped(resp);
          let text: string;
          if (contentType.includes("text/html")) {
            text = htmlToText(body);
          } else {
            text = body;
          }
          // 截断（省 token）
          const truncated = text.slice(0, 4000);
          const note = text.length > 4000 ? `\n\n(已截断，原文 ${text.length} 字符)` : "";
          const capNote = capped ? `\n(响应超过 ${MAX_BODY_BYTES} 字节，仅读取前部分)` : "";
          return okResult(`[${currentUrl}]\n\n${truncated}${note}${capNote}`, { url: currentUrl, length: text.length });
        }
        return errResult("重定向处理异常");
      } catch (e) {
        if ((e as Error).name === "AbortError") return errResult("请求被中止");
        return errResult(`获取失败: ${(e as Error).message}`);
      }
    },
  );
}
