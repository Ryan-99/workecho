import test from "node:test";
import assert from "node:assert/strict";
import {
  WORKECHO_APPEND_SYSTEM_PROMPT,
  appendWorkechoIdentity,
  composeAppendSystemPromptWithWorkechoIdentity,
} from "../dist/workecho-identity.js";

test("identity block names Workecho and never instructs users toward pi settings", () => {
  assert.match(WORKECHO_APPEND_SYSTEM_PROMPT, /Workecho/);
  // 身份块必须显式压过上游默认 prompt 的 pi 表述
  assert.match(WORKECHO_APPEND_SYSTEM_PROMPT, /Do not mention "pi"/);
  assert.match(WORKECHO_APPEND_SYSTEM_PROMPT, /Workecho 设置/);
});

test("appendWorkechoIdentity keeps caller-provided APPEND_SYSTEM content and appends identity last", () => {
  const result = appendWorkechoIdentity(["custom-append"]);
  assert.deepEqual(result, ["custom-append", WORKECHO_APPEND_SYSTEM_PROMPT]);
  assert.equal(result[result.length - 1], WORKECHO_APPEND_SYSTEM_PROMPT);
});

test("compose runs caller override first, Workecho identity still last", () => {
  const caller = (base: string[]): string[] => [...base, "caller-extra"];
  const composed = composeAppendSystemPromptWithWorkechoIdentity(caller);
  assert.deepEqual(composed(["a"]), ["a", "caller-extra", WORKECHO_APPEND_SYSTEM_PROMPT]);
});

test("compose without caller override degrades to plain Workecho identity append", () => {
  const composed = composeAppendSystemPromptWithWorkechoIdentity(undefined);
  assert.deepEqual(composed([]), [WORKECHO_APPEND_SYSTEM_PROMPT]);
});
