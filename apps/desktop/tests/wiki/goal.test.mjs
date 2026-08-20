/**
 * Phase 2d — Goal 子系统测试（TDD，对应 WIKI-DESIGN.md 附录 A3）。
 *
 * Goal 是 wiki 页面的一种类型（type=goal），追踪长任务目标。
 * 状态机：active → (推进) → complete
 *         active → (受阻) → blocked → (解决) → active
 *         active → (暂停) → paused → (恢复) → active
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ensureWikiStructure, createGoal, advanceGoal, updateGoalStatus, getActiveGoals } from "../../electron/wiki-manager.ts";
import { parseEntity } from "../../electron/business-store.ts";
import { makeTempWorkspace, cleanupWorkspace, readFile } from "./helpers.mjs";

let root;
beforeEach(() => { root = makeTempWorkspace(); ensureWikiStructure(root); });
afterEach(() => cleanupWorkspace(root));

test("createGoal: 创建带步骤列表的目标页面", () => {
  const result = createGoal(root, "整理 Q3 客户拜访报告", [
    "查询本季度拜访记录",
    "按客户分类整理",
    "生成报告草稿",
  ]);
  assert.ok(result.relPath);
  const { frontmatter, body } = parseEntity(readFile(root, `workbench/wiki/${result.relPath}`));
  assert.equal(frontmatter.type, "goal");
  assert.equal(frontmatter.status, "active");
  assert.equal(frontmatter.currentStep, 0);
  assert.deepEqual(frontmatter.steps, ["查询本季度拜访记录", "按客户分类整理", "生成报告草稿"]);
});

test("createGoal: body 包含步骤 checklist", () => {
  const result = createGoal(root, "测试目标", ["步骤A", "步骤B"]);
  const { body } = parseEntity(readFile(root, `workbench/wiki/${result.relPath}`));
  assert.match(body, /步骤A/);
  assert.match(body, /\[ \]/); // 未完成 checkbox
});

test("advanceGoal: 推进当前步骤（currentStep +1）", () => {
  const result = createGoal(root, "目标", ["s1", "s2", "s3"]);
  advanceGoal(root, result.relPath);
  const { frontmatter } = parseEntity(readFile(root, `workbench/wiki/${result.relPath}`));
  assert.equal(frontmatter.currentStep, 1);
});

test("advanceGoal: 最后一步完成时状态变 complete", () => {
  const result = createGoal(root, "目标", ["s1", "s2"]);
  advanceGoal(root, result.relPath); // → step 1
  advanceGoal(root, result.relPath); // → step 2 = last
  advanceGoal(root, result.relPath); // → complete
  const { frontmatter } = parseEntity(readFile(root, `workbench/wiki/${result.relPath}`));
  assert.equal(frontmatter.status, "complete");
});

test("updateGoalStatus: 改变目标状态（active → blocked）", () => {
  const result = createGoal(root, "目标", ["s1"]);
  updateGoalStatus(root, result.relPath, "blocked");
  const { frontmatter } = parseEntity(readFile(root, `workbench/wiki/${result.relPath}`));
  assert.equal(frontmatter.status, "blocked");
});

test("updateGoalStatus: 无效状态拒绝", () => {
  const result = createGoal(root, "目标", ["s1"]);
  const ok = updateGoalStatus(root, result.relPath, "invalid");
  assert.ok(!ok);
});

test("getActiveGoals: 返回所有 active 和 blocked 目标", () => {
  const g1 = createGoal(root, "目标1", ["s1"]);
  const g2 = createGoal(root, "目标2", ["s1"]);
  const g3 = createGoal(root, "目标3", ["s1"]);
  updateGoalStatus(root, g2.relPath, "blocked");
  updateGoalStatus(root, g3.relPath, "complete");
  const active = getActiveGoals(root);
  assert.equal(active.length, 2);
  const titles = active.map((g) => g.title);
  assert.ok(titles.includes("目标1"));
  assert.ok(titles.includes("目标2"));
  assert.ok(!titles.includes("目标3"));
});

test("getActiveGoals: 没有目标时返回空数组", () => {
  assert.deepEqual(getActiveGoals(root), []);
});
