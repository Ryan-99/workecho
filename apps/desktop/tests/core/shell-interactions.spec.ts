import { expect, test } from "@playwright/test";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import {
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  createSessionIpc,
  seedAgentDir,
  seedForkSessionFixture,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";

/**
 * shell-interactions —— 从 tests-legacy/ 移植的两条核心交互路径（选择器已对齐 shell UI）：
 * 1. fork-from-message：消息 hover「从此分支」→ 应用内确认 → forkThread 生成新会话
 * 2. composer-controls（核心子集）：斜杠命令菜单的唤出/过滤/点选插入 + @ 文件引用
 * 其余 legacy 用例按 tests-legacy/README.md 的对照表逐步移植。
 */
test("fork from a transcript message creates a new session after in-app confirm", async () => {
  test.setTimeout(120_000);
  const userDataDir = await makeUserDataDir("shell-fork-");
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("shell-fork-workspace");
  await seedAgentDir(agentDir);
  // 磁盘上种一个带 3 轮问答的真实会话（fork 校验走驱动层，消息 id 必须真实存在）
  await seedForkSessionFixture(agentDir, workspacePath);
  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);

    // 侧栏选中 fixture 会话（shell UI 路径）
    const row = window.locator(".session-item", { hasText: "Fork fixture session" });
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.click();
    await expect(window.locator(".chat-panel .msg").first()).toBeVisible({ timeout: 20_000 });
    await expect(window.locator(".chat-panel")).toContainText("Third fork question");

    const workspace = (await waitForWorkspaceByPath(window, workspacePath));
    const before = await getDesktopState(window);
    const beforeWs = before.workspaces.find((entry) => entry.id === workspace.id);
    const beforeCount = beforeWs?.sessions.length ?? 0;
    const beforeSelected = before.selectedSessionId;

    // hover 第二轮回答 → 「从此分支」→ 应用内确认
    const secondAnswer = window.locator(".msg", { hasText: "Second fork answer" }).first();
    await secondAnswer.hover();
    await secondAnswer.getByRole("button", { name: "从此分支" }).click();
    const dialog = window.locator(".app-dialog");
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await expect(dialog).toContainText("重开分支");
    await dialog.locator(".app-dialog__btn.primary").click();
    await expect(dialog).toHaveCount(0);

    // 新会话创建并选中；分支保留到 fork 点的历史、丢弃其后内容
    await expect
      .poll(async () => {
        const state = await getDesktopState(window);
        if (state.lastError) throw new Error(`forkThread 失败: ${JSON.stringify(state.lastError).slice(0, 300)}`);
        return state.workspaces.find((entry) => entry.id === workspace.id)?.sessions.length ?? 0;
      }, { timeout: 20_000 })
      .toBe(beforeCount + 1);
    const after = await getDesktopState(window);
    expect(after.selectedSessionId).not.toBe(beforeSelected);
    await expect(window.locator(".chat-panel")).toContainText("Second fork answer");
    await expect(window.locator(".chat-panel")).not.toContainText("Third fork question");
  } finally {
    await harness.close();
  }
});

test("slash menu opens, filters, and inserts; @ opens the file reference menu", async () => {
  test.setTimeout(120_000);
  const userDataDir = await makeUserDataDir("shell-slash-");
  const workspacePath = await makeWorkspace("shell-slash-workspace");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    const workspace = await waitForWorkspaceByPath(window, workspacePath);
    await createSessionIpc(window, workspace.id, "Slash menu thread");
    const composer = window.locator(".chat-panel .composer textarea");
    await expect(composer).toBeVisible({ timeout: 20_000 });

    // 输入 / 唤出菜单，内置命令可见
    await composer.click();
    await composer.fill("/");
    const menu = window.locator(".slash-menu").first();
    await expect(menu).toBeVisible({ timeout: 10_000 });
    await expect(menu).toContainText("/compact");
    await expect(menu).toContainText("/thinking");

    // 过滤：无匹配时菜单收起
    await composer.fill("/zzz-no-match");
    await expect(menu).toHaveCount(0);

    // 重新唤出点选 /compact → 本地执行：弹压缩确认 → 取消（输入框清空、无消息发送）
    await composer.fill("/");
    await expect(menu).toBeVisible();
    await menu.locator(".slash-menu__item", { hasText: "/compact" }).click();
    const compactDialog = window.locator(".app-dialog");
    await expect(compactDialog).toBeVisible({ timeout: 10_000 });
    await expect(compactDialog).toContainText("压缩会话上下文");
    await compactDialog.locator(".app-dialog__btn", { hasText: "取消" }).first().click();
    await expect(compactDialog).toHaveCount(0);
    await expect(composer).toHaveValue("");

    // /thinking 点选 → 参数选项 → 选 high → 本地设置思考级别（不发消息，输入框清空）
    await composer.fill("/");
    await expect(menu).toBeVisible();
    await menu.locator(".slash-menu__item", { hasText: "/thinking" }).click();
    const group = menu.locator(".slash-menu__group");
    await expect(group).toBeVisible();
    await expect(group).toContainText("思考级别");
    await menu.locator(".slash-menu__item", { hasText: "high" }).first().click();
    await expect(composer).toHaveValue("");

    // 模糊 slash 输入（/thin）点发送按钮 → 先补全而不是发给模型
    await composer.fill("/thin");
    await composer.press("Enter"); // 菜单激活时 Enter 应被拦截为补全
    await expect(composer).toHaveValue(/^\/thinking $/);
    await composer.fill("");
    await composer.fill("/thin");
    await window.locator(".composer__send").click();
    await expect(composer).toHaveValue(/^\/thinking $/);

    // @ 唤出文件引用菜单（makeWorkspace 自带 README.md，非 git 目录走兜底遍历）
    await composer.fill("");
    await composer.fill("@");
    const atMenu = window.locator(".slash-menu.at-file-menu");
    await expect(atMenu).toBeVisible({ timeout: 15_000 });
    await expect(atMenu).toContainText("README.md");
  } finally {
    await harness.close();
  }
});

test("picking a skill from the slash menu loads it as a removable chip in the composer", async () => {
  test.setTimeout(120_000);
  const userDataDir = await makeUserDataDir("shell-skill-chip-");
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("shell-skill-chip-workspace");
  await seedAgentDir(agentDir);
  // 种一个演示技能（pi 扫描 agentDir/skills 后注册为 /skill:demo-skill）
  await mkdir(join(agentDir, "skills", "demo-skill"), { recursive: true });
  await writeFile(
    join(agentDir, "skills", "demo-skill", "SKILL.md"),
    `---
name: demo-skill
description: 演示技能
---

# Demo
测试用技能。
`,
    "utf8",
  );
  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    const workspace = await waitForWorkspaceByPath(window, workspacePath);
    await createSessionIpc(window, workspace.id, "Skill chip thread");
    const composer = window.locator(".chat-panel .composer textarea");
    await expect(composer).toBeVisible({ timeout: 20_000 });

    // 输入 / 唤出菜单，等技能命令被运行时注册后出现
    await composer.click();
    await composer.fill("/");
    const skillItem = window.locator(".slash-menu__item", { hasText: "demo-skill" });
    await expect(skillItem).toBeVisible({ timeout: 20_000 });

    // 选中 → 输入框渲染胶囊（名称+可移除），输入框清空并聚焦
    await skillItem.click();
    const chip = window.locator(".composer-skill-chip");
    await expect(chip).toBeVisible();
    await expect(chip).toContainText("demo-skill");
    await expect(composer).toHaveValue("");

    // 补任务并发送 → 胶囊随消息发出并清除
    await composer.fill("帮我做个演示");
    await window.locator(".composer__send").click();
    await expect(chip).toHaveCount(0);
    await expect(composer).toHaveValue("");
  } finally {
    await harness.close();
  }
});
