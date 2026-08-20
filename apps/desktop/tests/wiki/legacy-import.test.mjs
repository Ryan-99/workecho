/**
 * 旧知识库导入测试（TDD）。
 *
 * 目标：把用户之前的 Karpathy 式精炼库（如 D:\Workspace\Workspace）导入统一 wiki：
 *   wiki/concepts/*.md        → wiki/knowledge/concepts/
 *   wiki/entities/customers/  → wiki/customers/（动态类型，可出卡片）
 *   wiki/entities/<其他>/     → wiki/<其他>/
 *   journals/                 → wiki/journals/
 *   pages/                    → wiki/pages/
 *   raw/                      → _sources/raw/（不可变源）
 *   wiki/index.md             → 精炼区块并入我们的 index（不被 regenerateIndex 覆盖）
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ensureWikiStructure, importLegacyWiki, regenerateIndex, readIndex } from "../../electron/wiki-manager.ts";
import { makeTempWorkspace, cleanupWorkspace, writeFile, readFile, exists } from "./helpers.mjs";

let root;
let legacy; // 模拟 D:\Workspace\Workspace
beforeEach(() => {
  root = makeTempWorkspace();
  legacy = makeTempWorkspace();
  ensureWikiStructure(root);
});
afterEach(() => { cleanupWorkspace(root); cleanupWorkspace(legacy); });

/** 搭一个迷你版旧库 */
function seedLegacy() {
  writeFile(legacy, "wiki/concepts/客户档案体系.md", "---\ntitle: 客户档案体系\ntype: concept\n---\n# 客户档案体系\n标准化客户信息管理，支撑主动运营");
  writeFile(legacy, "wiki/entities/customers/大连海事大学.md", "---\ntitle: 大连海事大学\ntype: entity\n---\n教育客户，信创 HCI 交付中");
  writeFile(legacy, "wiki/entities/projects/LRC标杆.md", "---\ntitle: LRC标杆\n---\n方法论项目");
  writeFile(legacy, "journals/2026_04_14.md", "# 4月14日\n今天推进了...");
  writeFile(legacy, "pages/2026 OKR.md", "# 2026 OKR\nO1 泛KA关键业务高效落地");
  writeFile(legacy, "raw/articles/入侵溯源.md", "原始文章...");
  writeFile(legacy, "wiki/index.md", "# Wiki Index\n## 概念\n- [[客户档案体系]] — 标准化体系");
}

test("importLegacyWiki: 概念页导入 knowledge/concepts", () => {
  seedLegacy();
  const r = importLegacyWiki(root, legacy);
  assert.ok(r.imported > 0);
  assert.ok(exists(root, "workbench/wiki/knowledge/concepts/客户档案体系.md"));
  assert.match(readFile(root, "workbench/wiki/knowledge/concepts/客户档案体系.md"), /主动运营/);
});

test("importLegacyWiki: 客户档案导入 wiki/customers（动态类型可出卡片）", () => {
  seedLegacy();
  importLegacyWiki(root, legacy);
  assert.ok(exists(root, "workbench/wiki/customers/大连海事大学.md"));
});

test("importLegacyWiki: 其他实体目录导入 wiki/<type>", () => {
  seedLegacy();
  importLegacyWiki(root, legacy);
  assert.ok(exists(root, "workbench/wiki/projects/LRC标杆.md"));
});

test("importLegacyWiki: 日志和 pages 导入", () => {
  seedLegacy();
  importLegacyWiki(root, legacy);
  assert.ok(exists(root, "workbench/wiki/journals/2026_04_14.md"));
  assert.ok(exists(root, "workbench/wiki/pages/2026 OKR.md"));
});

test("importLegacyWiki: raw 目录进 _sources/raw（不可变）", () => {
  seedLegacy();
  importLegacyWiki(root, legacy);
  assert.ok(exists(root, "workbench/_sources/raw/articles/入侵溯源.md"));
});

test("importLegacyWiki: 旧 index 作为精炼区块并入，不被 regenerateIndex 覆盖", () => {
  seedLegacy();
  importLegacyWiki(root, legacy);
  // 旧 index 的内容保留
  let idx = readIndex(root);
  assert.match(idx, /客户档案体系/);
  assert.match(idx, /标准化体系/);
  // 之后任何 create_page 触发 regenerateIndex，精炼区块仍在
  regenerateIndex(root);
  idx = readIndex(root);
  assert.match(idx, /客户档案体系\]\] — 标准化体系/);
});

test("importLegacyWiki: 幂等（重复导入不重复）", () => {
  seedLegacy();
  const r1 = importLegacyWiki(root, legacy);
  const r2 = importLegacyWiki(root, legacy);
  assert.equal(r2.imported, 0);
});

test("importLegacyWiki: 源目录不存在返回 0 不报错", () => {
  const r = importLegacyWiki(root, "D:/不存在的目录xyz");
  assert.equal(r.imported, 0);
});

test("regenerateIndex: 无精炼区块时行为不变（纯计数）", () => {
  regenerateIndex(root);
  const idx = readIndex(root);
  assert.match(idx, /知识目录/);
});
