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

/** 预定义模板 */
export const PRESET_TEMPLATES: Omit<CardConfig, "id">[] = [
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
  {
    title: "维保续费",
    icon: "ShieldCheck",
    entityType: "maintenance",
    displayFields: ["customer", "product", "expireDate", "status", "amount"],
    fieldLabels: { customer: "客户", product: "产品", expireDate: "到期", status: "状态", amount: "金额" },
    sortBy: "expireDate",
    limit: 10,
    template: "preset",
  },
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
    title: "KA 客户",
    icon: "Users",
    entityType: "ka",
    displayFields: ["name", "tier", "status"],
    fieldLabels: { name: "客户", tier: "等级", status: "状态" },
    limit: 10,
    template: "preset",
  },
  {
    title: "重点项目",
    icon: "FolderKanban",
    entityType: "projects",
    displayFields: ["title", "status"],
    fieldLabels: { title: "项目", status: "状态" },
    limit: 5,
    template: "preset",
  },
];

/** 默认卡片配置（首次启动写入） */
function defaultCards(): CardConfig[] {
  return PRESET_TEMPLATES.map((t, i) => ({ ...t, id: `preset-${i}` }));
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
    return JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    return defaultCards();
  }
}

/** 保存卡片配置 */
export function saveCardConfig(userDataDir: string, cards: CardConfig[]): void {
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(cardConfigPath(userDataDir), JSON.stringify(cards, null, 2), "utf-8");
}
