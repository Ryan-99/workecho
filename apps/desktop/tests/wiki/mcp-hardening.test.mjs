/**
 * 安全审核 F-29/MCP-1 回归测试：MCP spawn 环境白名单与保存前 diff 摘要。
 *
 * - buildSpawnEnv：子进程不再全量继承 process.env（Electron 应用变量/可被
 *   劫持的 PATH 覆写面收敛到白名单），用户自定义 env 仍可覆盖；
 * - summarizeMcpChanges：新增/变更的命令行进入确认摘要，纯删除不触发确认。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSpawnEnv, summarizeMcpChanges } from "../../electron/mcp-client.ts";

test("buildSpawnEnv: 只透传白名单键，不含应用自有变量", () => {
  process.env.WORKECHO_TEST_APP_VAR = "secret-app-value";
  process.env.PATH = process.env.PATH || "/usr/bin";
  try {
    const env = buildSpawnEnv();
    assert.equal(env.WORKECHO_TEST_APP_VAR, undefined, "非白名单的应用变量不应透传");
    assert.ok(env.PATH, "PATH 必须透传（命令解析依赖）");
    assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
  } finally {
    delete process.env.WORKECHO_TEST_APP_VAR;
  }
});

test("buildSpawnEnv: 用户自定义 env 在白名单之后应用，可显式覆盖", () => {
  const env = buildSpawnEnv({ MY_TOOL_TOKEN: "t1", PATH: "/custom/path" });
  assert.equal(env.MY_TOOL_TOKEN, "t1");
  assert.equal(env.PATH, "/custom/path");
});

test("buildSpawnEnv: 不传 configEnv 时结果只含白名单键", () => {
  const env = buildSpawnEnv();
  for (const key of Object.keys(env)) {
    assert.ok(
      ["PATH", "Path", "PATHEXT", "SystemRoot", "SystemDrive", "ComSpec", "TEMP", "TMP",
        "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "ProgramFiles", "ProgramData",
        "windir", "LANG", "LC_ALL", "TZ", "TERM", "SHELL", "XDG_CONFIG_HOME"].includes(key),
      `意外键: ${key}`,
    );
  }
});

test("summarizeMcpChanges: 新增与命令变更产生摘要行", () => {
  const current = {
    keep: { command: "node", args: ["s.js"] },
    changed: { command: "node", args: ["old.js"] },
    removed: { command: "node", args: ["r.js"] },
  };
  const next = {
    keep: { command: "node", args: ["s.js"] },
    changed: { command: "python", args: ["new.py"] },
    fresh: { command: "npx", args: ["-y", "some-mcp"] },
  };
  const lines = summarizeMcpChanges(current, next);
  assert.equal(lines.length, 2, "仅新增+变更两行，未变更与删除不产生摘要");
  assert.ok(lines.some((l) => l.includes("+ fresh") && l.includes("npx -y some-mcp")));
  assert.ok(lines.some((l) => l.includes("~ changed") && l.includes("python new.py")));
});

test("summarizeMcpChanges: 纯删除不触发确认（摘要为空）", () => {
  const current = { gone: { command: "node", args: ["x.js"] } };
  assert.equal(summarizeMcpChanges(current, {}).length, 0);
});

test("summarizeMcpChanges: 非法条目（缺 command）跳过不崩", () => {
  const lines = summarizeMcpChanges(null, { bad: {}, also: { command: "ok" } });
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes("+ also"));
});

test("summarizeMcpChanges: args 变更也算命令行变更", () => {
  const current = { s: { command: "node", args: ["a.js"] } };
  const next = { s: { command: "node", args: ["b.js"] } };
  assert.equal(summarizeMcpChanges(current, next).length, 1);
});
