/**
 * P2 — Hooks 服务测试（TDD）。
 *
 * 用户可配置的事件规则：事件 + 匹配条件 + 动作（记日志/通知/阻止）。
 * 存 workbench/wiki/hooks.md（JSON 代码块，同 schedule.md 模式）。
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ensureWikiStructure } from "../../electron/wiki-manager.ts";
import {
  ensureHooksFile,
  readHookRules,
  addHookRule,
  removeHookRule,
  matchHookRules,
  HOOK_ACTIONS,
} from "../../electron/hooks-service.ts";
import { makeTempWorkspace, cleanupWorkspace, readFile, exists } from "./helpers.mjs";

let root;
beforeEach(() => { root = makeTempWorkspace(); ensureWikiStructure(root); });
afterEach(() => cleanupWorkspace(root));

/* ===== 文件与 CRUD ===== */

test("ensureHooksFile: 创建 wiki/hooks.md（幂等）", () => {
  ensureHooksFile(root);
  assert.ok(exists(root, "workbench/wiki/hooks.md"));
  ensureHooksFile(root);
  assert.ok(exists(root, "workbench/wiki/hooks.md"));
});

test("addHookRule: 添加规则（自动 id）", () => {
  ensureHooksFile(root);
  const rule = addHookRule(root, {
    name: "OKR 修改拦截",
    event: "tool_call",
    toolName: "update_entity",
    action: "block",
    message: "修改 OKR 已被 Hook 拦截",
  });
  assert.ok(rule.id);
  const rules = readHookRules(root);
  assert.equal(rules.length, 1);
  assert.equal(rules[0].event, "tool_call");
  assert.equal(rules[0].toolName, "update_entity");
});

test("addHookRule: 支持指定固定 id（upsert）", () => {
  ensureHooksFile(root);
  addHookRule(root, { id: "fixed-1", name: "A", event: "tool_call", toolName: "t1", action: "log", message: "" });
  addHookRule(root, { id: "fixed-1", name: "A2", event: "tool_call", toolName: "t2", action: "log", message: "" });
  const rules = readHookRules(root);
  assert.equal(rules.length, 1);
  assert.equal(rules[0].name, "A2");
});

test("removeHookRule: 按 id 删除", () => {
  ensureHooksFile(root);
  const r = addHookRule(root, { name: "X", event: "tool_call", toolName: "t", action: "log", message: "" });
  assert.ok(removeHookRule(root, r.id));
  assert.equal(readHookRules(root).length, 0);
  assert.ok(!removeHookRule(root, r.id));
});

test("addHookRule: 无效事件类型拒绝", () => {
  ensureHooksFile(root);
  const r = addHookRule(root, { name: "bad", event: "invalid_event", toolName: "", action: "log", message: "" });
  assert.ok(!r);
});

test("addHookRule: 无效动作类型拒绝", () => {
  ensureHooksFile(root);
  const r = addHookRule(root, { name: "bad", event: "tool_call", toolName: "", action: "explode", message: "" });
  assert.ok(!r);
});

/* ===== 匹配 ===== */

test("matchHookRules: toolName 精确匹配", () => {
  const rules = [
    { id: "1", name: "a", enabled: true, event: "tool_call", toolName: "update_entity", action: "block", message: "" },
    { id: "2", name: "b", enabled: true, event: "tool_call", toolName: "add_todo", action: "log", message: "" },
  ];
  const hits = matchHookRules(rules, "tool_call", "update_entity");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, "1");
});

test("matchHookRules: toolName 通配 * 匹配所有", () => {
  const rules = [
    { id: "1", name: "all", enabled: true, event: "tool_call", toolName: "*", action: "log", message: "" },
  ];
  assert.equal(matchHookRules(rules, "tool_call", "anything").length, 1);
});

test("matchHookRules: toolName 前缀通配 wiki_*", () => {
  const rules = [
    { id: "1", name: "wiki", enabled: true, event: "tool_call", toolName: "wiki_*", action: "log", message: "" },
  ];
  assert.equal(matchHookRules(rules, "tool_call", "wiki_create_page").length, 1);
  assert.equal(matchHookRules(rules, "tool_call", "query_okr").length, 0);
});

test("matchHookRules: 事件不匹配排除", () => {
  const rules = [
    { id: "1", name: "a", enabled: true, event: "agent_end", toolName: "*", action: "log", message: "" },
  ];
  assert.equal(matchHookRules(rules, "tool_call", "x").length, 0);
  assert.equal(matchHookRules(rules, "agent_end", "x").length, 1);
});

test("matchHookRules: 禁用的规则不匹配", () => {
  const rules = [
    { id: "1", name: "a", enabled: false, event: "tool_call", toolName: "*", action: "log", message: "" },
  ];
  assert.equal(matchHookRules(rules, "tool_call", "x").length, 0);
});

/* ===== pi 0.84.1 新能力：terminate 动作（拦截并终止本轮） ===== */

test("HookAction 支持 terminate：applyHookRules 校验通过", () => {
  assert.ok(HOOK_ACTIONS.includes("terminate"));
});

test("tool-pipeline: terminate 规则返回 { block, reason, terminate: true } 否决", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const home = mkdtempSync(join(tmpdir(), "wb-term-"));
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  try {
    mkdirSync(join(home, ...(process.platform === "darwin" ? ["Library", "Application Support", "pi"]
      : process.platform === "linux" ? [(process.env.XDG_CONFIG_HOME ?? join(home, ".config")), "pi"]
      : ["AppData", "Roaming", "pi"])), { recursive: true });
    writeFileSync(join(home, "AppData/Roaming/pi/wiki-config.json"), JSON.stringify({ pipelineEnabled: true, hooksEnabled: true }));
    const ws = mkdtempSync(join(tmpdir(), "wb-ws-"));
    mkdirSync(join(ws, "workbench/wiki"), { recursive: true });
    writeFileSync(join(ws, "workbench/wiki/hooks.md"),
      "---\ntitle: Hooks\ntype: hooks\n---\n\n# Hooks\n\n```json\n{\"id\":\"t1\",\"name\":\"危险操作终止\",\"enabled\":true,\"event\":\"tool_call\",\"toolName\":\"update_entity\",\"action\":\"terminate\",\"message\":\"禁止修改实体，本轮终止\"}\n```\n");

    const { createPolicyExtension } = await import("../../electron/tool-pipeline.ts");
    const handlers = new Map();
    const pi = { registerTool: () => {}, on: (ev, fn) => handlers.set(ev, fn) };
    createPolicyExtension()(pi);
    const veto = await handlers.get("tool_call")({ toolName: "update_entity", input: {} }, { cwd: ws });
    assert.deepEqual(veto, { block: true, reason: "禁止修改实体，本轮终止", terminate: true });
    rmSync(ws, { recursive: true, force: true });
  } finally {
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("审计修复：pipelineEnabled=false 时 Hook 规则仍然生效（两开关独立）", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const home = mkdtempSync(join(tmpdir(), "wb-pipe-"));
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  try {
    // 管道关闭 + hooks 开启
    mkdirSync(join(home, ...(process.platform === "darwin" ? ["Library", "Application Support", "pi"]
      : process.platform === "linux" ? [(process.env.XDG_CONFIG_HOME ?? join(home, ".config")), "pi"]
      : ["AppData", "Roaming", "pi"])), { recursive: true });
    writeFileSync(join(home, "AppData/Roaming/pi/wiki-config.json"), JSON.stringify({ pipelineEnabled: false, hooksEnabled: true }));
    const ws = mkdtempSync(join(tmpdir(), "wb-ws-"));
    mkdirSync(join(ws, "workbench/wiki"), { recursive: true });
    writeFileSync(join(ws, "workbench/wiki/hooks.md"),
      "---\ntitle: Hooks\ntype: hooks\n---\n\n# Hooks\n\n```json\n{\"id\":\"b1\",\"name\":\"独立拦截\",\"enabled\":true,\"event\":\"tool_call\",\"toolName\":\"update_entity\",\"action\":\"block\",\"message\":\"管道关闭也应拦截\"}\n```\n");

    const { createPolicyExtension } = await import("../../electron/tool-pipeline.ts");
    const handlers = new Map();
    const pi = { registerTool: () => {}, on: (ev, fn) => handlers.set(ev, fn) };
    createPolicyExtension()(pi);
    const veto = await handlers.get("tool_call")({ toolName: "update_entity", input: {} }, { cwd: ws });
    assert.deepEqual(veto, { block: true, reason: "管道关闭也应拦截" });
    rmSync(ws, { recursive: true, force: true });
  } finally {
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("开关对称性：hooksEnabled=false 时不拦截（即使管道开启）", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const home = mkdtempSync(join(tmpdir(), "wb-off-"));
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  try {
    mkdirSync(join(home, ...(process.platform === "darwin" ? ["Library", "Application Support", "pi"]
      : process.platform === "linux" ? [(process.env.XDG_CONFIG_HOME ?? join(home, ".config")), "pi"]
      : ["AppData", "Roaming", "pi"])), { recursive: true });
    writeFileSync(join(home, "AppData/Roaming/pi/wiki-config.json"), JSON.stringify({ pipelineEnabled: true, hooksEnabled: false }));
    const ws = mkdtempSync(join(tmpdir(), "wb-ws-"));
    mkdirSync(join(ws, "workbench/wiki"), { recursive: true });
    writeFileSync(join(ws, "workbench/wiki/hooks.md"),
      "---\ntitle: Hooks\ntype: hooks\n---\n\n# Hooks\n\n```json\n{\"id\":\"b2\",\"name\":\"不应生效\",\"enabled\":true,\"event\":\"tool_call\",\"toolName\":\"update_entity\",\"action\":\"block\",\"message\":\"hooks 关闭不应拦截\"}\n```\n");
    const { createPolicyExtension } = await import("../../electron/tool-pipeline.ts");
    const handlers = new Map();
    const pi = { registerTool: () => {}, on: (ev, fn) => handlers.set(ev, fn) };
    createPolicyExtension()(pi);
    const result = await handlers.get("tool_call")({ toolName: "update_entity", input: {} }, { cwd: ws });
    assert.notEqual(result?.block, true);
    rmSync(ws, { recursive: true, force: true });
  } finally {
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  }
});
