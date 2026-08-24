/**
 * 计划模式测试：写类工具判定 + 状态读写 + 管道否决行为。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

test("isMutationTool：写类动词命中，只读与编排工具放行", async () => {
  const { isMutationTool } = await import("../../electron/plan-mode.ts");
  // 写类（含 wiki/实体/bash）
  for (const name of ["write", "edit", "bash", "create_entity", "update_entity", "wiki_create_page",
    "wiki_update_memory", "wiki_ingest", "create_card_template", "init_workspace"]) {
    assert.ok(isMutationTool(name), `${name} 应视为写类`);
  }
  // 只读
  for (const name of ["read", "ls", "grep", "find", "web_fetch", "web_search", "wiki_search",
    "wiki_read_memory", "query_okr", "list_threads", "read_thread"]) {
    assert.ok(!isMutationTool(name), `${name} 应视为只读`);
  }
  // 词边界：不含误伤
  assert.ok(!isMutationTool("already_read_file"), "already_read 不应命中（词边界）");
  // 消息编排在计划模式可用（send/stop 不在写类清单）
  assert.ok(!isMutationTool("send_message_to_thread"), "子线程消息不算写类");

  // init_scan：默认预览=只读，import=true=写入
  assert.ok(!isMutationTool("init_scan"), "init_scan 预览应视为只读");
  assert.ok(isMutationTool("init_scan", { import: true }), "init_scan import=true 应视为写类");
});

test("setPlanMode/isPlanMode：按工作区隔离，默认关闭", async () => {
  const { setPlanMode, isPlanMode } = await import("../../electron/plan-mode.ts");
  const wsA = "/tmp/ws-a", wsB = "/tmp/ws-b";
  assert.equal(isPlanMode(wsA), false, "默认关闭");
  setPlanMode(wsA, true);
  assert.equal(isPlanMode(wsA), true);
  assert.equal(isPlanMode(wsB), false, "工作区之间互不影响");
  setPlanMode(wsA, false);
  assert.equal(isPlanMode(wsA), false);
});

test("计划模式否决走 tool-pipeline：preExecute 前置拦截（行为由 createPolicyExtension 的 toolCall 钩子实现，此处锁定引导语存在）", async () => {
  const { PLAN_MODE_VETO_REASON } = await import("../../electron/plan-mode.ts");
  assert.ok(PLAN_MODE_VETO_REASON.includes("只读"), "否决理由要说明只读");
  assert.ok(PLAN_MODE_VETO_REASON.includes("行动方案"), "否决理由要引导输出方案");
});
