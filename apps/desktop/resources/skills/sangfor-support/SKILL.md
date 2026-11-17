---
name: sangfor-support
description: 深信服支持站（support.sangfor.com.cn）完整作业流程：登录、检索下载软件镜像/升级包/补丁（多线程+自动选盘+MD5校验）、关联下载（先问后下：配套补丁+升级手册+版本配套表，分类文件夹）、文档/订单驱动的版本升级核对（查最新版本+EOS停服+升级路径）、排障案例与文档查询、深信服风格测试方案/客户交付文档产出（官方模板复刻docx，客户版+内部实施手册双轨）。触发词：下载镜像、下补丁、下载升级包、支持站下载、找安装包、查案例、找手册、升级手册、配套表、版本配套、最新版本、EOS、停服、测试方案、测试文档、客户文档、交付文档、深信服风格、sangfor。
---

# 深信服支持站作业流程

底层是 MCP 服务器 `sangfor`（18 个 `sangfor_*` 工具，代码随分享包 `sangfor-mcp/` 分发）。本技能定义**怎么把工具串成一次可靠的交付**，含六种入口场景。

> **工具没出现 / 连不上？** 在 `sangfor-mcp/` 目录跑 `node setup.mjs`：stdio 握手自检 + 9 类客户端注册体检矩阵（ZCode / Claude Code / Cursor / Codex / Windsurf / Claude Desktop / VS Code / Gemini / 通用 .agents）；`node setup.mjs --install` 一键注册进已装客户端（逐个自动备份、幂等、写后回读校验）。矩阵里的 🔴"配置文件解析失败"能直接检出**同文件其他段（如 hooks）不合法拖垮整份配置**的形态——注册条目本身没问题也会整体失效（2026-11-11 真实案例）。写入/修复后重启客户端生效。

## 0. 场景路由（先判断是哪种活）

| 用户在说什么 | 走哪个场景 |
|---|---|
| "下载 HCI 6.12.0 的包/镜像"（版本明确） | **场景 A：点单下载**（第 3 节） |
| 给了订单/实施文档/测试文档，要核对版本+下升级包 | **场景 B：文档驱动升级核对**（第 7 节，含 A） |
| "现网 6.0.7 能不能直接升 6.12.0 / 这个版本停服了吗" | **场景 C：版本升级核对**（第 8 节） |
| "查个故障/案例" | **场景 D：案例查询**（第 9 节） |
| "找手册/文档/资料" | **场景 E：资料检索**（第 10 节） |
| "出测试方案/测试文档/客户交付文档（深信服风格 Word）" | **场景 F：文档产出**（第 13 节） |

A/B/C 共用下载纪律（第 4-6 节）；D/E 不需要登录；F 常组合 E（检索材料）+ 附件下载（第 13 节）。

## 1. 工具速查

| 工具 | 用途 | 登录 |
|---|---|---|
| `sangfor_quick_download` | **快路径·一句话直下**（首选）："HCI 6.12.0 C86 安装包" → 识别产品+匹配版本+下载一次完成，实测 ~2s；`with_related:true` 顺带返回关联件清单（不下） | 是 |
| `sangfor_resolve` | 快路径·只找不下：同款一句话解析出候选（id/文件名/大小/MD5/命中理由），多候选时让用户挑 | 是 |
| `sangfor_login` / `sangfor_login_status` / `sangfor_login_poll` / `sangfor_captcha` | 登录态管理 | - |
| `sangfor_products` | 产品线树（product_id） | 否 |
| `sangfor_software_versions` | 产品版本筛选项 | 是 |
| `sangfor_software_list` | 软件包列表（id/文件名/大小/MD5） | 是 |
| `sangfor_related` | 关联发现：基础包+补丁候选+工具+手册配套表；`latest:true` 自动定位最新版本 | 是 |
| `sangfor_lifecycle` | 版本生命周期：产品线/版本列表/**GA 与 EOS 停服日期**（STS/LTS） | 否 |
| `sangfor_software_download` | 下载（8线程/自动选盘/MD5/续传，>500MB 转后台） | 是 |
| `sangfor_download_status` | 后台下载进度 | - |
| `sangfor_search` | 全站搜索（文档/软件/案例聚合） | 否 |
| `sangfor_case_search` / `sangfor_case_detail` / `sangfor_case_filters` | 排障案例 | 否 |
| `sangfor_doc_read` | 读文档正文，可落盘 .md | 否 |

## 2. 登录（碰 list/related/download 前置）

查资料/案例/文档/lifecycle **不需要登录**。需要登录时：

1. `sangfor_login_status` → 已登录跳过。
2. **扫码展示在对话里（标准做法）**：`sangfor_login {method:"qrcode", qr_html_dir:"<可视化目录>"}`——支持富媒体内嵌展示的 Agent 填其会话可视化/资源目录，返回里会给 `::visualize{"path":"..."}` 行，**原样输出这行**二维码直接内嵌给用户扫（比弹窗图片可靠）；不支持内嵌的 Agent 不传该参数，展示 auth/qr.png 或弹窗即可。二维码约 4 分钟有效，过期重新生成。
3. 密码方式：`sangfor_login method=password`（账号密码）。建议 `store:true` 存凭据开自动重登；扫码登录不存凭据，下次过期还得扫。
4. 要图形验证码 → `sangfor_captcha` 取图，看图输码带 `captcha` 重试。
5. MCP 进程是旧代码时（改码后未重连）绕道：`node cli.mjs login --qr`。

## 3. 场景 A：点单下载

**默认走快路径（一次调用，秒级返回）**：

```
sangfor_quick_download {query:"HCI 6.12.0 C86 安装包", with_related:true, save_dir:"<项目>\<01-基础包>"}
```

一句话写法 = 产品别名（HCI/SCP/aDesk/VDC/AF/AC/SIP/aTrust/aES）+ 版本（6.12.0）+ build（C86，可选）+ 类型（安装包/升级包/补丁/工具/镜像，可选）。工具内部自动登录、识别产品、匹配版本与 build、排序打分（平台主件优先、仲裁/模板等衍生件压后），命中多个相近候选时**不会瞎猜**——返回候选清单，把文件名带上重试即可。

- `with_related:true` 的返回里附带补丁候选/工具/手册配套表清单（未下载）→ 按第 4 节问用户 → 要的逐个补下（手册用 `sangfor_doc_read` 落盘 04-文档）。
- 只想看不下的：`sangfor_resolve {query:"VDC 最新 镜像"}`。

**速度纪律（硬性）**：常规点单一律 quick_download，**禁止** login_status → products → search → list 长链路起步（登录和发现都在工具内部自动完成）。只在快路径返回候选要人挑、或需要浏览全量列表时才落精细流程。

**精细流程（备用）**：

```
1. 定位：sangfor_products {keyword} 拿 product_id
   ⚠ 产品树不全（HCI/SCP 偶发不在树里）→ 免登录 sangfor_search {keyword:"包名"}
     从返回"热门产品"聚合（如 33×3487）反查 product_id
   已知：超融合 HCI=33、云管 SCP=36、桌面云 aDesk=26、AF=13、AC=22、SIP=24
2. 发现：sangfor_related {product_id, base_keyword:"6.12.0"}   # 或 latest:true 自动取最新
3. 附加件先问后下（第 4 节，硬性）
4. 下载：sangfor_software_download {product_id, filename:"...", save_dir:"<分类目录>"}
5. 手册落盘：sangfor_doc_read {doc_url, save_dir:"<04-文档>"}
6. 交付清单（第 6 节）
```

定位技巧：优先用**版本号关键词**过滤列表（如 6.12、5.9.8），别整页翻；类目由工具自动发现合并。引用包下载给 `filename`（+product_id）比裸 `file_id` 好——自动带站点 MD5 校验。`save_dir` 必须绝对路径。

## 4. 附加件"先问后下"（硬性规则）

`sangfor_related` 返回后，**不要直接下附加件**。汇总成清单问用户：

```
基础包之外发现这些关联件，需要一起下载吗？
① 补丁候选 2 个（共 1.2GB）：HCI6.12.0R1补丁包.zip、…  ⚠ 名称启发式，需配套表核对
② 相关工具 1 个（86MB）：HCI升级导航工具.zip
③ 手册/配套表 3 篇（小文件）：升级手册、版本配套表、升级前置检查
```

- 对话直接问，或 AskUserQuestion（multiSelect：补丁/工具/文档）。
- **建议默认**：③文档要（小且交付必需）；①补丁经配套表核对通过后再确认；②工具按需。
- **核对补丁**：`sangfor_doc_read` 打开版本配套表 → 确认候选补丁与基础包版本配套 → 剔除不配套的，把核对结论告诉用户；找不到配套表时明确说"补丁未核对，建议人工确认"。
- **无人值守（收不到回答）**：只下用户点名的核心包；附加件写进交付报告「待确认清单」，不擅自下载。

## 5. 文件夹分类约定

项目目录名：客户/项目名；没给就用 `日期-产品-版本`（如 `20261020-HCI-6.12.0-C86`）。

```
<下载根>\<项目标识>\
  01-基础包\     # ISO/vma 安装包、升级包
  02-补丁\       # 核对通过的补丁
  03-工具\       # 升级导航工具等
  04-文档\       # 升级手册、版本配套表、前置检查（.md 落盘）
  交付清单.md
```

每个文件用 `save_dir` 指到对应子目录。不指定时的自动选盘：默认当前用户系统下载文件夹（可用 MCP env `SANGFOR_DOWNLOAD_DIR` 改默认根）→ 空间不足（需 15%+512MB 余量）换剩余最大的**非系统盘** `X:\Download\Sangfor` → 系统盘（C:）只作显式指定目录、不作自动备选，放不下报错并列各盘余量。

## 6. 交付清单（下载完必须输出，同时落盘 交付清单.md）

```markdown
# 交付清单：<项目标识>
| # | 文件 | 版本 | 大小 | MD5 | 校验 | 路径 |
|---|---|---|---|---|---|---|
| 1 | HCI6.12.0_C86(20260828).iso | 6.12.0 C86 | 4.29GB | abc... | ✅一致 | ...\01-基础包\ |
配套关系：HCI 6.12.0 ↔ SCP 6.12.x ↔ VDI 5.9.8（引自版本配套表 <链接>）
EOS 备注：HCI6.12.0 停服 2029-08-31（STS）
待确认：[无人值守时列附加件]
```

全部"✅一致"才算完成；站点没给 MD5 的注明是实际计算值。完整性以 MD5 为准（站点 size 是显示字符串，工具已归一化为近似字节）。

## 7. 场景 B：文档/订单驱动的升级核对（最有价值的流程）

输入是用户给的本地文件（订单、实施文档、测试文档——Word/PDF/Excel 用对应技能读）。目标：**从文档提取产品与版本 → 查最新版本与停服状态 → 产出升级清单 → 确认后分类下载**。

1. **提取**：产品（HCI/SCP/aDesk/VDC/AC/AF/EDS/aES…）、现网/发货版本（如 6.0.7、5.9.8）、数量与型号。文档信息不全时列出来问用户，不要猜。
2. **定位产品**：`sangfor_products` / `sangfor_search` 反查 → product_id（或跳过：quick_download/resolve 直接一句话识别）。
3. **最新版本**：`sangfor_resolve {query:"<产品> 最新 安装包"}`（快）或 `sangfor_related {product_id, latest:true}`（顺带关联件）→ 最新基础包 + 识别版本号。
4. **生命周期检查**：`sangfor_lifecycle action=eos version_name:"<现网版本>"` 与 `"<最新版本>"`。
   - 现网版本 EOS 临近（<1 年）→ **主动提醒**规划升级；LTS 优于 STS（长期维护优先 LTS）。
5. **升级路径核对**：`sangfor_search {keyword:"<产品> <现网版本> 升级 路径"}` → `sangfor_doc_read` 读升级路径/升级指导，确认能否直接升、要不要跨版本、要不要前置包。
6. **多产品配套**（aDesk/桌面云必做）：HCI、SCP、VDC/VDI 互相配套，用配套表核对整套组合（如 HCI 6.12.0 ↔ SCP 6.12.x ↔ VDI 5.9.8），别单升一个。
7. **产出升级清单 + 问用户确认**：目标版本基础包 + 配套补丁（核对过）+ 工具 + 手册/配套表 + 预估总体积。尤其体积大或文档版本与最新差异大时，让用户拍板目标版本（发货版本 ≠ 必须升到最新）。
8. 确认后按场景 A 第 4-6 步执行（附加件询问在此合并完成）。

## 8. 场景 C：版本升级核对（口头问）

现网版本 → 目标版本三件事：`sangfor_lifecycle eos`（两端 GA/EOS）、升级路径文档（search + doc_read）、配套表（多产品）。结论一句话给：能否直接升、要跨哪些版本、目标是否 LTS、EOS 还剩多久。

## 9. 场景 D：案例查询

```
sangfor_case_filters {}                                  → 产品线树
sangfor_case_search {keyword:"VDC 时间同步", product_line_id:26}  → 案例 id
sangfor_case_detail {case_id:10843}                      → 正文
```

关键词用「产品特性 + 故障现象」，命中太多再加 module 过滤。升级类交付可顺手搜"升级 失败"前 3 条作参考（可选，放 04-文档）。

- **案例搜索第一页即相关度排序**（站点 pageNum 0 基已在工具内处理），标题含关键词的案例在前列；`sangfor_case_search` 命中不理想就换 `sangfor_search` 全站搜——**案例结果会带"案例 id=xxx"行，直接传 sangfor_case_detail 看正文**（页面 URL 的 category_id 就是案例 id）。
- 案例正文偶报"仅深信服员工可见"= 站点权限判定抖动（同账号过会儿就能读），工具已自动重试 3 次；仍失败稍后再试，持续失败才是真权限墙（内部 KB）。

## 10. 场景 E：资料检索

`sangfor_search {keyword, type}` 聚合搜（2≈文档 5≈软件 1≈案例）→ `sangfor_doc_read {doc_url, save_dir}` 读正文/落盘。找安装包时注意区分"安装包/升级包/补丁包/工具"。

## 11. 下载行为（工具自动处理，需要知道）

- **多线程**：默认 8 线程分段（mdown 引擎），CDN 支持 Range 才启用，否则自动回退单线程；`threads` 可调 1-32。实测峰值 ~33MB/s。
- **MD5**：filename 定位自动带站点 MD5，整文件校验，不符删坏文件报错；站点没给 MD5 时报告实际计算值。
- **断点续传**：中断后重新调用同一下载，从 `.mdown` 断点继续（签名 URL 轮换会自动沿用仍有效的旧 URL）。
- **同名旧文件**：目标已存在且 MD5 不一致 → 挪开成 `xxx.旧-<时间戳>`；一致直接复用。`.旧-` 文件确认无用后让用户手动清理，别自动删。
- **>500MB 自动转后台**（返回 job_id），`sangfor_download_status {job_id}` 轮询；别同时发起太多大文件（8 线程已吃满带宽）。
- 落盘名若出现 `sangfor_file_<id>` 兜底名，真实文件名从 CDN URL 里取（如 `HCI6.12.0_C86(20260828).iso`）手动重命名。

## 12. 经验与坑（实战验证过）

- **SCP/VDC 安装包是 `.vma`（虚拟机模板）不是 ISO**；HCI 全新安装才是 ISO。镜像需求默认下安装包 ISO。
- **"598" = VDI 5.9.8 版本号**，不是 build 号。实测：HCI 6.12.0（C86）version_id=2046；"C86" 是 build 标识，同版本不同 build 并存时按文档要求选。
- 站点偶发抽风（空文档/500）：重试一次即好，别急着改代码。
- **MCP 是 stdio 常驻进程：改了 `sangfor-mcp` 代码要重连 MCP（或重启会话）才生效**。没重连时绕道：node 直调 `sangfor-mcp\lib\` 模块（`loadSession()` 读同一份 `auth/session.json`），登录走 `cli.mjs`。
- `save_dir` 必须绝对路径（`D:RyanDownload` 这类盘符相对路径会落错目录）。
- Git Bash 下临时脚本一律写 .mjs 文件再 `node xxx.mjs`，别用 `node -e`（bash 吃反斜杠和反引号）。
- 红线：公司材料与客户文件只在本机处理，不出本机、不进公开仓库。

## 13. 场景 F：深信服风格测试方案/客户交付文档产出

**工具包：本技能目录 `docx-kit/`（素材+脚本+README 完整配方）。客户版测试方案（generate.js）/ 内部实施手册（generate_internal.js）的生成脚本范式与管线顺序见 docx-kit/README.md。**

### 13.1 硬性规则

1. **版式必须 1:1 复刻 support 官方模板**（基准=《深信服全网行为管理AC测试方案》），禁用自创封面/配色。版式 token、章节骨架、生成管线全在 `docx-kit/README.md`。
2. **客户版 / 内部实施手册双轨**：客户文档只写测试本身；材料获取位置、接口人、内部流程文档引用、软件包明细（MD5/大小/渠道）、产线分责、集中排障附录一律进《内部实施手册》（同版式、密级=内部资料）。完整禁写清单见 README「客户版/内部版双轨口径」。
3. 模板附件下载：文档页 HTML 里附件真实地址为 `/supportFile/getFile/<attachment-id>`，用 `docx-kit/fetch-attachment.mjs`（在 sangfor-mcp 目录内跑，复用登录态；URL 参数必须完整 https:// 开头）。
4. 交付前两道门：`postcheck.py` 全绿（封面满幅曲线的 image-overflow 是已知误报）+ visual-judge 子代理逐页视觉验收。
5. **用户改过的已交付文档绝不重新生成覆盖**：先备份 → `extract_docx_text.py` 提取 → 与原始版两轮 diff（先滤 Word 重存噪音：TOC 条目文本带页码后缀、Heading 样式 ID 变数字）→ 归类真实增删 → 悬空引用用 lxml 修（TOC 条目在 `w:sdt` 里且文本在 `w:hyperlink` 内，`paragraphs`/`.text` 拿不到）。

### 13.2 生成管线速查

```
node generate.js                     # 弯引号必须 \u201c\u201d 转义；混排标题手工分行，禁 calcTitleLayout 自动断（会拆断 XDR/GPT）
→ add_toc_placeholders --auto → fix_toc_first_entry → postprocess_footers（节序变了改 fmt_by_index）
→ 渲染 PDF → compute_toc_entries.py 反推页码 → 重新生成 → add_toc_placeholders --entries（subprocess 传 JSON 防 shell 乱码）
→ 后处理重跑 → postcheck → LibreOffice 渲染 → visual-judge 验收
```
