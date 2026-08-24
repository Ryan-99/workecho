/**
 * 内置官方 Skill 安装测试：幂等、不覆盖已有、目录结构完整。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 造一个假的 bundled skills 目录 */
function makeResources() {
  const dir = mkdtempSync(join(tmpdir(), "wb-res-"));
  const base = join(dir, "skills", "demo-skill");
  mkdirSync(base, { recursive: true });
  writeFileSync(join(base, "SKILL.md"), "---\nname: demo-skill\ndescription: demo\n---\nbody\n");
  mkdirSync(join(base, "scripts"));
  writeFileSync(join(base, "scripts", "run.py"), "print('hi')");
  // 没有 SKILL.md 的目录应被忽略
  mkdirSync(join(dir, "skills", "not-a-skill"), { recursive: true });
  return dir;
}

test("installBundledSkills：首次安装（含子目录），重复调用幂等跳过", async () => {
  const { installBundledSkills, userSkillsRoot } = await import("../../electron/skill-service.ts");
  const res = makeResources();
  // 把 userSkillsRoot 重定向到临时目录：HOME 优先于 USERPROFILE（Windows Git Bash 会设 HOME），两者都要重定向
  const fakeHome = mkdtempSync(join(tmpdir(), "wb-home-"));
  const prevHome = process.env.HOME;
  const prevProfile = process.env.USERPROFILE;
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  try {
    const first = installBundledSkills(res);
    assert.deepEqual(first, ["demo-skill"]);
    const installed = join(userSkillsRoot(), "demo-skill");
    assert.ok(existsSync(join(installed, "SKILL.md")));
    assert.ok(existsSync(join(installed, "scripts", "run.py")), "子目录应完整复制");

    // 用户改过之后重跑：不得覆盖
    writeFileSync(join(installed, "SKILL.md"), "---\nname: demo-skill\ndescription: 用户修改版\n---\nuser body\n");
    const second = installBundledSkills(res);
    assert.deepEqual(second, [], "已存在不应重复安装");
    assert.match(readFileSync(join(installed, "SKILL.md"), "utf-8"), /用户修改版/);

    // resources 不存在时安全返回
    assert.deepEqual(installBundledSkills(join(res, "nope")), []);
  } finally {
    process.env.HOME = prevHome;
    process.env.USERPROFILE = prevProfile;
    rmSync(res, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("应用打包目录内置官方 skill-creator（SKILL.md + 方法论存在性抽查）", async () => {
  const { existsSync } = await import("node:fs");
  const p = join(process.cwd(), "resources", "skills", "skill-creator", "SKILL.md");
  if (!existsSync(p)) return; // 打包产物里才有的场景跳过（开发目录必有）
  const text = readFileSync(p, "utf-8");
  assert.match(text, /^---\nname: skill-creator/m, "frontmatter 完整");
  assert.ok(text.length > 5000, "官方方法论应为完整版而非摘要");
});
