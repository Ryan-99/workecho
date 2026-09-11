import { app, net, Notification, shell } from "electron";
import { workechoNotificationIcon } from "./brand-notification";

const RELEASES_URL =
  "https://api.github.com/repos/Ryan-99/workecho/releases?per_page=1";
const RELEASES_PAGE = "https://github.com/Ryan-99/workecho/releases";
// api.github.com 匿名限额按出口 IP 共享，代理场景极易 403/429。
// 命中限流时回退到 releases/latest 的 302 重定向解析真实版本号。
const RELEASES_LATEST_URL = "https://github.com/Ryan-99/workecho/releases/latest";
const RELEASES_ATOM_URL = "https://github.com/Ryan-99/workecho/releases.atom";

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
const INITIAL_DELAY_MS = 15_000; // 15 seconds after launch
const FETCH_TIMEOUT_MS = 10_000; // give up on a hung request

export type UpdateCheckResult =
  | { status: "up-to-date"; currentVersion: string; latestVersion: string }
  | {
      status: "update-available";
      currentVersion: string;
      latestVersion: string;
      releaseUrl: string;
    }
  | { status: "error"; message: string };

export type GitHubRelease = {
  tag_name?: string;
  html_url?: string;
};

export function openReleasesPage(releaseUrl = RELEASES_PAGE): Promise<void> {
  // S-02：url 可能来自渲染层/上游回调，openExternal 直通任意协议
  // （file:/自定义协议）是高危原语——只放行 http(s)
  const parsed = (() => {
    try {
      return new URL(releaseUrl);
    } catch {
      return null;
    }
  })();
  if (!parsed || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) {
    console.warn(`[update-checker] 拒绝打开非 http(s) 链接: ${releaseUrl}`);
    return Promise.resolve();
  }
  return shell.openExternal(parsed.toString());
}

export function showUpdateNotification(
  currentVersion: string,
  latestVersion: string,
  releaseUrl: string,
): void {
  if (!Notification.isSupported()) {
    return;
  }
  const notification = new Notification({
    ...(workechoNotificationIcon() ? { icon: workechoNotificationIcon()! } : {}),
    title: "Workecho 有新版本",
    body: `新版本 ${latestVersion} 可用（当前 ${currentVersion}），点击查看。`,
  });
  notification.on("click", () => {
    void openReleasesPage(releaseUrl);
  });
  notification.show();
}

/**
 * releases.atom 走 github.com 网页域（不受 api.github.com 匿名限流影响），
 * 且包含 prerelease——beta 仓没有正式 release，releases/latest 解析不到 tag，
 * 只有 feed 能给出真实最新版本。取第一条 entry 的 /releases/tag/<tag>。
 */
async function resolveLatestViaAtom(): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await net.fetch(RELEASES_ATOM_URL, { signal: controller.signal });
      if (!res.ok) return null;
      const xml = await res.text();
      const match = xml.match(/<entry>[\s\S]*?<link[^>]+href="[^"]*\/releases\/tag\/(v?[0-9A-Za-z.+-]+)"/);
      return match?.[1] ?? null;
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return null;
  }
}

/**
 * releases/latest 对已发布版本 302 到 /releases/tag/<tag>。
 * 解析最终 URL 提取版本号，绕开 api.github.com 的匿名限流。
 */
async function resolveLatestViaRedirect(): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await net.fetch(RELEASES_LATEST_URL, { signal: controller.signal });
      const finalUrl = res.url || RELEASES_LATEST_URL;
      const match = finalUrl.match(/\/releases\/tag\/(v?[0-9A-Za-z.+-]+)\/?$/);
      return match?.[1] ?? null;
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return null;
  }
}

/**
 * Pure update check — performs the network request and version comparison but
 * never shows UI. Callers decide how to surface the result (auto path shows a
 * deduped notification, the manual menu path shows a dialog).
 */
export async function checkForUpdate(): Promise<UpdateCheckResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await net.fetch(RELEASES_URL, {
      headers: { Accept: "application/vnd.github.v3+json" },
      signal: controller.signal,
    });
  } catch (error) {
    const message =
      error instanceof Error && error.name === "AbortError"
        ? "The update check timed out."
        : error instanceof Error
          ? error.message
          : "The update check could not reach GitHub.";
    return { status: "error", message };
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    // 403/429 = 匿名 API 限流，改走 github.com 网页端兜底（无限流）：
    // 先解析 releases.atom（含 prerelease，beta 仓必需），再退 latest 重定向
    if (res.status === 403 || res.status === 429) {
      const fallbackTag = (await resolveLatestViaAtom()) ?? (await resolveLatestViaRedirect());
      if (fallbackTag) {
        return compareReleaseVersions(fallbackTag);
      }
    }
    return {
      status: "error",
      message: `GitHub Releases returned ${res.status}.`,
    };
  }

  let releases: GitHubRelease[];
  try {
    releases = (await res.json()) as GitHubRelease[];
  } catch {
    return { status: "error", message: "GitHub Releases returned an unreadable response." };
  }

  const release = releases[0];
  if (!release?.tag_name) {
    return {
      status: "error",
      message: "GitHub Releases did not return any published versions.",
    };
  }

  return compareReleaseVersions(release.tag_name, release.html_url);
}

/** 版本比较收敛为单一入口：API 路径与限流兜底路径共用同一套判定。 */
function compareReleaseVersions(rawTag: string, htmlUrl?: string): UpdateCheckResult {
  const latest = rawTag.replace(/^v/, "");
  const current = app.getVersion();

  // Only an actually newer published version counts as an update — a proper
  // semver compare avoids misfiring on prereleases or newer-local dev builds.
  if (compareSemver(latest, current) > 0) {
    return {
      status: "update-available",
      currentVersion: current,
      latestVersion: latest,
      releaseUrl: htmlUrl ?? `${RELEASES_PAGE}/tag/${rawTag}`,
    };
  }

  return {
    status: "up-to-date",
    currentVersion: current,
    latestVersion: latest,
  };
}

export function initUpdateChecker(): () => void {
  // Dedupe notifications per version so a still-unactioned update doesn't
  // re-notify on every 4-hour poll.
  let lastNotifiedVersion: string | undefined;
  const runAutoCheck = async () => {
    const result = await checkForUpdate();
    if (result.status === "error") {
      console.warn("Update check failed:", result.message);
      return;
    }
    if (result.status === "update-available" && result.latestVersion !== lastNotifiedVersion) {
      lastNotifiedVersion = result.latestVersion;
      showUpdateNotification(result.currentVersion, result.latestVersion, result.releaseUrl);
    }
  };

  const timeout = setTimeout(() => void runAutoCheck(), INITIAL_DELAY_MS);
  const interval = setInterval(() => void runAutoCheck(), CHECK_INTERVAL_MS);

  return () => {
    clearTimeout(timeout);
    clearInterval(interval);
  };
}

export function releaseUrlFor(release: GitHubRelease): string {
  const tag = release.tag_name;
  if (!tag) {
    return RELEASES_PAGE;
  }

  const canonicalUrl = `${RELEASES_PAGE}/tag/${encodeURIComponent(tag)}`;
  if (!release.html_url) {
    return canonicalUrl;
  }

  try {
    const candidate = new URL(release.html_url);
    const canonical = new URL(canonicalUrl);
    if (
      candidate.protocol === canonical.protocol &&
      candidate.host === canonical.host &&
      candidate.pathname === canonical.pathname &&
      candidate.username === "" &&
      candidate.password === "" &&
      candidate.search === "" &&
      candidate.hash === ""
    ) {
      return candidate.toString();
    }
  } catch {
    // Fall through to the repository's canonical URL for this exact tag.
  }
  return canonicalUrl;
}

/**
 * Compare two semver strings. Returns a negative number when `a < b`, zero when
 * equal, positive when `a > b`. Handles prerelease precedence per semver
 * (a release outranks its own prereleases); unparseable inputs compare equal so
 * we never claim an update we can't verify.
 */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) {
    return 0;
  }
  if (pa.nums[0] !== pb.nums[0]) {
    return pa.nums[0] < pb.nums[0] ? -1 : 1;
  }
  if (pa.nums[1] !== pb.nums[1]) {
    return pa.nums[1] < pb.nums[1] ? -1 : 1;
  }
  if (pa.nums[2] !== pb.nums[2]) {
    return pa.nums[2] < pb.nums[2] ? -1 : 1;
  }
  return comparePrerelease(pa.pre, pb.pre);
}

function parseSemver(version: string): { nums: [number, number, number]; pre: string[] } | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(version.trim());
  if (!match) {
    return undefined;
  }
  return {
    nums: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] ? match[4].split(".") : [],
  };
}

function comparePrerelease(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) {
    return 0;
  }
  // A version without a prerelease tag has higher precedence than one with it.
  if (a.length === 0) {
    return 1;
  }
  if (b.length === 0) {
    return -1;
  }
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const left = a[index] ?? "";
    const right = b[index] ?? "";
    const leftNumeric = /^\d+$/.test(left);
    const rightNumeric = /^\d+$/.test(right);
    if (leftNumeric && rightNumeric) {
      const delta = Number(left) - Number(right);
      if (delta !== 0) {
        return delta < 0 ? -1 : 1;
      }
    } else if (leftNumeric) {
      return -1; // numeric identifiers rank lower than alphanumeric
    } else if (rightNumeric) {
      return 1;
    } else if (left !== right) {
      return left < right ? -1 : 1;
    }
  }
  if (a.length === b.length) {
    return 0;
  }
  return a.length < b.length ? -1 : 1;
}
