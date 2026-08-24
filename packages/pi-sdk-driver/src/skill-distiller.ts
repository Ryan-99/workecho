import {
  SessionManager,
  SettingsManager,
  createExtensionRuntime,
  createAgentSession,
  type CreateAgentSessionOptions,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import type { ModelRuntime, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { SessionModelSelection, WorkspaceRef } from "@pi-gui/session-driver";
import { messageText as sessionMessageText } from "./session-supervisor-utils.js";

export interface DistillSkillOptions {
  readonly prompt: string;
  readonly model?: SessionModelSelection;
  readonly thinkingLevel?: string;
  readonly signal?: AbortSignal;
}

interface SkillDistillerDeps {
  readonly agentDir: string;
  readonly modelRuntime: ModelRuntime;
  readonly modelRegistry: ModelRegistry;
}

/**
 * 自学习蒸馏器的系统提示：输入一段对话 + 已有 Skill 清单，
 * 让模型判定是否存在可复用的流程/偏好，并输出结构化 JSON。
 * 输出格式契约与 apps/desktop/electron/self-learning.ts 的
 * parseDistillDecision 配对（那里负责解析与校验）。
 */
const DISTILL_SYSTEM_PROMPT = [
  "You distill reusable skills from conversations with a coding/business assistant.",
  "Return ONLY a JSON object with no markdown fences and no extra text, in one of two shapes:",
  '{"learn": false}',
  '{"learn": true, "name": "short-english-kebab-case-name", "description": "one sentence: when to use this skill", "content": "markdown instructions"}',
  "Learn ONLY when the conversation demonstrates a reusable workflow, procedure, or a stable user preference that future sessions would benefit from.",
  "Do NOT learn: one-off facts, trivial Q&A, sensitive personal data, secrets or credentials, or anything already covered by the existing skills list.",
  "name must be short English kebab-case (lowercase letters, digits, hyphens).",
  "description and content must use the same language as the conversation.",
  "content must be self-contained step-by-step instructions with no references to this particular conversation.",
  "Follow the official skill-creator conventions:",
  "- description states WHAT it does and WHEN to use it, written in third person (e.g. \"Use when ...\"). Keep it under 1024 characters.",
  "- content starts with a short overview, then numbered step-by-step instructions, then a compact example. Keep the body under 500 words; do not inline long reference material.",
  "- prefer explicit decision rules (when to do what) over vague guidance.",
].join("\n");

/**
 * 一次性蒸馏调用：临时会话（无工具、无扩展、无 Skill、不落盘），
 * 返回模型原始输出文本（调用方解析 JSON），失败返回 null。
 */
export async function distillSkill(
  workspace: WorkspaceRef,
  options: DistillSkillOptions,
  deps: SkillDistillerDeps,
): Promise<string | null> {
  const prompt = options.prompt.trim();
  if (!prompt || options.signal?.aborted) {
    return null;
  }

  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const resourceLoader = createSkillDistillerResourceLoader();

  const createOptions: CreateAgentSessionOptions = {
    cwd: workspace.path,
    agentDir: deps.agentDir,
    modelRuntime: deps.modelRuntime,
    resourceLoader,
    settingsManager,
    sessionManager: SessionManager.inMemory(),
    tools: [],
  };
  if (options.model) {
    const selectedModel = deps.modelRegistry.find(options.model.provider, options.model.modelId);
    if (!selectedModel) {
      return null;
    }
    createOptions.model = selectedModel;
  }
  if (options.thinkingLevel) {
    createOptions.thinkingLevel = options.thinkingLevel as NonNullable<CreateAgentSessionOptions["thinkingLevel"]>;
  }

  const { session } = await createAgentSession(createOptions);
  const handleAbort = () => {
    void session.abort().catch(() => undefined);
  };
  options.signal?.addEventListener("abort", handleAbort, { once: true });
  try {
    if (options.signal?.aborted) {
      return null;
    }
    if (!session.model) {
      return null;
    }
    const auth = await deps.modelRegistry.getApiKeyAndHeaders(session.model);
    if (!auth.ok || !auth.apiKey) {
      return null;
    }

    await session.prompt(prompt, { source: "interactive" });
    return extractLastAssistantText(session);
  } finally {
    options.signal?.removeEventListener("abort", handleAbort);
    session.dispose();
  }
}

function createSkillDistillerResourceLoader(): ResourceLoader {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => DISTILL_SYSTEM_PROMPT,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

function extractLastAssistantText(session: { messages: readonly unknown[] }): string {
  for (let index = session.messages.length - 1; index >= 0; index -= 1) {
    const message = session.messages[index];
    if (!isRecord(message) || message.role !== "assistant") {
      continue;
    }
    return sessionMessageText(message);
  }
  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
