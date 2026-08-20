/**
 * CoStrict 一键接入服务测试（TDD）。
 *
 * 方案：Workecho 托管 costrict-router 二进制（github.com/mokeyjay/costrict-router）
 * 登录 CoStrict（深信服 OIDC）→ 本地 OpenAI 兼容代理（127.0.0.1:14567/v1）
 * → 捕获一次性显示的本地 API Key → 注册为 pi 自定义 Provider。
 *
 * 可注入 spawn/fetch，全部离线可测。
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractLoginUrl,
  extractApiKey,
  pickReleaseAsset,
  parseModelsResponse,
  readState,
  writeState,
  costrictStatus,
  costrictStart,
  costrictLogin,
  LOCAL_BASE_URL,
  PROVIDER_ID,
} from "../../electron/costrict-service.ts";

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "wb-cs-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

test("extractLoginUrl: 从 login 命令输出中提取登录链接（跳过本地地址）", () => {
  const out = [
    "Costrict Router v0.3.2",
    "请在浏览器中完成登录: https://zgsm.sangfor.com/oidc-auth?state=abc123",
    "等待登录完成...",
  ].join("\n");
  assert.equal(extractLoginUrl(out), "https://zgsm.sangfor.com/oidc-auth?state=abc123");
  // 本地 URL 不算登录链接
  assert.equal(extractLoginUrl("服务已启动 http://127.0.0.1:14567"), null);
  assert.equal(extractLoginUrl("没有任何链接"), null);
});

test("extractApiKey: 捕获一次性显示的 sk-costrict key", () => {
  const out = "本地 API Key（仅显示一次）: sk-costrict-AbC123_xyz-9\n请妥善保存";
  assert.equal(extractApiKey(out), "sk-costrict-AbC123_xyz-9");
  assert.equal(extractApiKey("没有 key"), null);
});

test("pickReleaseAsset: 按平台选对资产", () => {
  const assets = [
    { name: "costrict-router_v0.3.2_linux_amd64.tar.gz" },
    { name: "costrict-router_v0.3.2_windows_amd64.zip" },
    { name: "costrict-router_v0.3.2_windows_arm64.zip" },
    { name: "costrict-router_v0.3.2_macos_arm64.tar.gz" },
  ];
  assert.equal(pickReleaseAsset(assets, "win32", "x64")?.name, "costrict-router_v0.3.2_windows_amd64.zip");
  assert.equal(pickReleaseAsset(assets, "darwin", "arm64")?.name, "costrict-router_v0.3.2_macos_arm64.tar.gz");
  assert.equal(pickReleaseAsset(assets, "linux", "x64")?.name, "costrict-router_v0.3.2_linux_amd64.tar.gz");
  assert.equal(pickReleaseAsset(assets, "sunos", "x64"), null);
});

test("parseModelsResponse: /v1/models 映射为 provider 模型列表", () => {
  const json = {
    data: [
      { id: "glm-5", context_length: 200000 },
      { id: "kimi-k2.5" },
    ],
  };
  assert.deepEqual(parseModelsResponse(json), [
    { id: "glm-5", contextWindow: 200000 },
    { id: "kimi-k2.5", contextWindow: 128000 },
  ]);
});

test("state 读写：apiKey 持久化到托管目录", () => {
  assert.equal(readState(dir).apiKey, undefined);
  writeState(dir, { apiKey: "sk-costrict-test" });
  assert.equal(readState(dir).apiKey, "sk-costrict-test");
  // 部分更新
  writeState(dir, { upstreamBaseUrl: "https://cs.example.com" });
  const s = readState(dir);
  assert.equal(s.apiKey, "sk-costrict-test");
  assert.equal(s.upstreamBaseUrl, "https://cs.example.com");
});

/* ===== 带注入依赖的编排测试 ===== */

function fakeSpawn(script) {
  // script(args) => { stdout, exitCode }，模拟子进程
  return (cmd, args) => {
    const r = script(args);
    return {
      stdout: { on: (_ev, cb) => { if (r.stdout) cb(r.stdout); } },
      stderr: { on: () => {} },
      on: (ev, cb) => { if (ev === "close") setTimeout(() => cb(r.exitCode ?? 0), 5); },
    };
  };
}

test("costrictLogin: 提取登录链接回调 + 成功退出", async () => {
  const urls = [];
  const r = await costrictLogin({
    binPath: "fake",
    baseUrl: "https://zgsm.sangfor.com",
    spawnImpl: fakeSpawn(() => ({
      stdout: "登录链接: https://zgsm.sangfor.com/oidc-auth?x=1\n等待中",
      exitCode: 0,
    })),
    onLoginUrl: (u) => urls.push(u),
  });
  assert.equal(r.ok, true);
  assert.equal(urls.length, 1);
  assert.match(urls[0], /^https:\/\/zgsm/);
});

test("costrictStart: 捕获一次性 key 并写入 state，健康检查通过", async () => {
  const r = await costrictStart({
    dir,
    binPath: "fake",
    spawnImpl: fakeSpawn(() => ({
      stdout: "已启动 127.0.0.1:14567\nAPI Key: sk-costrict-Zz9",
      exitCode: 0,
    })),
    fetchImpl: async (url) => {
      if (String(url).includes("/healthz")) return { ok: true };
      throw new Error("unexpected " + url);
    },
  });
  assert.equal(r.apiKey, "sk-costrict-Zz9");
  assert.equal(readState(dir).apiKey, "sk-costrict-Zz9");
});

test("costrictStatus: 汇总二进制/服务/key 状态", async () => {
  // 无二进制无服务
  let s = await costrictStatus({
    dir,
    fetchImpl: async () => { throw new Error("no"); },
  });
  assert.deepEqual(s, { binaryPresent: false, serviceRunning: false, apiKeySaved: false, localBaseUrl: LOCAL_BASE_URL });
  // 有二进制 + 服务在线 + key 已存
  writeFileSync(join(dir, "costrict-router.exe"), "bin");
  writeState(dir, { apiKey: "sk-costrict-x" });
  s = await costrictStatus({
    dir,
    fetchImpl: async () => ({ ok: true }),
  });
  assert.deepEqual(s, { binaryPresent: true, serviceRunning: true, apiKeySaved: true, localBaseUrl: LOCAL_BASE_URL });
  assert.equal(PROVIDER_ID, "costrict");
});

test("installBundledBinary: 从内置资源目录安装到托管目录", async () => {
  const { installBundledBinary, managedBinaryPath } = await import("../../electron/costrict-service.ts");
  // 构造假 resources：resources/costrict/windows-x64/costrict-router.exe
  const resDir = join(dir, "resources");
  mkdirSync(join(resDir, "costrict", "windows-x64"), { recursive: true });
  writeFileSync(join(resDir, "costrict", "windows-x64", "costrict-router.exe"), "FAKE_BIN");
  const managed = join(dir, "managed");
  const ok1 = installBundledBinary({ resourcesDir: resDir, dir: managed });
  assert.equal(ok1, true);
  assert.equal(readFileSync(managedBinaryPath(managed), "utf-8"), "FAKE_BIN");
  // 已存在时幂等
  const ok2 = installBundledBinary({ resourcesDir: resDir, dir: managed });
  assert.equal(ok2, true);
  // 无对应平台资源时返回 false
  const ok3 = installBundledBinary({ resourcesDir: join(dir, "empty"), dir: join(dir, "m2") });
  assert.equal(ok3, false);
});

test("costrictLogin: 超时抛错并尝试杀子进程", async () => {
  let killed = false;
  const neverExitChild = {
    stdout: { on: () => {} },
    stderr: { on: () => {} },
    on: () => {}, // 永不触发 close
    kill: () => { killed = true; },
  };
  await assert.rejects(
    costrictLogin({
      binPath: "fake",
      baseUrl: "https://zgsm.sangfor.com",
      spawnImpl: () => neverExitChild,
      timeoutMs: 120,
    }),
  );
  assert.equal(killed, true, "超时后应杀掉子进程");
});
