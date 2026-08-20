/**
 * Phase 1d — 数据迁移测试（TDD）。
 *
 * 旧路径 → 新路径映射（WIKI-DESIGN.md 第十节）：
 *   workbench/okr/         → workbench/wiki/okr/
 *   workbench/todos/       → workbench/wiki/todos/
 *   workbench/maintenance/ → workbench/wiki/maintenance/
 *   workbench/ka/          → workbench/wiki/ka/
 *   workbench/projects/    → workbench/wiki/projects/
 *   workbench/cases/       → workbench/wiki/knowledge/cases/
 *   workbench/_inbox/      → workbench/_sources/inbox/
 *
 * 迁移幂等：已迁移则跳过。
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ensureWikiStructure, migrateLegacyData } from "../../electron/wiki-manager.ts";
import { makeTempWorkspace, cleanupWorkspace, writeFile, readFile, exists } from "./helpers.mjs";

let root;
beforeEach(() => { root = makeTempWorkspace(); });
afterEach(() => cleanupWorkspace(root));

test("migrateLegacyData: 业务实体从旧路径迁移到 wiki/", () => {
  writeFile(root, "workbench/okr/q3.md", "---\ntitle: Q3\n---\nbody");
  writeFile(root, "workbench/todos/task.md", "---\ntitle: task\n---\n");
  ensureWikiStructure(root);
  const result = migrateLegacyData(root);
  assert.ok(result.migrated > 0);
  assert.ok(exists(root, "workbench/wiki/okr/q3.md"));
  assert.ok(exists(root, "workbench/wiki/todos/task.md"));
  assert.equal(readFile(root, "workbench/wiki/okr/q3.md"), "---\ntitle: Q3\n---\nbody");
});

test("migrateLegacyData: cases/ 迁移到 knowledge/cases/", () => {
  writeFile(root, "workbench/cases/incident.md", "---\ntitle: 故障\n---\n");
  ensureWikiStructure(root);
  migrateLegacyData(root);
  assert.ok(exists(root, "workbench/wiki/knowledge/cases/incident.md"));
});

test("migrateLegacyData: _inbox/ 迁移到 _sources/inbox/", () => {
  writeFile(root, "workbench/_inbox/note.txt", "some note");
  ensureWikiStructure(root);
  migrateLegacyData(root);
  assert.ok(exists(root, "workbench/_sources/inbox/note.txt"));
});

test("migrateLegacyData: 迁移后旧目录清空", () => {
  writeFile(root, "workbench/okr/q3.md", "---\ntitle: Q3\n---\n");
  ensureWikiStructure(root);
  migrateLegacyData(root);
  assert.ok(!exists(root, "workbench/okr/q3.md"));
});

test("migrateLegacyData: 无旧数据时幂等返回 0", () => {
  ensureWikiStructure(root);
  const result = migrateLegacyData(root);
  assert.equal(result.migrated, 0);
});

test("migrateLegacyData: 已在 wiki/ 的数据不重复迁移（幂等）", () => {
  ensureWikiStructure(root);
  writeFile(root, "workbench/wiki/okr/q3.md", "---\ntitle: Q3\n---\n");
  const result = migrateLegacyData(root);
  assert.equal(result.migrated, 0);
  // 文件内容不变
  assert.ok(exists(root, "workbench/wiki/okr/q3.md"));
});

test("migrateLegacyData: 迁移记录写入 log.md", () => {
  writeFile(root, "workbench/okr/q3.md", "---\ntitle: Q3\n---\n");
  writeFile(root, "workbench/todos/t.md", "---\ntitle: T\n---\n");
  ensureWikiStructure(root);
  migrateLegacyData(root);
  const log = readFile(root, "workbench/wiki/log.md");
  assert.match(log, /migrate/i);
});
