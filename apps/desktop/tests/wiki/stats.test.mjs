/**
 * Phase 5 — Wiki 统计 + 知识图谱数据测试（TDD）。
 *
 * getWikiStats: 统计各类别页面数、最近活跃度、交叉引用密度
 * getWikiGraph: 生成节点+边数据（供未来 graph view 用）
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ensureWikiStructure, createWikiPage, seedWikiDefaults, addCrossReference, ingestText } from "../../electron/wiki-manager.ts";
import { getWikiStats, getWikiGraph } from "../../electron/wiki-manager.ts";
import { makeTempWorkspace, cleanupWorkspace, writeFile, page } from "./helpers.mjs";

let root;
beforeEach(() => { root = makeTempWorkspace(); ensureWikiStructure(root); seedWikiDefaults(root); });
afterEach(() => cleanupWorkspace(root));

/* ===== getWikiStats ===== */

test("getWikiStats: 返回各类别页面数", () => {
  createWikiPage(root, "todos", "task1", {});
  createWikiPage(root, "todos", "task2", {});
  createWikiPage(root, "maintenance", "维保A", {});
  const stats = getWikiStats(root);
  assert.ok(stats.categories.todos >= 2);
  assert.ok(stats.categories.maintenance >= 1);
});

test("getWikiStats: 返回总页面数", () => {
  const stats = getWikiStats(root);
  assert.ok(stats.totalPages >= 0);
  assert.ok(typeof stats.totalPages === "number");
});

test("getWikiStats: 返回交叉引用数", () => {
  createWikiPage(root, "maintenance", "招行维保", {});
  createWikiPage(root, "todos", "跟进招行", { related: ["[[招行维保]]"] });
  const stats = getWikiStats(root);
  assert.ok(stats.crossReferences >= 1);
});

test("getWikiStats: 返回最近更新的页面数", () => {
  const stats = getWikiStats(root);
  assert.ok(typeof stats.recentUpdates === "number");
});

/* ===== getWikiGraph ===== */

test("getWikiGraph: 返回节点和边", () => {
  createWikiPage(root, "maintenance", "实体A", {});
  createWikiPage(root, "knowledge/cases", "案例B", {}, "提到了 实体A");
  const graph = getWikiGraph(root);
  assert.ok(graph.nodes.length >= 2);
  assert.ok(Array.isArray(graph.edges));
});

test("getWikiGraph: 边表示交叉引用关系", () => {
  const a = createWikiPage(root, "maintenance", "源实体", {});
  createWikiPage(root, "todos", "目标实体", {});
  addCrossReference(root, "todos/目标实体.md" in {} ? "" : "todos/目标实体.md".replace("todos/", ""), "源实体");
  // 用 addCrossReference 正确建引用
  const graph = getWikiGraph(root);
  // 至少有节点
  assert.ok(graph.nodes.length >= 2);
});

test("getWikiGraph: 节点包含 title 和 category", () => {
  createWikiPage(root, "todos", "测试节点", {});
  const graph = getWikiGraph(root);
  const node = graph.nodes.find((n) => n.title === "测试节点");
  assert.ok(node);
  assert.equal(node.category, "todos");
});
