# pi agent 升级指南（解耦架构 + Runbook）

> 目标：上游 `@earendil-works/pi-coding-agent` 更新频繁（0.x 阶段 minor 即破坏性），
> 我们的适配成本必须收敛到"改一个文件 + 跑一个测试"。

## 架构：两层隔离

```
上游 @earendil-works/pi-coding-agent  ←—— 频繁变动
        │
        ▼
【第一层】@pi-gui/session-driver / pi-sdk-driver / catalogs（本地 workspace 包）
        │  pi-gui 基座的会话/驱动抽象
        ▼
【第二层】apps/desktop/electron/pi-compat.ts  ←—— 业务代码唯一的上游 import 点
        │  defineTool / toolOk / toolErr / cwdFromContext /
        │  PI_EVENTS / assertPiExtensionApi / 类型再导出
        ▼
业务代码（business-runtime / tool-pipeline / web-fetch-tool / main / orchestration）
```

规则：**业务代码禁止直接 `import ... from "@earendil-works/pi-coding-agent"`**，
一律从 `./pi-compat` 引用。新增工具时用 `defineTool()`，不要手写工具对象形状。

## 我们依赖的上游契约面（C1–C7）

契约测试 `apps/desktop/tests/wiki/pi-contract.test.mjs` 固化了以下断言，
**升级后先跑它**（秒级），失败信息会直接指向要改的地方：

| 编号 | 契约 | pi-compat 中的对应 |
|------|------|--------------------|
| C1 | 版本在 0.x 带内（进入 1.x 触发全面复核） | — |
| C2 | 包 ESM 入口可动态 import | — |
| C3 | 扩展工厂约定 `(pi) => void`，`pi.registerTool` / `pi.on` | `ExtensionFactory`、`assertPiExtensionApi` |
| C4 | 工具形状 `{name, description, parameters, execute(五参)}` | `defineTool` / `PiToolDefinition` |
| C5 | 工具结果 `{content:[{type:"text",text}], details}` | `toolOk` / `toolErr` |
| C6 | `tool_call` handler 返回 `{block, reason}` 可否决 | `PI_EVENTS.toolCall` |
| C7 | `ExtensionContext.cwd` 提供 workspace 路径 | `cwdFromContext`（缺省回退 process.cwd） |

另有两处**隐性契约**（契约测试覆盖不到，升级时人工核对）：

1. `business-runtime.ts` 的 create_plugin 工具生成给用户的插件代码模板
   （`export default function(pi){pi.registerTool(...)})` —— 模板写死了 pi 的 API 形状。
2. 长工具的 `AbortSignal` 中止传导（execute 第三参）—— 停止按钮依赖它。

## 升级 Runbook

```bash
# 1. 更新依赖
pnpm --dir "D:/Claude Code/Zcode/pi-gui" up @earendil-works/pi-coding-agent

# 2. 重建本地驱动包（pi-gui 基座可能需要适配新上游）
pnpm --dir "D:/Claude Code/Zcode/pi-gui/apps/desktop" run build:deps

# 3. 契约测试先行（几秒，失败会指明具体契约）
cd apps/desktop
node --import ./tests/wiki/ts-resolver.mjs --test --experimental-strip-types \
  --no-warnings tests/wiki/pi-contract.test.mjs

# 4. 全量回归（200+ 测试，含 40 个工具的真实执行 smoke）
node --import ./tests/wiki/ts-resolver.mjs --test --experimental-strip-types \
  --no-warnings tests/wiki/*.test.mjs

# 5. 改动收敛：所有适配改 electron/pi-compat.ts（必要时加映射函数，
#    保持业务代码调用的签名不变）

# 6. typecheck 改过的文件 + pnpm dev 起来人工过一遍：
#    发消息 / 工具调用 / Hook 拦截 / 停止按钮

# 7. 产物校验（打包后运行；pi-coding-agent 期望版本自动从
#    apps/desktop/package.json 依赖声明推导，无需手工同步——历史事故 C-06）
pnpm --dir apps/desktop run verify:packaged-runtime-deps:windows
```

## 版本策略

- `package.json` 保持 `^0.80.6` 形式（0.x 的 caret 只允许 patch 级自动更新，
  minor 升级必须走上面的 Runbook 人工确认）。
- 每次升级在本文档底部追加一行变更记录。

## 变更记录

| 日期 | 上游版本 | 说明 |
|------|---------|------|
| 2026-08-17 | 0.84.2 | 建立隔离层与契约测试（本文件） |
| 2026-08-17 | 0.80.6 → 0.84.2 | 第一次真实升级。**Workecho 业务层零改动**（pi-compat 生效）；适配集中在 pi-gui 基座 pi-sdk-driver：AuthStorage 类移除 → ModelRuntime.create()（异步，依赖改惰性 Promise 单例）；ModelRegistry.create 静态工厂 → new ModelRegistry(runtime)；createAgentSession 的 authStorage/modelRegistry 选项 → modelRuntime；session.modelRegistry → 共享 registry；ResourceLoader 新增 getSystemPromptSource/getAppendSystemPromptSources。集成新能力：Hook 规则新增 terminate 动作（拦截并终止本轮，0.84.1）。**可跟进**：defaultTools 启动工具配置、Provider 凭据预检（ModelRuntime.checkAuth）、transcript Mermaid/LaTeX 渲染（需前端渲染器支持）、AGENTS.override.md 按目录上下文覆盖（免费获得） |
