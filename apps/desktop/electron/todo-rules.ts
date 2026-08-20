/**
 * 待办排序规则管理。
 *
 * 用户可以在设置页编辑排序规则（自然语言描述），注入系统提示词。
 * AI 创建/更新待办时会根据规则给 priority 字段打分（1-5，5 最紧急）。
 * 状态面板按 priority 降序显示。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const RULES_FILE = "todo-sort-rules.md";

const DEFAULT_RULES = `# 待办排序规则

创建或更新待办时，请根据以下规则给 priority 字段打分（1-5，5 最紧急）：

## 默认规则
- **5 分（紧急）**：已逾期、当天截止、影响客户交付的事项
- **4 分（高）**：3 天内截止、领导关注、KA 客户相关
- **3 分（中）**：本周内截止、常规跟进事项
- **2 分（低）**：下周或更远、非紧急
- **1 分（可延后）**：无截止日期、想法/备选事项

## 排序优先级
1. priority 高的排前面
2. 同 priority 的按 dueDate 升序（近的排前面）
3. 无 dueDate 的排最后

用户可以修改以上规则来定制自己的排序逻辑。
`;

export function rulesFilePath(userDataDir: string): string {
  return path.join(userDataDir, RULES_FILE);
}

export function readTodoRules(userDataDir: string): string {
  const file = rulesFilePath(userDataDir);
  if (!existsSync(file)) {
    writeFileSync(file, DEFAULT_RULES, "utf-8");
  }
  return readFileSync(file, "utf-8");
}

export function writeTodoRules(userDataDir: string, content: string): void {
  writeFileSync(rulesFilePath(userDataDir), content, "utf-8");
}
