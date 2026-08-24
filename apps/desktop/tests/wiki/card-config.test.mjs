/**
 * 卡片配置测试：KA 卡绑定修正 + 旧配置自动迁移。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

/* ===== 卡片模板精简：默认只装待办，其余全靠用户/AI 按需创建 ===== */

test("模板目录只剩待办事项+OKR（维保/KA/项目不再预置，需要就让 AI 建）", async () => {
  const { PRESET_TEMPLATES } = await import("../../electron/card-config.ts");
  const titles = PRESET_TEMPLATES.map((c) => c.title).sort();
  assert.deepEqual(titles, ["OKR 进展", "待办事项"]);
  assert.ok(!titles.includes("KA 客户"), "KA 卡不再预置");
  assert.ok(!titles.includes("维保续费"), "维保卡不再预置");
  assert.ok(!titles.includes("重点项目"), "项目卡不再预置");
});

test("新初始化默认只装待办事项一张卡（知识库概览是独立固定卡）", async () => {
  const { readCardConfig } = await import("../../electron/card-config.ts");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "wb-card-def-"));
  try {
    const cards = readCardConfig(dir);
    const titles = cards.map((c) => c.title).sort();
    assert.deepEqual(titles, ["待办事项"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readCardConfig 迁移：旧 ka/name 卡自动升级为 customers/title（用户已存配置无需手动改）", async () => {
  const { readCardConfig, saveCardConfig } = await import("../../electron/card-config.ts");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "wb-card-"));
  try {
    // 模拟用户已存的旧配置
    saveCardConfig(dir, [{
      id: "preset-3", title: "KA 客户", icon: "Users", entityType: "ka",
      displayFields: ["name", "tier", "status"],
      fieldLabels: { name: "客户", tier: "等级", status: "状态" },
      limit: 10, template: "preset",
    }]);
    const migrated = readCardConfig(dir);
    const ka = migrated.find((c) => c.id === "preset-3" || c.title === "KA 客户");
    assert.equal(ka?.entityType, "customers", "应迁移为 customers");
    assert.ok(ka?.displayFields.includes("title"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
