/**
 * 安全审核 CS-3 回归测试：apiKey 经注入 codec 加密落盘。
 *
 * main 启动时注入 safeStorage 编解码器后：
 * - writeState 落盘的 state.json 不含明文 apiKey（存 apiKeyEnc）；
 * - readState 解码回明文供运行时使用；
 * - 存量明文 state.json 在下一次 writeState 自动迁移；
 * - 解密失败（系统凭据变更）→ 视为无 key 而非崩溃。
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  readState,
  writeState,
  setSecretCodec,
} from "../../electron/costrict-service.ts";

let dir;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "costrict-enc-"));
  mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  setSecretCodec(null);
  rmSync(dir, { recursive: true, force: true });
});

test("writeState: 注入 codec 后落盘无明文 apiKey（CS-3 核心）", () => {
  setSecretCodec({
    encode: (p) => Buffer.from(p, "utf-8").toString("base64"),
    decode: (e) => Buffer.from(e, "base64").toString("utf-8"),
  });
  writeState(dir, { apiKey: "sk-costrict-test-123" });
  const disk = JSON.parse(readFileSync(path.join(dir, "state.json"), "utf-8"));
  assert.equal(disk.apiKey, undefined, "磁盘上不应有明文 apiKey");
  assert.ok(typeof disk.apiKeyEnc === "string" && disk.apiKeyEnc.length > 0, "应有加密字段 apiKeyEnc");
  assert.ok(!JSON.stringify(disk).includes("sk-costrict-test-123"), "全文不应出现明文 key");
});

test("readState: 加密落盘后 round-trip 还原明文", () => {
  setSecretCodec({
    encode: (p) => Buffer.from(p, "utf-8").toString("base64"),
    decode: (e) => Buffer.from(e, "base64").toString("utf-8"),
  });
  writeState(dir, { apiKey: "sk-costrict-roundtrip" });
  assert.equal(readState(dir).apiKey, "sk-costrict-roundtrip");
});

test("明文存量：无 codec 读取兼容，注入 codec 后 writeState({}) 自动迁移", () => {
  writeFileSync(path.join(dir, "state.json"), JSON.stringify({ apiKey: "sk-legacy-plain", upstreamBaseUrl: "https://x" }), "utf-8");
  // 无 codec：旧行为，明文直读
  assert.equal(readState(dir).apiKey, "sk-legacy-plain");
  assert.equal(readState(dir).upstreamBaseUrl, "https://x");
  // 注入 codec 后空 patch 写入 → 迁移为加密形态，字段保留
  setSecretCodec({
    encode: (p) => "enc:" + p,
    decode: (e) => e.slice(4),
  });
  const next = writeState(dir, {});
  assert.equal(next.apiKey, "sk-legacy-plain");
  assert.equal(next.upstreamBaseUrl, "https://x");
  const disk = JSON.parse(readFileSync(path.join(dir, "state.json"), "utf-8"));
  assert.equal(disk.apiKey, undefined);
  assert.equal(disk.apiKeyEnc, "enc:sk-legacy-plain");
});

test("解密失败 → 视为无 key（不抛错），其余字段保留", () => {
  setSecretCodec({
    encode: (p) => "enc:" + p,
    decode: () => { throw new Error("DPAPI 凭据变更"); },
  });
  writeFileSync(path.join(dir, "state.json"), JSON.stringify({ apiKeyEnc: "enc:stale", upstreamBaseUrl: "https://y" }), "utf-8");
  const st = readState(dir);
  assert.equal(st.apiKey, undefined);
  assert.equal(st.upstreamBaseUrl, "https://y");
});

test("登出清 key：writeState({apiKey: undefined}) 清除加密字段", () => {
  setSecretCodec({ encode: (p) => "enc:" + p, decode: (e) => e.slice(4) });
  writeState(dir, { apiKey: "sk-to-clear" });
  writeState(dir, { apiKey: undefined });
  const disk = JSON.parse(readFileSync(path.join(dir, "state.json"), "utf-8"));
  assert.equal(disk.apiKey, undefined);
  assert.equal(disk.apiKeyEnc, undefined);
});
