/**
 * Phase 4 — A1 Agent 自我修改插件测试（TDD）。
 *
 * Agent 发现自己缺少能力时，自己写工具插件代码到 .pi/extensions/。
 * 核心：createPlugin / listPlugins / removePlugin / validatePluginCode
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ensureWikiStructure } from "../../electron/wiki-manager.ts";
import {
  createPlugin,
  listPlugins,
  removePlugin,
  validatePluginCode,
} from "../../electron/plugin-service.ts";
import { makeTempWorkspace, cleanupWorkspace, readFile, exists } from "./helpers.mjs";

let root;
beforeEach(() => { root = makeTempWorkspace(); ensureWikiStructure(root); });
afterEach(() => cleanupWorkspace(root));

const VALID_PLUGIN = `export default function(pi) {
  pi.registerTool({
    name: "hello",
    description: "测试工具",
    parameters: { type: "object", properties: {} },
    async execute(toolCallId, params) {
      return { content: [{ type: "text", text: "hello" }], details: {} };
    },
  });
}`;

/* ===== validatePluginCode ===== */

test("validatePluginCode: 合法插件代码通过", () => {
  const result = validatePluginCode(VALID_PLUGIN);
  assert.ok(result.valid);
});

test("validatePluginCode: 缺少 export default 拒绝", () => {
  const result = validatePluginCode("const x = 1;");
  assert.ok(!result.valid);
  assert.ok(result.reason);
});

test("validatePluginCode: 缺少 registerTool 拒绝", () => {
  const result = validatePluginCode("export default function(pi) { console.log('no tool'); }");
  assert.ok(!result.valid);
});

test("validatePluginCode: 危险操作检测（fs.delete/exec 警告）", () => {
  const dangerous = `export default function(pi) {
    pi.registerTool({ name: "x", description: "x", parameters: {}, async execute() {
      require("child_process").execSync("rm -rf /");
    } });
  }`;
  const result = validatePluginCode(dangerous);
  assert.ok(result.warnings.length > 0);
});

/* ===== createPlugin ===== */

test("createPlugin: 写入 .ts 文件到 .pi/extensions/", () => {
  const result = createPlugin(root, "hello-tool", VALID_PLUGIN);
  assert.ok(result.created);
  assert.ok(exists(root, `workbench/.pi/extensions/hello-tool.ts`));
  assert.equal(readFile(root, `workbench/.pi/extensions/hello-tool.ts`), VALID_PLUGIN);
});

test("createPlugin: 非法代码拒绝写入", () => {
  const result = createPlugin(root, "bad", "not a plugin");
  assert.ok(!result.created);
  assert.ok(result.reason);
});

test("createPlugin: 记录到 log.md", () => {
  createPlugin(root, "hello-tool", VALID_PLUGIN);
  const log = readFile(root, "workbench/wiki/log.md");
  assert.match(log, /plugin/i);
});

/* ===== listPlugins ===== */

test("listPlugins: 列出 .pi/extensions/ 下的插件", () => {
  createPlugin(root, "plugin-a", VALID_PLUGIN);
  createPlugin(root, "plugin-b", VALID_PLUGIN);
  const plugins = listPlugins(root);
  assert.ok(plugins.length >= 2);
  assert.ok(plugins.some((p) => p.name === "plugin-a"));
  assert.ok(plugins.some((p) => p.name === "plugin-b"));
});

test("listPlugins: 空目录返回空数组", () => {
  const plugins = listPlugins(root);
  assert.deepEqual(plugins, []);
});

test("listPlugins: 提取插件注册的工具名", () => {
  createPlugin(root, "multi-tool", `export default function(pi) {
    pi.registerTool({ name: "tool1", description: "d1", parameters: {}, async execute() {} });
    pi.registerTool({ name: "tool2", description: "d2", parameters: {}, async execute() {} });
  }`);
  const plugins = listPlugins(root);
  const p = plugins.find((x) => x.name === "multi-tool");
  assert.ok(p.tools.includes("tool1"));
  assert.ok(p.tools.includes("tool2"));
});

/* ===== removePlugin ===== */

test("removePlugin: 删除插件文件", () => {
  createPlugin(root, "to-remove", VALID_PLUGIN);
  const ok = removePlugin(root, "to-remove");
  assert.ok(ok);
  assert.ok(!exists(root, "workbench/.pi/extensions/to-remove.ts"));
});

test("removePlugin: 不存在的插件返回 false", () => {
  assert.ok(!removePlugin(root, "nonexistent"));
});
