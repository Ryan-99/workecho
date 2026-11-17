import fs from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';
import { AUTH_DIR, SESSION_FILE, CREDENTIALS_FILE, BASE, UA } from './config.mjs';
import { api, unwrap, AuthRequiredError, ApiError, collectCookies, cookieHeader, dumpCookies, loadCookies, hasSessionCookies, setReloginHook } from './http.mjs';

export class CaptchaRequiredError extends Error {
  constructor(msg = '站点要求图形验证码（连续登录失败触发）。请调用 sangfor_captcha 获取验证码图片后再带 captcha 参数重试，或改用扫码登录。') {
    super(msg);
    this.name = 'CaptchaRequiredError';
  }
}

// ---------- 会话持久化 ----------
function saveSession(info = {}) {
  fs.writeFileSync(
    SESSION_FILE,
    JSON.stringify({ cookies: dumpCookies(), ...info, savedAt: new Date().toISOString() }, null, 2),
    'utf8'
  );
}

export function loadSession() {
  try {
    const s = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    loadCookies(s.cookies);
    return s;
  } catch {
    loadCookies({});
    return null;
  }
}

// ---------- 凭据（用于会话过期自动重登；仅存本机 auth/ 目录） ----------
export function loadCredentials() {
  const envUser = process.env.SANGFOR_USERNAME;
  const envPass = process.env.SANGFOR_PASSWORD;
  if (envUser && envPass) return { username: envUser, password: envPass };
  try {
    return JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf8'));
  } catch {
    return null;
  }
}

export function storeCredentials(username, password) {
  fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify({ username, password }, null, 2), 'utf8');
}

export function clearCredentials() {
  try {
    fs.unlinkSync(CREDENTIALS_FILE);
  } catch {}
}

// ---------- 登录态 ----------
/** 当前登录用户；未登录返回 null */
export async function whoami() {
  try {
    const j = await api('/user/userInfo');
    if (!j || j.code === 40701 || (j.data && j.data.uid === 0)) return null;
    unwrap(j);
    const d = j.data ?? {};
    return { uid: d.uid, username: d.username ?? d.account ?? '', email: d.email ?? '' };
  } catch {
    return null;
  }
}

/**
 * 确保可用会话：载入持久会话 → 校验；失效则用已存凭据自动重登。
 * 返回 {loggedIn, username, uid} 或 loggedIn:false。
 */
export async function ensureSession() {
  if (!hasSessionCookies()) loadSession();
  let me = await whoami();
  if (!me) {
    // 内存会话失效：重读磁盘会话（可能已被 cli 或其他进程刷新）再试一次
    loadSession();
    me = await whoami();
  }
  if (me) return { loggedIn: true, ...me };
  const cred = loadCredentials();
  if (cred) {
    try {
      const r = await loginPassword(cred.username, cred.password);
      return { loggedIn: true, autoRelogin: true, ...r };
    } catch {
      /* 自动重登失败则按未登录处理 */
    }
  }
  return { loggedIn: false };
}

// ---------- 密码登录 ----------
export async function loginPassword(username, password, captcha) {
  const params = { username, password };
  if (captcha) params.captcha = captcha;
  const j = await api('/user/loginByPwd', { method: 'POST', params });
  if (j.code === 200) {
    const d = j.data ?? {};
    const me = { uid: d.uid, username: d.username ?? username };
    saveSession(me);
    return me;
  }
  if (j.code === 40003 || j.code === 40004) throw new CaptchaRequiredError();
  if (j.code === 40706) throw new ApiError('账号已被锁定（错误次数过多），请稍后再试或改用扫码登录', j.code);
  throw new ApiError(j.message ?? j.msg ?? `登录失败 code=${j.code}` + (j.data?.errNum ? `（已错 ${j.data.errNum} 次）` : ''), j.code);
}

// ---------- 扫码登录 ----------
export async function qrCreate() {
  const j = await api('/user/loginByQRCode', { params: { scanStatus: 1 } });
  unwrap(j);
  return j.data?.url;
}

export async function qrPoll() {
  const j = await api('/user/loginByQRCode', { params: { scanStatus: 2 } });
  unwrap(j);
  const st = j.data?.status;
  if (st === 3) {
    const me = await whoami();
    saveSession(me ?? {});
    return { status: 3, info: me, message: '登录成功' };
  }
  const map = {
    0: '等待扫码',
    1: '已扫码，等待手机确认',
    2: '二维码已过期，请重新获取（sangfor_login method=qrcode）',
    6: '该二维码由其他平台使用，请在支持站登录页扫码',
  };
  return { status: st, message: map[st] ?? `status=${st}` };
}

/** 二维码的终端 ASCII 形态 */
export async function qrAscii(text) {
  return QRCode.toString(text, { type: 'terminal', small: true });
}

/**
 * 生成可在支持富媒体内嵌展示的 Agent 会话里直接展示的二维码 HTML 片段（白底黑块 + base64 data URL，无外部依赖）。
 * dir 传该 Agent 的会话可视化/资源目录；返回文件绝对路径，按其内嵌引用语法展示给用户扫码。
 */
export function writeQrHtmlFragment(dir, pngPath = AUTH_DIR + '\\qr.png') {
  const b64 = fs.readFileSync(pngPath).toString('base64');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'sangfor-login-qr.html');
  fs.writeFileSync(
    file,
    `<div id="sangfor-qr" style="display:flex;flex-direction:column;align-items:center;gap:12px;padding:8px 0;">
  <div style="background:#ffffff;border-radius:12px;padding:16px;box-shadow:0 1px 8px rgba(0,0,0,.18);line-height:0;">
    <img src="data:image/png;base64,${b64}" alt="深信服支持站扫码登录二维码" style="width:280px;height:280px;display:block;">
  </div>
  <div style="font-size:13px;opacity:.75;">微信 / 深信服 App 扫一扫，手机上点确认 · 约 4 分钟有效</div>
</div>
`,
    'utf8'
  );
  return file;
}

// ---------- 图形验证码（登录被要求验证码时的兜底） ----------
export async function captchaImage() {
  const res = await fetch(`${BASE}/common/captcha?t=${Date.now()}`, {
    headers: { 'User-Agent': UA, Cookie: cookieHeader('support.sangfor.com.cn') },
  });
  collectCookies('support.sangfor.com.cn', res);
  const buf = Buffer.from(await res.arrayBuffer());
  const file = AUTH_DIR + '\\captcha.png';
  fs.writeFileSync(file, buf);
  return file;
}

// ---------- 登出 ----------
export async function logout() {
  try {
    await api('/user/logout', { method: 'POST', params: {} });
  } catch {}
  loadCookies({});
  try {
    fs.unlinkSync(SESSION_FILE);
  } catch {}
}

// 会话失效时用已存凭据自动重登（供 apiAuth 调用）
setReloginHook(async () => {
  const cred = loadCredentials();
  if (!cred) return false;
  try {
    await loginPassword(cred.username, cred.password);
    return true;
  } catch {
    return false;
  }
});
