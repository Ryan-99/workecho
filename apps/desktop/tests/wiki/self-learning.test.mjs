/**
 * Agent 自学习（auto-skill）测试：
 *  - 配置默认值（开关默认开）
 *  - 蒸馏输出解析（JSON 容错/形状校验）
 *  - learned- 名称清洗
 *  - Skill 写入/精炼（只覆盖带 learned: true 标记的）
 *  - 服务门控：阈值、每会话评估上限、翻倍再评估、失败重试上限、全局串行、learned 总量上限
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let skillsBase;
beforeEach(() => {
  skillsBase = mkdtempSync(join(tmpdir(), "wb-selflearn-"));
});
afterEach(() => { rmSync(skillsBase, { recursive: true, force: true }); });

const REF = { workspaceId: "ws1", sessionId: "s1" };

function makeMessage(role, text) {
  return { kind: "message", role, text, createdAt: new Date().toISOString(), id: Math.random().toString(36).slice(2) };
}

/** 最小可用对话：4 用户 + 4 助手（达到阈值） */
function thresholdTranscript() {
  const out = [];
  for (let i = 0; i < 4; i++) {
    out.push(makeMessage("user", `用户消息 ${i}：请帮我整理周报数据并生成汇报`));
    out.push(makeMessage("assistant", `助手回复 ${i}：好的，按以下流程处理……`));
  }
  return out;
}

function makeDeps(overrides = {}) {
  const calls = { distill: 0, log: [], notify: [], refresh: 0 };
  const { distill: distillOverride, ...rest } = overrides;
  const innerDistill = distillOverride ?? (async () => '{"learn": false}');
  const deps = {
    getConfig: () => ({ selfLearningSkills: true }),
    getWorkspacePath: () => "/tmp/ws",
    getTranscript: async () => thresholdTranscript(),
    refreshRuntime: async () => { calls.refresh += 1; },
    log: (_ws, line) => calls.log.push(line),
    notify: (title, body) => calls.notify.push({ title, body }),
    skillsBase,
    ...rest,
    distill: async (ref, ws, prompt) => { calls.distill += 1; return innerDistill(ref, ws, prompt); },
  };
  return { deps, calls };
}

test("默认配置：selfLearningSkills 开启", async () => {
  const { DEFAULT_WIKI_CONFIG } = await import("../../electron/wiki-config.ts");
  assert.equal(DEFAULT_WIKI_CONFIG.selfLearningSkills, true);
});

test("parseDistillDecision：合法 JSON / 围栏 / 杂文包裹", async () => {
  const { parseDistillDecision } = await import("../../electron/self-learning.ts");
  assert.deepEqual(parseDistillDecision('{"learn": false}'), { learn: false });
  assert.deepEqual(parseDistillDecision('```json\n{"learn": false}\n```'), { learn: false });
  const d = parseDistillDecision('好的，结果如下：\n```json\n{"learn": true, "name": "weekly-report", "description": "生成周报", "content": "# 步骤\\n1. ..."}\n```\n以上。');
  assert.equal(d.learn, true);
  assert.equal(d.name, "weekly-report");
  assert.equal(d.content, "# 步骤\n1. ...");
});

test("parseDistillDecision：非法输入返回 null", async () => {
  const { parseDistillDecision } = await import("../../electron/self-learning.ts");
  assert.equal(parseDistillDecision("没有任何 JSON"), null);
  assert.equal(parseDistillDecision("{broken"), null);
  assert.equal(parseDistillDecision('{"learn": "yes"}'), null);
  assert.equal(parseDistillDecision('{"learn": true, "name": "x"}'), null); // 缺 description/content
});

test("sanitizeLearnedName：kebab-case + learned- 前缀 + 回退", async () => {
  const { sanitizeLearnedName } = await import("../../electron/self-learning.ts");
  assert.equal(sanitizeLearnedName("Weekly Report!!"), "learned-weekly-report");
  assert.equal(sanitizeLearnedName("learned-foo"), "learned-foo"); // 不双前缀
  assert.equal(sanitizeLearnedName("learned-Foo Bar"), "learned-foo-bar");
  const fallback = sanitizeLearnedName("周报生成", "abc123");
  assert.equal(fallback, "learned-skill-abc123");
});

test("buildDialogue：保留最近消息、总量截断保尾部", async () => {
  const { buildDialogue } = await import("../../electron/self-learning.ts");
  const messages = [];
  for (let i = 0; i < 50; i++) messages.push({ role: "user", text: `m${i}` });
  const dialogue = buildDialogue(messages);
  assert.ok(dialogue.includes("m49"), "应保留最近的消息");
  assert.ok(!dialogue.includes("m0\n"), "应丢弃最早的消息");
});

test("buildDistillPrompt：包含已有清单与对话", async () => {
  const { buildDistillPrompt } = await import("../../electron/self-learning.ts");
  const p = buildDistillPrompt("用户: 你好", [{ name: "learned-a", description: "描述A", dir: "/x" }]);
  assert.ok(p.includes("<existing_skills>"));
  assert.ok(p.includes("learned-a: 描述A"));
  assert.ok(p.includes("<conversation>"));
  assert.ok(p.includes("用户: 你好"));
});

test("applyLearnedSkill：写入 frontmatter（learned: true 标记）", async () => {
  const { applyLearnedSkill } = await import("../../electron/self-learning.ts");
  const r = applyLearnedSkill(skillsBase, {
    learn: true, name: "Weekly Report", description: "生成周报\n第二行", content: "# 周报步骤\n1. 汇总",
  });
  assert.equal(r.written, true);
  assert.equal(r.name, "learned-weekly-report");
  const file = readFileSync(join(skillsBase, "learned-weekly-report", "SKILL.md"), "utf-8");
  assert.ok(file.includes("name: learned-weekly-report"));
  assert.ok(file.includes("description: 生成周报 第二行"), "描述压平单行");
  assert.match(file, /^learned: true$/m);
  assert.ok(file.includes("# 周报步骤"));
});

test("applyLearnedSkill：精炼覆盖带标记的同名 Skill，拒绝覆盖用户手工 Skill", async () => {
  const { applyLearnedSkill } = await import("../../electron/self-learning.ts");
  applyLearnedSkill(skillsBase, { learn: true, name: "weekly", description: "v1", content: "第一版" });
  const refine = applyLearnedSkill(skillsBase, { learn: true, name: "weekly", description: "v2", content: "第二版" });
  assert.equal(refine.written, true);
  assert.ok(readFileSync(join(skillsBase, "learned-weekly", "SKILL.md"), "utf-8").includes("第二版"));

  mkdirSync(join(skillsBase, "learned-manual"), { recursive: true });
  writeFileSync(join(skillsBase, "learned-manual", "SKILL.md"), "---\nname: learned-manual\ndescription: 用户手写\n---\n内容", "utf-8");
  const r = applyLearnedSkill(skillsBase, { learn: true, name: "manual", description: "想覆盖", content: "x" });
  assert.equal(r.written, false);
  assert.match(r.reason, /拒绝覆盖/);
  assert.ok(readFileSync(join(skillsBase, "learned-manual", "SKILL.md"), "utf-8").includes("用户手写"), "原文件未被改动");
});

/* ───────────── 服务门控 ───────────── */

test("服务：开关关闭 → 不蒸馏", async () => {
  const { createSelfLearningService } = await import("../../electron/self-learning.ts");
  const { deps, calls } = makeDeps({ getConfig: () => ({ selfLearningSkills: false }) });
  const svc = createSelfLearningService(deps);
  await svc.handleRunCompleted(REF);
  assert.equal(calls.distill, 0);
});

test("服务：消息量不足 → 不蒸馏", async () => {
  const { createSelfLearningService } = await import("../../electron/self-learning.ts");
  const short = [makeMessage("user", "hi"), makeMessage("assistant", "hello")];
  const { deps, calls } = makeDeps({ getTranscript: async () => short });
  await createSelfLearningService(deps).handleRunCompleted(REF);
  assert.equal(calls.distill, 0);
});

test("服务：用户消息过少（大量助手输出）→ 不蒸馏", async () => {
  const { createSelfLearningService } = await import("../../electron/self-learning.ts");
  const oneSided = [makeMessage("user", "跑一下"), ...Array.from({ length: 10 }, (_, i) => makeMessage("assistant", `长回复 ${i}`))];
  const { deps, calls } = makeDeps({ getTranscript: async () => oneSided });
  await createSelfLearningService(deps).handleRunCompleted(REF);
  assert.equal(calls.distill, 0);
});

test("服务：蒸馏 learn=false 记账，同量不再评估，翻倍后再评估，3 次封顶", async () => {
  const { createSelfLearningService } = await import("../../electron/self-learning.ts");
  let transcript = thresholdTranscript(); // 8 条
  const { deps, calls } = makeDeps({ getTranscript: async () => transcript });
  const svc = createSelfLearningService(deps);

  await svc.handleRunCompleted(REF);
  assert.equal(calls.distill, 1, "达到阈值首次评估");

  await svc.handleRunCompleted(REF);
  assert.equal(calls.distill, 1, "消息量未翻倍，不重复评估");

  transcript = [...transcript, ...thresholdTranscript()]; // 16 条
  await svc.handleRunCompleted(REF);
  assert.equal(calls.distill, 2, "消息量翻倍，再次评估");

  transcript = [...transcript, ...thresholdTranscript(), ...thresholdTranscript()]; // 48 条
  await svc.handleRunCompleted(REF);
  assert.equal(calls.distill, 3, "第 3 次评估");

  transcript = [...transcript, ...thresholdTranscript(), ...thresholdTranscript(), ...thresholdTranscript()];
  await svc.handleRunCompleted(REF);
  assert.equal(calls.distill, 3, "每会话最多评估 3 次");
});

test("服务：蒸馏失败重试最多 3 次", async () => {
  const { createSelfLearningService } = await import("../../electron/self-learning.ts");
  let fail = true;
  const { deps, calls } = makeDeps({
    distill: async () => (fail ? null : '{"learn": false}'),
  });
  const svc = createSelfLearningService(deps);
  await svc.handleRunCompleted(REF);
  await svc.handleRunCompleted(REF);
  await svc.handleRunCompleted(REF);
  await svc.handleRunCompleted(REF);
  assert.equal(calls.distill, 3, "失败最多尝试 3 次");
  fail = false;
  await svc.handleRunCompleted(REF);
  assert.equal(calls.distill, 3, "尝试达上限后不再调用");
});

test("服务：learn=true → 写入 Skill + 日志 + 通知 + 热加载", async () => {
  const { createSelfLearningService } = await import("../../electron/self-learning.ts");
  const { deps, calls } = makeDeps({
    distill: async () => '{"learn": true, "name": "weekly-report", "description": "生成周报", "content": "# 步骤\\n1. 汇总数据"}',
  });
  await createSelfLearningService(deps).handleRunCompleted(REF);
  assert.ok(existsSync(join(skillsBase, "learned-weekly-report", "SKILL.md")), "Skill 已写入");
  assert.equal(calls.log.filter((l) => l.startsWith("self_learn |")).length, 1);
  assert.equal(calls.notify.length, 1);
  assert.equal(calls.refresh, 1);
});

test("服务：全局串行——蒸馏进行中第二个触发直接跳过且不记账", async () => {
  const { createSelfLearningService } = await import("../../electron/self-learning.ts");
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let transcript = thresholdTranscript();
  const { deps, calls } = makeDeps({
    getTranscript: async () => transcript,
    distill: async () => { await gate; return '{"learn": false}'; },
  });
  const svc = createSelfLearningService(deps);

  const first = svc.handleRunCompleted(REF); // 进入蒸馏（挂起）
  await Promise.resolve(); // 让 first 走到 distill await
  await svc.handleRunCompleted(REF); // 忙 → 跳过
  assert.equal(calls.distill, 1);
  release();
  await first;

  // 忙时那次跳过未记账：第一次评估完成后，消息翻倍仍可正常评估
  transcript = [...transcript, ...thresholdTranscript()];
  await svc.handleRunCompleted(REF);
  assert.equal(calls.distill, 2, "空闲后可再次评估");
});

test("服务：两个会话并发触发（getTranscript 挂起期间）只蒸馏一次，另一个不记账", async () => {
  const { createSelfLearningService } = await import("../../electron/self-learning.ts");
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { deps, calls } = makeDeps({
    getTranscript: async () => { await gate; return thresholdTranscript(); },
  });
  const svc = createSelfLearningService(deps);

  const a = svc.handleRunCompleted(REF); // 停在 getTranscript
  const b = svc.handleRunCompleted({ workspaceId: "ws1", sessionId: "s2" }); // 同样停在 getTranscript
  release();
  await Promise.all([a, b]);
  assert.equal(calls.distill, 1, "二次检查后只有一个触发进入蒸馏");

  // 未进入蒸馏的会话没有被记账：单独再触发应正常评估
  await svc.handleRunCompleted({ workspaceId: "ws1", sessionId: "s2" });
  assert.equal(calls.distill, 2);
});

test("服务：learned Skill 达 50 个上限后跳过", async () => {
  const { createSelfLearningService } = await import("../../electron/self-learning.ts");
  for (let i = 0; i < 50; i++) {
    mkdirSync(join(skillsBase, `learned-skill-${i}`), { recursive: true });
    writeFileSync(join(skillsBase, `learned-skill-${i}`, "SKILL.md"), `---\nname: learned-skill-${i}\ndescription: x\nlearned: true\n---\nc`, "utf-8");
  }
  const { deps, calls } = makeDeps();
  await createSelfLearningService(deps).handleRunCompleted(REF);
  assert.equal(calls.distill, 0, "达上限不再蒸馏");
  assert.ok(calls.log.some((l) => l.includes("reached-max-learned-skills")));
});
