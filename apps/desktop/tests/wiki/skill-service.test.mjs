/**
 * Skill 导入测试（TDD）。
 *
 * 设置页从「新建」改为「导入」：技能包 = 含 SKILL.md 的目录，
 * 完整技能应在与 Agent 对话中沉淀（wiki_create_skill），设置页只做导入/管理。
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let root; // skills 根
let dir; // 源目录父级
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "wb-skills-"));
  dir = mkdtempSync(join(tmpdir(), "wb-src-"));
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true }); });

test("importSkill: 导入含 SKILL.md 的目录", async () => {
  const { importSkill } = await import("../../electron/skill-service.ts");
  const src = join(dir, "my-report-skill");
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "SKILL.md"), "---\nname: my-report\ndescription: 测试技能\n---\n# 内容\n步骤...", "utf-8");
  writeFileSync(join(src, "helper.md"), "辅助文件", "utf-8");
  const r = importSkill(root, src);
  assert.equal(r.imported, true, r.reason);
  assert.ok(existsSync(join(root, "my-report-skill", "SKILL.md")), "应复制到 skills 根目录");
  assert.ok(existsSync(join(root, "my-report-skill", "helper.md")), "附属文件一并复制");
  const r2 = importSkill(root, src);
  assert.equal(r2.imported, true, "重复导入幂等");
});

test("importSkill: 没有 SKILL.md 的目录拒绝", async () => {
  const { importSkill } = await import("../../electron/skill-service.ts");
  const src = join(dir, "not-a-skill");
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "readme.txt"), "不是技能", "utf-8");
  const r = importSkill(root, src);
  assert.equal(r.imported, false);
  assert.match(r.reason ?? "", /SKILL\.md/);
});
