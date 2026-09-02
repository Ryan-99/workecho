/**
 * 运行时模型注册表校验（CI 门禁）。
 * pi 0.84.2 起 AuthStorage 导出移除、ModelRegistry 需 runtime 实参——
 * 模型存在性改为直接校验 pi-ai 内置 provider 数据 JSON（同一数据源，
 * 无需构造运行时）。运行时 import 完整性由 assert-packaged-runtime-deps
 * 的导出面检查覆盖。
 */
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const lazyUrl = import.meta.resolve("@earendil-works/pi-ai/api/anthropic-messages.lazy.js");
const piAiDist = path.dirname(decodeURIComponent(new URL(lazyUrl).pathname).replace(/^\/([A-Za-z]:)/, "$1"));
const dataDir = path.join(piAiDist, "..", "providers", "data");

const EXPECTED = [
  { file: "openai-codex.json", provider: "openai-codex", id: "gpt-5.6-luna", reason: "GPT 5.6 Codex support" },
  { file: "anthropic.json", provider: "anthropic", id: "claude-opus-4-7", reason: "Opus 4.7 visibility" },
  { file: "zai.json", provider: "zai", id: "glm-5.2", reason: "GLM 5.x visibility" },
];

let failures = 0;
const cache = new Map();
for (const check of EXPECTED) {
  if (!cache.has(check.file)) {
    const json = JSON.parse(await readFile(path.join(dataDir, check.file), "utf8"));
    const ids = new Set();
    for (const apiGroup of Object.values(json)) {
      for (const id of Object.keys(apiGroup ?? {})) ids.add(id);
    }
    cache.set(check.file, ids);
  }
  const ids = cache.get(check.file);
  if (!ids.has(check.id)) {
    console.error(`[model-registry] ${check.provider}/${check.id} missing (${check.reason})`);
    failures += 1;
  }
}
if (failures > 0) {
  console.error(`[model-registry] ${failures} expected model(s) missing from pi-ai provider data.`);
  process.exit(1);
}
console.log("[model-registry] pi-ai 内置 provider 数据包含全部预期模型。");
