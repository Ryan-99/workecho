/**
 * Phase 1e — Wiki 初始种子数据测试（TDD）。
 *
 * seedWikiDefaults 创建：
 * - memory/user-profile.md（用户画像模板）
 * - memory/working-context.md（工作上下文模板）
 * - okr/example-okr.md（示例 OKR）
 * - todos/example-todo.md（示例待办）
 * 幂等：已存在则跳过。
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ensureWikiStructure, seedWikiDefaults } from "../../electron/wiki-manager.ts";
import { parseEntity } from "../../electron/business-store.ts";
import { makeTempWorkspace, cleanupWorkspace, readFile, exists } from "./helpers.mjs";

let root;
beforeEach(() => { root = makeTempWorkspace(); ensureWikiStructure(root); });
afterEach(() => cleanupWorkspace(root));

test("seedWikiDefaults: 创建 user-profile.md 记忆模板", () => {
  seedWikiDefaults(root);
  assert.ok(exists(root, "workbench/wiki/memory/user-profile.md"));
  const text = readFile(root, "workbench/wiki/memory/user-profile.md");
  const { frontmatter } = parseEntity(text);
  assert.equal(frontmatter.type, "memory");
});

test("seedWikiDefaults: 创建 working-context.md 记忆模板", () => {
  seedWikiDefaults(root);
  assert.ok(exists(root, "workbench/wiki/memory/working-context.md"));
});

test("seedWikiDefaults: 创建示例 OKR", () => {
  seedWikiDefaults(root);
  assert.ok(exists(root, "workbench/wiki/okr/example-okr.md"));
  const { frontmatter } = parseEntity(readFile(root, "workbench/wiki/okr/example-okr.md"));
  assert.equal(frontmatter.type, "entity");
  assert.equal(frontmatter.category, "okr");
});

test("seedWikiDefaults: 创建示例待办", () => {
  seedWikiDefaults(root);
  assert.ok(exists(root, "workbench/wiki/todos/example-todo.md"));
});

test("seedWikiDefaults: 示例数据带 type/tags/created 等统一字段", () => {
  seedWikiDefaults(root);
  const { frontmatter } = parseEntity(readFile(root, "workbench/wiki/okr/example-okr.md"));
  assert.ok(frontmatter.type);
  assert.ok(frontmatter.created);
  assert.ok(frontmatter.updated);
});

test("seedWikiDefaults: 幂等（已有则跳过）", () => {
  seedWikiDefaults(root);
  // 记录内容
  const before = readFile(root, "workbench/wiki/memory/user-profile.md");
  // 再调一次
  seedWikiDefaults(root);
  const after = readFile(root, "workbench/wiki/memory/user-profile.md");
  assert.equal(before, after);
});

test("seedWikiDefaults: 记录到 log.md", () => {
  seedWikiDefaults(root);
  const log = readFile(root, "workbench/wiki/log.md");
  assert.match(log, /seed/i);
});
