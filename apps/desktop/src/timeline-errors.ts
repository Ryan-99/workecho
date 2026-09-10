/**
 * 运行失败的展示策略（纯函数，便于单测）：
 * 原始报错（如整段 API JSON）不直接进时间线，压成一句人话，
 * 完整文本由错误块的"详情"折叠展示。
 *
 * 视觉分级（莫兰迪基调）：一般瞬时错误（网络/限流/服务波动）灰色弱化；
 * 只有需要用户处理才能恢复的严重错误（认证失效/余额不足/模型不可用）
 * 才用偏黑的深红，避免大面积亮红过于突兀。
 */

export interface RunErrorSummary {
  readonly label: string;
  /** true = 需要用户处理（认证/余额/模型），深红强调；一般瞬时错误 false（灰） */
  readonly severe: boolean;
}

/** 把原始报错压成一句人话 + 严重级别 */
export function summarizeRunError(raw: string): RunErrorSummary {
  const m = raw.trim();
  if (!m) return { label: "请求失败", severe: false };
  const unknownModel = /Unknown model\s+(\S+)/.exec(m);
  if (unknownModel?.[1]) {
    return {
      label: `模型不可用（${unknownModel[1].replace(/[.,]$/, "")}），请切换模型后重试`,
      severe: true,
    };
  }
  // 余额/欠费类错误常伴随 403——必须在认证分支之前判定，否则误报"认证失效"
  if (/insufficient|balance|quota|arrear|余额|欠费|充值/i.test(m)) {
    return { label: "账户余额不足或额度受限，请到服务商控制台检查", severe: true };
  }
  if (/auth_unavailable|no auth available|refresh token|unauthorized|No API key|\b401\b|\b403\b/i.test(m)) {
    return { label: "认证失效或未配置，请到设置中检查该 Provider 的认证", severe: true };
  }
  const code = /\((\d{3})\)/.exec(m)?.[1] ?? /^(\d{3}):/.exec(m)?.[1];
  if (code === "429") return { label: "请求过于频繁（429），请稍后重试", severe: false };
  if (code === "404") return { label: "接口或模型不存在（404），请检查配置", severe: true };
  if (code && Number(code) >= 500) return { label: `服务暂时不可用（${code}），请稍后重试`, severe: false };
  if (/timeout|aborted|connection error|connection refused|ENOTFOUND|ECONNREFUSED|ECONNRESET|fetch failed|network|Service Unavailable/i.test(m)) {
    return { label: "网络或服务异常，请稍后重试", severe: false };
  }
  return { label: truncateLine(m.split("\n")[0] ?? m, 60), severe: false };
}

function truncateLine(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
