import { expect, test } from "@playwright/test";

/**
 * C-09：web_search / web_fetch 的 live 网络冒烟（默认跳过）。
 *
 * 单元层已有解析与 SSRF 网段矩阵（tests/wiki/web-search.test /
 * webfetch-ssrf.test），但真实网络路径（DDG HTML 端点改版、重定向跟随）
 * 只有真网才能发现。设 PI_APP_LIVE_WEB_SMOKE=1 显式启用：
 *
 *   PI_APP_LIVE_WEB_SMOKE=1 pnpm --filter @workecho/desktop run test:e2e:live
 */
const liveWebEnabled = process.env.PI_APP_LIVE_WEB_SMOKE === "1";

test.skip(!liveWebEnabled, "Set PI_APP_LIVE_WEB_SMOKE=1 to run live web tooling smoke tests.");

test("web_search parses a real DuckDuckGo response", async () => {
  const { parseDuckDuckGoHtml } = await import("../../electron/web-search-tool");
  const html = await fetchReal("https://html.duckduckgo.com/html/?q=workecho+electron");
  const results = parseDuckDuckGoHtml(html);
  expect(Array.isArray(results)).toBeTruthy();
  // DDG 结构改版时这里会红——这正是本用例存在的意义
  expect(results.length).toBeGreaterThan(0);
  expect(results[0]?.url).toMatch(/^https?:\/\//);
});

test("web_fetch SSRF guard rejects loopback even with a live resolver", async () => {
  const { isBlockedIp } = await import("../../electron/web-fetch-tool");
  expect(isBlockedIp("127.0.0.1")).toBe(true);
  expect(isBlockedIp("::1")).toBe(true);
  expect(isBlockedIp("169.254.169.254")).toBe(true);
});

async function fetchReal(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0 (compatible; WorkechoSmoke/1.0)" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`live fetch failed: ${res.status} ${url}`);
  return res.text();
}
