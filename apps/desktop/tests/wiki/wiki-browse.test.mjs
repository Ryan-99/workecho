/**
 * Wiki 浏览页后端测试（TDD）。
 *
 * 独立知识库页面需要：页面列表（按分类）+ 正文读取（带路径穿越防护）。
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { listWikiPages, readWikiPage, ensureWikiStructure, createWikiPage } from "../../electron/wiki-manager.ts";
import { makeTempWorkspace, cleanupWorkspace } from "./helpers.mjs";

let root;
beforeEach(() => {
  root = makeTempWorkspace();
  ensureWikiStructure(root);
});
afterEach(() => cleanupWorkspace(root));

test("listWikiPages: 返回标题/分类/更新时间，排除 index.md", () => {
  createWikiPage(root, "todos", "整理客户拜访", {}, "内容");
  createWikiPage(root, "knowledge/cases", "AF 故障案例", {}, "内容");
  const pages = listWikiPages(root);
  assert.ok(pages.length >= 2);
  const todo = pages.find((p) => p.title === "整理客户拜访");
  assert.equal(todo?.category, "todos");
  assert.match(todo?.updatedAt ?? "", /^\d{4}-\d{2}-\d{2}/);
  const kc = pages.find((p) => p.title === "AF 故障案例");
  assert.equal(kc?.category, "knowledge/cases");
  // index.md 不在列表里
  assert.ok(!pages.some((p) => p.relPath === "index.md"));
});

test("readWikiPage: 读取正文内容", () => {
  createWikiPage(root, "todos", "周报草稿", {}, "本周完成了知识库页面开发。");
  const page = readWikiPage(root, "todos/周报草稿.md");
  assert.ok(page, "应能读到页面");
  assert.match(page.content, /本周完成了知识库页面开发/);
  assert.match(page.content, /title: 周报草稿/);
});

test("readWikiPage: 路径穿越防护", () => {
  assert.equal(readWikiPage(root, "../package.json"), null, "不允许逃出 wiki 根");
  assert.equal(readWikiPage(root, "todos/../../x.md"), null);
  assert.equal(readWikiPage(root, "index.md"), null, "index.md 不可读（内部文件）");
  assert.equal(readWikiPage(root, "不存在.md"), null);
});
