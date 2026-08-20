/**
 * Skill 服务：Agent 自管 Skill（omp learn/manage_skill 思路）。
 *
 * Skill 是 <skillsBase>/<name>/SKILL.md（标准 frontmatter 格式）：
 *   ---
 *   name: weekly-report
 *   description: 生成每周工作回顾
 *   ---
 *   ## 步骤 ...
 *
 * 生产环境 skillsBase = ~/.pi/agent/skills（pi 的用户级发现目录）。
 * Agent 通过 wiki_create_skill 工具把对话经验沉淀成 skill；
 * 设置页「新建 Skill」也走同一套逻辑。
 */
import { existsSync, mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync, cpSync } from "node:fs";
import path from "node:path";

export interface CreateSkillResult {
  created: boolean;
  path?: string;
  reason?: string;
}

export interface SkillInfo {
  name: string;
  description: string;
  dir: string;
}

/** 生产环境 skills 根目录 */
export function userSkillsRoot(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  return path.join(home, ".pi", "agent", "skills");
}

/** 单个 skill 目录（名称清洗：非字母数字连字符 → -，连续合并） */
export function skillDir(skillsBase: string, name: string): string {
  const safe = name.trim()
    .replace(/[^a-zA-Z0-9-_]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return path.join(skillsBase, safe);
}

/** 创建 skill（重名拒绝） */
export function createSkill(
  skillsBase: string,
  name: string,
  description: string,
  content: string,
): CreateSkillResult {
  const trimmed = name.trim();
  if (!trimmed) return { created: false, reason: "名称不能为空" };
  const dir = skillDir(skillsBase, trimmed);
  const skillPath = path.join(dir, "SKILL.md");
  if (existsSync(skillPath)) {
    return { created: false, reason: `Skill "${trimmed}" 已存在`, path: skillPath };
  }
  mkdirSync(dir, { recursive: true });
  // 描述压平成单行（frontmatter 安全）
  const flatDesc = description.replace(/\r?\n/g, " ").trim();
  const fm = ["---", `name: ${trimmed}`, `description: ${flatDesc}`, "---", ""].join("\n");
  writeFileSync(skillPath, fm + content.trim() + "\n", "utf-8");
  return { created: true, path: skillPath };
}

/** 列出已安装 skill（解析 frontmatter） */
export function listSkills(skillsBase: string): SkillInfo[] {
  if (!existsSync(skillsBase)) return [];
  const out: SkillInfo[] = [];
  for (const name of readdirSync(skillsBase, { withFileTypes: true })) {
    if (!name.isDirectory()) continue;
    const skillPath = path.join(skillsBase, name.name, "SKILL.md");
    if (!existsSync(skillPath)) continue;
    try {
      const text = readFileSync(skillPath, "utf-8");
      const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      let skillName = name.name;
      let description = "";
      if (m) {
        const nameMatch = m[1]?.match(/^name:\s*(.+)$/m);
        const descMatch = m[1]?.match(/^description:\s*(.+)$/m);
        if (nameMatch?.[1]) skillName = nameMatch[1].trim();
        if (descMatch?.[1]) description = descMatch[1].trim();
      }
      out.push({ name: skillName, description, dir: path.join(skillsBase, name.name) });
    } catch { /* 跳过解析失败的 */ }
  }
  return out;
}

/** 删除 skill（整个目录） */
export function removeSkill(skillsBase: string, name: string): boolean {
  const dir = skillDir(skillsBase, name);
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

export interface ImportSkillResult {
  imported: boolean;
  path?: string;
  reason?: string;
}

/**
 * 导入技能包：sourceDir 必须是含 SKILL.md 的目录，
 * 整目录复制到 <skillsBase>/<目录名>（重名覆盖，幂等）。
 */
export function importSkill(skillsBase: string, sourceDir: string): ImportSkillResult {
  if (!existsSync(sourceDir)) {
    return { imported: false, reason: `目录不存在: ${sourceDir}` };
  }
  if (!existsSync(path.join(sourceDir, "SKILL.md"))) {
    return { imported: false, reason: "所选目录里没有 SKILL.md，不是有效的技能包" };
  }
  const target = skillDir(skillsBase, path.basename(sourceDir));
  if (path.basename(target) === "" || path.basename(target) === ".") {
    return { imported: false, reason: "目录名无法作为技能名" };
  }
  const name = path.basename(target);
  mkdirSync(skillsBase, { recursive: true });
  rmSync(target, { recursive: true, force: true });
  cpSync(sourceDir, target, { recursive: true });
  return { imported: true, path: target };
}
