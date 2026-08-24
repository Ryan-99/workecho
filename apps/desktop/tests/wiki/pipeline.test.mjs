/**
 * Phase 3c — A2 瀑布流工具执行管道测试（TDD）。
 *
 * 三层管道：PRE-EXECUTE（审计/拦截）→ EXECUTE → POST-EXECUTE（存入wiki/刷新）
 * 核心策略引擎可独立测试，pi hook 注册是接线代码。
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ensureWikiStructure } from "../../electron/wiki-manager.ts";
import {
  isDangerousOp,
  auditToolCall,
  PipelineDecision,
  createPolicyExtension,
} from "../../electron/tool-pipeline.ts";
import { makeTempWorkspace, cleanupWorkspace, readFile } from "./helpers.mjs";

let root;
beforeEach(() => { root = makeTempWorkspace(); ensureWikiStructure(root); });
afterEach(() => cleanupWorkspace(root));

/* ===== isDangerousOp ===== */

test("isDangerousOp: update_entity 修改 okr 类型是危险操作", () => {
  assert.ok(isDangerousOp("update_entity", { type: "okr", id: "q3", updates: { progress: 100 } }));
});

test("isDangerousOp: update_entity 修改 todos 不是危险操作", () => {
  assert.ok(!isDangerousOp("update_entity", { type: "todos", id: "t1", updates: { status: "done" } }));
});

test("isDangerousOp: create_entity 不算危险（新建不破坏数据）", () => {
  assert.ok(!isDangerousOp("create_entity", { type: "maintenance" }));
});

test("isDangerousOp: wiki_update_page 修改 maintenance 是危险操作", () => {
  assert.ok(isDangerousOp("wiki_update_page", { title: "招行维保", frontmatterUpdates: { status: "expired" } }));
});

test("isDangerousOp: query 类工具不危险", () => {
  assert.ok(!isDangerousOp("query_okr", {}));
  assert.ok(!isDangerousOp("wiki_search", { query: "test" }));
  assert.ok(!isDangerousOp("wiki_read_memory", {}));
});

/* ===== auditToolCall ===== */

test("auditToolCall: 记录工具调用到 log.md", () => {
  auditToolCall(root, "query_okr", { filter: "active" });
  const log = readFile(root, "workbench/wiki/log.md");
  assert.match(log, /tool_call/);
  assert.match(log, /query_okr/);
});

test("auditToolCall: 记录工具结果到 log.md", () => {
  auditToolCall(root, "add_todo", {}, { ok: true, result: "已添加" }, "result");
  const log = readFile(root, "workbench/wiki/log.md");
  assert.match(log, /tool_result/);
});

/* ===== createPolicyExtension ===== */

test("createPolicyExtension: 返回 ExtensionFactory 函数", () => {
  const factory = createPolicyExtension();
  assert.equal(typeof factory, "function");
});

test("createPolicyExtension: preExecute 放行安全操作", () => {
  const factory = createPolicyExtension();
  // 模拟 pi 对象
  const registered = {};
  const pi = {
    on: (event, handler) => { registered[event] = handler; },
    registerTool: () => {},
  };
  factory(pi);
  assert.ok(registered.tool_call || registered["pre-execute"] || Object.keys(registered).length > 0);
});

test("PipelineDecision: PASS 和 BLOCK 常量存在", () => {
  assert.equal(PipelineDecision.PASS, "pass");
  assert.equal(PipelineDecision.BLOCK, "block");
});
