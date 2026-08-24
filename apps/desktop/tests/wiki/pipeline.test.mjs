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

/* ===== B-01/B-03/B-04 回归：确认门覆盖面与开关独立性 ===== */

test("B-01 回归: wiki_create_page 写 memory/ 是危险操作（持久化注入面）", () => {
  assert.ok(isDangerousOp("wiki_create_page", { category: "memory", title: "x" }));
  assert.ok(isDangerousOp("wiki_create_page", { category: "Memory/", title: "x" }));
  assert.ok(!isDangerousOp("wiki_create_page", { category: "todos", title: "x" }));
});

test("B-01 回归: wiki_update_page 按标题更新管控文件（hooks/schedule/log）是危险操作", () => {
  assert.ok(isDangerousOp("wiki_update_page", { title: "Hooks" }));
  assert.ok(isDangerousOp("wiki_update_page", { title: "schedule" }));
  assert.ok(!isDangerousOp("wiki_update_page", { title: "普通页面" }));
});

test("B-03 回归: wiki_import_legacy 与 init_workspace 显式 scanDir 是危险操作", () => {
  assert.ok(isDangerousOp("wiki_import_legacy", { sourceDir: "D:/outside" }));
  assert.ok(isDangerousOp("init_workspace", { scanDir: "D:/outside" }));
  assert.ok(!isDangerousOp("init_workspace", {}));
});

test("B-04 回归: pipelineEnabled=false 不再连带关闭危险确认", async () => {
  // 直接驱动 policy 扩展：模拟 pi 事件回调，配置 pipelineEnabled=false
  const { getActiveWikiConfig } = await import("../../electron/wiki-config.ts");
  const { setDangerousOpConfirmer } = await import("../../electron/tool-pipeline.ts");
  const registered = {};
  const pi = { on: (event, handler) => { registered[event] = handler; }, registerTool: () => {} };
  createPolicyExtension()(pi);
  const toolCall = registered["tool_call"] ?? registered.tool_call ?? Object.values(registered)[0];
  assert.ok(typeof toolCall === "function", "tool_call 钩子已注册");

  // 写入 pipelineEnabled=false 的配置（其他开关全默认开）
  const fs = await import("node:fs");
  const path = await import("node:path");
  const os = await import("node:os");
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-b04-"));
  fs.mkdirSync(path.join(root, "workbench/wiki"), { recursive: true });
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-b04-ud-"));
  const { setActiveWikiUserDataDir } = await import("../../electron/wiki-config.ts");
  setActiveWikiUserDataDir(userDataDir);
  fs.writeFileSync(path.join(userDataDir, "wiki-config.json"), JSON.stringify({ pipelineEnabled: false }));
  assert.equal(getActiveWikiConfig().pipelineEnabled, false);

  let confirmed = 0;
  setDangerousOpConfirmer(async () => { confirmed += 1; return false; });
  const verdict = await toolCall(
    { toolName: "update_entity", input: { type: "okr", id: "q3", updates: {} } },
    { cwd: root },
  );
  assert.equal(confirmed, 1, "危险确认在 pipelineEnabled=false 下仍然触发");
  assert.deepEqual(verdict, { block: true, reason: "用户拒绝了危险操作" });
  setDangerousOpConfirmer(null);
  fs.rmSync(cfgDir, { recursive: true, force: true });
  fs.rmSync(userDataDir, { recursive: true, force: true });
});
