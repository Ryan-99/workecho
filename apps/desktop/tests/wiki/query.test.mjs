/**
 * Phase 3b — wiki_query 查询 + 存回测试（TDD）。
 *
 * wiki_query 流程：读 index 定位 → 全文搜索相关页 → 综合回答 + 引用 → 结果存回 wiki
 * searchWiki：全文搜索（标题/frontmatter/正文），按相关度排序
 * saveSynthesis：把查询产生的洞察存为 synthesis 页（write-back）
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ensureWikiStructure, createWikiPage, searchWiki, saveSynthesis, ingestText } from "../../electron/wiki-manager.ts";
import { parseEntity } from "../../electron/business-store.ts";
import { makeTempWorkspace, cleanupWorkspace, writeFile, readFile, page } from "./helpers.mjs";

let root;
beforeEach(() => { root = makeTempWorkspace(); ensureWikiStructure(root); });
afterEach(() => cleanupWorkspace(root));

/* ===== searchWiki ===== */

test("searchWiki: 按关键词搜索标题", () => {
  createWikiPage(root, "maintenance", "招商银行AF维保", { customer: "招商银行", status: "expiring" });
  createWikiPage(root, "maintenance", "工商银行WAF维保", { customer: "工商银行", status: "active" });
  const results = searchWiki(root, "招商银行");
  assert.ok(results.length >= 1);
  assert.ok(results.some((r) => r.title === "招商银行AF维保"));
});

test("searchWiki: 按关键词搜索正文", () => {
  createWikiPage(root, "knowledge/cases", "AF故障案例", {}, "招商银行AF策略引擎内存泄漏故障排查全过程");
  const results = searchWiki(root, "内存泄漏");
  assert.ok(results.length >= 1);
  assert.ok(results.some((r) => r.title === "AF故障案例"));
});

test("searchWiki: 按标签搜索", () => {
  createWikiPage(root, "maintenance", "测试维保", { tags: ["紧急", "VIP客户"] });
  const results = searchWiki(root, "VIP客户");
  assert.ok(results.length >= 1);
});

test("searchWiki: 按相关度排序（标题匹配 > 正文匹配）", () => {
  createWikiPage(root, "maintenance", "AF防火墙", {}, "正文里有招商银行");
  createWikiPage(root, "ka", "招商银行", {});
  const results = searchWiki(root, "招商银行");
  assert.ok(results.length >= 2);
  // 标题匹配的应该排在前面
  assert.equal(results[0].title, "招商银行");
});

test("searchWiki: 没有匹配返回空数组", () => {
  createWikiPage(root, "todos", "无关待办", {});
  const results = searchWiki(root, "完全不存在的关键词xyz");
  assert.equal(results.length, 0);
});

test("searchWiki: limit 参数限制结果数", () => {
  for (let i = 0; i < 5; i++) {
    createWiki(root, `maintenance`, `招商银行项目${i}`, {});
  }
  const results = searchWiki(root, "招商银行", { limit: 2 });
  assert.ok(results.length <= 2);
});

/** helper */
function createWiki(r, category, title, fm, body) {
  return createWikiPage(r, category, title, fm, body);
}

/* ===== saveSynthesis (write-back) ===== */

test("saveSynthesis: 把查询洞察存为 synthesis 页", () => {
  const result = saveSynthesis(root, "招行维保综合分析", "根据多个维保记录分析，招行AF续保应优先处理", ["招商银行AF维保", "AF故障案例"]);
  assert.ok(result.relPath);
  assert.match(result.relPath, /synthesis/);
  const text = readFile(root, `workbench/wiki/${result.relPath}`);
  const { frontmatter, body } = parseEntity(text);
  assert.equal(frontmatter.type, "synthesis");
  assert.match(body, /优先处理/);
});

test("saveSynthesis: synthesis 页带 related 引用来源", () => {
  const result = saveSynthesis(root, "测试洞察", "分析内容", ["来源页A", "来源页B"]);
  const text = readFile(root, `workbench/wiki/${result.relPath}`);
  assert.match(text, /来源页A/);
  assert.match(text, /来源页B/);
});

test("saveSynthesis: 记录到 log.md", () => {
  saveSynthesis(root, "洞察", "内容", []);
  const log = readFile(root, "workbench/wiki/log.md");
  assert.match(log, /synthesis/i);
});
