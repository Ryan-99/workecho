# sangfor-mcp

深信服技术支持站（support.sangfor.com.cn）的 MCP 服务器。让 AI 助手能直接：检索并下载软件镜像/补丁包（带 MD5 校验、断点续传）、搜排障案例、搜全站资料、查版本生命周期（GA/EOS 停服）。纯 HTTP 实现（逆向站点自身 API），不依赖浏览器。

**当前状态**：18 个工具，下载/列表/案例/搜索/生命周期全链路已实测通过（含 4.29GB 镜像 8 线程下载 + MD5 校验）。

## 快速开始（三步）

1. **解压** `sangfor-mcp` 到任意目录，要求 Node 18+（终端 `where node` 能找到即可；无需 npm install，依赖已随包附带）。
2. **自检 + 一键注册**（推荐顺序）：

   **① 先自检**：在 sangfor-mcp 目录里跑 `node setup.mjs` —— 用与客户端完全相同的方式（stdio 子进程）拉起 server 做握手测试，并输出**多客户端体检矩阵**（逐家检查：是否安装 / 是否已注册 / 注册形状是否会被客户端拒收）。

```
node setup.mjs                 # 自检 + 体检矩阵 + 打印未注册客户端的配置片段
node setup.mjs --install       # 注册进所有"已安装"客户端（逐个自动备份原配置，写后回读校验）
node setup.mjs --install --client zcode,cursor   # 只注册指定客户端
node setup.mjs --remove        # 从已注册客户端移除（同样自动备份）
```

   内置适配 9 类客户端（各按其**原生配置形状**写入，非通用模板硬套）：ZCode / Claude Code / Cursor / Codex CLI（TOML）/ Windsurf / Claude Desktop / VS Code (Copilot MCP) / Gemini CLI / 通用 `.agents/mcp.json`；Windows / macOS / Linux 路径规则齐备。

   **手动配置必须注意两条**（"注册了但拉不起来"的头号原因，Windows GUI 客户端尤其常见；`--install` 已自动规避）：
   - `command` 用 **node.exe 绝对路径**——GUI 客户端进程 PATH 与终端不同，裸 `"node"` 会 spawn 失败；
   - ZCode 配置必须带 **`"type": "stdio"`** 且**不要加白名单外的键**——桌面端 schema 严格，缺 type / 未知键 / command 数组都会被**静默丢弃**（2026-11-02 本机实测踩坑）；另外同文件其他段（如 hooks）不合法会把整份配置拖下水，`node setup.mjs` 的体检矩阵能直接检出这类"配置文件解析失败"（2026-11-11 踩坑）。

```json
"sangfor": {
  "type": "stdio",
  "command": "<node.exe 绝对路径>",
  "args": ["<安装目录>/sangfor-mcp/server.mjs"],
  "env": { "SANGFOR_DOWNLOAD_DIR": "D:\\Ryan\\Download" }
}
```

   其他客户端（Cline 等）用上面打印的通用 stdio 参数在各家 MCP 设置里加。**重启客户端 / 重连 MCP 后**即可用 `sangfor_*` 工具。
3. **装技能**（可选但推荐）：如果你的 Agent 支持 skills 机制，把 `skill-sangfor-support/SKILL.md` 放入其技能目录（如 `~/.agents/skills/sangfor-support/SKILL.md`）——它是完整作业流程（点单下载/文档驱动升级核对/案例查询），AI 会按流程走，少踩坑。

## 工具一览

| 工具 | 用途 | 登录 |
|---|---|---|
| `sangfor_login` | 密码 / 扫码登录 | - |
| `sangfor_login_status` | 登录状态、凭据配置 | - |
| `sangfor_login_poll` | 扫码后轮询结果 | - |
| `sangfor_captcha` | 被要求图形验证码时取图 | - |
| `sangfor_quick_download` | **快路径·一句话直下**："HCI 6.12.0 C86 安装包" → 识别+下载一次完成（~2s）；with_related 顺带给关联件清单 | 是 |
| `sangfor_resolve` | 快路径·只找不下：一句话解析出候选（打分排序，平台主件优先） | 是 |
| `sangfor_products` | 软件产品线树（product_id） | 否 |
| `sangfor_software_versions` | 产品的版本筛选项 | 是 |
| `sangfor_software_list` | 软件包列表（id/文件名/大小/MD5） | 是 |
| `sangfor_related` | 关联发现：基础包+补丁候选+工具+手册/配套表；`latest:true` 自动定位最新版本 | 是 |
| `sangfor_software_download` | 下载镜像/补丁（8线程/自动选盘/>500MB 转后台） | 是 |
| `sangfor_download_status` | 后台下载进度 | - |
| `sangfor_search` | 全站搜索（文档/软件/案例聚合） | 否 |
| `sangfor_case_filters` | 案例产品线/模块/版本 | 否 |
| `sangfor_case_search` | 排障案例搜索 | 否 |
| `sangfor_case_detail` | 案例正文 | 否 |
| `sangfor_doc_read` | 读文档正文，可落盘 .md | 否 |
| `sangfor_lifecycle` | 版本生命周期：产品线/版本列表/GA 与 EOS 停服日期（STS/LTS） | 否 |

## 首次登录

三种方式任选：

1. **扫码（推荐，无需给 AI 密码）**：让 AI 调 `sangfor_login {method:"qrcode"}`——会生成 `auth/qr.png`（部分客户端还能传 `qr_html_dir` 参数把二维码内嵌到对话里，不支持的客户端忽略该参数即可），打开图片用手机微信/深信服 App 扫一扫；也可以终端 `node cli.mjs login --qr`（弹图+终端字符画+自动轮询）。
2. **MCP 工具**：让 AI 调 `sangfor_login`（method=password，传账号密码；被要求验证码时先 `sangfor_captcha` 取图）。
3. **终端密码**：`node cli.mjs login`。

登录成功后会话 cookie 存 `auth/session.json`，之后所有会话直接可用。**`auth/` 目录是个人登录态，不要转发给别人。**

### 自动重登（推荐配置一次）

会话过期后自动用已存凭据重登，两种方式：

- 登录时传 `store=true`（或 `node cli.mjs login` 里回答 y），凭据存本机 `auth/credentials.json`；
- 或设环境变量 `SANGFOR_USERNAME` / `SANGFOR_PASSWORD`（加在 MCP 服务器的 `env` 配置里）。

凭据只落本机，不出网。

## 下载行为

- **多线程分段**：内置多线程下载引擎（`lib/mdown-engine.mjs`），默认 8 线程（`threads` 可调 1-32）；CDN 支持 Range 才分段，否则自动回退单线程。
- **自动选盘**：默认下载到当前用户的系统下载文件夹（每台机器各自的；可用环境变量 `SANGFOR_DOWNLOAD_DIR` 改，如偏好放数据盘）；空间不够（需要 15%+512MB 余量）自动换剩余空间最大的**非系统盘**的 `X:\Download\Sangfor`；系统盘（C:）只作为你指定的下载目录使用、不作自动备选。都放不下时报错并列各盘余量。`save_dir` 可显式指定。
- **关联下载**：`sangfor_related` 按基础包版本返回补丁候选、相关工具、升级手册/版本配套表文档链接。补丁是名称启发式，**须用配套表核对**（配合 `sangfor_doc_read`）。完整作业流程见技能 `sangfor-support`。
- **MD5 校验**：用 filename 定位时自动带站点 MD5；下载完整文件校验，不符自动删坏文件并报错。
- **断点续传**：`.mdown` + `.mdown.json` 进度存档；中断后重新调用即续传（签名 URL 轮换时自动沿用仍有效的旧 URL）。
- **同名旧文件**：目标已存在且 MD5 不一致 → 挪开成 `xxx.旧-<时间戳>`（含对应 .mdown 残片）；一致则直接复用。
- **后台任务**：>500MB 或 `wait:false` 立即返回 `job_id`，`sangfor_download_status` 轮询；下载在 MCP 服务进程内继续，不受单次工具调用时限影响。
- 默认保存目录可用 `SANGFOR_DOWNLOAD_DIR` 环境变量改。

### 典型用法

```text
# 关联下载：HCI 6.12.0 基础包 + 补丁 + 手册
sangfor_related {product_id:33, base_keyword:"6.12.0"}
sangfor_doc_read {doc_url:"...配套表...", save_dir:"D:\\Download\\HCI-6.12.0\\04-文档"}   # 核对补丁版本（save_dir 必须绝对路径）
sangfor_software_download {product_id:33, filename:"HCI6.12.0_X86(20260828).iso"}
sangfor_download_status {job_id:"dl_1"}
```

## 开发

```bash
npm install
node test/smoke.mjs   # stdio 冒烟测试（无需登录的部分）
```

## 使用提示与已知口径（实战验证）

- **产品树不全**：`sangfor_products` 拿不到 HCI/SCP 等（站点接口就这德行）——用免登录 `sangfor_search` 搜目标包名，从"热门产品"聚合反查 product_id（HCI=33、SCP=36、aDesk=26、AF=13、AC=22、SIP=24）。
- **案例搜索**：第一页即相关度排序；`sangfor_case_search` 命中不理想就换 `sangfor_search` 全站搜——案例结果会带"案例 id=xxx"，直接传 `sangfor_case_detail` 看正文。
- **案例正文偶报"仅深信服员工可见"**：站点权限判定抖动（同账号过会儿就能读），工具已自动重试 3 次；仍失败稍后再试。
- **软件列表 size 是显示字符串**：工具已归一化为近似字节数；文件完整性以 MD5 为准。
- **`save_dir` 必须绝对路径**（盘符相对路径会落错盘，工具已直接拒绝）。
- **改了代码要重连 MCP**：MCP 是 stdio 常驻进程，`server.mjs`/`lib/*.mjs` 改动须重连（或重启会话）才生效。
- **Windows + Git Bash 环境**：临时脚本写成 .mjs 文件再 `node xxx.mjs`，别用 `node -e`（bash 会吃反斜杠/反引号）。

## 使用红线（务必遵守）

- 本工具仅限**公司内部使用**，不进公开仓库、不上传外部服务。
- `auth/session.json`、`auth/credentials.json` 是个人登录态/凭据，**不要转发给别人、不要提交到任何仓库**。
- 客户材料与公司文件只在本机处理。

## 接口地图（逆向结论，2026-10）

- 站点约定：`GET` 走 query、`POST` 把参数作为 JSON body（服务端亦兼容 query）；请求头 `X-Requested-With: xmlhttprequest` + `Accept: application/vnd.edusoho.v2+json`；信封 `{code:200|0|666=成功, 40701=未登录}`（40002=参数缺失，如软件接口缺 `category_id`）。
- 软件：`/productSoftware/{packageApi,softwareVersionApi,softwareScreenApi,ruleApi,romApi}`（需登录，**均强制 `category_id`**，类目列表从软件下载页 SSR 左侧导航提取，工具已自动发现并跨类目合并）；产品树 `/scene/productApi?type=0|1`（匿名，不全，无 HCI）。
- 案例：`/spt/openapi/case/es/{search,getDetailById/{id},getCaseModuleList/{pid},getProductVersionList/{pid}}`（匿名可用，结果在 `rows` / `rows.content[]`；**`pageNum` 0 基**；版本列表的名字在 `code` 字段）。
- 全局搜索：`POST /search/search`（匿名可用，`data.list.list[]`，type 2≈文档 5≈软件 1≈案例；案例条目 link 的 `category_id` 即案例 id，可直取 `getDetailById`）。
- 文档正文：`/productDocument/read?product_id&version_id&category_id` SSR 页，正文在脚本变量 `var __DOC_CONTENT_HTML__ = "..."`（json_encode 字符串）里，v-html 占位为空。
- 生命周期：`GET versionQuery/lifecycleProductsApi?regions=cn`（产品线）；`POST versionQuery/lifecycleProductVersionsApi {product_id,name,code}`（版本列表）；`POST versionQuery/lifecycleVersionsApi {...,version_id}`（GA/EOS）——均匿名。
- 下载：`GET /file/downloadToUrl?url_type=6&id=<id>` → 302 链（可能经 bbs OAuth）→ 真实文件；页面内 fetch 会被 CORS 拦，Node 侧手动跟 302 + 共享 cookie 即可。
- 登录：`POST /user/loginByPwd {username,password}`（明文，多次失败才要验证码 code=40003）；扫码 `GET /user/loginByQRCode?scanStatus=1`（取二维码 URL）→ `scanStatus=2` 轮询（0 等/1 已扫/2 过期/3 成功）；会话 = `PHPSESSID` cookie。
