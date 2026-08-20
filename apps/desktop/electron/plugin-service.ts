/**
 * A1 Agent 自我修改插件（WIKI-DESIGN.md 附录 A1）。
 *
 * Agent 发现自己缺少能力时，自己写工具插件代码到 workbench/.pi/extensions/。
 * pi agent 会自动加载该目录下的 .ts 文件作为工具扩展。
 *
 * 安全机制：
 * - 插件代码写入前展示给用户确认（通过 Extension UI）
 * - 检测危险操作（exec/delete/fs）并警告
 * - 插件只能用 pi.registerTool API
 */
import { existsSync, writeFileSync, readdirSync, readFileSync, unlinkSync, mkdirSync } from "node:fs";
import path from "node:path";
import { workbenchRoot, wikiRoot, appendToLog } from "./wiki-manager";

/** .pi/extensions 目录路径 */
function extensionsDir(workspaceDir: string): string {
  return path.join(workbenchRoot(workspaceDir), ".pi", "extensions");
}

/**
 * 危险操作关键词检测（仅提示，不拦截；强制确认由 tool-pipeline 的
 * isDangerousOp(wiki_create_plugin) 负责）。注意不能带 /g 标志——
 * 带 /g 的 RegExp.test 有 lastIndex 状态，多次调用会漏报。
 */
const DANGEROUS_PATTERNS = [
  { pattern: /exec\s*\(|execSync|spawn\s*\(|spawnSync/, msg: "检测到命令执行（exec/spawn），可能危险" },
  { pattern: /unlink|rm\s+-rf|rmdir|rimraf/i, msg: "检测到文件删除操作" },
  { pattern: /writeFile.*\.\.|dotenv|process\.env/i, msg: "检测到环境变量或路径写入" },
  { pattern: /require\s*\(|child_process|import\s*\(|from\s+["']node:/, msg: "检测到动态/系统模块加载（require/import/child_process）" },
  { pattern: /\.pi|extensions\/|agent\/mcp-servers/, msg: "检测到对插件/扩展/MCP 配置路径的访问" },
];

export interface ValidationResult {
  valid: boolean;
  reason?: string;
  warnings: string[];
}

/**
 * 验证插件代码：
 * - 必须有 export default function
 * - 必须调用 pi.registerTool
 * - 检测危险操作
 */
export function validatePluginCode(code: string): ValidationResult {
  const warnings: string[] = [];

  // 必须有 export default
  if (!/export\s+default\s+function/.test(code)) {
    return { valid: false, reason: "插件必须 export default function(pi) { ... }", warnings };
  }
  // 必须调用 registerTool
  if (!/registerTool\s*\(/.test(code)) {
    return { valid: false, reason: "插件必须在函数内调用 pi.registerTool() 注册至少一个工具", warnings };
  }

  // 危险操作检测
  for (const { pattern, msg } of DANGEROUS_PATTERNS) {
    if (pattern.test(code)) {
      warnings.push(msg);
    }
  }

  return { valid: true, warnings };
}

export interface CreatePluginResult {
  created: boolean;
  relPath: string;
  reason?: string;
  warnings: string[];
}

/** 创建插件文件。同名插件已存在时默认拒绝覆盖（force 显式开启才允许） */
export function createPlugin(
  workspaceDir: string,
  name: string,
  code: string,
  options: { force?: boolean } = {},
): CreatePluginResult {
  const validation = validatePluginCode(code);
  if (!validation.valid) {
    return { created: false, relPath: "", reason: validation.reason, warnings: validation.warnings };
  }

  const dir = extensionsDir(workspaceDir);
  mkdirSync(dir, { recursive: true });

  // 安全文件名（只允许字母数字和连字符）
  const safeName = name.replace(/[^a-zA-Z0-9-_]/g, "-");
  const fileName = `${safeName}.ts`;
  const fullPath = path.join(dir, fileName);
  if (existsSync(fullPath) && !options.force) {
    return {
      created: false,
      relPath: `workbench/.pi/extensions/${fileName}`,
      reason: `插件 ${safeName} 已存在；如确认覆盖请删除后重建（防止静默替换已有插件行为）`,
      warnings: validation.warnings,
    };
  }
  writeFileSync(fullPath, code, "utf-8");

  appendToLog(workspaceDir, `plugin_create | .pi/extensions/${fileName}${validation.warnings.length > 0 ? ` | WARN: ${validation.warnings.join("; ")}` : ""}`);

  return {
    created: true,
    relPath: `workbench/.pi/extensions/${fileName}`,
    warnings: validation.warnings,
  };
}

export interface PluginInfo {
  name: string;
  fileName: string;
  tools: string[]; // 注册的工具名
  description: string;
}

/** 列出所有插件 */
export function listPlugins(workspaceDir: string): PluginInfo[] {
  const dir = extensionsDir(workspaceDir);
  if (!existsSync(dir)) return [];

  const plugins: PluginInfo[] = [];
  for (const fileName of readdirSync(dir)) {
    if (!fileName.endsWith(".ts") || fileName.startsWith("_")) continue;
    const code = (() => {
      try {
        return readFileSync(path.join(dir, fileName), "utf-8");
      } catch { return ""; }
    })();
    // 提取工具名
    const tools: string[] = [];
    const toolMatches = code.matchAll(/registerTool\s*\(\s*\{\s*name\s*:\s*["']([^"']+)["']/g);
    for (const m of toolMatches) {
      if (m[1]) tools.push(m[1]);
    }
    // 提取描述（第一个 registerTool 的 description）
    const descMatch = code.match(/description\s*:\s*["']([^"']+)["']/);
    plugins.push({
      name: fileName.replace(/\.ts$/, ""),
      fileName,
      tools,
      description: descMatch?.[1] ?? "",
    });
  }
  return plugins;
}

/** 删除插件 */
export function removePlugin(workspaceDir: string, name: string): boolean {
  const safeName = name.replace(/[^a-zA-Z0-9-_]/g, "-");
  const fullPath = path.join(extensionsDir(workspaceDir), `${safeName}.ts`);
  if (!existsSync(fullPath)) return false;
  unlinkSync(fullPath);
  appendToLog(workspaceDir, `plugin_remove | .pi/extensions/${safeName}.ts`);
  return true;
}
