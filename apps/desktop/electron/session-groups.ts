/**
 * 会话分组管理。
 *
 * 轻量级 JSON 配置文件，不改动复杂的 PersistedUiState / store 层。
 * 分组是 client-side overlay — session 本身的数据不变，
 * 只是额外记录「哪个 session 属于哪个分组」。
 *
 * 存储在 <userDataDir>/session-groups.json
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface SessionGroup {
  id: string;
  name: string;
  order: number;
}

export interface SessionGroupsConfig {
  groups: SessionGroup[];
  /** sessionId → groupId */
  assignmentBySession: Record<string, string>;
}

const CONFIG_FILE = "session-groups.json";

const EMPTY_CONFIG: SessionGroupsConfig = {
  groups: [],
  assignmentBySession: {},
};

export function sessionGroupsPath(userDataDir: string): string {
  return path.join(userDataDir, CONFIG_FILE);
}

/** 读取分组配置。首次调用返回空配置。 */
export function readSessionGroups(userDataDir: string): SessionGroupsConfig {
  const file = sessionGroupsPath(userDataDir);
  if (!existsSync(file)) return { ...EMPTY_CONFIG };
  try {
    const raw = JSON.parse(readFileSync(file, "utf-8"));
    return {
      groups: Array.isArray(raw.groups) ? raw.groups : [],
      assignmentBySession: raw.assignmentBySession ?? {},
    };
  } catch {
    return { ...EMPTY_CONFIG };
  }
}

/** 保存分组配置 */
export function saveSessionGroups(userDataDir: string, config: SessionGroupsConfig): void {
  writeFileSync(sessionGroupsPath(userDataDir), JSON.stringify(config, null, 2), "utf-8");
}

/** 创建分组，返回更新后的完整配置 */
export function createGroup(userDataDir: string, name: string): SessionGroupsConfig {
  const config = readSessionGroups(userDataDir);
  const id = `g-${Date.now().toString(36)}`;
  config.groups.push({ id, name: name.trim(), order: config.groups.length });
  saveSessionGroups(userDataDir, config);
  return config;
}

/** 删除分组，该分组下的 session 回到未分类 */
export function removeGroup(userDataDir: string, groupId: string): SessionGroupsConfig {
  const config = readSessionGroups(userDataDir);
  config.groups = config.groups.filter((g) => g.id !== groupId);
  config.groups.forEach((g, i) => (g.order = i));
  // 清理该分组的 session 分配
  for (const [sid, gid] of Object.entries(config.assignmentBySession)) {
    if (gid === groupId) delete config.assignmentBySession[sid];
  }
  saveSessionGroups(userDataDir, config);
  return config;
}

/** 重命名分组 */
export function renameGroup(userDataDir: string, groupId: string, newName: string): SessionGroupsConfig {
  const config = readSessionGroups(userDataDir);
  const g = config.groups.find((g) => g.id === groupId);
  if (g) g.name = newName.trim();
  saveSessionGroups(userDataDir, config);
  return config;
}

/** 分配 session 到分组（groupId 为 null 则取消分配） */
export function assignSessionToGroup(
  userDataDir: string,
  sessionId: string,
  groupId: string | null,
): SessionGroupsConfig {
  const config = readSessionGroups(userDataDir);
  if (groupId === null) {
    delete config.assignmentBySession[sessionId];
  } else {
    config.assignmentBySession[sessionId] = groupId;
  }
  saveSessionGroups(userDataDir, config);
  return config;
}

/** 重排分组顺序 */
export function reorderGroups(userDataDir: string, groupIds: string[]): SessionGroupsConfig {
  const config = readSessionGroups(userDataDir);
  config.groups.sort((a, b) => {
    const ai = groupIds.indexOf(a.id);
    const bi = groupIds.indexOf(b.id);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });
  config.groups.forEach((g, i) => (g.order = i));
  saveSessionGroups(userDataDir, config);
  return config;
}
