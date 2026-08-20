/**
 * Phase 1a — frontmatter 解析器测试（TDD）。
 *
 * 统一页面格式需要支持：tags 数组、related 引用数组、引号字符串、
 * 多行列表、布尔/数字类型推断。当前 parseEntity 无法正确处理这些。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEntity, stringifyFrontmatter } from "../../electron/business-store.ts";

test("parseEntity: 标量字段（字符串/数字/布尔）", () => {
  const r = parseEntity("---\ntitle: 测试\nprogress: 65\nstatus: active\nflag: true\n---\nbody");
  assert.equal(r.frontmatter.title, "测试");
  assert.equal(r.frontmatter.progress, 65);
  assert.equal(r.frontmatter.status, "active");
  assert.equal(r.frontmatter.flag, true);
});

test("parseEntity: tags 内联数组 [a, b, c]", () => {
  const r = parseEntity('---\ntags: [维保, 招商银行, AF]\n---\n');
  assert.deepEqual(r.frontmatter.tags, ["维保", "招商银行", "AF"]);
});

test("parseEntity: tags 带引号的内联数组", () => {
  const r = parseEntity('---\ntags: ["维保", "招商银行"]\n---\n');
  assert.deepEqual(r.frontmatter.tags, ["维保", "招商银行"]);
});

test("parseEntity: related 多行列表（YAML 块序列）", () => {
  const text = [
    "---",
    "title: 招商银行AF",
    "related:",
    '  - "[[案例A]]"',
    '  - "[[概念B]]"',
    "  - \"[[todo：跟进]]\"",
    "---",
    "body",
  ].join("\n");
  const r = parseEntity(text);
  assert.deepEqual(r.frontmatter.related, ["[[案例A]]", "[[概念B]]", "[[todo：跟进]]"]);
});

test("parseEntity: sources 多行列表", () => {
  const text = [
    "---",
    "title: x",
    "sources:",
    "  - 对话记录",
    "  - 文档A.txt",
    "---",
    "",
  ].join("\n");
  const r = parseEntity(text);
  assert.deepEqual(r.frontmatter.sources, ["对话记录", "文档A.txt"]);
});

test("parseEntity: 空数组 tags: []", () => {
  const r = parseEntity("---\ntags: []\n---\n");
  assert.deepEqual(r.frontmatter.tags, []);
});

test("parseEntity: 带引号的字符串值去引号", () => {
  const r = parseEntity('---\ntitle: "带空格的 标题"\n---\n');
  assert.equal(r.frontmatter.title, "带空格的 标题");
});

test("parseEntity: 无 frontmatter 时整体作为 body", () => {
  const r = parseEntity("just some text\nno frontmatter");
  assert.deepEqual(r.frontmatter, {});
  assert.equal(r.body, "just some text\nno frontmatter");
});

test("stringifyFrontmatter: 往返一致（标量 + 数组）", () => {
  const fm = {
    title: "测试页",
    type: "entity",
    tags: ["维保", "招行"],
    progress: 50,
  };
  const text = stringifyFrontmatter(fm);
  const reparsed = parseEntity(`${text}---\nbody\n`);
  assert.equal(reparsed.frontmatter.title, "测试页");
  assert.equal(reparsed.frontmatter.type, "entity");
  assert.deepEqual(reparsed.frontmatter.tags, ["维保", "招行"]);
  assert.equal(reparsed.frontmatter.progress, 50);
});

test("stringifyFrontmatter: related 数组正确序列化", () => {
  const fm = { title: "x", related: ["[[A]]", "[[B]]"] };
  const text = stringifyFrontmatter(fm);
  assert.ok(text.includes('related:'));
  assert.ok(text.includes('[[A]]'));
  const reparsed = parseEntity(`${text}---\nbody\n`);
  assert.deepEqual(reparsed.frontmatter.related, ["[[A]]", "[[B]]"]);
});
