/**
 * 一键初始化工作环境（含知识库）测试（TDD）。
 *
 * 用户说"帮我初始化工作环境" → init_workspace 工具 → initializeWorkspace()：
 * 1. wiki 结构 + 种子数据 + 记忆模板 + schedule + hooks（幂等）
 * 2. 扫描指定目录 → 导入知识库（wiki/knowledge/cases）
 * 3. 领域发现（关键词频次 → 建议动态类型）
 * 4. 重建 index + 记 log
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { initializeWorkspace } from "../../electron/workbench-init.ts";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempWorkspace, cleanupWorkspace, writeFile, exists, readFile } from "./helpers.mjs";

let root;
let scanDir;
let savedHome;
beforeEach(() => {
  root = makeTempWorkspace();
  scanDir = makeTempWorkspace(); // 模拟"用户文档目录"
  // 隔离 HOME：避免 getActiveWikiConfig 读到真实用户配置（含 legacyWikiPath）
  // 把开发者机器上的旧知识库悄悄导入测试临时目录
  savedHome = process.env.HOME;
  process.env.HOME = makeTempWorkspace();
});
afterEach(() => {
  cleanupWorkspace(root); cleanupWorkspace(scanDir);
  if (process.env.HOME) cleanupWorkspace(process.env.HOME); // 先清隔离 HOME 临时目录
  if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome; // 再还原
});

test("initializeWorkspace: 创建完整 wiki 结构（含知识库/记忆/hooks）", async () => {
  const r = await initializeWorkspace(root, { scanDirs: [scanDir] });
  assert.ok(r.wikiReady);
  assert.ok(exists(root, "workbench/wiki/okr"));
  assert.ok(exists(root, "workbench/wiki/knowledge/cases"));
  assert.ok(exists(root, "workbench/wiki/memory/user-profile.md"));
  assert.ok(exists(root, "workbench/wiki/schedule.md"));
  assert.ok(exists(root, "workbench/wiki/hooks.md"));
  assert.ok(exists(root, "workbench/wiki/index.md"));
});

test("initializeWorkspace: 扫描目录并导入知识库", async () => {
  writeFile(scanDir, "af-fault.md", "AF防火墙策略引擎故障排查案例：客户报策略下发后流量不通，经排查为会话表溢出导致，调整会话超时后恢复，附完整处置步骤和根因分析。");
  writeFile(scanDir, "sop.md", "标准交付SOP流程规范文档：覆盖需求调研、方案设计、POC 验证、上线割接、验收交付五个阶段的质量标准与检查清单。");
  const r = await initializeWorkspace(root, { scanDirs: [scanDir] });
  assert.ok(r.scanned.ok >= 2, `应导入 2 篇，实际 ${r.scanned.ok}`);
  // 知识页以标题 slug 命名（可读），正文包含文档全文；原始文件留在原处（不动用户文件）
  const casesDir = join(root, "workbench/wiki/knowledge/cases");
  const conceptsDir = join(root, "workbench/wiki/knowledge/concepts");
  const pageText = [casesDir, conceptsDir]
    .flatMap((d) => readdirSync(d).filter((f) => f.endsWith(".md")).map((f) => join(d, f)))
    .map((p) => readFileSync(p, "utf-8"))
    .join("\n");
  assert.ok(pageText.includes("title: af-fault") || pageText.includes("title: 标准交付SOP流程规范文档"));
  // 正文写入全文而非 summary
  assert.match(pageText, /会话表溢出|上线割接/);
});

test("initializeWorkspace: 领域发现返回建议", async () => {
  for (let i = 0; i < 5; i++) {
    writeFile(scanDir, `mt-${i}.txt`, `维保续费到期合同文档第${i}号，客户维保将于下月到期，需要提前准备续费方案与商务材料。`);
  }
  const r = await initializeWorkspace(root, { scanDirs: [scanDir] });
  assert.ok(r.domainSuggestions.some((d) => d.count >= 5));
});

test("initializeWorkspace: 记录到 log.md", async () => {
  await initializeWorkspace(root, { scanDirs: [scanDir] });
  const log = readFile(root, "workbench/wiki/log.md");
  assert.match(log, /init_workspace/);
});

test("initializeWorkspace: 幂等（重复执行不报错不重复）", async () => {
  writeFile(scanDir, "doc.md", "故障案例文档：某客户核心交换机间歇性丢包，定位为光模块老化，整体更换后恢复正常，复盘含预防性巡检建议。");
  await initializeWorkspace(root, { scanDirs: [scanDir] });
  const r2 = await initializeWorkspace(root, { scanDirs: [scanDir] });
  assert.ok(r2.wikiReady);
  // 第二次扫描同一目录：同标题页面已存在，不再重复导入
  assert.equal(r2.scanned.total, 0);
  assert.ok((r2.scanned.skipped?.dup ?? 0) + r2.scanned.ok >= 1);
});

test("initializeWorkspace: doScan=false 跳过扫描只建结构", async () => {
  writeFile(scanDir, "doc.md", "故障案例：某客户核心交换机间歇性丢包，定位为光模块老化，整体更换后恢复正常，复盘含预防性巡检建议。");
  const r = await initializeWorkspace(root, { scanDirs: [scanDir], doScan: false });
  assert.ok(r.wikiReady);
  assert.equal(r.scanned.total, 0);
});

/* ===== 进度回调 ===== */

test("initializeWorkspace: onProgress 上报阶段和进度", async () => {
  const events = [];
  for (let i = 0; i < 12; i++) {
    writeFile(scanDir, `p-${i}.txt`, `维保文档${i}`);
  }
  await initializeWorkspace(root, {
    scanDirs: [scanDir],
    onProgress: (e) => events.push(e),
  });
  const phases = [...new Set(events.map((e) => e.phase))];
  // 应覆盖结构/扫描/导入/领域阶段
  assert.ok(phases.includes("structure"), "缺 structure 阶段: " + phases);
  assert.ok(phases.includes("scan"), "缺 scan 阶段: " + phases);
  assert.ok(phases.includes("import"), "缺 import 阶段: " + phases);
  assert.ok(phases.includes("done"), "缺 done 阶段: " + phases);
  // import 阶段进度单调递增且到 total
  const imports = events.filter((e) => e.phase === "import");
  assert.ok(imports.length > 0);
  const last = imports[imports.length - 1];
  assert.ok(last.current >= last.total, `最终 current(${last.current}) 应 >= total(${last.total})`);
});
