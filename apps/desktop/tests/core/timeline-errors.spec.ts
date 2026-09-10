import { expect, test } from "@playwright/test";
import { summarizeRunError } from "../../src/timeline-errors";

/**
 * 时间线错误块的摘要函数：用户真实遇到的报错（provider 503、认证失效、
 * Unknown model）必须压成一句可行动的短话，原始 JSON 只进"详情"折叠。
 * severe 标记决定视觉分级：瞬时错误灰色弱化，需要用户处理的错误深红。
 * 用例文本取自真实会话文件里的 errorMessage。
 */
test("summarizeRunError turns provider 503s into a short service message", () => {
  expect(summarizeRunError('OpenAI API error (503): {"message":"Service Unavailable","type":"error","param":"","code":null}').label).toBe(
    "服务暂时不可用（503），请稍后重试",
  );
});

test("summarizeRunError explains auth failures without the raw token dump", () => {
  const summary = summarizeRunError(
    'OpenAI API error (503): {"message":"auth_unavailable: no auth available (providers=codex, model=gpt-5.6-terra; last upstream error: unauthorized: token: Could not validate your refresh token. Please try signing in again."}',
  );
  expect(summary.label).toBe("认证失效或未配置，请到设置中检查该 Provider 的认证");
  expect(summary.severe).toBe(true);
});

test("summarizeRunError points stale models at the model switcher", () => {
  const summary = summarizeRunError("Unknown model echoly:gpt-5.4-mini");
  expect(summary.label).toBe("模型不可用（echoly:gpt-5.4-mini），请切换模型后重试");
  expect(summary.severe).toBe(true);
});

test("summarizeRunError covers rate limits, missing routes, and network failures", () => {
  expect(summarizeRunError("OpenAI API error (429): rate limited").label).toBe("请求过于频繁（429），请稍后重试");
  expect(summarizeRunError('404: {"message":"Unknown request URL: POST /v1/chat/completions"}').label).toBe(
    "接口或模型不存在（404），请检查配置",
  );
  expect(summarizeRunError("fetch failed ENOTFOUND api.example.com").label).toBe("网络或服务异常，请稍后重试");
  expect(summarizeRunError("Connection error.").label).toBe("网络或服务异常，请稍后重试");
});

test("summarizeRunError diagnoses balance errors before the generic 403 auth branch", () => {
  // 真实场景：403 + Insufficient account balance 被误报成"认证失效"
  const summary = summarizeRunError(
    'OpenAI API error (403): {"message":"Insufficient account balance. Please check your account and recharge."}',
  );
  expect(summary.label).toBe("账户余额不足或额度受限，请到服务商控制台检查");
  expect(summary.severe).toBe(true);
});

test("transient errors render gray (severe=false), user-action errors deep red (severe=true)", () => {
  // 灰色弱化：瞬时错误与未识别错误
  expect(summarizeRunError("OpenAI API error (503): x").severe).toBe(false);
  expect(summarizeRunError("OpenAI API error (429): x").severe).toBe(false);
  expect(summarizeRunError("Connection error.").severe).toBe(false);
  expect(summarizeRunError("weird failure\nsecond line").severe).toBe(false);
  // 深红：需要用户处理
  expect(summarizeRunError("Unknown model a:b").severe).toBe(true);
  expect(summarizeRunError("401: unauthorized").severe).toBe(true);
  expect(summarizeRunError('404: {"message":"Unknown request URL"}').severe).toBe(true);
});

test("summarizeRunError truncates unrecognized errors to one line", () => {
  const summary = summarizeRunError(`weird failure\nsecond line {"json": true}`);
  expect(summary.label).toBe("weird failure");
  expect(summary.label).not.toContain("\n");
  expect(summarizeRunError("").label).toBe("请求失败");
});
