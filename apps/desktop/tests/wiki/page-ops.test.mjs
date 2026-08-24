/**
 * Phase 2a/2b — Wiki 页面 CRUD + Memory 系统测试（TDD）。
 *
 * createWikiPage: 统一创建入口，自动加 type/category/created/updated，
 *                 维护 index.md + log.md
 * updateWikiPage: append 模式（不覆写 body），更新 updated + log
 * findPageByTitle: 按标题查找页面
 * readMemory: 读 user-profile + working-context + insights
 * updateMemory: 更新记忆页面（追加/替换 section）
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ensureWikiStructure, createWikiPage, updateWikiPage, findPageByTitle, readMemory, updateMemory, seedWikiDefaults } from "../../electron/wiki-manager.ts";
import { parseEntity } from "../../electron/business-store.ts";
import { makeTempWorkspace, cleanupWorkspace, readFile, exists } from "./helpers.mjs";

let root;
beforeEach(() => { root = makeTempWorkspace(); ensureWikiStructure(root); });
afterEach(() => cleanupWorkspace(root));

/* ===== createWikiPage ===== */

test("createWikiPage: 在指定类别下创建页面（统一格式）", () => {
  const result = createWikiPage(root, "maintenance", "招商银行AF维保", {
    customer: "招商银行",
    product: "AF防火墙",
    expireDate: "2026-09-15",
    status: "expiring",
  }, "## 基本信息\n客户：招商银行");
  assert.ok(result.created);
  assert.ok(exists(root, `workbench/wiki/${result.relPath}`));
  const { frontmatter, body } = parseEntity(readFile(root, `workbench/wiki/${result.relPath}`));
  assert.equal(frontmatter.title, "招商银行AF维保");
  assert.equal(frontmatter.type, "entity");
  assert.equal(frontmatter.category, "maintenance");
  assert.equal(frontmatter.customer, "招商银行");
  assert.match(body, /客户：招商银行/);
});

test("createWikiPage: 自动生成 id（基于标题）", () => {
  const result = createWikiPage(root, "todos", "跟进招行续保", {});
  assert.ok(result.id);
  assert.match(result.relPath, /todos/);
});

test("createWikiPage: 在 knowledge 子目录创建案例页", () => {
  const result = createWikiPage(root, "knowledge/cases", "招行AF策略故障处置", {
    type: "case",
    tags: ["AF", "策略引擎", "内存泄漏"],
  }, "## 故障现象\n...");
  assert.ok(result.relPath.includes("knowledge"));
  assert.ok(result.relPath.includes("cases"));
  const { frontmatter } = parseEntity(readFile(root, `workbench/wiki/${result.relPath}`));
  assert.equal(frontmatter.type, "case");
  assert.deepEqual(frontmatter.tags, ["AF", "策略引擎", "内存泄漏"]);
});

test("createWikiPage: 创建后记录到 log.md 和更新 index.md", () => {
  createWikiPage(root, "todos", "task1", {});
  const log = readFile(root, "workbench/wiki/log.md");
  assert.match(log, /create_page/);
  assert.match(log, /task1|todos/);
  const idx = readFile(root, "workbench/wiki/index.md");
  assert.match(idx, /todos/);
});

test("createWikiPage: 自动生成 slug 文件名（中文标题）", () => {
  const result = createWikiPage(root, "todos", "跟进招商银行续保", {});
  // 文件名应该是 ASCII slug 或带时间戳的 id
  assert.match(result.fileName, /\.md$/);
});

/* ===== updateWikiPage ===== */

test("updateWikiPage: append 模式追加内容到 body（不覆写）", () => {
  const page = createWikiPage(root, "maintenance", "招行AF", {}, "## 基本信息\n原始内容");
  updateWikiPage(root, page.relPath, "## 跟进记录\n- 2026-08-12 确认续保");
  const { body } = parseEntity(readFile(root, `workbench/wiki/${page.relPath}`));
  assert.match(body, /原始内容/);
  assert.match(body, /跟进记录/);
  assert.match(body, /确认续保/);
});

test("updateWikiPage: 更新 updated 时间戳", () => {
  const page = createWikiPage(root, "todos", "task", {});
  const before = parseEntity(readFile(root, `workbench/wiki/${page.relPath}`));
  updateWikiPage(root, page.relPath, "新增内容");
  const after = parseEntity(readFile(root, `workbench/wiki/${page.relPath}`));
  assert.ok(after.frontmatter.updated);
});

test("updateWikiPage: 也可以更新 frontmatter 字段", () => {
  const page = createWikiPage(root, "maintenance", "招行", { status: "active" });
  updateWikiPage(root, page.relPath, "", { status: "expiring", amount: 180000 });
  const { frontmatter } = parseEntity(readFile(root, `workbench/wiki/${page.relPath}`));
  assert.equal(frontmatter.status, "expiring");
  assert.equal(frontmatter.amount, 180000);
});

test("updateWikiPage: 记录到 log.md", () => {
  const page = createWikiPage(root, "todos", "task", {});
  readFile(root, "workbench/wiki/log.md"); // baseline
  updateWikiPage(root, page.relPath, "新内容");
  const log = readFile(root, "workbench/wiki/log.md");
  assert.match(log, /update_page/);
});

/* ===== findPageByTitle ===== */

test("findPageByTitle: 按标题查找页面", () => {
  createWikiPage(root, "maintenance", "招商银行AF维保", {});
  createWikiPage(root, "todos", "跟进招行", {});
  const found = findPageByTitle(root, "招商银行AF维保");
  assert.ok(found);
  assert.match(found.relPath, /maintenance/);
});

test("findPageByTitle: 找不到返回 null", () => {
  assert.equal(findPageByTitle(root, "不存在的标题"), null);
});

/* ===== Memory 系统 ===== */

test("readMemory: 读取 user-profile 和 working-context", () => {
  seedWikiDefaults(root);
  const mem = readMemory(root);
  assert.ok(mem.userProfile);
  assert.ok(mem.workingContext);
  assert.match(mem.userProfile, /用户画像|user-profile/i);
  assert.match(mem.workingContext, /当前工作上下文|working-context/i);
});

test("readMemory: 读取 insights（如果存在）", () => {
  seedWikiDefaults(root);
  // seedWikiDefaults 不一定创建 insights，但 readMemory 应处理
  const mem = readMemory(root);
  // insights 可能有内容也可能为空字符串
  assert.ok(typeof mem.insights === "string");
});

test("updateMemory: 更新 user-profile 内容", () => {
  updateMemory(root, "user-profile", "## 基本信息\n- 姓名：Ryan\n- 职位：深信服东北区AI技术负责人", "replace");
  const mem = readMemory(root);
  assert.match(mem.userProfile, /Ryan/);
  assert.match(mem.userProfile, /深信服/);
});

test("updateMemory: append 模式追加到 working-context", () => {
  seedWikiDefaults(root);
  const before = readMemory(root).workingContext;
  updateMemory(root, "working-context", "\n## 新增\n- 测试追加", "append");
  const after = readMemory(root).workingContext;
  assert.ok(after.length > before.length);
  assert.match(after, /测试追加/);
  // 原有内容保留
  assert.match(after, /本周重点|当前工作上下文/);
});

/* ===== B-01/B-08 回归：create 永不静默覆写 ===== */

test("B-01 回归: createWikiPage 同名页已存在时拒绝且不改动原文件", () => {
  createWikiPage(root, "memory", "user-profile", {}, "原始画像内容");
  const second = createWikiPage(root, "memory", "user-profile", {}, "恶意覆写内容");
  assert.equal(second.created, false);
  assert.equal(second.exists, true);
  const page = findPageByTitle(root, "user-profile");
  assert.ok(page);
  assert.ok(readFile(root, `workbench/wiki/${page.relPath}`).includes("原始画像内容"));
  assert.ok(!readFile(root, `workbench/wiki/${page.relPath}`).includes("恶意覆写内容"));
});

test("B-01 回归: category='.' 被拒绝（不能借 create 写 wiki 根的管控文件）", () => {
  assert.throws(() => createWikiPage(root, ".", "hooks", {}, "x"));
});

test("B-08 回归: suffixOnConflict 自动改名保留旧页", () => {
  const first = createWikiPage(root, "knowledge/cases", "同名案例", {}, "第一份");
  const second = createWikiPage(root, "knowledge/cases", "同名案例", {}, "第二份", { suffixOnConflict: true });
  assert.equal(second.created, true);
  assert.notEqual(second.relPath, first.relPath);
  assert.ok(readFile(root, `workbench/wiki/${first.relPath}`).includes("第一份"));
  assert.ok(readFile(root, `workbench/wiki/${second.relPath}`).includes("第二份"));
});

test("B-08 回归: overwrite=true 受控覆写仍然可用", () => {
  createWikiPage(root, "knowledge/synthesis", "周报综合", {}, "v1");
  const second = createWikiPage(root, "knowledge/synthesis", "周报综合", {}, "v2", { overwrite: true });
  assert.equal(second.created, true);
  assert.ok(readFile(root, `workbench/wiki/${second.relPath}`).includes("v2"));
});

/* ===== B-16 回归：AGENTS.md 管理块不覆盖用户内容 ===== */

test("B-16 回归: 用户手写的 AGENTS.md 内容在同步后保留（管理块追加）", async () => {
  const { syncPromptToWorkspace } = await import("../../electron/business-prompt.ts");
  const fs = await import("node:fs");
  const userContent = "# 我自己的规则\n\n- 回答用中文\n";
  fs.writeFileSync(`${root}/AGENTS.md`, userContent, "utf-8");
  syncPromptToWorkspace(root, "业务提示词 v1");
  const after = fs.readFileSync(`${root}/AGENTS.md`, "utf-8");
  assert.ok(after.includes("回答用中文"), "用户内容保留");
  assert.ok(after.includes("业务提示词 v1"), "管理块已追加");
  // 再同步 v2：用户内容仍在，管理块被替换
  syncPromptToWorkspace(root, "业务提示词 v2");
  const after2 = fs.readFileSync(`${root}/AGENTS.md`, "utf-8");
  assert.ok(after2.includes("回答用中文"), "第二次同步后用户内容仍保留");
  assert.ok(after2.includes("业务提示词 v2") && !after2.includes("业务提示词 v1"), "管理块更新为 v2");
});

test("B-16 回归: 首次同步直接写管理块；同内容旧形态升级、异内容视为用户内容保留", async () => {
  const { syncPromptToWorkspace } = await import("../../electron/business-prompt.ts");
  const fs = await import("node:fs");
  syncPromptToWorkspace(root, "全新提示词");
  const fresh = fs.readFileSync(`${root}/AGENTS.md`, "utf-8");
  assert.ok(fresh.includes("workecho:business-prompt:begin"));
  // 同内容重同步（无标记的旧形态）→ 升级为管理块
  fs.writeFileSync(`${root}/AGENTS.md`, "全新提示词", "utf-8");
  syncPromptToWorkspace(root, "全新提示词");
  const upgraded = fs.readFileSync(`${root}/AGENTS.md`, "utf-8");
  assert.ok(upgraded.includes("workecho:business-prompt:begin"), "同内容旧形态升级为管理块");
  assert.ok(upgraded.includes("全新提示词"));
  // 无法辨识来源的异内容 → 按用户内容保留并追加管理块（不覆盖）
  fs.writeFileSync(`${root}/AGENTS.md`, "可能是旧版提示词或用户内容", "utf-8");
  syncPromptToWorkspace(root, "新提示词");
  const kept = fs.readFileSync(`${root}/AGENTS.md`, "utf-8");
  assert.ok(kept.includes("可能是旧版提示词或用户内容"), "来源不明的内容按用户内容保留");
  assert.ok(kept.includes("新提示词"));
});
