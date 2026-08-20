/**
 * P1 测试补强：web_fetch SSRF 网段判定规则（安全审核 WF-1 的核心表）。
 *
 * isBlockedIp 是 SSRF 防护的判定核心——模型可控 URL 的 DNS 解析结果与
 * 字面量 IP 都要过这张表。这里逐段验证 v4/v6/映射地址/CGNAT，防止
 * 未来有人"优化"时意外放开某段。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isBlockedIp, htmlToText } from "../../electron/web-fetch-tool.ts";

/* ===== IPv4 保留段 ===== */
test("v4 环回与本网络：127.x / 0.x / 10.x 阻断", () => {
  assert.ok(isBlockedIp("127.0.0.1"));
  assert.ok(isBlockedIp("127.8.8.8"));
  assert.ok(isBlockedIp("0.0.0.0"));
  assert.ok(isBlockedIp("10.1.2.3"));
});

test("v4 链路本地与元数据：169.254.x 阻断（含 AWS/GCP 元数据地址）", () => {
  assert.ok(isBlockedIp("169.254.169.254"));
  assert.ok(isBlockedIp("169.254.0.1"));
  assert.ok(!isBlockedIp("169.255.0.1"), "169.255 不属于链路本地段");
});

test("v4 私网：172.16-31.x 与 192.168.x 阻断，边界外放行", () => {
  assert.ok(isBlockedIp("172.16.0.1"));
  assert.ok(isBlockedIp("172.31.255.255"));
  assert.ok(!isBlockedIp("172.15.255.255"));
  assert.ok(!isBlockedIp("172.32.0.1"));
  assert.ok(isBlockedIp("192.168.1.1"));
  assert.ok(!isBlockedIp("192.169.1.1"));
});

test("v4 CGNAT：100.64-127.x 阻断（边界内外验证）", () => {
  assert.ok(isBlockedIp("100.64.0.1"));
  assert.ok(isBlockedIp("100.127.255.255"));
  assert.ok(!isBlockedIp("100.63.0.1"));
  assert.ok(!isBlockedIp("100.128.0.1"));
});

test("v4 公网地址放行", () => {
  assert.ok(!isBlockedIp("8.8.8.8"));
  assert.ok(!isBlockedIp("1.1.1.1"));
  assert.ok(!isBlockedIp("203.107.1.1"));
});

/* ===== IPv6 ===== */
test("v6 未指定/环回/唯一本地/链路本地 阻断", () => {
  assert.ok(isBlockedIp("::"));
  assert.ok(isBlockedIp("::1"));
  assert.ok(isBlockedIp("fc00::1"));
  assert.ok(isBlockedIp("fd12:3456::1"));
  assert.ok(isBlockedIp("fe80::1"));
  assert.ok(isBlockedIp("fea1::1"));
  assert.ok(!isBlockedIp("fec0::1"), "fec0 已废弃但不在阻断表内（site-local）");
});

test("v6 IPv4-mapped 地址按映射的 v4 规则判定", () => {
  assert.ok(isBlockedIp("::ffff:127.0.0.1"));
  assert.ok(isBlockedIp("::ffff:10.0.0.1"));
  assert.ok(isBlockedIp("::ffff:169.254.169.254"));
  assert.ok(!isBlockedIp("::ffff:8.8.8.8"));
});

test("v6 公网地址放行", () => {
  assert.ok(!isBlockedIp("2001:db8::1"));
  assert.ok(!isBlockedIp("2606:4700::1111"));
});

/* ===== 异常输入：fail-closed ===== */
test("无法识别的输入一律阻断（fail-closed）", () => {
  assert.ok(isBlockedIp("not-an-ip"));
  assert.ok(isBlockedIp(""));
  assert.ok(isBlockedIp("999.999.999.999"));
  assert.ok(isBlockedIp("::gg::"));
});

/* ===== htmlToText 剥离 ===== */
test("htmlToText：去 script/style 与未闭合 script 残留", () => {
  const html = '<p>a</p><script>alert(1)</script><style>.x{}</style><p>b</p>';
  assert.equal(htmlToText(html), "a b");
  const unclosed = '<p>ok</p><script src="https://evil.example/x.js">';
  const out = htmlToText(unclosed);
  assert.ok(!out.includes("evil.example"), "未闭合 script 起到文件尾都应剥离");
  assert.match(out, /ok/);
});

test("htmlToText：常见实体解码", () => {
  assert.equal(htmlToText("a &amp; b &lt;c&gt; &quot;d&quot;"), 'a & b <c> "d"');
});
