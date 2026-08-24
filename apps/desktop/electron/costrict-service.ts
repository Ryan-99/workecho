/**
 * CoStrict 一键接入服务。
 *
 * 托管 github.com/mokeyjay/costrict-router 二进制：
 * 1. 首次使用自动从 GitHub Releases 下载（Windows zip / mac,linux tar.gz）
 * 2. login --base-url <CoStrict 地址>：提取登录链接（深信服 OIDC）→ 系统浏览器完成 SSO
 * 3. start：后台守护进程，本地 OpenAI 兼容服务（默认 127.0.0.1:14567/v1）
 *    首次启动会生成 sk-costrict-* 本地 API Key（只显示一次）——必须当场捕获并持久化
 * 4. 用 key 探测 /v1/models，注册为 pi 自定义 Provider（openai-completions）
 *
 * 本模块不依赖 electron（spawn/fetch/下载目录均可注入），便于离线测试。
 * IPC/UI 接线见 main.ts / preload.ts / SettingsView.tsx。
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync, renameSync } from "node:fs";
import path from "node:path";

export const PROVIDER_ID = "costrict";
/** 默认 CoStrict 服务地址：登录弹窗预填，用户直接确认即用 */
export const DEFAULT_BASE_URL = "https://zgsm.sangfor.com";
export const LOCAL_BASE_URL = "http://127.0.0.1:14567/v1";
const STATE_FILE = "state.json";
const GITHUB_REPO = "mokeyjay/costrict-router";

/**
 * 官方固定的发行包 sha256（"tag/资产名" -> sha256）。
 * 新版本发布后在此追加即可强制 pin；未列出的版本走 TOFU（首次记录、防事后替换）。
 * 查询：下载资产后 sha256sum，或 GitHub Release 页官方 checksums。
 */
const PINNED_SHA256: Record<string, string> = {
  // 下载资产 pin：新版本发布后在此追加即可强制校验；
  // 未列出的版本走 TOFU（首次记录、防事后替换）。
};

/**
 * S-09/C-10：随包分发二进制（resources/costrict/windows-x64/）的实测 sha256。
 * installBundledBinary 在复制前校验——打包内容被篡改/损坏时拒绝安装并走下载兜底，
 * 不再是纯 TOFU。升级二进制时同步更新此值。
 */
const BUNDLED_BINARY_SHA256: Record<string, string> = {
  "windows-x64": "16e92a0af86b30592248fe648ea286d92866a62f4133ac9cd8db5c72064f43a2",
};

/** 托管目录里的二进制文件名（跨平台） */
export function binaryName(): string {
  return process.platform === "win32" ? "costrict-router.exe" : "costrict-router";
}

/** 托管目录（dir 由调用方传入：应用传 userData/costrict，测试传临时目录） */
export function managedBinaryPath(dir: string): string {
  return path.join(dir, binaryName());
}

/** 内置资源目录的平台键（resources/costrict/<key>/costrict-router[.exe]） */
export function bundledPlatformKey(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string | null {
  const osMap: Partial<Record<NodeJS.Platform, string>> = {
    win32: "windows", darwin: "macos", linux: "linux",
  };
  const archMap: Record<string, string> = { x64: "x64", arm64: "arm64" };
  const osKey = osMap[platform];
  if (!osKey || !archMap[arch]) return null;
  return `${osKey}-${arch}`;
}

/**
 * 从应用内置资源安装二进制（resources/costrict/<platform>/）。
 * 主路径：随应用打包，零网络依赖；下载仅作未内置平台的兜底。
 */
export function installBundledBinary(opts: { resourcesDir: string; dir: string }): boolean {
  const key = bundledPlatformKey();
  if (!key) return false;
  const bundled = path.join(opts.resourcesDir, "costrict", key, binaryName());
  if (!existsSync(bundled)) return false;
  // S-09：复制前校验随包二进制哈希（已知 pin 的平台）；不匹配/读不出 →
  // 拒绝安装并返回 false 走 GitHub 下载兜底，不静默安装可疑内容
  const expectedSha = BUNDLED_BINARY_SHA256[key];
  if (expectedSha) {
    try {
      const actual = createHash("sha256").update(readFileSync(bundled)).digest("hex");
      if (actual !== expectedSha) {
        console.error(`[costrict] 随包二进制哈希不匹配（${key}），跳过内置安装走下载兜底`);
        return false;
      }
    } catch (error) {
      console.error("[costrict] 随包二进制读取失败，走下载兜底:", (error as Error).message);
      return false;
    }
  }
  const target = managedBinaryPath(opts.dir);
  if (existsSync(target)) return true; // 已安装
  mkdirSync(opts.dir, { recursive: true });
  copyFileSync(bundled, target);
  return true;
}

/* ============ 纯函数：输出解析 / 资产选择 ============ */

/**
 * CoStrict 相关地址的可信主机：深信服域或本机（测试）。
 * 登录 URL / base-url 只信任这些，防止子进程输出被诱导成钓鱼链接（安全审核 CS-6）。
 */
export function isAllowedCostrictUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    const h = u.hostname.toLowerCase();
    return h === "localhost" || h === "127.0.0.1" || h.endsWith(".sangfor.com") || h === "sangfor.com";
  } catch {
    return false;
  }
}

/** 从 login 输出提取登录链接（排除本地服务地址，且只信任深信服域） */
export function extractLoginUrl(text: string): string | null {
  const matches = text.match(/https?:\/\/[^\s'"]+/g) ?? [];
  return matches.find((u) => isAllowedCostrictUrl(u) && !/127\.0\.0\.1|localhost/.test(u)) ?? null;
}

/** 捕获一次性显示的本地 API Key（配置文件里只存 hash，丢了只能 key reset） */
export function extractApiKey(text: string): string | null {
  return text.match(/sk-costrict-[A-Za-z0-9_-]+/)?.[0] ?? null;
}

/** 按平台选择 GitHub Release 资产 */
export function pickReleaseAsset(
  assets: Array<{ name: string; browser_download_url?: string }>,
  platform: NodeJS.Platform,
  arch: string,
): { name: string; browser_download_url?: string } | null {
  const osMap: Partial<Record<NodeJS.Platform, string>> = {
    win32: "windows", darwin: "macos", linux: "linux",
  };
  const archMap: Record<string, string> = { x64: "amd64", arm64: "arm64" };
  const osKey = osMap[platform];
  const archKey = archMap[arch];
  if (!osKey || !archKey) return null;
  const suffix = osKey === "windows" ? ".zip" : ".tar.gz";
  return assets.find((a) => a.name.endsWith(`_${osKey}_${archKey}${suffix}`)) ?? null;
}

/** /v1/models 响应 → 自定义 Provider 模型列表 */
export function parseModelsResponse(json: unknown): Array<{ id: string; contextWindow: number }> {
  const data = (json as { data?: Array<{ id: string; context_length?: number }> })?.data ?? [];
  return data
    .filter((m) => typeof m?.id === "string" && m.id.length > 0)
    .map((m) => ({ id: m.id, contextWindow: m.context_length ?? 128000 }));
}

/* ============ state.json 持久化 ============ */

export interface CostrictState {
  apiKey?: string;
  upstreamBaseUrl?: string;
  binaryVersion?: string;
  /** 已验证过的下载摘要（TOFU）：tag/asset -> sha256，同版本内容变更即拒绝 */
  verifiedDownloads?: Record<string, string>;
}

/**
 * 密钥编解码器：main 启动时注入 Electron safeStorage（安全审核 CS-3：
 * apiKey 不再明文落盘）。不注入（单测/无 Electron）时保持明文行为。
 */
export interface SecretCodec {
  encode(plain: string): string;
  decode(encoded: string): string;
}

let secretCodec: SecretCodec | null = null;

/** main 启动时注入；传 null 清除（单测 afterEach） */
export function setSecretCodec(codec: SecretCodec | null): void {
  secretCodec = codec;
}

/** 磁盘形态：apiKey 加密后存 apiKeyEnc；旧版明文 apiKey 仅作读取兼容 */
interface CostrictStateOnDisk extends CostrictState {
  apiKeyEnc?: string;
}

export function readState(dir: string): CostrictState {
  const stateFile = path.join(dir, STATE_FILE);
  let raw: CostrictStateOnDisk;
  try {
    raw = JSON.parse(readFileSync(stateFile, "utf-8"));
  } catch (error) {
    // B-11：state.json 损坏（非缺失）时先把残骸改名保留再返回 {}——
    // 否则下一次 writeState 会把 apiKey/TOFU 一并抹掉且无从恢复
    if (existsSync(stateFile)) {
      const corruptBak = `${stateFile}.corrupt-${Date.now().toString(36)}.bak`;
      try {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          copyFileSync(stateFile, corruptBak);
          console.error(`[costrict] state.json 损坏，已备份到 ${corruptBak}（一次性 key 若在其中需 key reset 重新登录）`);
        }
      } catch { /* 备份失败不阻断 */ }
    }
    return {};
  }
  const state: CostrictState = { ...raw };
  delete (state as CostrictStateOnDisk).apiKeyEnc;
  if (typeof raw.apiKeyEnc === "string" && secretCodec) {
    try {
      state.apiKey = secretCodec.decode(raw.apiKeyEnc);
    } catch {
      state.apiKey = undefined; // 解密失败（系统凭据变更等）→ 视为无 key，重新登录
    }
  }
  // 旧明文 apiKey 原样返回；下一次 writeState 会自动迁移为加密形态
  return state;
}

export function writeState(dir: string, patch: CostrictState): CostrictState {
  const next = { ...readState(dir), ...patch };
  mkdirSync(dir, { recursive: true });
  const disk: CostrictStateOnDisk = { ...next };
  if (typeof next.apiKey === "string" && secretCodec) {
    try {
      disk.apiKeyEnc = secretCodec.encode(next.apiKey);
      delete disk.apiKey;
    } catch {
      // 加密失败 → 保留明文字段（功能可用性优先，仅退化到旧行为）
      console.warn("[costrict] safeStorage 加密失败，apiKey 将以明文落盘（功能优先降级）");
    }
  }
  if (next.apiKey === undefined) delete disk.apiKey;
  // B-11：tmp+rename 原子替换——writeFileSync 中途崩溃/AV 干扰产生半截 JSON 后，
  // readState 会把它当损坏清空，一次性 apiKey 与下载 TOFU 记录随之丢失
  const target = path.join(dir, STATE_FILE);
  const tmp = `${target}.${process.pid}.${Date.now().toString(36)}.tmp`;
  writeFileSync(tmp, JSON.stringify(disk, null, 2), "utf-8");
  try {
    renameSync(tmp, target);
  } catch {
    // Windows 占用退路：移走目标再换名（同 atomic-file-write 策略）
    try {
      if (existsSync(target)) rmSync(target, { force: true });
      renameSync(tmp, target);
    } catch (fallbackError) {
      try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
      throw fallbackError;
    }
  }
  return next;
}

/* ============ 子进程编排（spawnImpl 可注入） ============ */

type FakeChild = {
  stdout: { on: (ev: string, cb: (d: string) => void) => void };
  stderr: { on: (ev: string, cb: (d: string) => void) => void };
  on: (ev: string, cb: (code: number) => void) => void;
  kill?: () => void;
};
type SpawnImpl = (cmd: string, args: string[]) => FakeChild;

function defaultSpawn(cmd: string, args: string[]): FakeChild {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const child = spawn(cmd, args, { windowsHide: true }) as unknown as FakeChild;
  return child;
}

function runUntilExit(child: FakeChild, collect: (chunk: string) => void): Promise<number> {
  return new Promise((resolve) => {
    child.stdout?.on("data", (d) => collect(String(d)));
    child.stderr?.on("data", (d) => collect(String(d)));
    child.on("close", (code) => resolve(code ?? 0));
  });
}

export interface LoginOptions {
  binPath: string;
  baseUrl: string;
  onLoginUrl?: (url: string) => void;
  spawnImpl?: SpawnImpl;
  timeoutMs?: number;
}

/** 登录 CoStrict：提取登录链接回调给 UI（打开浏览器），等待 SSO 完成 */
export async function costrictLogin(opts: LoginOptions): Promise<{ ok: boolean; output: string; url: string | null }> {
  if (!isAllowedCostrictUrl(opts.baseUrl)) {
    throw new Error(`不允许的 CoStrict 服务地址: ${opts.baseUrl}（仅信任 *.sangfor.com）`);
  }
  const spawnImpl = opts.spawnImpl ?? defaultSpawn;
  let output = "";
  let url: string | null = null;
  const child = spawnImpl(opts.binPath, ["login", "--base-url", opts.baseUrl]);
  const exit = runUntilExit(child, (chunk) => {
    output += chunk;
    if (!url) {
      const found = extractLoginUrl(output);
      if (found) {
        url = found;
        try { opts.onLoginUrl?.(found); } catch { /* 回调失败不中断登录 */ }
      }
    }
  });
  // 超时定时器必须在 race 结束后清理，否则句柄会挂住进程
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error("登录超时（默认 5 分钟）")), opts.timeoutMs ?? 5 * 60_000);
  });
  let code: number;
  try {
    code = await Promise.race([exit, timeout]);
  } catch (e) {
    // 超时：杀掉仍在轮询的 login 子进程，避免孤儿进程
    try { child.kill?.(); } catch { /* 进程可能已退出 */ }
    clearTimeout(timer);
    throw e;
  }
  clearTimeout(timer);
  return { ok: code === 0, output, url };
}

export interface StartOptions {
  dir: string;
  binPath: string;
  spawnImpl?: SpawnImpl;
  fetchImpl?: typeof fetch;
}

/** 启动本地代理守护进程：捕获一次性 key 并持久化，健康检查确认就绪 */
export async function costrictStart(opts: StartOptions): Promise<{ apiKey: string | null; healthy: boolean }> {
  const spawnImpl = opts.spawnImpl ?? defaultSpawn;
  let output = "";
  const child = spawnImpl(opts.binPath, ["start"]);
  await runUntilExit(child, (chunk) => { output += chunk; });
  const apiKey = extractApiKey(output);
  if (apiKey) writeState(opts.dir, { apiKey });
  // start 是守护化命令，父进程退出后服务需要一小段时间就绪
  const healthy = await waitHealthy({ fetchImpl: opts.fetchImpl, timeoutMs: 15000 });
  return { apiKey, healthy };
}

export async function costrictStop(binPath: string, spawnImpl: SpawnImpl = defaultSpawn): Promise<void> {
  const child = spawnImpl(binPath, ["stop"]);
  await runUntilExit(child, () => {});
}

/* ============ 状态与健康检查 ============ */

export interface CostrictStatus {
  binaryPresent: boolean;
  serviceRunning: boolean;
  apiKeySaved: boolean;
  localBaseUrl: string;
}

export async function costrictStatus(opts: { dir: string; binPath?: string; fetchImpl?: typeof fetch }): Promise<CostrictStatus> {
  const binPath = opts.binPath ?? managedBinaryPath(opts.dir);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const serviceRunning = await (async () => {
    try {
      const r = await fetchImpl("http://127.0.0.1:14567/healthz");
      return r.ok;
    } catch { return false; }
  })();
  return {
    binaryPresent: existsSync(binPath),
    serviceRunning,
    apiKeySaved: Boolean(readState(opts.dir).apiKey),
    localBaseUrl: LOCAL_BASE_URL,
  };
}

export async function waitHealthy(opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}): Promise<boolean> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const deadline = Date.now() + (opts.timeoutMs ?? 10000);
  while (Date.now() < deadline) {
    try {
      const r = await fetchImpl("http://127.0.0.1:14567/healthz");
      if (r.ok) return true;
    } catch { /* 未就绪 */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/** 探测 /v1/models（用捕获的本地 key） */
export async function fetchCostrictModels(opts: { apiKey: string; baseUrl?: string; fetchImpl?: typeof fetch }): Promise<Array<{ id: string; contextWindow: number }>> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const r = await fetchImpl(`${opts.baseUrl ?? LOCAL_BASE_URL}/models`, {
    headers: { Authorization: `Bearer ${opts.apiKey}` },
  });
  if (!r.ok) throw new Error(`获取模型列表失败: HTTP ${r.status}`);
  return parseModelsResponse(await r.json());
}

/** 下载二进制：查 GitHub 最新 Release → 选资产 → 下载解压到托管目录 */
export async function downloadBinary(opts: {
  dir: string;
  fetchImpl?: typeof fetch;
  extractImpl?: (archivePath: string, dir: string) => Promise<string>;
  log?: (msg: string) => void;
}): Promise<{ ok: boolean; path: string; error?: string }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const log = opts.log ?? (() => {});
  const binPath = managedBinaryPath(opts.dir);
  try {
    log("查询最新版本...");
    const relRes = await fetchImpl(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
      headers: { "User-Agent": "workecho" },
    });
    if (!relRes.ok) throw new Error(`查询 Release 失败: HTTP ${relRes.status}`);
    const rel = (await relRes.json()) as { tag_name: string; assets: Array<{ name: string; browser_download_url: string }> };
    const asset = pickReleaseAsset(rel.assets, process.platform, process.arch);
    if (!asset?.browser_download_url) throw new Error(`没有适配当前平台的发行包 (${process.platform}/${process.arch})`);
    // 资产名来自 GitHub API 响应，压成纯文件名并做字符白名单，防路径注入（安全审核 CS-2）
    const safeAssetName = path.basename(asset.name);
    if (!/^[A-Za-z0-9._-]+$/.test(safeAssetName)) {
      throw new Error(`异常的发行包文件名: ${asset.name}`);
    }
    log(`下载 ${safeAssetName}...`);
    const dlRes = await fetchImpl(asset.browser_download_url, { headers: { "User-Agent": "workecho" } });
    if (!dlRes.ok) throw new Error(`下载失败: HTTP ${dlRes.status}`);
    mkdirSync(opts.dir, { recursive: true });
    const buf = Buffer.from(await dlRes.arrayBuffer());
    // 供应链校验（安全审核 CS-1）：下载即执行的二进制必须校验 sha256。
    // 1) 有官方 pin 用 pin；2) 无 pin 时 TOFU——同版本资产首次记录摘要，之后内容变更即拒绝
    const digest = createHash("sha256").update(buf).digest("hex");
    const digestKey = `${rel.tag_name}/${safeAssetName}`;
    const pinned = PINNED_SHA256[digestKey];
    const state = readState(opts.dir);
    const known = state.verifiedDownloads?.[digestKey];
    const expected = pinned ?? known;
    if (expected && expected !== digest) {
      throw new Error(
        `下载内容校验失败：${digestKey} sha256 ${digest.slice(0, 12)}… 与已记录 ${expected.slice(0, 12)}… 不一致，` +
        "疑似发布资产被替换，已拒绝安装（如确认为官方更新，删除 costrict/state.json 后重试）",
      );
    }
    if (!expected) {
      log(`首次下载 ${digestKey}，记录 sha256=${digest}`);
    }
    writeState(opts.dir, { verifiedDownloads: { ...state.verifiedDownloads, [digestKey]: digest } });
    const archivePath = path.join(opts.dir, safeAssetName);
    writeFileSync(archivePath, buf);
    // 解压：Windows 用系统自带 bsdtar（Win10+ 支持 zip），类 Unix 用 tar
    const extract = opts.extractImpl ?? defaultExtract;
    const extracted = await extract(archivePath, opts.dir);
    const finalPath = extracted || binPath;
    log("解压完成");
    return { ok: true, path: finalPath };
  } catch (e) {
    return { ok: false, path: binPath, error: (e as Error).message };
  }
}

/** 系统 tar 的绝对路径：避免 PATH 劫持（Windows 用系统自带 bsdtar，Win10+ 支持 zip） */
function systemTarPath(): string {
  if (process.platform === "win32") {
    return path.join(process.env.SystemRoot ?? "C:\Windows", "System32", "tar.exe");
  }
  return "tar"; // macOS/Linux 系统 tar 在标准路径，PATH 相对可信
}

async function defaultExtract(archivePath: string, dir: string): Promise<string> {
  const isZip = archivePath.endsWith(".zip");
  const tarArgs = isZip ? ["-xf", archivePath, "-C", dir] : ["-xzf", archivePath, "-C", dir];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(systemTarPath(), tarArgs, { windowsHide: true });
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`解压失败 (tar exit ${code}))`))));
    child.on("error", reject);
  });
  return managedBinaryPath(dir);
}
