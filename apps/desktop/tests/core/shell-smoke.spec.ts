import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import {
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";

/**
 * shell-smoke —— Workecho 实际 UI（src/shell/*）的最小可用路径冒烟。
 *
 * 背景（审计 F-04）：2026-08-20 换壳后旧 e2e 套件的选择器全部失效
 * （见 ../tests-legacy/README.md）。本 spec 锁定换壳后 UI 的关键路径：
 * 启动（不误弹引导）→ 工作区就绪 → IPC 建会话出现在侧栏 →
 * 新建会话进入欢迎页 → 输入框可用、发送按钮状态正确。
 * 断言全部使用 shell 组件的真实 class，不依赖旧 UI 选择器。
 */
test("shell boots to main UI, lists an IPC-created thread, and drives the welcome composer", async () => {
  test.setTimeout(120_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("shell-smoke-workspace");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();

    // 1) 壳层 UI 渲染,且注入了已注册工作区时不误弹首启引导（F-04 回归）
    await expect(window.locator(".app-titlebar")).toBeVisible({ timeout: 20_000 });
    await expect(window.locator(".onboarding")).toHaveCount(0);
    await expect(window.locator(".sidebar")).toBeVisible();

    // 2) 注入的工作区就绪
    const workspace = await waitForWorkspaceByPath(window, workspacePath);
    expect(workspace.path).toBe(workspacePath);

    // 3) IPC 直接建会话 → 侧栏 session-item 出现并成为激活项
    await createSessionDirect(window, workspace.id, "Smoke thread");
    const row = window.locator(".session-item", { hasText: "Smoke thread" });
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row).toHaveClass(/active/);

    // 4) 新建会话（UI 路径）→ 进入可输入的 composer（空会话为 WelcomeView 或
    //    已选中新会话的 ChatPanel——两态竞态都合法,统一断言 composer 可用）
    await window.locator(".new-btn").click();
    const editor = window.locator(".composer textarea");
    await expect(editor).toBeVisible();
    await editor.click();
    await expect(editor).toBeFocused();

    // 5) 发送按钮的禁用/使能跟随输入
    const sendButton = window.locator(".composer__send");
    await expect(sendButton).toBeDisabled();
    await editor.fill("帮我初始化工作环境");
    await expect(sendButton).toBeEnabled();

    // 6) 侧栏两个会话共存（激活的是新会话）
    await expect(window.locator(".session-item")).toHaveCount(2);
  } finally {
    await harness.close();
  }
});

/** 直接走 IPC 建会话（不经旧 helper 的 .session-row__select 断言）。 */
async function createSessionDirect(window: Page, workspaceId: string, title: string): Promise<void> {
  await window.evaluate(async ({ wsId, threadTitle }) => {
    const app = (window as unknown as { piApp: { createSession: (o: object) => Promise<unknown> } }).piApp;
    if (!app) throw new Error("piApp IPC bridge is unavailable");
    await app.createSession({ workspaceId: wsId, title: threadTitle });
  }, { wsId: workspaceId, threadTitle: title });
  // 等 IPC 侧状态真正落定（侧栏由 onStateChanged 推送刷新）
  await expect
    .poll(async () => {
      const state = await getDesktopState(window);
      return state.selectedSessionId ?? null;
    }, { timeout: 20_000 })
    .toBeTruthy();
}

test("wiki page opens from the sidebar and plan-mode toggle reflects in the composer", async () => {
  test.setTimeout(120_000);
  const userDataDir = await makeUserDataDir("shell-smoke-2-");
  const workspacePath = await makeWorkspace("shell-smoke-wiki-workspace");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    const workspace = await waitForWorkspaceByPath(window, workspacePath);

    // 建会话进入 ChatPanel（含 + 菜单）
    await createSessionDirect(window, workspace.id, "Plan mode thread");
    await expect(window.locator(".session-item", { hasText: "Plan mode thread" })).toBeVisible({ timeout: 20_000 });

    // C-08：知识库独立页从侧栏打开（列表视图 + 图谱视图切换）
    await window.getByText("知识库", { exact: true }).click();
    await expect(window.locator(".wiki-page")).toBeVisible({ timeout: 20_000 });
    await expect(window.locator(".wiki-tree")).toBeVisible();
    await window.locator(".wiki-page-actions button", { hasText: "图谱" }).click();
    await expect(window.locator(".wiki-page-actions button", { hasText: "图谱" })).toHaveClass(/active/);
    // 关闭按钮回到聊天面板
    await window.locator(".wiki-page-actions button", { hasText: "关闭" }).click();
    await expect(window.locator(".chat-panel")).toBeVisible({ timeout: 20_000 });

    // C-08：计划模式开关（+ 菜单内）切换后 placeholder 变化 + 徽标出现
    await window.locator(".composer-plus .composer__icon-btn").click();
    const planToggle = window.locator(".composer-plus-menu button", { hasText: "计划模式" });
    await expect(planToggle).toBeVisible();
    await planToggle.click();
    await expect(window.locator("textarea")).toHaveAttribute(
      "placeholder",
      /计划模式/,
      { timeout: 10_000 },
    );
    // 关闭计划模式恢复（togglePlan 不收起菜单——直接再点一次）
    await planToggle.click();
    await expect(window.locator("textarea")).toHaveAttribute("placeholder", "给 Workecho 助手发消息", { timeout: 10_000 });
  } finally {
    await harness.close();
  }
});

test("compact-session confirm gate and context meter popover work on the shell composer", async () => {
  test.setTimeout(120_000);
  const userDataDir = await makeUserDataDir("shell-smoke-3-");
  const workspacePath = await makeWorkspace("shell-smoke-c8-workspace");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    const workspace = await waitForWorkspaceByPath(window, workspacePath);
    await createSessionDirect(window, workspace.id, "C8 thread");
    await expect(window.locator(".session-item", { hasText: "C8 thread" })).toBeVisible({ timeout: 20_000 });

    // C-08：压缩会话——+ 菜单 → 应用内确认弹窗（取消路径，不实际压缩空会话）
    await window.locator(".composer-plus .composer__icon-btn").click();
    await window.locator(".composer-plus-menu button", { hasText: "压缩会话" }).click();
    const dialog = window.locator(".app-dialog");
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await expect(dialog).toContainText("压缩会话上下文");
    await dialog.locator(".app-dialog__btn", { hasText: "取消" }).first().click();
    await expect(dialog).toHaveCount(0);

    // C-08：上下文用量圆环——常驻可见，悬浮出现容量明细
    const meter = window.locator(".context-meter");
    await expect(meter).toBeVisible();
    await meter.hover();
    const popover = window.locator(".context-popover");
    await expect(popover).toBeVisible({ timeout: 10_000 });
    await expect(popover).toContainText("上下文容量");
  } finally {
    await harness.close();
  }
});

test("provider setup dialog lists configurable providers instead of a bare API key input", async () => {
  test.setTimeout(120_000);
  const userDataDir = await makeUserDataDir("shell-provider-setup-");
  const workspacePath = await makeWorkspace("shell-provider-setup-workspace");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);

    // 模拟"发消息触发 pi 要 API key"（e2e 测试钩子 → 主进程拦截推送同款通道）
    await harness.electronApp.evaluate((electron) => {
      const hooks = (globalThis as { __PI_APP_TEST_HOOKS?: { emitProviderSetupNeeded?: (m?: string) => void } })
        .__PI_APP_TEST_HOOKS;
      if (!hooks?.emitProviderSetupNeeded) throw new Error("emitProviderSetupNeeded hook unavailable");
      hooks.emitProviderSetupNeeded("Enter your API key");
    });

    // 弹出的是完整 provider 配置引导，而不是裸 key 输入框
    const dialog = window.locator(".provider-setup-dialog");
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await expect(dialog).toContainText("配置模型服务");
    // CoStrict 一键接入出现在"账号登录"分组（内网用户正路；引导页三步重做后
    // 分组从"直接登录"改为"账号登录/API Key/自定义"三段）
    await expect(dialog.locator(".provider-setup-group-title", { hasText: "账号登录" })).toBeVisible();
    await expect(dialog).toContainText("CoStrict");
    // 不再出现旧的 key 输入 prompt 形态（app-dialog__input）
    await expect(dialog.locator(".app-dialog__input")).toHaveCount(0);
    // 关闭按钮可退出
    await dialog.locator(".app-dialog__close").click();
    await expect(dialog).toHaveCount(0);
  } finally {
    await harness.close();
  }
});
