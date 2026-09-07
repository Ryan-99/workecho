import test from "node:test";
import assert from "node:assert/strict";
import { transcriptFromMessages } from "../dist/session-supervisor-utils.js";

/**
 * 失败运行的 assistant 消息（stopReason=error、无正文、只有 errorMessage）
 * 必须映射成 kind:"error" 的 transcript 项——之前被静默丢弃，重开历史会话时
 * 连续失败（如 provider 认证失效被 pi 自动重试多次）完全不可见。
 */
test("transcriptFromMessages maps stopReason=error assistant messages to error items", () => {
  const transcript = transcriptFromMessages([
    { role: "user", content: "hello", createdAt: "2026-09-07T10:00:00.000Z" },
    {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: 'OpenAI API error (503): {"message":"Service Unavailable"}',
      createdAt: "2026-09-07T10:00:01.000Z",
    },
  ]);

  assert.equal(transcript.length, 2);
  const errorItem = transcript[1];
  assert.ok(errorItem && errorItem.kind === "error");
  if (errorItem.kind === "error") {
    assert.equal(errorItem.message, 'OpenAI API error (503): {"message":"Service Unavailable"}');
  }
});

test("transcriptFromMessages keeps multiple consecutive failures in order", () => {
  const transcript = transcriptFromMessages([
    { role: "user", content: "hi", createdAt: "2026-09-07T10:00:00.000Z" },
    { role: "assistant", content: [], stopReason: "error", errorMessage: "first failure", createdAt: "2026-09-07T10:00:01.000Z" },
    { role: "assistant", content: [], stopReason: "error", errorMessage: "second failure", createdAt: "2026-09-07T10:00:02.000Z" },
  ]);

  const errors = transcript.filter((item) => item.kind === "error");
  assert.equal(errors.length, 2);
  const first = errors[0];
  const second = errors[1];
  assert.ok(first && first.kind === "error" && first.message === "first failure");
  assert.ok(second && second.kind === "error" && second.message === "second failure");
});

test("transcriptFromMessages still skips empty assistant messages without an error", () => {
  const transcript = transcriptFromMessages([
    { role: "user", content: "hello", createdAt: "2026-09-07T10:00:00.000Z" },
    { role: "assistant", content: [], createdAt: "2026-09-07T10:00:01.000Z" },
  ]);

  assert.equal(transcript.length, 1);
  assert.equal(transcript[0]?.kind, "message");
});

test("aborted runs without errorMessage do not produce empty error items", () => {
  const transcript = transcriptFromMessages([
    { role: "user", content: "hello", createdAt: "2026-09-07T10:00:00.000Z" },
    { role: "assistant", content: [], stopReason: "aborted", createdAt: "2026-09-07T10:00:01.000Z" },
  ]);

  assert.equal(transcript.filter((item) => item.kind === "error").length, 0);
});
