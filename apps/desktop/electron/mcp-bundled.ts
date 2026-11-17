/**
 * 内置 MCP 包安装（对标 installBundledSkills / installBundledBinary）。
 *
 * 布局：
 *   resources/mcp/manifest.json
 *   resources/mcp/<id>/...          # 解压后的 MCP 服务器文件
 *   resources/mcp/secrets.local.json    # 开发机本地密钥（gitignore，不进仓/不进包）
 *   resources/mcp/secrets.packaged.json # 可选：构建期写入并打进安装包（gitignore，不进仓）
 *
 * 启动时把内置服务器复制到 ~/.pi/agent/bundled-mcp/<id>/，并在
 * ~/.pi/agent/mcp-servers.json 中幂等合并配置（绝不覆盖用户已有同名条目）。
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export interface BundledMcpServerSpec {
  /** mcp-servers.json 中的键名 */
  readonly id: string;
  /** resources/mcp/ 下的子目录名 */
  readonly dirname: string;
  readonly command: string;
  readonly args?: readonly string[];
  /** 额外环境变量；值可用 ${ENV_NAME} 引用 process.env / secrets.local.json */
  readonly env?: Readonly<Record<string, string>>;
}

export interface BundledMcpManifest {
  readonly servers: readonly BundledMcpServerSpec[];
}

export interface InstallBundledMcpResult {
  readonly installedDirs: string[];
  readonly configuredServers: string[];
  readonly skippedExisting: string[];
  /** 目录已复制，但因 ${ENV} 未解析到非空值而未写入 mcp-servers.json */
  readonly skippedMissingSecrets: string[];
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as T;
  } catch {
    return null;
  }
}

function mergeSecretMaps(...maps: Array<Readonly<Record<string, string>>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const map of maps) {
    for (const [k, v] of Object.entries(map)) {
      if (typeof v === "string" && v.length > 0) out[k] = v;
    }
  }
  return out;
}

function readSecretFile(filePath: string): Record<string, string> {
  const raw = readJsonFile<Record<string, unknown>>(filePath);
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "string" && v.length > 0) out[k] = v;
  }
  return out;
}

/**
 * 读取 MCP 密钥：process 侧由 resolveEnvTemplates 再覆盖。
 * 优先级（后者覆盖前者）：secrets.packaged.json → secrets.local.json
 */
export function readMcpLocalSecrets(resourcesDir: string): Record<string, string> {
  const mcpDir = path.join(resourcesDir, "mcp");
  return mergeSecretMaps(
    readSecretFile(path.join(mcpDir, "secrets.packaged.json")),
    readSecretFile(path.join(mcpDir, "secrets.local.json")),
  );
}

/** 解析 ${VAR} 占位：优先 process.env，其次 secrets（packaged/local） */
export function resolveEnvTemplates(
  env: Readonly<Record<string, string>> | undefined,
  secrets: Readonly<Record<string, string>>,
): Record<string, string> | undefined {
  if (!env) return undefined;
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    const m = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value.trim());
    if (!m) {
      resolved[key] = value;
      continue;
    }
    const name = m[1]!;
    const fromEnv = process.env[name];
    const fromSecrets = secrets[name];
    if (typeof fromEnv === "string" && fromEnv.length > 0) resolved[key] = fromEnv;
    else if (typeof fromSecrets === "string" && fromSecrets.length > 0) resolved[key] = fromSecrets;
    else resolved[key] = ""; // 缺密钥时写空串，便于用户后续在设置页补全
  }
  return resolved;
}

export function readBundledMcpManifest(resourcesDir: string): BundledMcpManifest | null {
  const manifestPath = path.join(resourcesDir, "mcp", "manifest.json");
  const raw = readJsonFile<BundledMcpManifest>(manifestPath);
  if (!raw || !Array.isArray(raw.servers)) return null;
  return raw;
}

/**
 * 安装内置 MCP：复制目录 + 合并 mcp-servers.json。
 * 幂等：已存在同名 server 配置不覆盖；目标目录已存在则跳过复制。
 */
export function installBundledMcpServers(
  resourcesDir: string,
  agentDir: string,
): InstallBundledMcpResult {
  const result: InstallBundledMcpResult = {
    installedDirs: [],
    configuredServers: [],
    skippedExisting: [],
    skippedMissingSecrets: [],
  };
  const manifest = readBundledMcpManifest(resourcesDir);
  if (!manifest || manifest.servers.length === 0) return result;

  const secrets = readMcpLocalSecrets(resourcesDir);
  const bundledRoot = path.join(resourcesDir, "mcp");
  const targetRoot = path.join(agentDir, "bundled-mcp");
  mkdirSync(targetRoot, { recursive: true });
  mkdirSync(agentDir, { recursive: true });

  const configPath = path.join(agentDir, "mcp-servers.json");
  const existingRaw = readJsonFile<Record<string, unknown>>(configPath) ?? {};
  // 兼容 { servers: {...} } 与扁平 map
  const wrapped = existingRaw.servers && typeof existingRaw.servers === "object";
  const serversMap: Record<string, unknown> = wrapped
    ? { ...(existingRaw.servers as Record<string, unknown>) }
    : { ...existingRaw };

  let configChanged = false;

  for (const spec of manifest.servers) {
    if (!spec?.id || !spec.dirname || !spec.command) continue;
    const sourceDir = path.join(bundledRoot, spec.dirname);
    if (!existsSync(sourceDir)) {
      console.warn(`[mcp-bundled] 跳过 ${spec.id}：缺少目录 ${sourceDir}`);
      continue;
    }

    const targetDir = path.join(targetRoot, spec.id);
    if (!existsSync(targetDir)) {
      mkdirSync(path.dirname(targetDir), { recursive: true });
      cpSync(sourceDir, targetDir, { recursive: true });
      result.installedDirs.push(spec.id);
    }

    if (serversMap[spec.id]) {
      result.skippedExisting.push(spec.id);
      continue;
    }

    const args = (spec.args ?? []).map((a) =>
      a.replaceAll("${MCP_ROOT}", targetDir).replaceAll("${BUNDLED_MCP_ROOT}", targetRoot),
    );
    const env = resolveEnvTemplates(spec.env, secrets);
    // 缺密钥时不要写入配置：createMcpExtension 会对无响应子进程空等 ~10s，
    // 拖慢每次 Electron 启动并打爆短超时的 lifecycle 测试。
    if (env && Object.values(env).some((v) => v.length === 0)) {
      console.warn(
        `[mcp-bundled] 跳过写入 ${spec.id}：缺少环境变量（请配置 secrets.local.json 或 process.env）`,
      );
      result.skippedMissingSecrets.push(spec.id);
      continue;
    }
    serversMap[spec.id] = {
      command: spec.command,
      args,
      ...(env && Object.keys(env).length > 0 ? { env } : {}),
    };
    result.configuredServers.push(spec.id);
    configChanged = true;
  }

  if (configChanged) {
    const next = wrapped ? { ...existingRaw, servers: serversMap } : serversMap;
    writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
  }

  return result;
}
