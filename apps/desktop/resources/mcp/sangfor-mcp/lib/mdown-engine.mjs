/**
 * mdown 下载引擎 —— CLI 与 GUI 共用
 * 提供 DownloadJob（任务生命周期 + update 事件）、HTTP 层与格式化工具。
 * 多线程分段下载引擎（2026-10-20 集成）。
 */

import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';

export const VERSION = '1.1.0';
const MAX_REDIRECTS = 10;
const MAX_RETRY = 5;
const IDLE_TIMEOUT_MS = 30_000;
export const MIN_PART_SIZE = 1024 * 1024;
export const PART_SUFFIX = '.mdown';
export const META_SUFFIX = '.mdown.json';
const NOTIFY_INTERVAL_MS = 250;

export class PauseSignal extends Error {}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- HTTP 层 ---------- */

export function parseProxy(v) {
  const u = new URL(v.includes('://') ? v : `http://${v}`);
  if (!u.hostname) throw new Error(`代理地址无法解析: ${v}`);
  return { host: u.hostname, port: Number(u.port) || 80 };
}

export function parseHeaderLine(line) {
  const idx = line.indexOf(':');
  if (idx < 1) return null;
  const k = line.slice(0, idx).trim();
  const v = line.slice(idx + 1).trim();
  return k && v ? [k, v] : null;
}

function connectTunnel(proxy, host, port) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: `${host}:${port}`,
      headers: { host: `${host}:${port}` },
    });
    req.once('connect', (res, socket) => {
      if (res.statusCode === 200) resolve(socket);
      else { socket.destroy(); reject(new Error(`代理 CONNECT 失败: HTTP ${res.statusCode}`)); }
    });
    req.once('error', reject);
    req.end();
  });
}

function rawRequest(urlStr, { method = 'GET', headers = {}, proxy } = {}) {
  let u;
  try { u = new URL(urlStr); } catch { return Promise.reject(new Error(`无效 URL: ${urlStr}`)); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return Promise.reject(new Error(`不支持的协议: ${u.protocol}`));
  }
  return new Promise((resolve, reject) => {
    const isHttps = u.protocol === 'https:';
    const port = Number(u.port) || (isHttps ? 443 : 80);
    const reqOpts = { method, headers: { ...headers, host: u.host }, agent: false };
    const wire = r => { r.once('response', resolve); r.once('error', reject); r.end(); };

    if (isHttps) {
      const base = { ...reqOpts, host: u.hostname, port, path: u.pathname + u.search };
      if (proxy) {
        connectTunnel(proxy, u.hostname, port).then(socket => {
          wire(https.request({ ...base, createConnection: () => tls.connect({ socket, servername: u.hostname }) }));
        }, reject);
      } else {
        wire(https.request(base));
      }
    } else {
      const opts = proxy
        ? { ...reqOpts, host: proxy.host, port: proxy.port, path: urlStr }
        : { ...reqOpts, host: u.hostname, port, path: u.pathname + u.search };
      wire(http.request(opts));
    }
  });
}

async function request(urlStr, init = {}) {
  let current = urlStr;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const res = await rawRequest(current, init);
    if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
      const loc = res.headers.location;
      res.destroy();
      if (!loc) throw new Error(`HTTP ${res.statusCode} 重定向缺少 Location`);
      current = new URL(loc, current).href;
      continue;
    }
    res.finalUrl = current;
    return res;
  }
  throw new Error(`重定向超过 ${MAX_REDIRECTS} 次`);
}

async function probe(url, headers, proxy) {
  let res = await request(url, { headers: { ...headers, range: 'bytes=0-0' }, proxy });
  if (res.statusCode === 416) {
    res.destroy();
    res = await request(url, { headers, proxy });
  }
  const { statusCode, headers: h } = res;
  const finalUrl = res.finalUrl;
  const filename = parseContentDisposition(h['content-disposition']);
  const etag = h.etag || null;
  const lastModified = h['last-modified'] || null;
  res.destroy();

  if (statusCode === 206) {
    const total = String(h['content-range'] || '').split('/')[1];
    const size = total && total !== '*' ? Number(total) : null;
    if (Number.isFinite(size) && size > 0) {
      return { supportsRanges: true, size, finalUrl, filename, etag, lastModified };
    }
  } else if (statusCode === 200) {
    const size = h['content-length'] ? Number(h['content-length']) : null;
    return { supportsRanges: false, size, finalUrl, filename, etag, lastModified };
  } else {
    throw new Error(`探测失败: HTTP ${statusCode}`);
  }
  // 206 但拿不到总大小 → 当作不支持分段
  return { supportsRanges: false, size: null, finalUrl, filename, etag, lastModified };
}

/* ---------- 工具 ---------- */

function parseContentDisposition(cd) {
  if (!cd) return null;
  let m = /filename\*=(?:UTF-8|utf-8)''([^;]+)/.exec(cd);
  if (m) { try { return decodeURIComponent(m[1].trim().replace(/^"|"$/g, '')); } catch { /* 忽略编码错误 */ } }
  m = /filename\s*=\s*"?([^";]+)"?/.exec(cd);
  return m ? m[1].trim() : null;
}

function sanitizeName(name) {
  const cleaned = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim();
  return cleaned || 'download.bin';
}

function urlFilename(u) {
  try {
    const last = new URL(u).pathname.split('/').filter(Boolean).pop() || '';
    return decodeURIComponent(last);
  } catch { return ''; }
}

export function fmtBytes(n) {
  if (n == null || !Number.isFinite(n)) return '?';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${i === 0 || v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

export const fmtSpeed = n => `${fmtBytes(n)}/s`;

export function fmtEta(sec) {
  if (!Number.isFinite(sec)) return '--:--';
  sec = Math.ceil(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const p = x => String(x).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
}

export function bar(ratio, width = 22) {
  const f = Math.round(Math.min(1, Math.max(0, ratio)) * width);
  return '█'.repeat(f) + '░'.repeat(width - f);
}

function splitParts(size, n) {
  const per = Math.ceil(size / n);
  const parts = [];
  for (let s = 0; s < size; s += per) {
    parts.push({ start: s, end: Math.min(s + per, size) - 1, received: 0 });
  }
  return parts;
}

const readJson = async p => JSON.parse(await fsp.readFile(p, 'utf8'));

function resolveOut(out, info, fallbackUrl) {
  const autoName = sanitizeName(info.filename || urlFilename(info.finalUrl || fallbackUrl) || 'download.bin');
  if (!out) return autoName;
  if (/[\\/]$/.test(out) || (fs.existsSync(out) && fs.statSync(out).isDirectory())) {
    return path.join(out, autoName);
  }
  return out;
}

class Meter {
  constructor(total, initial = 0) {
    this.total = total;
    this.done = initial;
    this.initial = initial;
    this.samples = [];
    this.t0 = Date.now();
  }
  add(n) {
    const now = Date.now();
    this.done += n;
    this.samples.push([now, n]);
    while (this.samples.length && this.samples[0][0] < now - 3000) this.samples.shift();
  }
  speed() {
    const now = Date.now();
    if (this.samples.length < 2) {
      const elapsed = Math.max(0.3, (now - this.t0) / 1000);
      return this.done > this.initial ? (this.done - this.initial) / elapsed * 0.6 : 0;
    }
    const bytes = this.samples.reduce((s, [, n]) => s + n, 0);
    const span = (now - this.samples[0][0]) / 1000;
    return span > 0.2 ? bytes / span : 0;
  }
}

/* ---------- 任务 ---------- */

let seq = 0;
const ACTIVE_STATUSES = ['queued', 'probing', 'downloading'];

export class DownloadJob extends EventEmitter {
  constructor({ url, out = null, threads = 8, headers = [], proxy = null }) {
    super();
    if (!/^https?:\/\//i.test(url || '')) throw new Error(`无效 URL: ${url}`);
    this.id = `j${Date.now().toString(36)}${(++seq).toString(36)}`;
    this.opts = {
      url,
      out: out || null,
      threads: Math.min(32, Math.max(1, Math.round(Number(threads) || 8))),
      headers: (headers || []).filter(Boolean),
      proxy: proxy || null,
    };
    this.status = 'queued';
    this.error = null;
    this.info = null;
    this.outFile = null;
    this.partCount = null;
    this.meter = null;
    this._finishedAt = 0;
    this.createdAt = Date.now();
    this._paused = false;
    this._activeRes = new Set();
    this._running = false;
    this._settled = null;
    this._lastNotify = 0;
  }

  get paused() { return this._paused; }

  snapshot() {
    return {
      id: this.id,
      url: this.opts.url,
      status: this.status,
      error: this.error,
      outFile: this.outFile,
      name: this.outFile ? path.basename(this.outFile)
        : (this.info?.filename || urlFilename(this.info?.finalUrl || this.opts.url) || this.opts.url),
      total: this.meter ? this.meter.total : (this.info?.size ?? null),
      done: this.meter ? this.meter.done : 0,
      speed: this.meter ? this.meter.speed() : 0,
      elapsedMs: this.meter
        ? (this._finishedAt || Date.now()) - this.meter.t0
        : 0,
      supportsRanges: this.info ? this.info.supportsRanges : null,
      partCount: this.partCount,
      createdAt: this.createdAt,
    };
  }

  notify(force = false) {
    const now = Date.now();
    if (!force && now - this._lastNotify < NOTIFY_INTERVAL_MS) return;
    this._lastNotify = now;
    this.emit('update', this.snapshot());
  }

  pause() {
    if (!ACTIVE_STATUSES.includes(this.status)) return;
    this._paused = true;
    for (const res of this._activeRes) { try { res.destroy(); } catch { /* 忽略 */ } }
  }

  run() {
    if (!this._running) {
      this._running = true;
      this._settled = this._run();
    }
    return this._settled;
  }

  _baseHeaders() {
    return {
      'user-agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) mdown/${VERSION}`,
      accept: '*/*',
      'accept-encoding': 'identity',
      ...Object.fromEntries(this.opts.headers),
    };
  }

  async _run() {
    try {
      this.status = 'probing';
      this.notify(true);
      const info = await probe(this.opts.url, this._baseHeaders(), this.opts.proxy);
      this.info = info;
      this.outFile = resolveOut(this.opts.out, info, this.opts.url);
      await fsp.mkdir(path.dirname(path.resolve(this.outFile)), { recursive: true });
      if (info.supportsRanges) await this._runMulti();
      else await this._runSingle();
    } catch (err) {
      if (this._paused || err instanceof PauseSignal) this.status = 'paused';
      else {
        this.status = 'failed';
        this.error = err.message;
      }
    }
    if (this.status !== 'downloading' && !this._finishedAt) this._finishedAt = Date.now();
    this.notify(true);
  }

  async _runMulti() {
    const { size } = this.info;
    const partPath = this.outFile + PART_SUFFIX;
    const metaPath = this.outFile + META_SUFFIX;

    let parts = null;
    let resumed = false;
    const meta = await readJson(metaPath).catch(() => null);
    const st = await fsp.stat(partPath).catch(() => null);
    if (meta && st && meta.url === this.info.finalUrl && meta.size === size && st.size === size
        && Array.isArray(meta.parts)
        && (!meta.etag || !this.info.etag || meta.etag === this.info.etag)) {
      parts = meta.parts;
      resumed = true;
    }
    if (!parts) {
      const threads = Math.min(this.opts.threads, Math.max(1, Math.floor(size / MIN_PART_SIZE)));
      parts = splitParts(size, Math.max(1, threads));
    }
    this.partCount = parts.length;
    if (this._paused) throw new PauseSignal();

    const fd = resumed ? await fsp.open(partPath, 'r+') : await fsp.open(partPath, 'w');
    if (!resumed) await fd.truncate(size);

    this.meter = new Meter(size, resumed ? parts.reduce((s, p) => s + p.received, 0) : 0);
    this.status = 'downloading';
    this.notify(true);

    const saveMeta = () => fsp.writeFile(metaPath, JSON.stringify({
      url: this.info.finalUrl,
      size,
      etag: this.info.etag,
      lastModified: this.info.lastModified,
      parts: parts.map(p => ({ start: p.start, end: p.end, received: p.received })),
    }));
    let lastSaved = this.meter.done;
    const saver = setInterval(() => {
      const d = parts.reduce((s, p) => s + p.received, 0);
      if (d !== lastSaved) { lastSaved = d; saveMeta().catch(() => {}); }
    }, 2000);
    saver.unref?.();

    let fdClosed = false;
    const closeFd = async () => {
      if (fdClosed) return;
      fdClosed = true;
      try { await fd.close(); } catch { /* 忽略 */ }
    };

    let firstErr = null;
    try {
      await Promise.all(parts.map(async p => {
        try { await this._fetchPart(p, fd); } catch (e) { if (!firstErr) firstErr = e; }
      }));
      if (firstErr) throw firstErr;
      if (this._paused) throw new PauseSignal();
      await fd.sync();
      await closeFd();
      await fsp.unlink(metaPath).catch(() => {});
      await fsp.rename(partPath, this.outFile);
      this.status = 'completed';
    } catch (err) {
      if (this._paused || err instanceof PauseSignal) {
        try { await saveMeta(); } catch { /* 尽力保存 */ }
        this.status = 'paused';
      } else {
        try { await saveMeta(); } catch { /* 尽力保存 */ }
        this.status = 'failed';
        this.error = err.message;
      }
    }
    clearInterval(saver);
    await closeFd();
  }

  async _fetchPart(p, fd) {
    for (let attempt = 1; ; attempt++) {
      if (this._paused) throw new PauseSignal();
      const from = p.start + p.received;
      if (from > p.end) return;
      let res;
      try {
        res = await request(this.info.finalUrl, {
          headers: { ...this._baseHeaders(), range: `bytes=${from}-${p.end}` },
          proxy: this.opts.proxy,
        });
        this._activeRes.add(res);
        res.once('close', () => this._activeRes.delete(res));
        if (res.statusCode !== 206) {
          res.destroy();
          throw new Error(`HTTP ${res.statusCode}（分段下载需要 206）`);
        }
        let pos = from;
        let idle = null;
        const touch = () => {
          clearTimeout(idle);
          idle = setTimeout(() => res.destroy(), IDLE_TIMEOUT_MS);
        };
        try {
          touch();
          for await (const chunk of res) {
            touch();
            const room = p.end + 1 - pos;
            const buf = chunk.length > room ? chunk.subarray(0, room) : chunk;
            await fd.write(buf, 0, buf.length, pos);
            pos += buf.length;
            p.received = pos - p.start;
            this.meter.add(buf.length);
            this.notify();
            if (buf.length < chunk.length) { res.destroy(); break; }
          }
        } finally {
          clearTimeout(idle);
        }
        if (pos !== p.end + 1) throw new Error(`连接提前断开（还差 ${p.end + 1 - pos} 字节）`);
        return;
      } catch (err) {
        if (this._paused || err instanceof PauseSignal) throw new PauseSignal();
        if (attempt >= MAX_RETRY) throw new Error(`分片 ${p.start}-${p.end} 连续 ${MAX_RETRY} 次失败: ${err.message}`);
        await sleep(Math.min(500 * attempt, 4000));
      }
    }
  }

  async _runSingle() {
    if (this._paused) throw new PauseSignal();
    const partPath = this.outFile + PART_SUFFIX;
    const fd = await fsp.open(partPath, 'w');
    let fdClosed = false;
    const closeFd = async () => {
      if (fdClosed) return;
      fdClosed = true;
      try { await fd.close(); } catch { /* 忽略 */ }
    };
    this.meter = new Meter(this.info.size);
    this.status = 'downloading';
    this.notify(true);
    try {
      const res = await request(this.info.finalUrl || this.opts.url, { headers: this._baseHeaders(), proxy: this.opts.proxy });
      this._activeRes.add(res);
      res.once('close', () => this._activeRes.delete(res));
      if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode}`);
      let pos = 0;
      for await (const chunk of res) {
        if (this._paused) { res.destroy(); throw new PauseSignal(); }
        await fd.write(chunk, 0, chunk.length, pos);
        pos += chunk.length;
        this.meter.add(chunk.length);
        this.notify();
      }
      if (this.info.size != null && pos !== this.info.size) throw new Error(`传输不完整（${pos}/${this.info.size}）`);
      await fd.sync();
      await closeFd();
      await fsp.rename(partPath, this.outFile);
      this.status = 'completed';
    } catch (err) {
      await closeFd();
      if (this._paused || err instanceof PauseSignal) {
        this.status = 'paused'; // 保留 .mdown 残片，但单线程无续传，继续时重新下载
      } else {
        await fsp.unlink(partPath).catch(() => {});
        this.status = 'failed';
        this.error = err.message;
      }
    }
    await closeFd();
  }
}
