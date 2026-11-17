import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DownloadJob } from './mdown-engine.mjs';
import { chooseDestDir } from './disk.mjs';
import { BASE, BASE_HEADERS, DEFAULT_DOWNLOAD_DIR } from './config.mjs';
import { collectCookies, cookieHeader, AuthRequiredError } from './http.mjs';

// 下载链路（2026-10 逆向确认）：
//   GET /file/downloadToUrl?url_type=6&id=<文件id> → 302 链（可能经 bbs OAuth）→ 真实文件。
//   拿到终点后交给 mdown 引擎做 8 线程分段下载（不支持 Range 自动回退单线程）。
const MAX_HOPS = 10;

export class DownloadError extends Error {
  constructor(msg, { partialFile } = {}) {
    super(msg);
    this.name = 'DownloadError';
    this.partialFile = partialFile;
  }
}

function reqHeaders(urlStr, extra = {}) {
  const u = new URL(urlStr);
  const h = { ...BASE_HEADERS, Referer: BASE + '/', ...extra };
  const cookie = cookieHeader(u.hostname);
  if (cookie) h['Cookie'] = cookie;
  return h;
}

/** 解析 downloadToUrl 重定向链，返回最终文件 URL 与响应头 */
export async function resolveDownloadUrl(id, { onHop } = {}) {
  let url = `${BASE}/file/downloadToUrl?url_type=6&id=${id}`;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    onHop?.(url);
    const res = await fetch(url, { redirect: 'manual', headers: reqHeaders(url) });
    collectCookies(new URL(url).hostname, res);
    if (res.status >= 300 && res.status < 400) {
      res.body?.cancel().catch?.(() => {});
      const loc = res.headers.get('location');
      if (!loc) throw new DownloadError(`重定向缺少 Location：HTTP ${res.status} @ ${url}`);
      if (/\/user\/login/i.test(loc)) throw new AuthRequiredError('下载被重定向到登录页，会话无效或已过期');
      url = new URL(loc, url).href;
      continue;
    }
    if (res.status === 200) {
      const ct = res.headers.get('content-type') ?? '';
      // 站点会把登录页 HTML 伪标成 application/json（2026-11-02 实测），非文件响应补一次内容嗅探
      if (/text\/html/i.test(ct) || (/application\/json/i.test(ct) && !res.headers.get('content-disposition'))) {
        res.body?.cancel().catch?.(() => {});
        const probe = await fetch(url, { headers: { ...reqHeaders(url), Range: 'bytes=0-63' } });
        const head = Buffer.from(await probe.arrayBuffer()).toString('utf8');
        probe.body?.cancel().catch?.(() => {});
        if (/^\s*<(!doctype|html)/i.test(head)) {
          if (/登录|login/i.test(head)) throw new AuthRequiredError('下载端点返回登录页（会话无效或已过期），请重新扫码登录');
          throw new DownloadError(`终点是网页而非文件：${url}（可能无下载权限或文件已下架）`);
        }
      }
      return { url, headers: res.headers };
    }
    res.body?.cancel().catch?.(() => {});
    throw new DownloadError(`下载失败 HTTP ${res.status} @ ${url}`);
  }
  throw new DownloadError(`重定向超过 ${MAX_HOPS} 跳，放弃`);
}

function parseContentDisposition(cd) {
  if (!cd) return null;
  let m = /filename\*=UTF-8''([^;]+)/i.exec(cd);
  if (m) {
    try {
      return decodeURIComponent(m[1]);
    } catch {}
  }
  m = /filename="?([^";]+)"?/i.exec(cd);
  return m ? m[1] : null;
}

export function sanitize(name) {
  return (name ?? '').replace(/[\\/:*?"<>|]/g, '_').trim();
}

export async function fileMd5(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('md5');
    fs.createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });
}

/** 轻量探测一个 URL 是否还活着（用于断点续传时校验旧签名 URL），返回 {ok, size} */
async function probeUrl(url) {
  try {
    const res = await fetch(url, { redirect: 'manual', headers: reqHeaders(url, { Range: 'bytes=0-0' }) });
    collectCookies(new URL(url).hostname, res);
    if (res.status >= 300 && res.status < 400) {
      res.body?.cancel().catch?.(() => {});
      return { ok: false };
    }
    if (res.status === 206) {
      const total = String(res.headers.get('content-range') ?? '').split('/')[1];
      res.body?.cancel().catch?.(() => {});
      return { ok: true, size: total && total !== '*' ? Number(total) : null };
    }
    if (res.status === 200) {
      const len = res.headers.get('content-length');
      res.body?.cancel().catch?.(() => {});
      return { ok: true, size: len ? Number(len) : null };
    }
    res.body?.cancel().catch?.(() => {});
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

/**
 * 下载一个文件到本地（mdown 引擎：8 线程分段 + 断点续传 + 单线程回退）。
 * - saveDir 缺省时自动选盘：优先下载目录，空间不足自动换剩余最大的非 C 盘（永不落 C 盘）
 * - 目标已存在且 MD5 不符：挪开成 `<name>.旧-<时间戳>`（含对应 .mdown 残片）
 * - 签名 URL 轮换导致的续传失效：优先复用上次 .mdown.json 里的 URL（仍有效时）
 * - 完成后整文件 MD5 校验，不符删除并报错
 * onProgress(written, total, speed) 由引擎 update 事件驱动
 */
export async function downloadFile({
  id,
  name,
  md5,
  size,
  saveDir,
  threads = 8,
  onProgress,
} = {}) {
  if (!id) throw new DownloadError('缺少文件 id');

  const { url: freshUrl, headers } = await resolveDownloadUrl(id);
  const cdName = parseContentDisposition(headers.get('content-disposition'));
  const filename = sanitize(name || cdName || `sangfor_file_${id}`) || `sangfor_file_${id}`;
  const expectMd5 = md5 ? String(md5).toLowerCase() : null;
  // 空间需求：优先调用方给的 size，其次下载链终点响应的 content-length
  const effSize = Number(size) || Number(headers.get('content-length')) || 0;

  // 选盘（显式 saveDir 直接用；否则优先下载目录、空间不足自动换盘，永不落 C 盘）
  let destDir;
  if (saveDir) {
    if (!/^[a-zA-Z]:[\\/]/.test(saveDir) && !saveDir.startsWith('\\\\')) {
      throw new DownloadError(`saveDir 必须是绝对路径（收到 "${saveDir}"，盘符相对路径会落错盘）`);
    }
    fs.mkdirSync(saveDir, { recursive: true });
    destDir = saveDir;
  } else {
    const chosen = await chooseDestDir({ needBytes: effSize, prefer: DEFAULT_DOWNLOAD_DIR });
    destDir = chosen.dir;
  }
  const target = path.join(destDir, filename);
  const partFile = target + '.mdown';
  const metaFile = target + '.mdown.json';

  let movedAside = null;
  if (fs.existsSync(target)) {
    const same = expectMd5 && (await fileMd5(target)) === expectMd5;
    if (same) {
      return { file: target, size: fs.statSync(target).size, md5: expectMd5, verified: true, alreadyDownloaded: true, threads: 0 };
    }
    movedAside = target + `.旧-${Date.now()}`;
    fs.renameSync(target, movedAside);
    for (const f of [partFile, metaFile]) {
      if (fs.existsSync(f)) fs.renameSync(f, f + `.旧-${Date.now()}`);
    }
  }

  // 断点续传 URL 对账：签名 URL 每次解析可能不同，若上次进度还在且旧 URL 仍有效，则沿用旧 URL
  let jobUrl = freshUrl;
  try {
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    if (meta?.url && meta.url !== freshUrl && fs.existsSync(partFile)) {
      const probe = await probeUrl(meta.url);
      if (probe.ok && (meta.size == null || probe.size == null || probe.size === meta.size)) {
        jobUrl = meta.url;
      }
    }
  } catch {
    /* 无历史进度 */
  }

  const job = new DownloadJob({
    url: jobUrl,
    out: target,
    threads: Math.min(32, Math.max(1, Number(threads) || 8)),
    headers: (() => {
      const u = new URL(jobUrl);
      const list = [['Referer', BASE + '/']];
      const cookie = cookieHeader(u.hostname);
      if (cookie) list.push(['Cookie', cookie]);
      return list;
    })(),
  });
  job.on('update', (s) => onProgress?.(s.done, s.total, s.speed));
  await job.run();
  if (job.status !== 'completed') {
    throw new DownloadError(`下载未完成：${job.error ?? job.status}`, { partialFile: fs.existsSync(partFile) ? partFile : undefined });
  }

  // 完整性校验。字节比较只信两处精确值：调用方明确传的数字（typeof number）、
  // 下载链终点的 content-length；站点"4.29GB"这类显示值换算出的近似字节不可作依据。
  // 落盘内容嗅探：引擎分段请求丢了会话时会拉回登录页 HTML（92845B，2026-11-02 实测），
  // 小文件 + HTML 头直接判假成功，删文件抛登录错误
  const headBuf = Buffer.alloc(64);
  const fd = fs.openSync(target, 'r');
  fs.readSync(fd, headBuf, 0, 64, 0);
  fs.closeSync(fd);
  if (/^\s*<(!doctype|html)/i.test(headBuf.toString('utf8'))) {
    fs.rmSync(target, { force: true });
    for (const f of [partFile, metaFile]) fs.rmSync(f, { force: true });
    throw new AuthRequiredError('下载到的是登录页而非文件（会话无效），请重新登录后重试');
  }
  const actualSize = fs.statSync(target).size;
  const expectBytes =
    typeof size === 'number' && Number.isInteger(size)
      ? size
      : Number(headers.get('content-length')) || 0;
  if (expectBytes && actualSize !== expectBytes) {
    fs.unlinkSync(target);
    throw new DownloadError(`文件大小不符：实际 ${actualSize}，期望 ${expectBytes}（已删除坏文件）`);
  }
  const actualMd5 = await fileMd5(target);
  if (expectMd5 && actualMd5 !== expectMd5) {
    fs.unlinkSync(target);
    throw new DownloadError(`MD5 校验失败：实际 ${actualMd5}，站点标注 ${expectMd5}（已删除坏文件，可重试）`);
  }

  return {
    file: target,
    size: actualSize,
    md5: actualMd5,
    verified: !expectMd5 || actualMd5 === expectMd5,
    movedAside,
    threads: job.partCount ?? 1,
    destDir,
  };
}
