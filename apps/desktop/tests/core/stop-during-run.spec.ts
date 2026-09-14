import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import {
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";

/**
 * 停止键必须在模型"等待首字节"阶段立即生效。
 *
 * 锁定的真实缺陷：全局 window-scoped IPC 串行队列里，submitComposer 持有
 * 队列直到整个模型运行结束（driver.sendUserMessage await session.prompt），
 * cancelCurrentRun 若走同一条队列就要排到运行自然结束才执行——表现为
 * "点停止没反应"、回复照常泄漏进时间线（beta.39 及之前）。
 * 修复后 cancel 不入队；本用例用"首字节延迟 5s"的 mock 端点锁定该路径。
 */

const RELAY_T0 = Date.now();

function startSlowRelay(firstByteDelayMs: number): Promise<{ server: http.Server; baseUrl: string }> {
  const server = http.createServer((req, res) => {
    const url = (req.url ?? "").split("?")[0];
    if (req.method === "GET" && url.replace(/\/+$/, "").endsWith("/v1/models")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "slow-chat", object: "model" }] }));
      return;
    }
    if (req.method === "POST" && url.includes("/chat/completions")) {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        console.log(`[relay] POST received t=${Date.now() - RELAY_T0}ms`);
        // 先静默 hold 住请求（等待首字节阶段），再开始流式输出
        setTimeout(() => {
          console.log(`[relay] 6s timer fired t=${Date.now() - RELAY_T0}ms destroyed=${res.destroyed} writableEnded=${res.writableEnded}`);
          if (res.writableEnded || res.destroyed) return;
          res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
          const base = { id: "chatcmpl-slow", object: "chat.completion.chunk", created: 1, model: "slow-chat" };
          const frame = (content: string, finish: string | null) =>
            `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: content ? { content } : {}, finish_reason: finish }] })}\n\n`;
          res.write(frame("", null));
          res.write(frame("这句话不应该出现在被停止的会话里。", "stop"));
          res.write("data: [DONE]\n\n");
          res.end();
        }, firstByteDelayMs);
      });
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "not found" } }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}/v1` });
    });
  });
}

function selectedSession(state: Awaited<ReturnType<typeof getDesktopState>>, workspaceId: string) {
  const ws = state.workspaces.find((entry) => entry.id === workspaceId);
  return ws?.sessions.find((session) => session.id === state.selectedSessionId);
}

test("stop button aborts a run that is waiting for the first byte", async () => {
  test.setTimeout(180_000);
  const { server, baseUrl } = await startSlowRelay(6_000);
  const userDataDir = await makeUserDataDir("stop-run-");
  const agentDir = join(userDataDir, "agent");
  await seedAgentDir(agentDir, { withOpenAiAuth: false, withDefaultModel: false, enabledModels: [] });
  const workspacePath = await makeWorkspace("stop-run-workspace");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
    agentDir,
  });

  try {
    const window = await harness.firstWindow();
    await expect(window.locator(".app-titlebar")).toBeVisible({ timeout: 20_000 });
    const workspace = await waitForWorkspaceByPath(window, workspacePath);

    // 配自定义 provider（completions 协议即可命中 slow relay）
    await window.locator(".sidebar-footer button", { hasText: "设置" }).click();
    await window.locator(".session-item", { hasText: "模型 Provider" }).click();
    await window.locator("button", { hasText: "添加自定义 Provider" }).click();
    const form = window.locator(".custom-provider-form");
    await expect(form).toBeVisible({ timeout: 10_000 });
    await form.locator("input").nth(0).fill("slow-relay");
    await form.locator("input").nth(1).fill(baseUrl);
    await form.locator("input").nth(2).fill("sk-test");
    await form.locator("textarea").fill("slow-chat");
    await window.locator(".custom-provider-form .btn-primary", { hasText: "保存" }).click();
    await expect(window.locator(".provider-row", { hasText: "slow-relay" })).toBeVisible({ timeout: 15_000 });
    await window.locator(".sidebar-footer button", { hasText: "返回对话" }).click();

    // 新会话发送消息。submitComposer 的 IPC 动作在主进程持有 window 串行队列
    // 直到整个运行结束——绝不能 await 它，否则后续"点停止"必然落在运行完成
    // 之后，测试将永远验证不到停止路径本身。真实 UI（composer 回车）也是
    // fire-and-forget，这里的语义与之一致。
    const created = await window.evaluate(async (wsId: string) => {
      return (window as any).piApp.createSession({ workspaceId: wsId, title: "stop regression" });
    }, workspace.id);
    expect(created.selectedSessionId).toBeTruthy();
    await window.evaluate(async () => {
      void (window as any).piApp.submitComposer("你好，慢慢回复");
    });

    // 等待进入 running（此时 mock 还没吐首字节）
    await expect
      .poll(async () => {
        const state = await getDesktopState(window);
        return selectedSession(state, workspace.id)?.status ?? "";
      }, { timeout: 20_000 })
      .toBe("running");

    // 点停止：修复后 cancel 绕开队列立即执行；若回归（重新入队），
    // cancel 会排到 6s 后流结束才执行，此断言（4s 内 idle）必红
    const stopBtn = window.locator(".composer__send--stop");
    await expect(stopBtn).toBeVisible({ timeout: 5_000 });
    // test 模式下窗口不可见，Playwright actionability 偶发误报 not enabled；
    // 用 dispatchEvent 触发真实 onClick，不放松后面的行为断言
    await stopBtn.dispatchEvent("click");
    await expect
      .poll(async () => {
        const state = await getDesktopState(window);
        return selectedSession(state, workspace.id)?.status ?? "";
      }, { timeout: 4_000 })
      .toBe("idle");

    // 再等过首字节窗口，确认被中止的运行没有把回复泄漏进时间线
    await window.waitForTimeout(8_000);
    const lastText = await window.evaluate(async () => {
      const transcript = await (window as any).piApp.getSelectedTranscript();
      const items: Array<{ kind?: string; role?: string; text?: string }> = transcript?.transcript ?? [];
      return items
        .filter((item) => item.kind === "message" && item.role === "assistant")
        .map((item) => item.text ?? "")
        .join("");
    });
    expect(lastText).not.toContain("不应该出现");
  } finally {
    await harness.close();
    server.close();
  }
});

/**
 * 流中途点停止：此前 runFailed（code ABORTED）把会话打成 "failed"、时间线弹
 * error 色调的 "Request was aborted"——用户主动停止被呈现成失败。修复后：
 * 会话回到 idle、时间线只留中性 "Stopped" 活动条、已流出内容保留但不再增长。
 */
function startMidStreamRelay(chunkCount: number, chunkGapMs: number): Promise<{ server: http.Server; baseUrl: string }> {
  const server = http.createServer((req, res) => {
    const url = (req.url ?? "").split("?")[0];
    if (req.method === "GET" && url.replace(/\/+$/, "").endsWith("/v1/models")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "mid-chat", object: "model" }] }));
      return;
    }
    if (req.method === "POST" && url.includes("/chat/completions")) {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        setTimeout(() => {
          if (res.writableEnded || res.destroyed) return;
          res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
          const base = { id: "chatcmpl-mid", object: "chat.completion.chunk", created: 1, model: "mid-chat" };
          const frame = (content: string, finish: string | null) =>
            `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: content ? { content } : {}, finish_reason: finish }] })}\n\n`;
          res.write(frame("", null));
          let i = 0;
          const tick = () => {
            if (res.writableEnded || res.destroyed) return;
            if (i >= chunkCount) {
              res.write(frame("", "stop"));
              res.write("data: [DONE]\n\n");
              res.end();
              return;
            }
            i += 1;
            res.write(frame(`片段${i}，`, null));
            setTimeout(tick, chunkGapMs);
          };
          tick();
        }, 300);
      });
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "not found" } }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}/v1` });
    });
  });
}

test("stop button aborts a mid-stream run into idle with a neutral Stopped marker", async () => {
  test.setTimeout(180_000);
  const { server, baseUrl } = await startMidStreamRelay(30, 400);
  const userDataDir = await makeUserDataDir("stop-mid-");
  const agentDir = join(userDataDir, "agent");
  await seedAgentDir(agentDir, { withOpenAiAuth: false, withDefaultModel: false, enabledModels: [] });
  const workspacePath = await makeWorkspace("stop-mid-workspace");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
    agentDir,
  });

  let harnessWindow: Page;
  const transcriptTexts = async () =>
    harnessWindow.evaluate(async () => {
      const transcript = await (window as any).piApp.getSelectedTranscript();
      return (transcript?.transcript ?? []) as Array<{ kind?: string; role?: string; text?: string; label?: string; tone?: string }>;
    });

  try {
    const window = await harness.firstWindow();
    harnessWindow = window;
    await expect(window.locator(".app-titlebar")).toBeVisible({ timeout: 20_000 });
    const workspace = await waitForWorkspaceByPath(window, workspacePath);

    await window.locator(".sidebar-footer button", { hasText: "设置" }).click();
    await window.locator(".session-item", { hasText: "模型 Provider" }).click();
    await window.locator("button", { hasText: "添加自定义 Provider" }).click();
    const form = window.locator(".custom-provider-form");
    await expect(form).toBeVisible({ timeout: 10_000 });
    await form.locator("input").nth(0).fill("mid-relay");
    await form.locator("input").nth(1).fill(baseUrl);
    await form.locator("input").nth(2).fill("sk-test");
    await form.locator("textarea").fill("mid-chat");
    await window.locator(".custom-provider-form .btn-primary", { hasText: "保存" }).click();
    await expect(window.locator(".provider-row", { hasText: "mid-relay" })).toBeVisible({ timeout: 15_000 });
    await window.locator(".sidebar-footer button", { hasText: "返回对话" }).click();

    const created = await window.evaluate(async (wsId: string) => {
      return (window as any).piApp.createSession({ workspaceId: wsId, title: "stop mid-stream" });
    }, workspace.id);
    expect(created.selectedSessionId).toBeTruthy();
    await window.evaluate(async () => {
      void (window as any).piApp.submitComposer("慢慢说，说久一点");
    });

    await expect
      .poll(async () => {
        const state = await getDesktopState(window);
        return selectedSession(state, workspace.id)?.status ?? "";
      }, { timeout: 20_000 })
      .toBe("running");

    // 等流真的一段段出来（进入中途），再点停止
    await expect
      .poll(async () => {
        const items = await transcriptTexts();
        return items
          .filter((item) => item.kind === "message" && item.role === "assistant")
          .map((item) => item.text ?? "")
          .join("");
      }, { timeout: 20_000 })
      .toContain("片段2");

    const stopBtn = window.locator(".composer__send--stop");
    await expect(stopBtn).toBeVisible({ timeout: 5_000 });
    await stopBtn.dispatchEvent("click");

    // 核心断言：停止后会话必须是 idle（回归时这里是 "failed"）
    await expect
      .poll(async () => {
        const state = await getDesktopState(window);
        return selectedSession(state, workspace.id)?.status ?? "";
      }, { timeout: 4_000 })
      .toBe("idle");

    // 时间线：中性 "Stopped" 活动条，没有 error 色调条目、没有错误块
    await expect
      .poll(async () => {
        const items = await transcriptTexts();
        return items.some((item) => item.kind === "activity" && item.label === "Stopped");
      }, { timeout: 5_000 })
      .toBe(true);
    const items = await transcriptTexts();
    expect(items.some((item) => item.kind === "error")).toBe(false);
    expect(items.some((item) => item.kind === "activity" && item.tone === "error")).toBe(false);

    // 已流出的内容保留，但停止后不再增长
    const textAt = async () =>
      (await transcriptTexts())
        .filter((item) => item.kind === "message" && item.role === "assistant")
        .map((item) => item.text ?? "")
        .join("");
    const frozen = await textAt();
    expect(frozen).toContain("片段2");
    await window.waitForTimeout(2_500);
    expect(await textAt()).toBe(frozen);
  } finally {
    await harness.close();
    server.close();
  }
});
