/**
 * 安全审核 F-09 回归测试：userData 路径统一注入。
 *
 * 背景：productName=Workecho 时 app.getPath("userData") 是 Roaming/Workecho，
 * 而 piUserDataDir() 平台启发式返回 Roaming/pi——设置页与工具门控读写
 * 两份不同配置，selfModifyPlugins 等开关在生产构建中失效。
 * main 进程启动时调用 setActiveWikiUserDataDir() 注入权威路径后，
 * 所有同步读取点（getActiveWikiConfig / 卡片配置等）必须跟随注入值。
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { piUserDataDir, setActiveWikiUserDataDir, getActiveWikiConfig } from "../../electron/wiki-config.ts";

let tempDir = null;

afterEach(() => {
  // 清除注入，避免污染后续测试读取的路径
  setActiveWikiUserDataDir("");
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

test("piUserDataDir: 未注入时回退平台启发式路径（结尾为 pi）", () => {
  setActiveWikiUserDataDir("");
  const dir = piUserDataDir();
  assert.ok(dir.length > 0);
  assert.match(dir, /pi$/);
});

test("piUserDataDir: 注入后返回注入路径（F-09 核心）", () => {
  const injected = path.join(tmpdir(), "workecho-test-userdata");
  setActiveWikiUserDataDir(injected);
  assert.equal(piUserDataDir(), injected);
});

test("getActiveWikiConfig: 注入后读取注入目录下的 wiki-config.json", () => {
  tempDir = mkdtempSync(path.join(tmpdir(), "workecho-cfg-"));
  mkdirSync(tempDir, { recursive: true });
  writeFileSync(path.join(tempDir, "wiki-config.json"), JSON.stringify({ selfModifyPlugins: true }), "utf-8");
  setActiveWikiUserDataDir(tempDir);
  const config = getActiveWikiConfig();
  assert.equal(config.selfModifyPlugins, true, "应读到注入目录下的配置而非启发式路径的");
});

test("setActiveWikiUserDataDir(空串) 等价于清除注入", () => {
  const injected = path.join(tmpdir(), "some-other-dir");
  setActiveWikiUserDataDir(injected);
  assert.equal(piUserDataDir(), injected);
  setActiveWikiUserDataDir("");
  assert.notEqual(piUserDataDir(), injected);
});
