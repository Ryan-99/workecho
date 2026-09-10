import { expect, test } from "@playwright/test";
import { summarizeRunError } from "../../src/timeline-errors";

/**
 * 时间线错误块的摘要函数：用户真实遇到的报错（provider 503、认证失效、
 * Unknown model）必须压成一句可行动的短话，原始 JSON 只进"详情"折叠。
 * 用例文本取自真实会话文件里的 errorMessage。
 */
test("summarizeRunError turns provider 503s into a short service message", () => {
  expect(summarizeRunError('OpenAI API error (503): {"message":"Service Unavailable","type":"error","param":"","code":null}')).toBe(
    "服务暂时不可用（503），请稍后重试",
  );
});

test("summarizeRunError explains auth failures without the raw token dump", () => {
  expect(
    summarizeRunError(
      'OpenAI API error (503): {"message":"auth_unavailable: no auth available (providers=codex, model=gpt-5.6-terra; last upstream error: unauthorized: token: Could not validate your refresh token. Please try signing in again."}',
    ),
  ).toBe("认证失效或未配置，请到设置中检查该 Provider 的认证");
});

test("summarizeRunError points stale models at the model switcher", () => {
  expect(summarizeRunError("Unknown model echoly:gpt-5.4-mini")).toBe(
    "模型不可用（echoly:gpt-5.4-mini），请切换模型后重试",
  );
});

test("summarizeRunError covers rate limits, missing routes, and network failures", () => {
  expect(summarizeRunError("OpenAI API error (429): rate limited")).toBe("请求过于频繁（429），请稍后重试");
  expect(summarizeRunError('404: {"message":"Unknown request URL: POST /v1/chat/completions"}')).toBe(
    "接口或模型不存在（404），请检查配置",
  );
  expect(summarizeRunError("fetch failed ENOTFOUND api.example.com")).toBe("网络或服务异常，请稍后重试");
});

test("summarizeRunError diagnoses balance errors before the generic 403 auth branch", () => {
  // 真实场景：403 + Insufficient account balance 被误报成"认证失效"
  expect(
    summarizeRunError(
      'OpenAI API error (403): {"message":"Insufficient account balance. Please check your account and recharge."}',
    ),
  ).toBe("账户余额不足或额度受限，请到服务商控制台检查");
  expect(summarizeRunError("402: {\"error\":{\"code\":\"quota_exceeded\"}}")).toBe(
    "账户余额不足或额度受限，请到服务商控制台检查",
  );
});

test("summarizeRunError truncates unrecognized errors to one line", () => {
  const summary = summarizeRunError(`weird failure\nsecond line {"json": true}`);
  expect(summary).toBe("weird failure");
  expect(summary).not.toContain("\n");
  expect(summarizeRunError("")).toBe("请求失败");
});
