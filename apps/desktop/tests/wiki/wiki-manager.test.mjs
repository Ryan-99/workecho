/**
 * Phase 1b — wiki-manager.ts 测试（TDD）。
 *
 * wiki-manager 负责：目录结构创建、index.md/log.md 维护、
 * 交叉引用（[[wikilink]]）、lint 巡检（孤立页/死链）。
 *
 * 路径约定：workspaceDir（=cwd） → workbench/wiki/<category>/...md
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  ensureWikiStructure,
  appendToLog,
  readLog,
  regenerateIndex,
  readIndex,
  countPagesInCategory,
  extractLinks,
  addCrossReference,
  lintWiki,
} from "../../electron/wiki-manager.ts";
import { makeTempWorkspace, cleanupWorkspace, writeFile, readFile, exists, page } from "./helpers.mjs";

let root;
beforeEach(() => { root = makeTempWorkspace(); });
afterEach(() => cleanupWorkspace(root));

test("ensureWikiStructure: 创建 wiki/ 子目录结构（幂等）", () => {
  ensureWikiStructure(root);
  assert.ok(exists(root, "workbench/wiki/okr"));
  assert.ok(exists(root, "workbench/wiki/todos"));
  assert.ok(exists(root, "workbench/wiki/maintenance"));
  assert.ok(exists(root, "workbench/wiki/ka"));
  assert.ok(exists(root, "workbench/wiki/projects"));
  assert.ok(exists(root, "workbench/wiki/knowledge/cases"));
  assert.ok(exists(root, "workbench/wiki/knowledge/concepts"));
  assert.ok(exists(root, "workbench/wiki/knowledge/synthesis"));
  assert.ok(exists(root, "workbench/wiki/memory"));
  assert.ok(exists(root, "workbench/_sources/inbox"));
  assert.ok(exists(root, "workbench/_sources/scanned"));
  assert.ok(exists(root, "workbench/_sources/web"));
  // 幂等：再调一次不报错
  ensureWikiStructure(root);
  assert.ok(exists(root, "workbench/wiki/okr"));
});

test("ensureWikiStructure: 创建初始 index.md 和 log.md", () => {
  ensureWikiStructure(root);
  assert.ok(exists(root, "workbench/wiki/index.md"));
  assert.ok(exists(root, "workbench/wiki/log.md"));
  const idx = readFile(root, "workbench/wiki/index.md");
  assert.match(idx, /知识目录/);
  const log = readFile(root, "workbench/wiki/log.md");
  assert.match(log, /init/);
});

test("appendToLog: 追加操作日志（append-only，带时间戳）", () => {
  ensureWikiStructure(root);
  appendToLog(root, "create_page | todos/跟进招行.md");
  const log = readLog(root);
  assert.match(log, /create_page \| todos\/跟进招行\.md/);
  // 追加第二条，不覆盖
  appendToLog(root, "update_page | maintenance/招行AF.md");
  const log2 = readLog(root);
  assert.match(log2, /create_page \| todos\/跟进招行\.md/);
  assert.match(log2, /update_page \| maintenance\/招行AF\.md/);
});

test("appendToLog: 每行带 YYYY-MM-DD 日期前缀", () => {
  ensureWikiStructure(root);
  appendToLog(root, "test entry");
  const log = readLog(root);
  assert.match(log, /\d{4}-\d{2}-\d{2}\s+test entry/);
});

test("countPagesInCategory: 统计某类别下的页面数", () => {
  ensureWikiStructure(root);
  writeFile(root, "workbench/wiki/todos/a.md", page({ title: "A" }));
  writeFile(root, "workbench/wiki/todos/b.md", page({ title: "B" }));
  writeFile(root, "workbench/wiki/todos/c.md", page({ title: "C" }));
  assert.equal(countPagesInCategory(root, "todos"), 3);
  assert.equal(countPagesInCategory(root, "okr"), 0);
});

test("regenerateIndex: 根据实际页面数重建 index.md", () => {
  ensureWikiStructure(root);
  writeFile(root, "workbench/wiki/todos/a.md", page({ title: "A" }));
  writeFile(root, "workbench/wiki/todos/b.md", page({ title: "B" }));
  writeFile(root, "workbench/wiki/okr/q3.md", page({ title: "Q3" }));
  writeFile(root, "workbench/wiki/maintenance/zh.md", page({ title: "招行" }));
  regenerateIndex(root);
  const idx = readIndex(root);
  assert.match(idx, /todos/);
  assert.match(idx, /2/);
  assert.match(idx, /okr/);
  assert.match(idx, /maintenance/);
});

test("extractLinks: 从正文提取 [[wikilink]] 引用", () => {
  const body = "参见 [[招行AF故障]] 和 [[todo：跟进]]，详见 [[概念:WAF]]。";
  const links = extractLinks(body);
  assert.deepEqual(links, ["招行AF故障", "todo：跟进", "概念:WAF"]);
});

test("extractLinks: 没有链接返回空数组", () => {
  assert.deepEqual(extractLinks("普通文本没有链接"), []);
});

test("addCrossReference: 给源页添加到目标标题的 related 引用", () => {
  ensureWikiStructure(root);
  writeFile(root, "workbench/wiki/todos/follow.md", page({ title: "跟进招行" }));
  writeFile(root, "workbench/wiki/maintenance/zh.md", page({ title: "招行AF" }));
  const ok = addCrossReference(root, "todos/follow.md", "招行AF");
  assert.ok(ok);
  const content = readFile(root, "workbench/wiki/todos/follow.md");
  assert.match(content, /related:/);
  assert.match(content, /招行AF/);
});

test("addCrossReference: 已存在引用不重复添加", () => {
  ensureWikiStructure(root);
  writeFile(root, "workbench/wiki/todos/follow.md", page({ title: "跟进招行", related: ["[[招行AF]]"] }));
  const ok = addCrossReference(root, "todos/follow.md", "招行AF");
  assert.ok(ok);
  const content = readFile(root, "workbench/wiki/todos/follow.md");
  // 只出现一次
  const count = (content.match(/招行AF/g) || []).length;
  assert.equal(count, 1);
});

test("lintWiki: 检测死链（引用了不存在的页面）", () => {
  ensureWikiStructure(root);
  writeFile(root, "workbench/wiki/todos/a.md", page({ title: "A", related: ["[[不存在的页面]]"] }));
  const report = lintWiki(root);
  assert.ok(report.deadLinks.length >= 1);
  assert.ok(report.deadLinks.some((d) => d.link === "不存在的页面"));
});

test("lintWiki: 检测孤立页（没有任何页面引用它）", () => {
  ensureDefaultData(root);
  const report = lintWiki(root);
  assert.ok(report.orphans.length >= 1);
});

/** helper: 写入若干页面，其中 b.md 引用 a.md，c.md 无人引用（孤立） */
function ensureDefaultData(r) {
  ensureWikiStructure(r);
  writeFile(r, "workbench/wiki/todos/a.md", page({ title: "A" }));
  writeFile(r, "workbench/wiki/todos/b.md", page({ title: "B", related: ["[[A]]"] }));
  writeFile(r, "workbench/wiki/todos/c.md", page({ title: "孤立页C" }));
}

test("lintWiki: 互相引用的页面不是孤立页", () => {
  ensureWikiStructure(root);
  writeFile(root, "workbench/wiki/todos/x.md", page({ title: "X", related: ["[[Y]]"] }));
  writeFile(root, "workbench/wiki/todos/y.md", page({ title: "Y", related: ["[[X]]"] }));
  const report = lintWiki(root);
  assert.ok(!report.orphans.includes("X"));
  assert.ok(!report.orphans.includes("Y"));
});
