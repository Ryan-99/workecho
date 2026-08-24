# tests-legacy —— 待移植的旧 UI e2e 用例

这 37 个 spec 针对的是 **Workecho 换壳前(2026-08-20 之前)的 pi-gui 原生组件树**
(`src/sidebar.tsx`、`src/topbar.tsx` 等),其选择器(`.session-row__select`、
`.topbar__session`、`data-testid="sidebar-toggle"`、`.timeline-item--assistant` 等)
在当前实际运行的 shell 组件树(`src/shell/*`,`App.tsx` 引用)中不存在。

历史:8/20 Workecho 定制层把 `App.tsx` 切到 `shell/*` 组件;当时 CI 的 e2e 步骤
因旧包名 `--filter @pi-gui/desktop` 静默空转(审计 C-01),套件从未真正跑过,
选择器漂移因此无人发现(审计 F-04 的连带发现)。

这些文件**保留待移植**,不在任何测试脚本/CI 的默认发现路径里
(`tests-legacy/` 与 `tests/` 平级,Playwright testDir 是 `apps/desktop/tests`)。

## 移植指引

- 新 UI 对应关系(部分):`.session-row__*` → `shell/Sidebar.tsx` 的
  `.session-item`/`.title`;`.topbar__session` → shell 无顶栏会话标题,
  断言改用侧栏 active 项;`data-testid="composer"` → `.composer` 类;
  `.timeline-item--assistant` → `shell/TranscriptTimeline.tsx` 的消息行结构。
- 注意 Ryan 的设计基线(有意为之,不是回归):侧栏切换无关闭按钮、
  灰色选中态、胶囊标签——不要为通过旧断言反向改 UI。
- 移植完的 spec 放回 `tests/core/`,跑
  `pnpm --filter @workecho/desktop run test:core:navigation` 式的单spec验证。

## 当前有效的核心套件

`tests/core/` 现存 8 个兼容 spec + `shell-smoke.spec.ts`(shell UI 冒烟,
覆盖启动→建会话→输入框可用→发送按钮状态的最小路径)。
