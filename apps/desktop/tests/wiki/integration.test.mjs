/**
 * 集成测试：验证完整的 Wiki 知识库生命周期。
 *
 * 模拟真实场景：
 * 1. 旧结构数据存在 → init → 迁移到 wiki/ → 新结构可查询
 * 2. Agent 创建/更新页面 → index.md + log.md 自动维护
 * 3. Memory 系统 → 写入 → 读取
 * 4. Goal 系统 → 创建 → 推进 → 查询活动目标
 * 5. 卡片查询路径 → 从 wiki/ 正确读取
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ensureWikiStructure, migrateLegacyData, seedWikiDefaults, createWikiPage, updateWikiPage, readMemory, updateMemory, createGoal, advanceGoal, getActiveGoals, regenerateIndex, appendToLog } from "../../electron/wiki-manager.ts";
import { listEntities, getCardData, listEntityTypes } from "../../electron/business-store.ts";
import { makeTempWorkspace, cleanupWorkspace, writeFile, readFile, exists, page } from "./helpers.mjs";

let root;
beforeEach(() => { root = makeTempWorkspace(); });
afterEach(() => cleanupWorkspace(root));

test("集成: 旧数据迁移后可通过 wiki 路径查询", () => {
  // 模拟旧结构
  writeFile(root, "workbench/okr/legacy-okr.md", page({ id: "legacy-okr", title: "旧OKR", progress: 50, status: "active" }));
  writeFile(root, "workbench/todos/legacy-todo.md", page({ id: "legacy-todo", title: "旧待办", status: "todo" }));
  writeFile(root, "workbench/cases/incident.md", page({ id: "incident", title: "故障案例" }));

  // 运行 wiki 初始化（含迁移）
  ensureWikiStructure(root);
  migrateLegacyData(root);
  seedWikiDefaults(root);

  // 验证数据已迁移到 wiki/ 并可查询
  assert.ok(exists(root, "workbench/wiki/okr/legacy-okr.md"));
  assert.ok(exists(root, "workbench/wiki/todos/legacy-todo.md"));
  assert.ok(exists(root, "workbench/wiki/knowledge/cases/incident.md"));

  // listEntities 从 wiki 路径读取
  const okrs = listEntities(root, "okr");
  assert.ok(okrs.length >= 1);
  assert.ok(okrs.some((e) => e.frontmatter.title === "旧OKR"));
});

test("集成: 卡片查询（getCardData）从 wiki/ 路径读取", () => {
  ensureWikiStructure(root);
  seedWikiDefaults(root);
  createWikiPage(root, "todos", "跟进招行", { status: "todo", priority: 4 });

  const data = getCardData(root, [{
    id: "todo-card",
    entityType: "todos",
    filter: { status: "todo" },
    sortBy: "priority",
    sortDesc: true,
  }]);
  assert.ok(data["todo-card"].length >= 1);
  assert.ok(data["todo-card"].some((e) => e.frontmatter.title === "跟进招行"));
});

test("集成: listEntityTypes 发现迁移后的动态类型", () => {
  writeFile(root, "workbench/visits/visit1.md", page({ title: "拜访1" }));
  ensureWikiStructure(root);
  migrateLegacyData(root);

  const types = listEntityTypes(root);
  assert.ok(types.includes("visits"), "应该发现 visits 类型");
  assert.ok(types.includes("okr"));
  assert.ok(types.includes("todos"));
});

test("集成: Agent 完整工作流 — 创建页面 → 更新 → 查记忆 → 推进目标", () => {
  ensureWikiStructure(root);
  seedWikiDefaults(root);

  // 1. Agent 发现用户偏好 → 更新记忆
  updateMemory(root, "user-profile", "## 基本信息\n- 姓名：Ryan\n- 沟通风格：简洁直接", "append");
  const mem = readMemory(root);
  assert.match(mem.userProfile, /简洁直接/);

  // 2. Agent 创建维保页面
  const maintenance = createWikiPage(root, "maintenance", "招行AF续保", {
    customer: "招商银行",
    product: "AF防火墙",
    status: "expiring",
    dueDate: "2026-09-15",
  }, "## 基本信息\n客户：招商银行");

  // 3. Agent 追加跟进记录
  updateWikiPage(root, maintenance.relPath, "## 跟进记录\n- 2026-08-12 确认续保");
  const updated = readFile(root, `workbench/wiki/${maintenance.relPath}`);
  assert.match(updated, /确认续保/);

  // 4. Agent 创建多步骤目标
  const goal = createGoal(root, "推进招行续保", ["确认报价", "发送合同", "跟进签约"]);
  assert.ok(goal.relPath);

  // 5. 推进目标
  advanceGoal(root, goal.relPath);
  advanceGoal(root, goal.relPath);

  // 6. 查询活动目标
  const active = getActiveGoals(root);
  assert.equal(active.length, 1);
  assert.equal(active[0].currentStep, 2);

  // 7. log.md 记录了所有操作
  const log = readFile(root, "workbench/wiki/log.md");
  assert.match(log, /create_page/);
  assert.match(log, /update_page/);
  assert.match(log, /create_goal/);
  assert.match(log, /advance_goal/);
});

test("集成: index.md 反映实际页面分布", () => {
  ensureWikiStructure(root);
  seedWikiDefaults(root);
  createWikiPage(root, "maintenance", "维保A", {});
  createWikiPage(root, "maintenance", "维保B", {});
  createWikiPage(root, "ka", "客户A", {});
  regenerateIndex(root);

  const idx = readFile(root, "workbench/wiki/index.md");
  assert.match(idx, /maintenance/);
  assert.match(idx, /2/); // 2 个维保
  assert.match(idx, /ka/);
});
