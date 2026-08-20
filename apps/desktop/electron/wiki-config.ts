/**
 * Wiki 知识库全局配置。
 *
 * 存储在 <userDataDir>/wiki-config.json，控制所有 Wiki 功能的开关和行为参数。
 * SettingsView 的 "Wiki 知识库" tab 读写这里。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

/** Wiki 配置数据模型 */
export interface WikiConfig {
  // ── 自动写入 ──
  /** Agent 对话中产生有价值信息时自动写入 wiki（不需要用户确认） */
  autoWrite: boolean;
  /** 会话启动时自动读 memory（user-profile + working-context） */
  autoReadMemory: boolean;
  /** 会话切换时自动更新 working-context */
  autoUpdateContext: boolean;

  // ── A2 工具执行管道 ──
  /** 启用工具执行审计管道（PRE/POST 拦截） */
  pipelineEnabled: boolean;
  /** 修改 OKR/维保等关键数据时需要确认 */
  dangerousOpConfirm: boolean;

  // ── P2 Hooks 规则 ──
  /** 启用用户 Hook 规则（事件→动作：记日志/通知/阻止） */
  hooksEnabled: boolean;

  // ── A4 Schedule 子系统 ──
  /** 启用定时规则自动触发 */
  scheduleEnabled: boolean;
  /** 启用每日早报（查询待办+维保→生成简报） */
  dailyBriefing: boolean;
  /** 每日早报触发时间（HH:MM） */
  dailyBriefingTime: string;

  // ── A1 自我修改插件 ──
  /** 允许 Agent 自己创建工具插件 */
  selfModifyPlugins: boolean;
  /** 创建插件时需要用户确认代码 */
  pluginCreateConfirm: boolean;

  // ── 知识摄取 ──
  /** 摄取文档时自动建立交叉引用 */
  ingestAutoCrossRef: boolean;
  /** 领域发现关键词频次阈值（超过此值建议创建类型） */
  discoverThreshold: number;

  // ── 可视化 ──
  /** 状态面板显示"知识库概览"卡片 */
  showWikiStatsCard: boolean;

  // ── 旧知识库 ──
  /** 旧版 Karpathy 式知识库目录（如 D:\Workspace\Workspace），初始化时自动导入 */
  legacyWikiPath?: string;
}

/** 默认配置 */
export const DEFAULT_WIKI_CONFIG: WikiConfig = {
  autoWrite: true,
  autoReadMemory: true,
  autoUpdateContext: true,
  pipelineEnabled: true,
  dangerousOpConfirm: true,
  hooksEnabled: true,
  scheduleEnabled: false,
  dailyBriefing: false,
  dailyBriefingTime: "09:00",
  selfModifyPlugins: false,
  pluginCreateConfirm: true,
  ingestAutoCrossRef: true,
  discoverThreshold: 3,
  showWikiStatsCard: true,
};

const CONFIG_FILE = "wiki-config.json";

/** 配置文件完整路径 */
export function wikiConfigPath(userDataDir: string): string {
  return path.join(userDataDir, CONFIG_FILE);
}

/**
 * 读取 Wiki 配置。首次调用写入默认值。
 * 与已有配置合并（新增字段自动补默认值，兼容旧配置）。
 */
export function readWikiConfig(userDataDir: string): WikiConfig {
  const file = wikiConfigPath(userDataDir);
  if (!existsSync(file)) {
    writeWikiConfig(userDataDir, DEFAULT_WIKI_CONFIG);
    return { ...DEFAULT_WIKI_CONFIG };
  }
  try {
    const raw = JSON.parse(readFileSync(file, "utf-8"));
    // 合并：已有值优先，缺失字段补默认值
    return { ...DEFAULT_WIKI_CONFIG, ...raw };
  } catch {
    return { ...DEFAULT_WIKI_CONFIG };
  }
}

/** 保存 Wiki 配置（整体覆写） */
export function writeWikiConfig(userDataDir: string, config: WikiConfig): void {
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(wikiConfigPath(userDataDir), JSON.stringify(config, null, 2), "utf-8");
}

/**
 * 局部更新配置（patch 模式），返回合并后的完整配置。
 * 适合 UI 中单个 toggle 变更时调用。
 */
export function patchWikiConfig(userDataDir: string, patch: Partial<WikiConfig>): WikiConfig {
  const current = readWikiConfig(userDataDir);
  const updated = { ...current, ...patch };
  writeWikiConfig(userDataDir, updated);
  return updated;
}

/**
 * 工具/扩展用的同步读取：从默认 userDataDir 路径读取配置。
 * 业务逻辑中需要检查开关时调用此函数。
 */
/** 与 Electron userData 约定对齐的应用数据目录（跨平台）。所有同步读取配置的地方统一走这里。 */
export function piUserDataDir(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  // Win: AppData/Roaming/pi, Mac: ~/Library/Application Support/pi, Linux: $XDG_CONFIG_HOME/pi（默认 ~/.config/pi）
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "pi");
  if (process.platform === "linux") return path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "pi");
  return path.join(home, "AppData", "Roaming", "pi");
}

export function getActiveWikiConfig(): WikiConfig {
  return readWikiConfig(piUserDataDir());
}
