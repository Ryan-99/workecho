# Workecho

> 本地优先的 AI 业务工作台 —— 把日常业务数据、知识库与自动化沉淀成一个可对话的工作环境。

Workecho 是一个 Electron 桌面应用：你用自然语言驱动 Agent 完成业务操作（查 OKR、管客户、跟维保、办待办），所有数据以 Markdown 形式沉淀在本地 Wiki 知识库里，随用随长。

## 核心特性

### 📚 一切皆为 Wiki
- 所有业务数据（OKR / 待办 / 维保 / 客户 / 自定义实体）都是 `workbench/wiki/` 下的 Markdown 文件，人可读、可 grep、可迁移
- 知识库独立页：文件夹树浏览、正文 Markdown 渲染、莫兰迪知识图谱（Obsidian 式交互）、操作日志视图
- 三层记忆（用户画像 / 工作上下文 / 洞察）会话启动自动注入，Agent 记得你是谁、在做什么

### 🤖 Agent 能力
- **计划模式**：先只读探索、输出行动方案，你批准后再执行（输入框 `+` 菜单开关）
- **联网搜索 + 网页阅读**：`web_search` 查资料，`web_fetch` 读原文（带 SSRF 防护）
- **子任务编排**：Agent 可派生子线程并行干活，侧栏嵌套展示进度与状态
- **富内容渲染**：Markdown / Mermaid 图表 / LaTeX 公式
- **消息分支与回滚**：任意消息"从此分支"重开会话；文件变更一键丢弃
- **多 Provider**：OAuth 直登 / API Key / 自定义 OpenAI 兼容端点 / CoStrict 一键接入（内网额度），每行可一键健康检测

### 🧠 自学习与技能
- **内置 Anthropic 官方 skill-creator**（完整方法论 + 评估脚本），创建技能按官方流程走
- **自学习蒸馏**：会话结束后自动评估是否有可复用流程，沉淀为 `learned-*` 技能（严格门控、绝不覆盖手工技能）
- 技能通过 `/技能名` 显式调用，或由 Agent 根据描述自动触发（渐进披露，不占上下文）

### 🗂️ 工作台卡片
右侧工作台以卡片展示业务数据（默认只装"待办事项"，其余口头让 Agent 建："帮我加个客户看板"），卡片可排序、图标走 lucide 库。

### 🛡️ 本地优先与安全
- 数据全部在本地工作区；危险操作（改 OKR / 覆写记忆 / 写插件）需应用内确认
- 工具执行管道全程审计到 `wiki/log.md`；Hook 规则可拦截/通知/终止

## 快速开始

### 环境要求
- Node.js ≥ 22，pnpm ≥ 10
- Windows 10+ / macOS 12+

### 开发运行
```bash
pnpm install
pnpm dev
```

### 打包
```bash
# Windows 安装包 + 免安装包（产出 release/*.exe）
pnpm package:win

# macOS（dmg + zip，需在 macOS 上构建）
pnpm package

# 正式发布：打 tag 推送，CI 自动构建双平台并发布 Release（.github/workflows/release.yml）
git tag v0.1.0 && git push origin v0.1.0
```

> Windows 本机打包提示：若报"无法创建符号链接：客户端没有所需的特权"，在系统设置开启**开发者模式**后重跑；或临时加 `--config.win.signAndEditExecutable=false`（代价是产物无自定义图标）。

### 首次使用
1. 设置 → 模型 Provider：登录或配置任意一家模型（内网用户可直接 CoStrict 一键登录）
2. 对话框输入"帮我初始化工作环境"：自动建 Wiki 结构、扫描导入常用文档（先预览后导入，不动源文件）
3. 直接开始对话；说"我想看到一个客户看板"让 Agent 建第一张卡片

## 输入框速查

| 操作 | 入口 |
|---|---|
| 附件 | `+` 菜单 / 粘贴 / 拖放 |
| 引用工作区文件 | 输入 `@` 唤出过滤列表 |
| 斜杠命令 / 技能 | 输入 `/` |
| 计划模式 | `+` 菜单 → 计划模式 |
| 压缩会话上下文 | `+` 菜单 → 压缩会话 |
| 上下文用量 | 悬浮输入框右侧圆环（分段占用构成） |
| 消息分支 | 消息 hover → 从此分支 |

## 目录结构

```
apps/desktop/          桌面应用（Electron 主进程 + 渲染层）
  electron/            主进程：业务工具、Wiki 服务、管道、自学习、CoStrict
  src/shell/           渲染层：会话/侧栏/设置/知识库页/状态面板
  resources/skills/    随包分发的内置技能（skill-creator）
  tests/wiki/          单元与契约测试（node:test）
packages/              内部驱动层（会话运行时、技能蒸馏等）
review/                设计与审计文档（AGENT-GAP-ANALYSIS.md 等）
```

## 测试与质量

```bash
pnpm typecheck                            # 双 tsconfig 0 错误
pnpm --filter @workecho/desktop test      # 全量测试用例
```

IPC 三侧（preload / 接口 / handler）由契约测试守门，新增通道不同步会直接红。

## 许可与致谢

内部工具，仅供授权范围内使用。内置的 [skill-creator](https://github.com/anthropics/claude-plugins-official) 技能遵循其原始许可。
