/**
 * Memory 会话启动自动注入测试（差距 P4）。
 *
 * 设计要求："会话启动时自动读 memory"——通过 pi 的 context 事件（每次 LLM 调用前触发，
 * 返回 messages 即替换）在会话首轮把 user-profile + working-context 注入为框架标识的
 * 首条消息。单次守卫：整个会话只注入一次，不随轮次重复。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryInjectionExtension } from "../../electron/memory-injection.ts";

function makePi() {
  const handlers = new Map();
  return {
    handlers,
    pi: { registerTool: () => {}, on: (ev, fn) => handlers.set(ev, fn) },
  };
}

const fakeMemory = {
  userProfile: "姓名：Ryan。偏好简洁中文回复。",
  workingContext: "本周重点：测试 Memory 自动注入。",
  insights: "客户沟通先看历史跟进。",
};

test("P4: context 事件注入 memory 为首条消息（带框架标识）", async () => {
  const ext = createMemoryInjectionExtension({ readMemory: () => fakeMemory });
  const { pi, handlers } = makePi();
  ext(pi);
  assert.ok(handlers.has("context"), "应订阅 context 事件");
  const messages = [{ role: "user", content: "你好" }];
  const r = await handlers.get("context")({ type: "context", messages }, {});
  assert.ok(Array.isArray(r?.messages), "应返回 messages");
  assert.equal(r.messages.length, 2, "注入 1 条 memory + 原消息");
  assert.equal(r.messages[0].role, "user");
  assert.match(r.messages[0].content, /记忆上下文/);
  assert.match(r.messages[0].content, /Ryan/);
  assert.match(r.messages[0].content, /本周重点：测试 Memory 自动注入/);
  // 原消息保留
  assert.equal(r.messages[1].content, "你好");
});

test("P4: 单次守卫——同一会话第二轮不再注入", async () => {
  const ext = createMemoryInjectionExtension({ readMemory: () => fakeMemory });
  const { pi, handlers } = makePi();
  ext(pi);
  const h = handlers.get("context");
  const first = await h({ type: "context", messages: [{ role: "user", content: "第一轮" }] }, {});
  assert.equal(first.messages.length, 2);
  const second = await h({ type: "context", messages: [{ role: "user", content: "第二轮" }] }, {});
  assert.equal(second, undefined, "第二轮不重复注入（undefined = 保持原上下文）");
});

test("P4: autoReadMemory=false 时不注入", async () => {
  const ext = createMemoryInjectionExtension({ readMemory: () => fakeMemory, configReader: () => ({ autoReadMemory: false }) });
  const { pi, handlers } = makePi();
  ext(pi);
  const messages = [{ role: "user", content: "你好" }];
  const r = await handlers.get("context")({ type: "context", messages }, {});
  assert.equal(r, undefined, "应原样放行（不返回替换）");
});

test("P4: memory 全空时不注入（避免空框架消息）", async () => {
  const ext = createMemoryInjectionExtension({ readMemory: () => ({ userProfile: "", workingContext: "", insights: "" }) });
  const { pi, handlers } = makePi();
  ext(pi);
  const messages = [{ role: "user", content: "你好" }];
  const r = await handlers.get("context")({ type: "context", messages }, {});
  assert.equal(r, undefined);
});

test("C-03 回归: insights 洞察层非空时同样注入（三层记忆对齐）", async () => {
  const ext = createMemoryInjectionExtension({
    readMemory: () => ({ userProfile: "", workingContext: "", insights: "客户沟通先看历史跟进。" }),
  });
  const { pi, handlers } = makePi();
  ext(pi);
  const messages = [{ role: "user", content: "你好" }];
  const r = await handlers.get("context")({ type: "context", messages }, {});
  assert.ok(r && r.messages, "应返回替换后的消息列表");
  assert.match(r.messages[0].content, /## 洞察/, "注入内容包含洞察区块");
  assert.match(r.messages[0].content, /客户沟通先看历史跟进/);
  assert.match(r.messages[0].content, /<memory_data>/, "沿用数据边界标注");
});
