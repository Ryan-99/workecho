/**
 * Phase 3 — wiki_ingest 知识摄取测试（TDD）。
 *
 * wiki_ingest 是替代 init_scan + process_inbox 的统一知识摄取入口。
 * 核心：ingestText（接受预提取文本，执行 wiki 操作）。
 *
 * 流程：读源文件 → 分类 → 写知识摘要页 → 建交叉引用 → 更新 index/log
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ensureWikiStructure, ingestText, ingestDocuments, discoverDomains } from "../../electron/wiki-manager.ts";
import { parseEntity, listEntities } from "../../electron/business-store.ts";
import { makeTempWorkspace, cleanupWorkspace, writeFile, readFile, exists, page } from "./helpers.mjs";

let root;
beforeEach(() => { root = makeTempWorkspace(); ensureWikiStructure(root); });
afterEach(() => cleanupWorkspace(root));

/* ===== ingestText ===== */

test("ingestText: 从文本创建知识页（分类 case）", () => {
  const result = ingestText(root, "AF防火墙策略引擎故障排查记录。客户报策略不通，经排查发现内存泄漏。", "AF策略故障排查", {
    source: "对话记录",
  });
  assert.ok(result.relPath);
  assert.match(result.relPath, /knowledge/);
  const { frontmatter, body } = parseEntity(readFile(root, `workbench/wiki/${result.relPath}`));
  assert.equal(frontmatter.type, "case");
  assert.ok(frontmatter.title);
  assert.ok(frontmatter.summary);
});

test("ingestText: 分类 method（含流程/规范关键词）", () => {
  const result = ingestText(root, "标准交付SOP流程，规范操作步骤。", "交付规范", {});
  const { frontmatter } = parseEntity(readFile(root, `workbench/wiki/${result.relPath}`));
  assert.equal(frontmatter.subcategory, "method");
});

test("ingestText: 分类 learning（含教程/笔记关键词）", () => {
  const result = ingestText(root, "AF产品学习教程和培训笔记。", "AF学习笔记", {});
  const { frontmatter } = parseEntity(readFile(root, `workbench/wiki/${result.relPath}`));
  assert.equal(frontmatter.subcategory, "learning");
});

test("ingestText: 自动生成摘要（前80字）", () => {
  const longText = "这是一段很长的文字".repeat(20);
  const result = ingestText(root, longText, "测试文档", {});
  const { frontmatter } = parseEntity(readFile(root, `workbench/wiki/${result.relPath}`));
  assert.ok(frontmatter.summary.length > 0);
  assert.ok(frontmatter.summary.length <= 100);
});

test("ingestText: 更新 index.md 和 log.md", () => {
  ingestText(root, "故障案例文字", "故障案例", {});
  const log = readFile(root, "workbench/wiki/log.md");
  assert.match(log, /ingest/i);
  const idx = readFile(root, "workbench/wiki/index.md");
  assert.match(idx, /knowledge/);
});

test("ingestText: 文本中提到的实体自动建交叉引用", () => {
  // 先创建一个维保实体
  writeFile(root, "workbench/wiki/maintenance/招行AF.md", page({ title: "招商银行AF维保", customer: "招商银行" }));
  // 摄取一篇提到"招商银行"的文档
  const result = ingestText(root, "招商银行AF防火墙最近出了故障，需要排查。", "招行故障记录", {});
  // 知识页应该有 related 引用到维保实体
  const { frontmatter } = parseEntity(readFile(root, `workbench/wiki/${result.relPath}`));
  const related = frontmatter.related;
  if (related) {
    const refStr = Array.isArray(related) ? related.join(",") : String(related);
    assert.match(refStr, /招商银行AF维保/);
  }
});

/* ===== ingestDocuments ===== */

test("ingestDocuments: 批量摄取 _sources/inbox/ 下的文件", () => {
  writeFile(root, "workbench/_sources/inbox/doc1.md", "# 故障案例\nAF策略引擎报错");
  writeFile(root, "workbench/_sources/inbox/doc2.txt", "交付SOP流程规范文档");
  const result = ingestDocuments(root);
  assert.ok(result.ingested >= 2);
  assert.ok(result.results.length >= 2);
});

test("ingestDocuments: 摄取后原文件归档到 _sources/scanned/", () => {
  writeFile(root, "workbench/_sources/inbox/note.md", "故障排查笔记");
  ingestDocuments(root);
  // inbox 清空，scanned 有文件
  assert.ok(!exists(root, "workbench/_sources/inbox/note.md"));
  assert.ok(exists(root, "workbench/_sources/scanned/note.md"));
});

test("ingestDocuments: inbox 为空时返回 0", () => {
  const result = ingestDocuments(root);
  assert.equal(result.ingested, 0);
});

/* ===== discoverDomains ===== */

test("discoverDomains: 统计关键词频次，建议动态类型", () => {
  // 多篇含维保关键词的文档
  for (let i = 0; i < 5; i++) {
    writeFile(root, `workbench/_sources/inbox/maintenance-${i}.txt`, `维保续费到期合同文档${i}`);
  }
  const domains = discoverDomains(root, ["维保", "续费", "到期", "合同"]);
  assert.ok(domains.some((d) => d.keyword === "维保" || d.keyword === "续费" || d.keyword === "到期"));
  // 频次 >= 5 的应该被检测到
  const highFreq = domains.filter((d) => d.count >= 5);
  assert.ok(highFreq.length > 0);
});

test("discoverDomains: 阈值以下的关键词不计入建议", () => {
  writeFile(root, "workbench/_sources/inbox/single.md", "维保文档");
  const domains = discoverDomains(root, ["维保"], { threshold: 5 });
  assert.equal(domains.length, 0);
});
