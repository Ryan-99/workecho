/**
 * Phase 3d — A4 Schedule 子系统测试（TDD）。
 *
 * Schedule = 比 cron 更智能的定时提醒：
 * - trigger: every 09:00 / before_event 3d / at specific time
 * - action: Agent 执行的查询/分析
 * - deliver: 注入对话回合（Agent 主动发言）
 *
 * 规则存在 wiki/schedule.md，Agent 可读写。
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ensureWikiStructure } from "../../electron/wiki-manager.ts";
import {
  readScheduleRules,
  addScheduleRule,
  removeScheduleRule,
  shouldFireRule,
  ensureScheduleFile,
} from "../../electron/schedule-service.ts";
import { makeTempWorkspace, cleanupWorkspace, readFile, exists } from "./helpers.mjs";

let root;
beforeEach(() => { root = makeTempWorkspace(); ensureWikiStructure(root); ensureScheduleFile(root); });
afterEach(() => cleanupWorkspace(root));

/* ===== ensureScheduleFile ===== */

test("ensureScheduleFile: 创建 wiki/schedule.md（幂等）", () => {
  assert.ok(exists(root, "workbench/wiki/schedule.md"));
  // 再调一次不报错
  ensureScheduleFile(root);
  assert.ok(exists(root, "workbench/wiki/schedule.md"));
});

/* ===== addScheduleRule / readScheduleRules ===== */

test("addScheduleRule: 添加每日定时规则", () => {
  addScheduleRule(root, {
    name: "每日早报",
    trigger: { type: "every", time: "09:00" },
    action: "查询今日待办+维保到期，生成早报",
  });
  const rules = readScheduleRules(root);
  assert.ok(rules.length >= 1);
  assert.ok(rules.some((r) => r.name === "每日早报"));
});

test("addScheduleRule: 添加事件触发规则（到期前3天）", () => {
  addScheduleRule(root, {
    name: "维保提醒",
    trigger: { type: "before_event", days: 3, entityType: "maintenance", field: "expireDate" },
    action: "查询即将到期的维保，生成续保建议",
  });
  const rules = readScheduleRules(root);
  const rule = rules.find((r) => r.name === "维保提醒");
  assert.ok(rule);
  assert.equal(rule.trigger.type, "before_event");
  assert.equal(rule.trigger.days, 3);
});

test("addScheduleRule: 自动生成 id", () => {
  addScheduleRule(root, { name: "测试", trigger: { type: "every", time: "10:00" }, action: "test" });
  const rules = readScheduleRules(root);
  assert.ok(rules[0].id);
});

/* ===== removeScheduleRule ===== */

test("removeScheduleRule: 按 id 删除规则", () => {
  const added = addScheduleRule(root, { name: "待删", trigger: { type: "every", time: "08:00" }, action: "x" });
  removeScheduleRule(root, added.id);
  const rules = readScheduleRules(root);
  assert.ok(!rules.some((r) => r.id === added.id));
});

/* ===== shouldFireRule ===== */

test("shouldFireRule: every 09:00 在 09:00 触发", () => {
  const rule = { id: "r1", name: "早报", enabled: true, trigger: { type: "every", time: "09:00" }, action: "早报" };
  const now = new Date("2026-08-12T09:00:00");
  assert.ok(shouldFireRule(rule, now, new Date("2026-08-12T08:59:00"))); // 刚到 09:00
});

test("shouldFireRule: every 09:00 在 08:00 不触发", () => {
  const rule = { id: "r1", name: "早报", enabled: true, trigger: { type: "every", time: "09:00" }, action: "早报" };
  const now = new Date("2026-08-12T08:00:00");
  assert.ok(!shouldFireRule(rule, now, new Date("2026-08-12T07:00:00")));
});

test("shouldFireRule: every Friday 17:00 在周五 17:00 触发", () => {
  const rule = { id: "r2", name: "周报", enabled: true, trigger: { type: "every", time: "17:00", weekday: 5 }, action: "周报" };
  // 2026-08-14 是周五
  const now = new Date("2026-08-14T17:00:00");
  assert.ok(shouldFireRule(rule, now, new Date("2026-08-14T16:59:00")));
});

test("shouldFireRule: every Friday 17:00 在周四不触发", () => {
  const rule = { id: "r2", name: "周报", enabled: true, trigger: { type: "every", time: "17:00", weekday: 5 }, action: "周报" };
  const now = new Date("2026-08-13T17:00:00"); // 周四
  assert.ok(!shouldFireRule(rule, now, new Date("2026-08-13T16:00:00")));
});

test("shouldFireRule: disabled 规则不触发", () => {
  const rule = { id: "r3", name: "禁用", enabled: false, trigger: { type: "every", time: "09:00" }, action: "x" };
  const now = new Date("2026-08-12T09:00:00");
  assert.ok(!shouldFireRule(rule, now, new Date("2026-08-12T08:00:00")));
});

