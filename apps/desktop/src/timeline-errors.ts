/**
 * 运行失败的展示策略（纯函数，便于单测）：
 * 原始报错（如整段 API JSON）不直接进时间线，压成一句人话，
 * 完整文本由错误块的"详情"折叠展示。
 */

/** 把原始报错压成一句人话 */
export function summarizeRunError(raw: string): string {
  const m = raw.trim();
  if (!m) return "请求失败";
  const unknownModel = /Unknown model\s+(\S+)/.exec(m);
  if (unknownModel?.[1]) {
    return `模型不可用（${unknownModel[1].replace(/[.,]$/, "")}），请切换模型后重试`;
  }
  // 余额/欠费类错误常伴随 403——必须在认证分支之前判定，否则误报"认证失效"
  if (/insufficient|balance|quota|arrear|余额|欠费|充值/i.test(m)) {
    return "账户余额不足或额度受限，请到服务商控制台检查";
  }
  if (/auth_unavailable|no auth available|refresh token|unauthorized|No API key|\b401\b|\b403\b/i.test(m)) {
    return "认证失效或未配置，请到设置中检查该 Provider 的认证";
  }
  // "OpenAI API error (503)" 带括号；中继直出的 "404: {...}" 只有行首状态码
  const code = /\((\d{3})\)/.exec(m)?.[1] ?? /^(\d{3}):/.exec(m)?.[1];
  if (code === "429") return "请求过于频繁（429），请稍后重试";
  if (code === "404") return "接口或模型不存在（404），请检查配置";
  if (code && Number(code) >= 500) return `服务暂时不可用（${code}），请稍后重试`;
  if (/timeout|aborted|connection error|connection refused|ENOTFOUND|ECONNREFUSED|ECONNRESET|fetch failed|network|Service Unavailable/i.test(m)) {
    return "网络或服务异常，请稍后重试";
  }
  return truncateLine(m.split("\n")[0] ?? m, 60);
}

function truncateLine(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
