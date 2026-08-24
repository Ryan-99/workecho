/**
 * 卡片配置管理。
 *
 * 卡片配置存在 userData/card-config.json。每张卡片定义：
 * - 绑定的实体类型（okr/maintenance/todos/ka/projects 或自定义类型）
 * - 展示哪些 front-matter 字段
 * - 过滤/排序/数量限制
 *
 * 用户可以：(1) 从预定义模板添加，(2) 让 AI 通过 create_card_template 工具创建自定义。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

export interface CardConfig {
  id: string;
  title: string;
  icon: string;                    // lucide 图标名
  entityType: string;              // 实体类型（okr/maintenance/.../自定义）
  displayFields: string[];         // 展示哪些 front-matter 字段
  fieldLabels?: Record<string, string>;  // 字段中文名映射
  filter?: Record<string, unknown>;      // 过滤条件
  sortBy?: string;                 // 排序字段
  sortDesc?: boolean;
  limit?: number;
  template: "preset" | "custom";
}

/** 可选模板（"+"添加）：OKR 按需手动加；维保/KA/项目等业务卡一律让 Agent 用 create_card_template 建 */
export const PRESET_TEMPLATES: Omit<CardConfig, "id">[] = [
  {
    title: "待办事项",
    icon: "CheckSquare",
    entityType: "todos",
    displayFields: ["title", "dueDate"],
    fieldLabels: { title: "事项", dueDate: "截止" },
    sortBy: "priority",
    sortDesc: true,
    limit: 10,
    template: "preset",
  },
  {
    title: "OKR 进展",
    icon: "Target",
    entityType: "okr",
    displayFields: ["title", "progress", "status"],
    fieldLabels: { title: "目标", progress: "进度", status: "状态" },
    sortBy: "progress",
    sortDesc: true,
    limit: 5,
    template: "preset",
  },
];

/** 首次初始化默认只装待办事项；OKR 等其余卡片用户手动添加或让 AI 创建 */
const DEFAULT_CARD_TITLES = new Set(["待办事项"]);

/** 默认卡片配置（首次启动写入） */
function defaultCards(): CardConfig[] {
  return PRESET_TEMPLATES
    .filter((t) => DEFAULT_CARD_TITLES.has(t.title))
    .map((t, i) => ({ ...t, id: `preset-${i}` }));
}

const CONFIG_FILE = "card-config.json";

export function cardConfigPath(userDataDir: string): string {
  return path.join(userDataDir, CONFIG_FILE);
}

/** 读卡片配置。首次调用写入默认值。 */
export function readCardConfig(userDataDir: string): CardConfig[] {
  const file = cardConfigPath(userDataDir);
  if (!existsSync(file)) {
    const defaults = defaultCards();
    saveCardConfig(userDataDir, defaults);
    return defaults;
  }
  try {
    let cards: CardConfig[] = JSON.parse(readFileSync(file, "utf-8"));
    cards = migrateLegacyKaCard(userDataDir, cards);
    return cards;
  } catch {
    return defaultCards();
  }
}

/**
 * 旧版 KA 卡迁移：早期预设绑定 ka 类型（displayFields 为 name/tier/status），
 * 但 ka 实体（旧业务数据迁移）没有名称字段，卡片渲染为空行。
 * 统一升级为 customers（旧知识库导入的客户档案，有 title）。
 */
function migrateLegacyKaCard(userDataDir: string, cards: CardConfig[]): CardConfig[] {
  let changed = false;
  const next = cards.map((c) => {
    if (c.entityType === "ka" && Array.isArray(c.displayFields) && c.displayFields.includes("name")) {
      changed = true;
      return {
        ...c,
        entityType: "customers",
        displayFields: ["title"],
        fieldLabels: { title: "客户" },
      };
    }
    return c;
  });
  if (changed) {
    try { saveCardConfig(userDataDir, next); } catch { /* 迁移写回失败不阻塞读取 */ }
  }
  return next;
}

/** 保存卡片配置 */
export function saveCardConfig(userDataDir: string, cards: CardConfig[]): void {
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(cardConfigPath(userDataDir), JSON.stringify(cards, null, 2), "utf-8");
}
