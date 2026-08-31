import { expect, test } from "@playwright/test";
import {
  createSessionIpc,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";

test("REPRO: paste a clipboard image (screenshot path) into the composer", async () => {
  test.setTimeout(120_000);
  const userDataDir = await makeUserDataDir("paste-repro-");
  const workspacePath = await makeWorkspace("paste-repro-workspace");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    const workspace = await waitForWorkspaceByPath(window, workspacePath);
    await createSessionIpc(window, workspace.id, "Paste repro");
    const composer = window.locator(".chat-panel .composer textarea");
    await expect(composer).toBeVisible({ timeout: 20_000 });

    // 1x1 红色 PNG 写进系统剪贴板（等价于截图路径）
    await harness.electronApp.evaluate(({ clipboard, nativeImage }) => {
      const img = nativeImage.createFromDataURL(
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      );
      clipboard.writeImage(img);
    });

    // 采集渲染层证据：paste 事件是否到达 textarea、files/items 里有什么
    await window.evaluate(() => {
      (window as unknown as { __pasteLog: string[] }).__pasteLog = [];
      const ta = document.querySelector(".chat-panel .composer textarea");
      ta?.addEventListener("paste", (e) => {
        const ce = e as ClipboardEvent;
        const dt = ce.clipboardData;
        const log = (window as unknown as { __pasteLog: string[] }).__pasteLog;
        log.push(`paste fired: files=${dt?.files?.length ?? "x"} items=${dt?.items?.length ?? "x"}`);
        for (const it of Array.from(dt?.items ?? [])) {
          log.push(`item kind=${it.kind} type=${it.type}`);
        }
        for (const f of Array.from(dt?.files ?? [])) {
          log.push(`file name=${f.name} type=${f.type} size=${f.size}`);
        }
      });
    });

    // 复现焦点丢失场景：粘贴前焦点移出输入框（点 body）
    await window.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); document.body.focus(); });
    await window.keyboard.press("Control+V");
    await window.waitForTimeout(1500);

    const pasteLog = await window.evaluate(() => (window as unknown as { __pasteLog?: string[] }).__pasteLog ?? ["NO PASTE EVENT"]);
    console.log("PASTE_LOG:", JSON.stringify(pasteLog));

    // 图片缩略卡是否出现（主进程直通链含 IPC 往返，轮询等待而非一次性取值）
    const card = window.locator(".composer-image-card");
    await expect(card).toHaveCount(1, { timeout: 10_000 });
  } finally {
    await harness.close();
  }
});
