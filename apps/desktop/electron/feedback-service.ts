import { net, app } from "electron";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * 用户反馈服务（Ryan 收集内网用户问题）。
 *
 * 支持两类群机器人 webhook（按 URL 自动识别，用户零配置）：
 * - 企业微信 qyapi.weixin.qq.com：markdown + image（base64 直传截图）
 * - 飞书 open.feishu.cn（/bot/v2/send）：富文本 post 消息；自定义机器人
 *   不支持传图——截图落盘反馈存档并在消息中注明
 * 通道优先级 = 本地覆盖（维护者用） > 环境变量 WORKECHO_FEEDBACK_WEBHOOK
 * > 内置默认 DEFAULT_FEEDBACK_WEBHOOK。无通道时降级：落盘 + 一键复制。
 */

/** 内置反馈通道：构建时由 WORKECHO_FEEDBACK_WEBHOOKS（逗号分隔多个）注入，
 * 支持企业微信/飞书群机器人，逐个发送。仓库中恒为空串（防泄露）。 */
declare const __WORKECHO_FEEDBACK_WEBHOOKS__: string;
const BUILTIN_FEEDBACK_WEBHOOKS = typeof __WORKECHO_FEEDBACK_WEBHOOKS__ === "string"
  ? __WORKECHO_FEEDBACK_WEBHOOKS__.split(/[\,\n]/).map((x) => x.trim()).filter(Boolean)
  : [];

export interface FeedbackInput {
  readonly kind: "bug" | "suggestion" | "ux" | "other";
  readonly text: string;
  readonly includeDiagnostics: boolean;
  readonly imageBase64?: string; // data URL 的 base64 段（png）
}

export interface FeedbackResult {
  readonly ok: boolean;
  readonly channel: "wecom" | "feishu" | "local";
  readonly message: string;
  readonly savedPath?: string;
}

const KIND_LABELS: Record<FeedbackInput["kind"], string> = {
  bug: "问题/BUG",
  suggestion: "功能建议",
  ux: "体验问题",
  other: "其他",
};

/** 诊断信息（发送前给用户预览；不含任何会话内容） */
export function buildDiagnostics(): string {
  const lines: string[] = [];
  lines.push(`- 版本：Workecho ${app.getVersion()}（${process.platform}/${process.arch}）`);
  lines.push(`- 时间：${new Date().toISOString()}`);
  const log = path.join(app.getPath("userData"), "crash.log");
  try {
    if (existsSync(log)) {
      const tail = readFileSync(log, "utf8").trim().split("\n").slice(-5).join("\n");
      if (tail) lines.push(`- 最近异常（crash.log 尾部，已脱敏）：\n\`\`\`\n${redact(tail)}\n\`\`\``);
    }
  } catch { /* 日志不可读则省略 */ }
  return lines.join("\n");
}

function redact(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-***")
    .replace(/(api[-_]?key|token|secret|authorization)[=:]\s*\S+/gi, "$1=***");
}

/** 解析生效通道列表：本地覆盖（单值）> 环境变量 > 构建注入内置 */
export function resolveFeedbackWebhooks(localOverride?: string): string[] {
  const local = localOverride?.trim();
  if (local) return [local];
  const envUrls = (process.env.WORKECHO_FEEDBACK_WEBHOOKS ?? "")
    .split(/[\,\n]/).map((x) => x.trim()).filter(Boolean);
  return envUrls.length > 0 ? envUrls : BUILTIN_FEEDBACK_WEBHOOKS;
}

export async function submitFeedback(
  input: FeedbackInput,
  localOverride: string | undefined,
): Promise<FeedbackResult> {
  const text = input.text.trim();
  if (!text) return { ok: false, channel: "local", message: "反馈内容为空" };

  const sections = [
    `## Workecho 用户反馈｜${KIND_LABELS[input.kind]}`,
    text,
  ];
  if (input.includeDiagnostics) sections.push(`**诊断信息**\n${buildDiagnostics()}`);
  const markdown = sections.join("\n\n").slice(0, 3900); // 企微 markdown 上限 4096

  // 本地存档（所有通道都留底，便于追查）
  const dir = path.join(app.getPath("userData"), "feedback");
  try {
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const savedPath = path.join(dir, `feedback-${stamp}.md`);
    writeFileSync(savedPath, `# ${KIND_LABELS[input.kind]}\n\n${markdown}\n`, "utf-8");

  } catch { /* 存档失败不阻断发送 */ }

  // 截图随存档落盘（两种通道都留底：飞书发不了图、企微发图失败也有底）
  if (input.imageBase64) {
    try {
      const imgBuf = Buffer.from(input.imageBase64, "base64");
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      writeFileSync(path.join(dir, `feedback-${stamp}.png`), imgBuf);
    } catch { /* 存档失败不阻断 */ }
  }

  const webhooks = resolveFeedbackWebhooks(localOverride);
  if (webhooks.length === 0) {
    return {
      ok: true,
      channel: "local",
      message: "已保存到本地（反馈通道未配置）。点击\"复制反馈内容\"发给维护者。",
    };
  }
  const failures: string[] = [];
  const sentChannels: string[] = [];
  for (const webhookUrl of webhooks) {
  const isFeishu = webhookUrl.includes("open.feishu.cn") || webhookUrl.includes("/bot/v2/send");
  try {
    const res = await postJson(webhookUrl, isFeishu
      ? buildFeishuPost(input, markdown, Boolean(input.imageBase64))
      : { msgtype: "markdown", markdown: { content: markdown } });
    const body = (await res.json()) as { errcode?: number; errmsg?: string; code?: number; msg?: string };
    const apiErr = body.errcode ?? body.code;
    const apiMsg = body.errmsg ?? body.msg;
    if (!res.ok || (apiErr !== undefined && apiErr !== 0)) {
      failures.push(`${isFeishu ? "飞书" : "企微"}:${apiMsg ?? `HTTP ${res.status}`}`);
      continue;
    }
    // 企微附图直传（可选，失败不影响整体成功；飞书通道截图已在存档）
    if (!isFeishu && input.imageBase64) {
      const md5 = createHash("md5").update(Buffer.from(input.imageBase64, "base64")).digest("hex");
      await postJson(webhookUrl, { msgtype: "image", image: { base64: input.imageBase64, md5 } }).catch(() => undefined);
    }
    sentChannels.push(isFeishu ? "飞书" : "企微");
  } catch (e) {
    failures.push(`${(e as Error).message}`);
  }
  }
  console.warn('[feedback] sent:', sentChannels.join(','), '| failures:', failures.join(' ; ') || '(none)');
  if (sentChannels.length > 0) {
    return {
      ok: true,
      channel: "wecom",
      message: failures.length > 0
        ? `已发送（${sentChannels.join("+")}）${failures.length < webhooks.length ? "" : "；其余通道失败已留底"}`
        : "反馈已发送，谢谢！",
    };
  }
  return { ok: false, channel: "wecom", message: `发送失败：${failures.join("；")}（内容已留底本地）` };
}

/**
 * 飞书自定义机器人富文本（post）：二维数组（每段一行），
 * 行内只支持 text/a/at/img 标签——lark_md 是卡片语法、post 不认。
 * markdown 常见标记做轻量清洗（** 加粗/## 标题/` 代码）避免原样噪声。
 */
function buildFeishuPost(input: FeedbackInput, markdown: string, hasImage: boolean) {
  const clean = (t: string) => t.replace(/\*\*/g, "").replace(/^#+\s*/gm, "").replace(/`/g, "");
  const lines: Array<Array<{ tag: string; text?: string }>> = markdown
    .split("\n\n")
    .filter(Boolean)
    .map((para) => [{ tag: "text", text: clean(para) }]);
  if (hasImage) {
    lines.push([{ tag: "text", text: "📎 附有截图，见该用户本机反馈存档" }]);
  }
  return {
    msg_type: "post",
    content: {
      post: {
        zh_cn: {
          title: `Workecho 用户反馈｜${KIND_LABELS[input.kind]}`,
          content: lines,
        },
      },
    },
  };
}

/**
 * 反馈 POST：优先 Electron net.fetch（尊重系统代理），
 * 失败自动降级 Node 原生 fetch 直连——系统代理不可达（如本机 7890 未开）
 * 时 webhook 仍能发出（实测飞书域名命中代理规则而企微直连，曾致单通道失败）。
 */
async function postJson(url: string, payload: unknown): Promise<Response> {
  try {
    return await net.fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    return await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }
}
