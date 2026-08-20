/**
 * 知识导入管线测试（TDD）。
 *
 * 修复目标（对应"初始化完啥信息也没导入进来"的根因）：
 * 1. importFiles 跳过 ignore 分类和空内容文件（不再灌垃圾页）
 * 2. 知识页正文写入文档全文（不是 80 字 summary）
 * 3. 页面文件名用标题 slug（可读），不是 kb-日期-随机
 * 4. 按标题去重（重复导入计数到 skipped）
 * 5. getCommonDocDirs 不扫整个盘符根目录
 * 6. scanDocs 跳过 bak/backup 目录，支持文件数上限
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { importFiles, getCommonDocDirs, scanDocs } from "../../electron/knowledge-service.ts";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempWorkspace, cleanupWorkspace, writeFile, exists, readFile } from "./helpers.mjs";

let root;
let srcDir;
beforeEach(() => {
  root = makeTempWorkspace();
  srcDir = makeTempWorkspace();
});
afterEach(() => { cleanupWorkspace(root); cleanupWorkspace(srcDir); });

test("importFiles: 跳过 ignore 分类的文件", async () => {
  writeFile(srcDir, "random-notes.md", "周末和家人去了郊外的山里徒步，天气很好，路上聊了很多家常，回来的路上顺路买了些水果，晚上一起吃了顿饭。");
  const r = await importFiles(root, [join(srcDir, "random-notes.md")]);
  assert.equal(r.ok, 0, "ignore 分类不应导入");
  assert.equal(r.skipped?.ignore ?? 0, 1);
  assert.ok(!existsSync(join(root, "workbench/wiki/knowledge")), "不应产生任何知识页");
});

test("importFiles: 跳过空内容/超短文件", async () => {
  writeFile(srcDir, "empty.md", "");
  writeFile(srcDir, "tiny.md", "故障");
  const r = await importFiles(root, [join(srcDir, "empty.md"), join(srcDir, "tiny.md")]);
  assert.equal(r.ok, 0);
  assert.ok(!exists(root, "workbench/wiki/knowledge"));
});

test("importFiles: 正文写入全文而非 summary", async () => {
  const long = "AF双活存储故障排查案例。".repeat(400); // ~4800 字
  writeFile(srcDir, "af-case.md", long);
  await importFiles(root, [join(srcDir, "af-case.md")]);
  const dir = join(root, "workbench/wiki/knowledge/cases");
  const pages = readdirSync(dir).filter((f) => f.endsWith(".md"));
  assert.ok(pages.length >= 1);
  const body = readFileSync(join(dir, pages[0]), "utf-8");
  assert.ok(body.length > 4000, `正文应包含全文，实际 ${body.length} 字`);
});

test("importFiles: 页面文件名用标题 slug（可读）", async () => {
  writeFile(srcDir, "AF双活故障案例.md", "AF双活存储故障排查交付案例：客户凌晨报脑裂告警，主存储卷进入只读，排查发现仲裁网络抖动，切换后恢复并完成复盘。");
  await importFiles(root, [join(srcDir, "AF双活故障案例.md")]);
  const dir = join(root, "workbench/wiki/knowledge/cases");
  const pages = readdirSync(dir).filter((f) => f.endsWith(".md"));
  assert.equal(pages.length, 1);
  assert.match(pages[0], /af/i, `文件名应含标题 slug: ${pages[0]}`);
  assert.ok(!pages[0].startsWith("kb-"), `不应是 kb- 前缀: ${pages[0]}`);
});

test("importFiles: 按标题去重（重复导入计入 skipped）", async () => {
  const f = join(srcDir, "sop.md");
  writeFile(srcDir, "sop.md", "标准交付SOP流程规范文档：覆盖调研、设计、POC、割接、验收五个阶段，每阶段附检查清单与质量标准。");
  const r1 = await importFiles(root, [f]);
  assert.equal(r1.ok, 1);
  const r2 = await importFiles(root, [f]);
  assert.equal(r2.ok, 0);
  assert.ok((r2.skipped?.dup ?? 0) >= 1, "重复应计入 skipped.dup");
  const dir = join(root, "workbench/wiki/knowledge/cases");
  assert.equal(readdirSync(dir).filter((x) => x.endsWith(".md")).length, 1);
});

test("importFiles: method/learning 分类进 knowledge/concepts", async () => {
  writeFile(srcDir, "nightly-sop.md", "标准作业流程规范：每晚巡检要核对设备清单，按流程逐项执行并记录结果，形成标准规范文件归档备查，季度回顾更新。");
  await importFiles(root, [join(srcDir, "nightly-sop.md")]);
  assert.ok(exists(root, "workbench/wiki/knowledge/concepts"), "method 应进 concepts");
  const dir = join(root, "workbench/wiki/knowledge/concepts");
  const pages = readdirSync(dir).filter((f) => f.endsWith(".md"));
  assert.ok(pages.length >= 1);
});

test("getCommonDocDirs: 不返回盘符根目录", () => {
  const dirs = getCommonDocDirs();
  for (const d of dirs) {
    assert.ok(!/^[A-Z]:[\\/]{0,1}$/.test(d), `不应包含盘符根: ${d}`);
  }
});

test("scanDocs: 跳过 bak/backup 目录", () => {
  writeFile(srcDir, "正常文档.md", "内容");
  writeFile(srcDir, "bak/备份垃圾.md", "内容");
  writeFile(srcDir, "backup/备份垃圾2.md", "内容");
  const files = scanDocs(srcDir, 5);
  assert.equal(files.length, 1, `应只扫到 1 个，实际: ${files.join(",")}`);
});

test("scanDocs: maxFiles 上限截断", () => {
  for (let i = 0; i < 6; i++) writeFile(srcDir, `doc-${i}.md`, "内容");
  const files = scanDocs(srcDir, 5, { maxFiles: 5 });
  assert.equal(files.length, 5);
});

test("importFiles: 扫描导入标记 quality: raw（原料/待消化，AI 渐进提升）", async () => {
  writeFile(srcDir, "raw-af.md", "AF防火墙故障排查案例：客户报策略下发后流量不通，排查会话表溢出，调整超时恢复，含完整步骤与根因。复盘结论：会话超时阈值与硬件规格不匹配，已按规格表修正并同步巡检基线。");
  await importFiles(root, [join(srcDir, "raw-af.md")]);
  const dir = join(root, "workbench/wiki/knowledge/cases");
  const body = readFileSync(join(dir, ...readdirSync(dir).filter(f => f.endsWith(".md"))), "utf-8");
  assert.match(body, /quality: raw/);
});
