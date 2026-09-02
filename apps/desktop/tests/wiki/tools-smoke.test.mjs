/**
 * 工具冒烟测试：真实执行各 Agent 工具，抓"打包后 MODULE_NOT_FOUND"这类
 * 只在运行时暴露的断裂（内联 require 在 electron-vite 打包后失效）。
 *
 * 规则：业务模块一律顶层 import；本测试执行工具确保依赖链可用。
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createBusinessTools } from "../../electron/business-runtime.ts";
import { ensureWikiStructure } from "../../electron/wiki-manager.ts";
import { patchWikiConfig } from "../../electron/wiki-config.ts";
import { makeTempWorkspace, cleanupWorkspace, exists } from "./helpers.mjs";
import { join } from "node:path";

let root;
let prevHome, prevUserProfile;
const find = (name) => createBusinessTools().find((t) => t.name === name);
const run = async (name, params, cwd) => {
  const tool = find(name);
  assert.ok(tool, `工具 ${name} 未注册`);
  return tool.execute(`smoke-${name}`, params, undefined, undefined, { cwd });
};

beforeEach(() => {
  root = makeTempWorkspace();
  // 生产环境启动时会初始化 wiki 结构；测试里等价补齐
  ensureWikiStructure(root);
  // 把 HOME/USERPROFILE 指到临时目录：userSkillsRoot / wiki-config / card-config 都基于它
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = root;
  process.env.USERPROFILE = root;
});
afterEach(() => {
  if (prevHome !== undefined) process.env.HOME = prevHome; else delete process.env.HOME;
  if (prevUserProfile !== undefined) process.env.USERPROFILE = prevUserProfile; else delete process.env.USERPROFILE;
  cleanupWorkspace(root);
});

test("冒烟: 41 个工具全部注册且可加载", () => {
  const tools = createBusinessTools();
  assert.equal(tools.length, 41);
  for (const t of tools) assert.ok(t.name && t.description && typeof t.execute === "function");
});

test("冒烟: init_workspace（skipScan）完整执行", async () => {
  const r = await run("init_workspace", { skipScan: true }, root);
  assert.match(r.content[0].text, /初始化完成/);
  assert.ok(exists(root, "workbench/wiki/index.md"));
});

test("冒烟: 定时任务工具链（create + list + remove）", async () => {
  const r1 = await run("wiki_create_schedule", {
    name: "冒烟早报", triggerType: "every", time: "09:00",
    action: "查询今日待办生成早报",
  }, root);
  assert.match(r1.content[0].text, /已创建定时规则/);
  const r2 = await run("wiki_list_schedules", {}, root);
  assert.match(r2.content[0].text, /冒烟早报/);
  const id = r1.details.id;
  const r3 = await run("wiki_remove_schedule", { ruleId: id }, root);
  assert.match(r3.content[0].text, /已删除/);
});

test("冒烟: Skill 工具链（create + list）", async () => {
  const r1 = await run("wiki_create_skill", {
    name: "smoke-skill", description: "冒烟测试技能", content: "## 步骤\n测试",
  }, root);
  assert.match(r1.content[0].text, /已创建 Skill/);
  const r2 = await run("wiki_list_skills", {}, root);
  assert.match(r2.content[0].text, /smoke-skill/);
});

test("冒烟: 插件工具链（create + list + remove）", async () => {
  // 插件工具受 selfModifyPlugins 开关控制（默认关）——测试里先开启
  patchWikiConfig(join(root, ...(process.platform === "darwin" ? ["Library", "Application Support", "pi"]
  : process.platform === "linux" ? [(process.env.XDG_CONFIG_HOME ?? join(root, ".config")), "pi"]
  : ["AppData", "Roaming", "pi"])), { selfModifyPlugins: true });
  const code = `export default function(pi) { pi.registerTool({ name: "smoke_tool", description: "d", parameters: { type: "object", properties: {} }, async execute() { return { content: [{ type: "text", text: "ok" }], details: {} }; } }); }`;
  const r1 = await run("wiki_create_plugin", { name: "smoke-plugin", code }, root);
  assert.match(r1.content[0].text, /已创建插件/);
  const r2 = await run("wiki_list_plugins", {}, root);
  assert.match(r2.content[0].text, /smoke-plugin/);
  const r3 = await run("wiki_remove_plugin", { name: "smoke-plugin" }, root);
  assert.match(r3.content[0].text, /已删除/);
});

test("冒烟: 卡片模板工具（create + list + remove）", async () => {
  const r1 = await run("create_card_template", {
    title: "冒烟卡片", entityType: "smoketype",
    displayFields: ["title", "date"], fieldLabels: { title: "标题", date: "日期" },
  }, root);
  assert.match(r1.content[0].text, /已创建卡片/);
  const r2 = await run("list_card_templates", {}, root);
  assert.match(r2.content[0].text, /冒烟卡片/);
  const id = r1.details.id;
  const r3 = await run("remove_card_template", { cardId: id }, root);
  assert.match(r3.content[0].text, /已删除/);
});

test("冒烟: wiki_ingest 文本摄取", async () => {
  const r = await run("wiki_ingest", {
    text: "AF防火墙策略引擎故障排查案例", title: "冒烟案例",
  }, root);
  assert.match(r.content[0].text, /已摄取/);
});

test("冒烟: wiki_import_legacy（不存在的目录安全返回）", async () => {
  const r = await run("wiki_import_legacy", { sourceDir: "D:/不存在的目录xyz" }, root);
  assert.match(r.content[0].text, /没有导入任何文件/);
});
