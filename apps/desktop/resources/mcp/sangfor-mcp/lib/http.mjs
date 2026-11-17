import { BASE, BASE_HEADERS, OK_CODES, AUTH_CODES } from './config.mjs';

export class AuthRequiredError extends Error {
  constructor(msg = '未登录或会话已过期，请先调用 sangfor_login') {
    super(msg);
    this.name = 'AuthRequiredError';
  }
}

export class ApiError extends Error {
  constructor(msg, code) {
    super(msg);
    this.name = 'ApiError';
    this.code = code;
  }
}

// ---------- Cookie Jar（跨 support/bbs 域，供下载重定向链使用） ----------
const jar = new Map(); // domain -> Map(name -> value)

export function collectCookies(hostname, res) {
  const list = res.headers.getSetCookie?.() ?? [];
  if (!list.length) return;
  if (!jar.has(hostname)) jar.set(hostname, new Map());
  const m = jar.get(hostname);
  for (const c of list) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    if (i > 0) m.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
}

export function cookieHeader(hostname) {
  const parts = [];
  for (const [d, cookies] of jar) {
    if (hostname === d || hostname.endsWith('.' + d)) {
      for (const [k, v] of cookies) parts.push(`${k}=${v}`);
    }
  }
  return parts.join('; ');
}

export function dumpCookies() {
  return Object.fromEntries([...jar].map(([d, m]) => [d, Object.fromEntries(m)]));
}

export function loadCookies(obj) {
  jar.clear();
  for (const [d, m] of Object.entries(obj ?? {})) jar.set(d, new Map(Object.entries(m)));
}

export function hasSessionCookies() {
  const s = jar.get('support.sangfor.com.cn');
  return !!(s && s.get('PHPSESSID'));
}

// ---------- 站点 API ----------
function buildUrl(base, p, params) {
  const url = new URL(base + p);
  if (params) for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  return url;
}

/**
 * 调用站点接口。站点约定（service.js）：GET 用 query，POST 把 params 作为 JSON body。
 * 返回原始信封 {code, data|rows, message|msg, uid}，不在此处解包。
 */
export async function api(p, { method = 'GET', params, base = BASE, extraHeaders = {} } = {}) {
  const url = buildUrl(base, p, method === 'GET' ? params : undefined);
  const headers = { ...BASE_HEADERS, ...extraHeaders };
  const cookie = cookieHeader(url.hostname);
  if (cookie) headers['Cookie'] = cookie;
  const opts = { method, headers };
  if (method === 'POST') {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(params ?? {});
  }
  const res = await fetch(url, opts);
  collectCookies(url.hostname, res);
  const text = await res.text();
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    // 站点偶发返回 39 字节空文档或 HTML，报出可诊断信息
    throw new ApiError(`非 JSON 响应 (HTTP ${res.status}): ${text.slice(0, 120)}`, res.status);
  }
  return j;
}

/** 解包信封；未登录抛 AuthRequiredError，业务错误抛 ApiError */
export function unwrap(j) {
  if (OK_CODES.includes(j.code)) return j;
  if (AUTH_CODES.includes(j.code)) {
    // 40002 在部分接口表示参数缺失（如“类目ID不能为空”），仅当消息提及登录才算会话失效
    if (j.code !== 40002 || /登录/.test(j.message ?? j.msg ?? '')) throw new AuthRequiredError();
  }
  if (j.code === 500 && /登录/.test(j.message ?? j.msg ?? '')) throw new AuthRequiredError();
  throw new ApiError(j.message ?? j.msg ?? `接口返回 code=${j.code}`, j.code);
}

/** 自动重登钩子由 auth.mjs 注入，避免循环依赖 */
let reloginHook = null;
export function setReloginHook(fn) {
  reloginHook = fn;
}

/** 自动登录包装：会话失效时用已存凭据重登一次再重试 */
export async function apiAuth(p, opts = {}) {
  try {
    return unwrap(await api(p, opts));
  } catch (e) {
    if (e instanceof AuthRequiredError && reloginHook) {
      const ok = await reloginHook().catch(() => false);
      if (ok) return unwrap(await api(p, opts));
    }
    throw e;
  }
}

/** 剥 HTML 标签为纯文本 */
export function html2text(h) {
  if (!h) return '';
  return String(h)
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|td|th)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function fmtSize(n) {
  if (n == null) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = Number(n);
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 2)}${units[i]}`;
}
