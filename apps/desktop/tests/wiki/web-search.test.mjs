/**
 * web_search 工具测试：DDG HTML 解析 + 链接解码（不发真实网络请求）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

test("parseDuckDuckGoHtml：提取标题/链接/摘要并配对", async () => {
  const { parseDuckDuckGoHtml } = await import("../../electron/web-search-tool.ts");
  const html = `
    <div class="result results_links">
      <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&amp;rut=abc123">Example <b>Domain</b></a></h2>
      <a class="result__snippet" href="#">This domain is for use in examples</a>
    </div>
    <div class="result">
      <h2 class="result__title"><a class="result__a" href="https://direct.example.org/page">直接链接 &amp; 测试</a></h2>
      <a class="result__snippet">第二条摘要 &lt;ok&gt;</a>
    </div>`;
  const results = parseDuckDuckGoHtml(html);
  assert.equal(results.length, 2);
  assert.equal(results[0].title, "Example Domain");
  assert.equal(results[0].url, "https://example.com/a", "uddg 重定向应解码为原始 URL");
  assert.ok(results[0].snippet.includes("use in examples"));
  assert.equal(results[1].url, "https://direct.example.org/page", "非重定向链接原样保留");
  assert.ok(results[1].snippet.includes("<ok>"), "摘要应解码 HTML 实体");
});

test("parseDuckDuckGoHtml：无结果/异常输入返回空数组", async () => {
  const { parseDuckDuckGoHtml } = await import("../../electron/web-search-tool.ts");
  assert.deepEqual(parseDuckDuckGoHtml("<html><body>没有结果</body></html>"), []);
  assert.deepEqual(parseDuckDuckGoHtml(""), []);
});

test("decodeDdgHref：uddg 参数解码与兜底", async () => {
  const { decodeDdgHref } = await import("../../electron/web-search-tool.ts");
  assert.equal(
    decodeDdgHref("//duckduckgo.com/l/?uddg=https%3A%2F%2Fzh.wikipedia.org%2Fwiki%2F%E6%B5%8B%E8%AF%95&rut=x"),
    "https://zh.wikipedia.org/wiki/测试",
  );
  // 缺 uddg / 坏链接按原样返回（&amp; 先还原）
  assert.equal(decodeDdgHref("https://plain.example.com/?a=1&amp;b=2"), "https://plain.example.com/?a=1&b=2");
  assert.equal(decodeDdgHref("//duckduckgo.com/l/?rut=only"), "//duckduckgo.com/l/?rut=only");
});

test("parseDuckDuckGoHtml：超过 8 条时截断", async () => {
  const { parseDuckDuckGoHtml } = await import("../../electron/web-search-tool.ts");
  const item = (i) =>
    `<a class="result__a" href="https://x.example/${i}">结果${i}</a><a class="result__snippet">s${i}</a>`;
  const html = Array.from({ length: 12 }, (_, i) => item(i)).join("\n");
  const results = parseDuckDuckGoHtml(html);
  assert.equal(results.length, 8);
  assert.equal(results[7].title, "结果7");
});
