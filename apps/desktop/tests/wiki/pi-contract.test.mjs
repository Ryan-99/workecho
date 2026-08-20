/**
 * pi agent 契约测试（Anti-Corruption Layer 的消费端契约）。
 *
 * 目的：上游 @earendil-works/pi-coding-agent 频繁更新，本文件把"我们的业务代码
 * 依赖上游哪些 API 形状"固化成断言。升级 pi 后先跑这个文件（秒级），
 * 失败的断言直接指明需要改 electron/pi-compat.ts 的哪一处映射。
 *
 * 契约面（= pi-compat.ts 封装的全部上游依赖）：
 * C1 包可安装、版本在预期主版本带内
 * C2 包入口可被 Node 运行时动态 import（ESM 入口没变）
 * C3 扩展工厂调用约定：(pi) => void，pi.registerTool(tool) / pi.on(event, handler)
 * C4 工具形状：{ name, description, parameters, execute(五参) => AgentToolResult }
 * C5 工具结果形状：{ content: [{ type: "text", text }], details }
 * C6 tool_call 事件可否决：handler 返回 { block: true, reason }
 * C7 ExtensionContext.cwd 提供 workspace 路径（缺失时回退 process.cwd）
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { createBusinessRuntimeExtension } from "../../electron/business-runtime.ts";
import { createPolicyExtension } from "../../electron/tool-pipeline.ts";
import { PI_EVENTS, toolOk, toolErr, cwdFromContext } from "../../electron/pi-compat.ts";
import { fileURLToPath } from "node:url";

/** mock pi 宿主：记录 registerTool/on 的调用，模拟上游最小 API 面 */
function makeMockPi() {
  const state = { tools: [], handlers: new Map() };
  return {
    state,
    registerTool: (t) => state.tools.push(t),
    on: (ev, fn) => state.handlers.set(ev, fn),
  };
}

/* C1: 版本带 */
test("C1 上游 pi-coding-agent 版本在预期带内（0.x，记录当前版本）", () => {
  // ESM-only 包：用 import.meta.resolve 定位入口，向上找包根的 package.json
  const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
  let dir = entry;
  for (let i = 0; i < 10; i++) {
    dir = dir.slice(0, Math.max(dir.lastIndexOf("/"), dir.lastIndexOf("\\")));
    try {
      const candidate = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
      if (candidate.name === "@earendil-works/pi-coding-agent") {
        const major = Number(candidate.version.split(".")[0]);
        console.log(`[pi-contract] 上游版本: ${candidate.version}`);
        // 0.x 阶段 minor 即破坏性升级：进入 1.x 需要全面复核 pi-compat.ts
        assert.equal(major, 0, `上游进入 ${major}.x，需要全面复核 pi-compat.ts`);
        return;
      }
    } catch { /* 继续向上找 */ }
  }
  assert.fail("未能定位上游 package.json（安装可能不完整）");
});

/* C2: 运行时可 import */
test("C2 上游包入口可被 Node 运行时动态 import", async () => {
  const mod = await import("@earendil-works/pi-coding-agent");
  assert.ok(mod !== null && typeof mod === "object", "入口应可导入");
});

/* C3+C4: 扩展工厂调用约定与工具形状 */
test("C3/C4 业务扩展在 mock pi 宿主上注册全部工具且形状合法", () => {
  const pi = makeMockPi();
  createBusinessRuntimeExtension()(pi);
  assert.ok(pi.state.tools.length >= 40, `应注册 ≥40 个工具，实际 ${pi.state.tools.length}`);
  for (const t of pi.state.tools) {
    assert.equal(typeof t.name, "string", `工具 ${t.name} 缺 name`);
    assert.equal(typeof t.description, "string", `工具 ${t.name} 缺 description`);
    assert.ok(t.parameters && typeof t.parameters === "object", `工具 ${t.name} 缺 parameters`);
    assert.equal(typeof t.execute, "function", `工具 ${t.name} 缺 execute`);
  }
  // 工具名唯一
  const names = pi.state.tools.map((t) => t.name);
  assert.equal(new Set(names).size, names.length, "工具名不应重复");
});

/* C3: 策略扩展订阅事件 */
test("C3 策略扩展通过 PI_EVENTS 常量订阅 tool_call/tool_result", () => {
  const pi = makeMockPi();
  createPolicyExtension()(pi);
  assert.ok(pi.state.handlers.has(PI_EVENTS.toolCall), "应订阅 tool_call");
  assert.ok(pi.state.handlers.has(PI_EVENTS.toolResult), "应订阅 tool_result");
});

/* C5: 结果形状 */
test("C5 toolOk/toolErr 产出 AgentToolResult 形状", () => {
  const ok = toolOk("hello", { a: 1 });
  assert.deepEqual(ok.content, [{ type: "text", text: "hello" }]);
  assert.deepEqual(ok.details, { a: 1 });
  const err = toolErr("boom");
  assert.deepEqual(err.content, [{ type: "text", text: "boom" }]);
});

/* C6: veto 形状 */
let homeBackup;
let homeTmp;
beforeEach(() => {
  homeBackup = process.env.HOME;
  homeTmp = mkdtempSync(join(tmpdir(), "wb-pc-"));
  process.env.HOME = homeTmp;
});
afterEach(() => {
  if (homeBackup === undefined) delete process.env.HOME; else process.env.HOME = homeBackup;
  rmSync(homeTmp, { recursive: true, force: true });
});

test("C6 tool_call 命中 block 规则时返回 { block, reason } 否决", async () => {
  // 配置：管道 + hooks 开
  mkdirSync(join(homeTmp, "AppData/Roaming/pi"), { recursive: true });
  writeFileSync(join(homeTmp, "AppData/Roaming/pi/wiki-config.json"), JSON.stringify({ pipelineEnabled: true, hooksEnabled: true }));
  // 工作区：一条 block 规则
  const ws = mkdtempSync(join(tmpdir(), "wb-ws-"));
  mkdirSync(join(ws, "workbench/wiki"), { recursive: true });
  writeFileSync(join(ws, "workbench/wiki/hooks.md"),
    `---\ntitle: Hooks\ntype: hooks\n---\n\n# Hooks\n\n\`\`\`json\n{"id":"h1","name":"禁删","enabled":true,"event":"tool_call","toolName":"update_entity","action":"block","message":"禁止直接改实体"}\n\`\`\`\n`);

  const pi = makeMockPi();
  createPolicyExtension()(pi);
  const handler = pi.state.handlers.get(PI_EVENTS.toolCall);
  const veto = await handler({ toolName: "update_entity", input: { type: "todo" } }, { cwd: ws });
  assert.deepEqual(veto, { block: true, reason: "禁止直接改实体" });
  // 非命中工具不否决
  const pass = await handler({ toolName: "query_okr", input: {} }, { cwd: ws });
  assert.notEqual(pass?.block, true);
  rmSync(ws, { recursive: true, force: true });
});

/* C7: ctx.cwd 回退 */
test("C7 cwdFromContext 优先 ctx.cwd，缺失回退 process.cwd", () => {
  assert.equal(cwdFromContext({ cwd: "D:/x" }), "D:/x");
  assert.equal(cwdFromContext({}), process.cwd());
});
