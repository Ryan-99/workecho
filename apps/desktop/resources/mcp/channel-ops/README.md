# 渠道运营管理平台 MCP 接入

适用平台 v5.30.9。接入包供外部工具查询渠道业务数据，使用平台内置只读接口。服务令牌可读取全部渠道，办事处和渠道参数仅用于筛选。仅向获准访问全平台数据的工具配置此令牌。

## 平台设置

在服务器 Docker Compose 项目的 .env 中设置 CHANNEL_OPS_MCP_TOKEN。已有令牌时沿用同一值。首次配置可在服务器执行 `openssl rand -hex 32` 生成随机令牌，保存后在该 Compose 目录运行 `docker compose up -d --no-deps app` 让应用加载配置。客户端在密钥设置或环境变量中填写同一令牌。

## HTTP 直连

在支持 Streamable HTTP 与自定义请求头的工具中添加服务 channel-ops，URL 填写平台地址加 `/api/mcp/channel-ops`。按现有部署地址举例：

```text
https://qdyy.sangforln.cloud:1443/api/mcp/channel-ops
Authorization: Bearer <平台的 MCP 令牌>
```

保存并刷新工具列表。协议版本为 2025-06-18。

## 本地命令接入

在调用端安装 Node.js 22 或更高版本。解压后，将 client.example.json 的 channel-ops 项合并到客户端 MCP 配置，修改 args 中的绝对路径和 env 中的平台 URL。另将 CHANNEL_OPS_MCP_TOKEN 注入该子进程的环境（客户端密钥设置、env 配置，或由启动客户端的进程传入）。保存后重新连接。本包只用 Node.js 内置模块，可直接运行。使用内部 CA 时通过 NODE_EXTRA_CA_CERTS 指定可信 CA 的 PEM 文件。

## 可调用工具

| 工具 | 用途 | 参数 |
| --- | --- | --- |
| list_channels | 获取渠道名称、ID、办事处、分类和等级 | office 可选 |
| get_channel_summary | 查看年度目标、本月目标与进展、当前事项和风险数量 | channelId 必填，从渠道列表获取 |
| list_operational_items | 查看运营事项的负责人、进展、下一步计划和状态 | channelId、category、status、limit 可选，默认 50 条，最多 100 条 |

示例指令：“先列出辽宁办事处的渠道，找到指定渠道后，查看它的本月目标，再列出进行中的 POC 项目。”对应事项参数示例为 `{"channelId":"替换为实际渠道ID","category":"poc","status":"进行中","limit":20}`。交付项目使用 delivery。摘要的事项计数反映当前状态。

HTTP 401 时核对令牌及长度（服务端至少要求 24 个字符），503 时检查服务端令牌配置和业务数据初始化状态。平台设置中的“其他 MCP 服务”用于平台调用外部服务。
