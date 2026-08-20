/**
 * 安全审核 HK-1/F-06 回归测试：受保护配置文件写入检测。
 *
 * Agent 的 write/edit 工具改写 hooks.md（Hook 管控规则）、AGENTS.md（系统
 * 提示词）、mcp-servers.json（可执行命令清单）等于修改自身安全管控，
 * 必须触发危险确认（复用 tool-pipeline 的 fail-closed 确认流）。
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isProtectedConfigPath, preExecute } from "../../electron/tool-pipeline.ts";

let ws;

beforeEach(() => {
  ws = mkdtempSync(path.join(tmpdir(), "wb-prot-"));
  mkdirSync(path.join(ws, "workbench/wiki"), { recursive: true });
});

afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
});

test("hooks.md：工作区相对路径命中", () => {
  assert.ok(isProtectedConfigPath({ path: "workbench/wiki/hooks.md" }, ws));
});

test("hooks.md：绝对路径与嵌套参数命中", () => {
  const abs = path.join(ws, "workbench", "wiki", "hooks.md");
  assert.ok(isProtectedConfigPath({ path: abs }, ws));
  assert.ok(isProtectedConfigPath({ edit: { target: "workbench/wiki/hooks.md" } }, ws));
  assert.ok(isProtectedConfigPath({ files: ["a.md", "workbench/wiki/hooks.md"] }, ws));
});

test("AGENTS.md：工作区根命中，子目录的不命中", () => {
  assert.ok(isProtectedConfigPath({ path: "AGENTS.md" }, ws));
  assert.ok(isProtectedConfigPath({ path: path.join(ws, "AGENTS.md") }, ws));
  assert.ok(!isProtectedConfigPath({ path: "docs/AGENTS.md" }, ws));
});

test("mcp-servers.json：家目录绝对路径命中（win/mac 分隔符均可）", () => {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  assert.ok(isProtectedConfigPath({ path: path.join(home, ".pi", "agent", "mcp-servers.json") }, ws));
  assert.ok(isProtectedConfigPath({ path: "C:/Users/x/.pi/agent/mcp-servers.json" }, "/fake-ws"));
});

test("普通业务文件不命中", () => {
  assert.ok(!isProtectedConfigPath({ path: "workbench/wiki/todos/task.md" }, ws));
  assert.ok(!isProtectedConfigPath({ path: "src/App.tsx" }, ws));
  assert.ok(!isProtectedConfigPath({}, ws));
  assert.ok(!isProtectedConfigPath({ path: 123 }, ws));
});

test("preExecute 集成：write 工具写 hooks.md 返回 dangerous 确认", () => {
  const pre = preExecute(ws, "write", { path: "workbench/wiki/hooks.md", content: "x" });
  assert.equal(pre.decision, "pass");
  assert.equal(pre.dangerous, true);
  assert.match(pre.dangerousDescription ?? "", /受保护配置文件/);
});

test("preExecute 集成：write 工具写普通文件不触发确认", () => {
  const pre = preExecute(ws, "write", { path: "workbench/wiki/notes/ok.md", content: "x" });
  assert.equal(pre.dangerous, undefined);
});

test("preExecute 集成：read 类工具读 hooks.md 不触发确认（只读无害）", () => {
  const pre = preExecute(ws, "read", { path: "workbench/wiki/hooks.md" });
  assert.equal(pre.dangerous, undefined);
});
