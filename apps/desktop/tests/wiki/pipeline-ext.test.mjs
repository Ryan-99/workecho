/**
 * 管道补全测试（差距 P1/P2）。
 *
 * P1：Hooks 的 session_start / agent_end 事件真正挂载（此前 UI 可配但永不触发）
 * P2：危险操作确认流（dangerousOpConfirm 配置生效，可注入 confirmer）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPolicyExtension, setDangerousOpConfirmer } from "../../electron/tool-pipeline.ts";

function makeEnv(config) {
  const home = mkdtempSync(join(tmpdir(), "wb-ext-"));
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  mkdirSync(join(home, ...(process.platform === "darwin" ? ["Library", "Application Support", "pi"]
      : process.platform === "linux" ? [(process.env.XDG_CONFIG_HOME ?? join(home, ".config")), "pi"]
      : ["AppData", "Roaming", "pi"])), { recursive: true });
  writeFileSync(join(home, "AppData/Roaming/pi/wiki-config.json"), JSON.stringify(config));
  const ws = mkdtempSync(join(tmpdir(), "wb-ws-"));
  mkdirSync(join(ws, "workbench/wiki"), { recursive: true });
  const cleanup = () => {
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  };
  return { ws, cleanup };
}

function makePi() {
  const handlers = new Map();
  return {
    handlers,
    pi: { registerTool: () => {}, on: (ev, fn) => handlers.set(ev, fn) },
  };
}

test("P1: session_start 事件触发 log 规则写入日志", () => {
  const env = makeEnv({ hooksEnabled: true });
  try {
    writeFileSync(join(env.ws, "workbench/wiki/hooks.md"),
      "---\ntitle: Hooks\ntype: hooks\n---\n\n# Hooks\n\n```json\n{\"id\":\"s1\",\"name\":\"会话启动记日志\",\"enabled\":true,\"event\":\"session_start\",\"toolName\":\"*\",\"action\":\"log\",\"message\":\"\"}\n```\n");
    const { pi, handlers } = makePi();
    createPolicyExtension()(pi);
    assert.ok(handlers.has("session_start"), "应订阅 session_start");
    assert.ok(handlers.has("agent_end"), "应订阅 agent_end");
    handlers.get("session_start")({}, { cwd: env.ws });
    const log = readFileSync(join(env.ws, "workbench/wiki/log.md"), "utf-8");
    assert.match(log, /hook \| 会话启动记日志 \| session_start/);
  } finally { env.cleanup(); }
});

test("P2: 危险操作 + confirmer 拒绝 → 否决执行", async () => {
  const env = makeEnv({ pipelineEnabled: true, dangerousOpConfirm: true });
  let asked = null;
  setDangerousOpConfirmer(async (title, body) => { asked = { title, body }; return false; });
  try {
    const { pi, handlers } = makePi();
    createPolicyExtension()(pi);
    const veto = await handlers.get("tool_call")(
      { toolName: "update_entity", input: { type: "okr", id: "q3", updates: { status: "done" } } },
      { cwd: env.ws },
    );
    assert.equal(asked?.title, "危险操作确认");
    assert.match(asked?.body ?? "", /okr/);
    assert.deepEqual(veto, { block: true, reason: "用户拒绝了危险操作" });
  } finally {
    setDangerousOpConfirmer(null);
    env.cleanup();
  }
});

test("P2: 危险操作 + 用户同意 → 放行", async () => {
  const env = makeEnv({ pipelineEnabled: true, dangerousOpConfirm: true });
  setDangerousOpConfirmer(async () => true);
  try {
    const { pi, handlers } = makePi();
    createPolicyExtension()(pi);
    const r = await handlers.get("tool_call")(
      { toolName: "update_entity", input: { type: "okr", id: "q3", updates: { status: "done" } } },
      { cwd: env.ws },
    );
    assert.notEqual(r?.block, true, "用户同意后应放行");
  } finally {
    setDangerousOpConfirmer(null);
    env.cleanup();
  }
});

test("P2: dangerousOpConfirm=false → 不弹确认直接放行", async () => {
  const env = makeEnv({ pipelineEnabled: true, dangerousOpConfirm: false });
  let asked = false;
  setDangerousOpConfirmer(async () => { asked = true; return false; });
  try {
    const { pi, handlers } = makePi();
    createPolicyExtension()(pi);
    const r = await handlers.get("tool_call")(
      { toolName: "update_entity", input: { type: "okr", id: "q3", updates: { status: "done" } } },
      { cwd: env.ws },
    );
    assert.equal(asked, false, "不应弹确认");
    assert.notEqual(r?.block, true, "应放行");
  } finally {
    setDangerousOpConfirmer(null);
    env.cleanup();
  }
});
