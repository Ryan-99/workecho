/**
 * Phase 1c — 动态 ENTITY_TYPES + wiki/ 路径支持测试（TDD）。
 *
 * entityDir/entityFile/listEntities 需要透明地读写 workbench/wiki/<type>/，
 * 同时向后兼容旧的 workbench/<type>/ 路径（迁移过渡期）。
 * ENTITY_TYPES 改为可通过扫描 wiki/ 目录动态发现。
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  entityDir,
  entityFile,
  listEntities,
  readEntity,
  listEntityTypes,
  wikiCategoryDir,
  DEFAULT_ENTITY_TYPES,
} from "../../electron/business-store.ts";
import { makeTempWorkspace, cleanupWorkspace, writeFile, page, exists } from "./helpers.mjs";

let root;
beforeEach(() => { root = makeTempWorkspace(); });
afterEach(() => cleanupWorkspace(root));

test("DEFAULT_ENTITY_TYPES: 包含固定 + 默认动态类型", () => {
  assert.ok(DEFAULT_ENTITY_TYPES.includes("okr"));
  assert.ok(DEFAULT_ENTITY_TYPES.includes("todos"));
  assert.ok(DEFAULT_ENTITY_TYPES.includes("maintenance"));
});

test("wikiCategoryDir: 始终返回 workbench/wiki/<type>/ 路径", () => {
  const dir = wikiCategoryDir(root, "todos");
  assert.ok(dir.replace(/\\/g, "/").endsWith("workbench/wiki/todos"));
});

test("entityDir: wiki/ 路径存在时优先用新路径", () => {
  writeFile(root, "workbench/wiki/todos/.keep", ""); // 确保目录存在
  const dir = entityDir(root, "todos");
  assert.ok(dir.replace(/\\/g, "/").endsWith("workbench/wiki/todos"));
});

test("entityDir: wiki/ 不存在时回退旧路径 workbench/<type>/（迁移过渡）", () => {
  writeFile(root, "workbench/todos/.keep", ""); // 只有旧路径
  const dir = entityDir(root, "todos");
  assert.ok(dir.replace(/\\/g, "/").endsWith("workbench/todos"));
});

test("entityFile: wiki 路径下的文件完整路径", () => {
  writeFile(root, "workbench/wiki/todos/.keep", "");
  const f = entityFile(root, "todos", "task1");
  assert.ok(f.replace(/\\/g, "/").endsWith("workbench/wiki/todos/task1.md"));
});

test("listEntities: 读 wiki/<type>/ 下的实体", () => {
  writeFile(root, "workbench/wiki/todos/a.md", page({ title: "A", status: "todo" }));
  writeFile(root, "workbench/wiki/todos/b.md", page({ title: "B", status: "done" }));
  const list = listEntities(root, "todos");
  assert.equal(list.length, 2);
});

test("listEntities: wiki 不存在时读旧路径（过渡兼容）", () => {
  writeFile(root, "workbench/todos/a.md", page({ title: "A" }));
  const list = listEntities(root, "todos");
  assert.equal(list.length, 1);
  assert.equal(list[0].frontmatter.title, "A");
});

test("readEntity: 从 wiki 路径读取", () => {
  writeFile(root, "workbench/wiki/okr/q3.md", page({ title: "Q3 目标", progress: 50 }));
  const e = readEntity(root, "okr", "q3");
  assert.ok(e);
  assert.equal(e.frontmatter.title, "Q3 目标");
  assert.equal(e.frontmatter.progress, 50);
});

test("readEntity: 找不到返回 null", () => {
  assert.equal(readEntity(root, "okr", "nope"), null);
});

test("listEntityTypes: 扫描 wiki/ 目录动态发现类型", () => {
  writeFile(root, "workbench/wiki/okr/a.md", page({ title: "x" }));
  writeFile(root, "workbench/wiki/todos/b.md", page({ title: "y" }));
  writeFile(root, "workbench/wiki/visits/c.md", page({ title: "z" })); // 自定义类型
  const types = listEntityTypes(root);
  assert.ok(types.includes("okr"));
  assert.ok(types.includes("todos"));
  assert.ok(types.includes("visits")); // 动态类型也发现
});

test("listEntityTypes: wiki 不存在时返回默认类型", () => {
  const types = listEntityTypes(root);
  // 即使没有 wiki 目录，至少返回默认类型
  assert.ok(types.includes("okr"));
  assert.ok(types.includes("todos"));
});
