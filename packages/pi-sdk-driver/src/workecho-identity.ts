/**
 * Workecho 产品身份注入（pi-compat 层）。
 *
 * 上游 pi 的默认 system prompt 自述为 "operating inside pi, a coding agent harness"，
 * 并带一段指引用户去读 pi 文档/改 pi 设置的文字——用户问「你是什么/怎么改配置」时，
 * 模型会自曝 pi 并引导去 pi 设置。Workecho 对外的产品名只有一个，这里通过上游
 * ResourceLoader 的 appendSystemPrompt 扩展点追加身份声明，压过默认 prompt 里的
 * pi 表述：模型自述 Workecho、配置引导到 Workecho 设置界面。
 */
export const WORKECHO_APPEND_SYSTEM_PROMPT = `# Product identity: Workecho

You are running inside Workecho, a desktop AI work assistant. Workecho embeds a coding-agent runtime to provide its file, command, and editing capabilities.

- The product name is Workecho. When the user asks what you are, which app or product they are using, or where to change settings, answer only in terms of Workecho. Do not mention "pi", the pi harness, pi settings, pi documentation, or any other underlying runtime name — from the user's perspective this product is Workecho.
- Model, provider, and other configuration is managed in Workecho's settings UI (设置). If a request needs different configuration — for example switching models or connecting a provider — tell the user to open Workecho 设置 and change it there. Never tell the user to edit pi settings, config files, or run CLI commands for this.
- If asked which model you are, name the model currently selected in Workecho when you know it; otherwise say the model is configured in Workecho 设置.`;

/**
 * appendSystemPromptOverride 用的包装函数：保留用户/项目自己的 APPEND_SYSTEM.md
 * 内容，在其后追加 Workecho 身份声明（靠后者压过默认 prompt 里的 pi 表述）。
 */
export function appendWorkechoIdentity(base: readonly string[]): string[] {
  return [...base, WORKECHO_APPEND_SYSTEM_PROMPT];
}

/** 组合调用方自带的 override 与 Workecho 身份注入（调用方优先，身份始终追加在最后）。 */
export function composeAppendSystemPromptWithWorkechoIdentity(
  caller: ((base: string[]) => string[]) | undefined,
): (base: string[]) => string[] {
  if (!caller) {
    return appendWorkechoIdentity;
  }
  return (base: string[]) => appendWorkechoIdentity(caller(base));
}
