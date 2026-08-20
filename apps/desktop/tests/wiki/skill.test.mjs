/**
 * P1-b — Skill 服务测试（TDD）。
 *
 * Agent 自管 Skill（omp learn/manage_skill 思路）：
 * createSkill 写 ~/.pi/agent/skills/<name>/SKILL.md（标准 frontmatter）
 * listSkills 解析 frontmatter，removeSkill 删除目录。
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createSkill, listSkills, removeSkill, skillDir } from "../../electron/skill-service.ts";
import { makeTempWorkspace, cleanupWorkspace, exists, readFile } from "./helpers.mjs";

let root;
beforeEach(() => { root = makeTempWorkspace(); });
afterEach(() => cleanupWorkspace(root));

test("createSkill: 写入 SKILL.md（带 frontmatter）", () => {
  const r = createSkill(root, "weekly-report", "生成每周工作回顾", "## 步骤\n1. 查询 OKR");
  assert.ok(r.created);
  assert.ok(exists(root, "weekly-report/SKILL.md"));
  const text = readFile(root, "weekly-report/SKILL.md");
  assert.match(text, /^---\nname: weekly-report\ndescription: 生成每周工作回顾\n---/);
  assert.match(text, /查询 OKR/);
});

test("createSkill: 重名拒绝", () => {
  createSkill(root, "dup", "d1", "c1");
  const r = createSkill(root, "dup", "d2", "c2");
  assert.ok(!r.created);
  assert.match(r.reason, /已存在/);
});

test("createSkill: 非法名称被清洗（特殊字符转连字符）", () => {
  const r = createSkill(root, "my skill!@#", "d", "c");
  assert.ok(r.created);
  assert.ok(exists(root, "my-skill/SKILL.md"));
});

test("createSkill: 空名称拒绝", () => {
  const r = createSkill(root, "", "d", "c");
  assert.ok(!r.created);
});

test("createSkill: 描述换行被压平（frontmatter 安全）", () => {
  createSkill(root, "multi", "第一行\n第二行", "c");
  const text = readFile(root, "multi/SKILL.md");
  assert.match(text, /description: 第一行 第二行/);
});

test("listSkills: 解析已安装 skill 的名称和描述", () => {
  createSkill(root, "skill-a", "描述A", "内容");
  createSkill(root, "skill-b", "描述B", "内容");
  const list = listSkills(root);
  assert.ok(list.some((s) => s.name === "skill-a" && s.description === "描述A"));
  assert.ok(list.some((s) => s.name === "skill-b" && s.description === "描述B"));
});

test("listSkills: 空目录返回空数组", () => {
  assert.deepEqual(listSkills(root), []);
});

test("removeSkill: 删除 skill 目录", () => {
  createSkill(root, "to-remove", "d", "c");
  assert.ok(removeSkill(root, "to-remove"));
  assert.ok(!exists(root, "to-remove/SKILL.md"));
});

test("removeSkill: 不存在返回 false", () => {
  assert.ok(!removeSkill(root, "nonexistent"));
});

test("skillDir: 名称清洗后拼接路径", () => {
  const p = skillDir(root, "My Skill");
  assert.match(p.replace(/\\/g, "/"), /My-Skill$/);
});
