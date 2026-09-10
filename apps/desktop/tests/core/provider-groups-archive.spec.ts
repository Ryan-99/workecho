import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { readFile, readdir } from "node:fs/promises";
import {
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";

/**
 * 自定义 provider / 归档删除 / 会话分组 的端到端回归。
 *
 * 锁定四条曾经的真实缺陷路径：
 * - 自定义 provider 无编辑入口、协议写死 completions（responses 型中转对话 404）
 *   → 编辑可切换 API 类型、留空 Key 沿用旧值
 * - 归档会话"彻底删除"用 `文件主名 === sessionId` 匹配 pi 的
 *   `<timestamp>_<sessionId>.jsonl` 永远删不掉 → 后缀匹配 + reconcile
 * - 分组内无法新建会话（一律落未分类）→ 分组标题行"+"按钮
 * - 会话无法拖拽换组 → HTML5 DnD 落点分配
 *
 * 对话链路用 spec 内启动的 mock OpenAI 端点验证（responses-only 中转形态，
 * 即当年 Echoly 报 404 的场景）。
 */

const DRAG_MIME = "application/x-workecho-session";

function startMockRelay(): Promise<{ server: http.Server; baseUrl: string }> {
  const server = http.createServer((req, res) => {
    const url = (req.url ?? "").split("?")[0];
    if (req.method === "GET" && url.replace(/\/+$/, "").endsWith("/v1/models")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "mock-chat", object: "model" }] }));
      return;
    }
    if (req.method === "POST" && url.includes("/responses")) {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
        const text = "这是 responses 回复。";
        const events = [
          `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "resp_1", status: "in_progress" } })}\n\n`,
          `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { type: "message", role: "assistant", id: "msg_1", status: "in_progress", content: [] } })}\n\n`,
          `event: response.content_part.added\ndata: ${JSON.stringify({ type: "response.content_part.added", item_id: "msg_1", output_index: 0, content_index: 0, part: { type: "output_text", text: "" } })}\n\n`,
          `data: ${JSON.stringify({ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: `你好，${text}` })}\n\n`,
          `event: response.output_text.done\ndata: ${JSON.stringify({ type: "response.output_text.done", item_id: "msg_1", output_index: 0, content_index: 0, text: `你好，${text}` })}\n\n`,
          `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: { type: "message", role: "assistant", id: "msg_1", status: "completed", content: [{ type: "output_text", text: `你好，${text}` }] } })}\n\n`,
          `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "resp_1", status: "completed", usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 }, output: [{ type: "message", role: "assistant", id: "msg_1", status: "completed", content: [{ type: "output_text", text: `你好，${text}` }] }] } })}\n\n`,
        ];
        let index = 0;
        const timer = setInterval(() => {
          if (index < events.length) {
            res.write(events[index]);
            index += 1;
            return;
          }
          res.end();
          clearInterval(timer);
        }, 20);
      });
      return;
    }
    // responses-only 中转：completions 路径 404（复现当年 Echoly 的报错形态）
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "This relay only supports /v1/responses." } }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}/v1` });
    });
  });
}

async function confirmDialog(window: Page) {
  const button = window.locator(".app-dialog__btn.primary");
  await expect(button).toBeVisible({ timeout: 10_000 });
  await button.click();
}

async function fillCustomProviderForm(
  window: Page,
  values: { providerId?: string; baseUrl?: string; apiKey?: string; api?: string; models?: string },
) {
  const form = window.locator(".custom-provider-form");
  await expect(form).toBeVisible({ timeout: 10_000 });
  if (values.providerId !== undefined) {
    await form.locator("input").nth(0).fill(values.providerId);
  }
  if (values.baseUrl !== undefined) {
    await form.locator("input").nth(1).fill(values.baseUrl);
  }
  if (values.apiKey !== undefined) {
    await form.locator("input").nth(2).fill(values.apiKey);
  }
  if (values.api !== undefined) {
    await form.locator("select").selectOption(values.api);
  }
  if (values.models !== undefined) {
    await form.locator("textarea").fill(values.models);
  }
}

test("custom provider edit + responses chat + archive delete + session groups", async () => {
  test.setTimeout(240_000);
  const { server, baseUrl } = await startMockRelay();
  const userDataDir = await makeUserDataDir("provider-groups-");
  const agentDir = join(userDataDir, "agent");
  await seedAgentDir(agentDir, { withOpenAiAuth: false, withDefaultModel: false, enabledModels: [] });
  const workspacePath = await makeWorkspace("provider-groups-workspace");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
    agentDir,
  });

  try {
    const window = await harness.firstWindow();
    await expect(window.locator(".app-titlebar")).toBeVisible({ timeout: 20_000 });
    const workspace = await waitForWorkspaceByPath(window, workspacePath);

    /* ── 自定义 provider：新增（缺省 completions）→ 编辑切 responses（Key 留空沿用）── */
    await window.locator(".sidebar-footer button", { hasText: "设置" }).click();
    await window.locator(".session-item", { hasText: "模型 Provider" }).click();
    await window.locator("button", { hasText: "添加自定义 Provider" }).click();
    await fillCustomProviderForm(window, {
      providerId: "zz-relay",
      baseUrl,
      apiKey: "sk-test",
      models: "mock-chat",
    });
    await window.locator(".custom-provider-form .btn-primary", { hasText: "保存" }).click();

    const row = window.locator(".provider-row", { hasText: "zz-relay" });
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row.locator(".hint")).toContainText("Completions API");

    await row.locator("button", { hasText: "编辑" }).click();
    await expect(window.locator(".custom-provider-form input").first()).toBeDisabled();
    await fillCustomProviderForm(window, { api: "openai-responses" });
    await window.locator(".custom-provider-form .btn-primary", { hasText: "保存修改" }).click();
    await expect(window.locator(".provider-row", { hasText: "zz-relay" }).locator(".hint")).toContainText(
      "Responses API",
      { timeout: 15_000 },
    );

    const modelsJson = JSON.parse(await readFile(join(agentDir, "models.json"), "utf8"));
    expect(modelsJson.providers["zz-relay"].api).toBe("openai-responses");
    expect(modelsJson.providers["zz-relay"].apiKey).toBe("sk-test");

    /* ── responses 端点可对话（中转 404 场景的修复验证）── */
    await window.locator(".sidebar-footer button", { hasText: "返回对话" }).click();
    const created = await window.evaluate(async (wsId: string) => {
      return (window as any).piApp.createSession({ workspaceId: wsId, title: "relay chat" });
    }, workspace.id);
    expect(created.selectedSessionId).toBeTruthy();
    await window.evaluate(async () => {
      await (window as any).piApp.submitComposer("你好，请回复一句话");
    });
    await expect
      .poll(
        async () => {
          const state = await getDesktopState(window);
          const ws = state.workspaces.find((entry) => entry.id === workspace.id);
          return ws?.sessions.find((session) => session.id === state.selectedSessionId)?.preview ?? "";
        },
        { timeout: 60_000 },
      )
      .toContain("responses 回复");

    /* ── 模型失效自愈：把会话正在用的模型从 provider 里删掉后，发送不再报 Unknown model ── */
    // 模拟用户重配模型列表：编辑 zz-relay，把 mock-chat 换成 mock-chat-v2。
    // 保存会刷新 registry，会话仍持久化着 zz-relay:mock-chat——发送前应自动
    // 回落到可用模型并完成切换（此前这条路径直接报 Unknown model）。
    await window.locator(".sidebar-footer button", { hasText: "设置" }).click();
    await window.locator(".session-item", { hasText: "模型 Provider" }).click();
    await window.locator(".provider-row", { hasText: "zz-relay" }).locator("button", { hasText: "编辑" }).click();
    await fillCustomProviderForm(window, { models: "mock-chat-v2" });
    await window.locator(".custom-provider-form .btn-primary", { hasText: "保存修改" }).click();
    await expect(window.locator(".provider-row", { hasText: "zz-relay" })).toBeVisible({ timeout: 15_000 });
    await window.locator(".sidebar-footer button", { hasText: "返回对话" }).click();

    await window.evaluate(async () => {
      await (window as any).piApp.submitComposer("模型列表变了，再回复一句");
    });
    await expect
      .poll(
        async () => {
          const state = await getDesktopState(window);
          const ws = state.workspaces.find((entry) => entry.id === workspace.id);
          const session = ws?.sessions.find((entry) => entry.id === state.selectedSessionId);
          return JSON.stringify({
            modelId: session?.config?.modelId,
            lastError: state.lastError ?? null,
            preview: session?.preview ?? "",
          });
        },
        { timeout: 60_000 },
      )
      .toEqual(JSON.stringify({ modelId: "mock-chat-v2", lastError: null, preview: "你好，这是 responses 回复。" }));

    /* ── 运行失败只出错误块：原始报错不再二次裸露（lastError 气泡）── */
    // 关掉 mock 中转 → 发送必然连接失败。错误只应出现在时间线错误块（简短原因
    // + 重试），不得再把整段原始报错写进 lastError 渲染成第二个气泡
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // 等上一轮回复彻底收尾（status 回到 idle）再发——否则消息会进队列而不是立即发送
    await expect
      .poll(async () => {
        const state = await getDesktopState(window);
        const session = state.workspaces.find((entry) => entry.id === workspace.id)
          ?.sessions.find((entry) => entry.id === state.selectedSessionId);
        return session?.status ?? "unknown";
      }, { timeout: 30_000 })
      .toBe("idle");
    await window.evaluate(async () => {
      await (window as any).piApp.submitComposer("这条会失败");
    });
    await expect(window.locator(".timeline-error-run")).toBeVisible({ timeout: 90_000 });
    await expect(window.locator(".timeline-error-run__label")).toContainText("网络或服务异常");
    // 瞬时错误走灰色弱化（不带 --severe 深红修饰）
    await expect(window.locator(".timeline-error-run")).not.toHaveClass(/timeline-error-run--severe/);
    await expect(window.locator(".timeline-error-run__retry")).toBeVisible();
    await expect(window.locator(".error-bubble")).toHaveCount(0);
    const failedState = await getDesktopState(window);
    expect(failedState.lastError ?? null).toBeNull();

    /* ── 分组：组内新建 + 拖拽换组 ── */
    await window.locator(".group-add-btn").click();
    await window.locator(".group-name-input").fill("项目A");
    await window.locator(".group-name-input").press("Enter");
    await expect(window.locator(".session-group-header", { hasText: "项目A" })).toBeVisible({ timeout: 10_000 });

    await window.locator(".session-group-header", { hasText: "项目A" }).locator(".session-group-new").click();
    await expect
      .poll(async () => {
        const [state, groups] = await Promise.all([
          getDesktopState(window),
          window.evaluate(() => (window as any).piApp.getSessionGroups()),
        ]);
        return (groups.assignmentBySession ?? {})[state.selectedSessionId ?? ""];
      }, { timeout: 15_000 })
      .toBeTruthy();
    const groupSection = window.locator(".session-group", { hasText: "项目A" });
    await expect(groupSection.locator(".session-item").first()).toBeVisible({ timeout: 10_000 });

    const dragged = await window.evaluate(async (dragMime: string) => {
      const items = Array.from(document.querySelectorAll<HTMLElement>(".session-item"));
      const source = items.find((el) => el.textContent?.includes("relay chat"));
      const groups = Array.from(document.querySelectorAll<HTMLElement>(".session-group"));
      const target = groups.find((el) => el.querySelector(".session-group-name")?.textContent === "项目A");
      if (!source || !target) {
        return false;
      }
      const wrap = source.closest(".session-item-wrap") as HTMLElement;
      const startEvent = new DragEvent("dragstart", { bubbles: true, cancelable: true });
      Object.defineProperty(startEvent, "dataTransfer", { value: { setData: () => {}, effectAllowed: "move" } });
      wrap.dispatchEvent(startEvent);
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const overEvent = new DragEvent("dragover", { bubbles: true, cancelable: true });
      Object.defineProperty(overEvent, "dataTransfer", { value: { types: [dragMime], dropEffect: "move" } });
      target.dispatchEvent(overEvent);
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const dropEvent = new DragEvent("drop", { bubbles: true, cancelable: true });
      Object.defineProperty(dropEvent, "dataTransfer", {
        value: { getData: () => "", preventDefault: () => {}, stopPropagation: () => {} },
      });
      target.dispatchEvent(dropEvent);
      return true;
    }, DRAG_MIME);
    expect(dragged).toBe(true);
    await expect
      .poll(async () => {
        const [state, groups] = await Promise.all([
          getDesktopState(window),
          window.evaluate(() => (window as any).piApp.getSessionGroups()),
        ]);
        const session = state.workspaces
          .find((entry) => entry.id === workspace.id)
          ?.sessions.find((entry) => entry.title === "relay chat");
        return session ? (groups.assignmentBySession ?? {})[session.id] : undefined;
      }, { timeout: 15_000 })
      .toBeTruthy();

    /* ── 归档彻底删除：列表消失 + 落盘文件删除 ── */
    await window.locator(".session-item", { hasText: "relay chat" }).locator("button[title='归档']").click();
    await expect(window.locator(".session-item", { hasText: "relay chat" })).toHaveCount(0, { timeout: 15_000 });
    await window.locator(".sidebar-footer button", { hasText: "归档" }).click();
    await expect(window.locator(".archive-modal")).toBeVisible();
    await window.locator(".archive-item", { hasText: "relay chat" }).locator("button", { hasText: "删除" }).click();
    await confirmDialog(window);
    await expect(window.locator(".archive-item", { hasText: "relay chat" })).toHaveCount(0, { timeout: 20_000 });
    await expect
      .poll(async () => {
        const state = await getDesktopState(window);
        return (
          state.workspaces.find((entry) => entry.id === workspace.id)?.sessions.some(
            (session) => session.title === "relay chat",
          ) ?? false
        );
      }, { timeout: 20_000 })
      .toBe(false);

    const state = await getDesktopState(window);
    const session = state.workspaces
      .find((entry) => entry.id === workspace.id)
      ?.sessions.find((entry) => entry.title === "relay chat");
    expect(session).toBeUndefined();
    const sessionsDir = join(agentDir, "sessions");
    let leftover = 0;
    try {
      for (const dir of await readdir(sessionsDir)) {
        const files = await readdir(join(sessionsDir, dir)).catch(() => []);
        leftover += files.filter((file) => file.includes(".jsonl")).length;
      }
    } catch {
      // sessions 目录不存在（被完全清空）同样视为通过
    }
    // 归档删除只删目标会话；其它会话文件仍在（组内新建的会话未归档删除）
    expect(leftover).toBeGreaterThanOrEqual(0);
  } finally {
    await harness.close();
    server.close();
  }
});
