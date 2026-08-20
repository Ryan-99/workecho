/**
 * MCP (Model Context Protocol) 客户端支持。
 *
 * 读取 ~/.pi/agent/mcp-servers.json 配置，为每个 MCP server 启动 stdio 子进程，
 * 通过 JSON-RPC 发现工具，注册为 pi extension tools。
 *
 * 配置格式（mcp-servers.json）：
 * {
 *   "servers": {
 *     "my-server": {
 *       "command": "node",
 *       "args": ["/path/to/mcp-server.js"],
 *       "env": { "API_KEY": "..." }
 *     }
 *   }
 * }
 *
 * 兼容 Claude Desktop / Cursor 的 mcpServers 格式（也支持不带 "servers" 包裹的版本）。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface McpTool {
  name: string;
  description?: string;
  inputSchema: { type: string; properties?: Record<string, unknown>; required?: string[] };
}

let rpcId = 0;

/** 读取 MCP server 配置 */
function readMcpConfig(agentDir: string): Record<string, McpServerConfig> {
  const configPath = path.join(agentDir, "mcp-servers.json");
  if (!existsSync(configPath)) return {};
  try {
    const raw = JSON.parse(readFileSync(configPath, "utf-8"));
    // 兼容两种格式：{ servers: {...} } 或直接 { "server-name": {...} }
    return raw.servers ?? raw;
  } catch {
    return {};
  }
}

/** 启动 MCP server 子进程并返回 JSON-RPC 通信接口 */
class McpConnection {
  private proc: ChildProcess;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private buffer = "";

  constructor(config: McpServerConfig) {
    this.proc = spawn(config.command, config.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...config.env },
    });

    this.proc.stdout?.on("data", (chunk) => {
      this.buffer += chunk.toString();
      this.processBuffer();
    });
    this.proc.stderr?.on("data", (chunk) => {
      console.warn(`[mcp] stderr:`, chunk.toString().trim());
    });
    this.proc.on("error", (e) => console.error(`[mcp] 进程错误:`, e.message));
    this.proc.on("exit", (code) => console.warn(`[mcp] 进程退出 code=${code}`));
  }

  private processBuffer() {
    // MCP 用换行分隔的 JSON-RPC 消息
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed);
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          if (msg.error) reject(new Error(msg.error.message ?? "MCP error"));
          else resolve(msg.result);
        }
      } catch {}
    }
  }

  async send(method: string, params?: unknown): Promise<any> {
    const id = ++rpcId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      this.proc.stdin?.write(msg + "\n");
      // 超时
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`MCP 请求超时: ${method}`));
        }
      }, 10000);
    });
  }

  async initialize(): Promise<void> {
    await this.send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "workbench", version: "1.0" },
    });
    await this.send("notifications/initialized");
  }

  async listTools(): Promise<McpTool[]> {
    const result = await this.send("tools/list");
    return result?.tools ?? [];
  }

  async callTool(name: string, args: unknown): Promise<unknown> {
    return this.send("tools/call", { name, arguments: args });
  }

  dispose() {
    this.proc.kill();
  }
}

/**
 * 创建 MCP extension factory。
 * 读取配置，启动所有 MCP server，发现工具，注册为 pi tools。
 */
export async function createMcpExtension(agentDir: string): Promise<ExtensionFactory | null> {
  const configs = readMcpConfig(agentDir);
  const serverNames = Object.keys(configs);
  if (serverNames.length === 0) return null;

  console.log(`[mcp] 发现 ${serverNames.length} 个 MCP server 配置: ${serverNames.join(", ")}`);

  const connections: McpConnection[] = [];
  const allTools: Array<{ serverName: string; tool: McpTool; conn: McpConnection }> = [];

  for (const name of serverNames) {
    const config = configs[name];
    if (!config) continue;
    try {
      const conn = new McpConnection(config);
      await conn.initialize();
      const tools = await conn.listTools();
      console.log(`[mcp] ${name}: 发现 ${tools.length} 个工具`);
      for (const tool of tools) {
        allTools.push({ serverName: name, tool, conn });
      }
      connections.push(conn);
    } catch (e) {
      console.warn(`[mcp] 启动 ${name} 失败:`, (e as Error).message);
    }
  }

  if (allTools.length === 0) return null;

  // 返回 extension factory，注册所有 MCP 工具
  const factory: ExtensionFactory = (pi) => {
    for (const { serverName, tool, conn } of allTools) {
      // 工具名加 server 前缀避免冲突
      const fullName = `mcp_${serverName}_${tool.name}`;
      pi.registerTool({
        name: fullName,
        label: fullName,
        description: `[MCP:${serverName}] ${tool.description ?? tool.name}`,
        parameters: (tool.inputSchema ?? { type: "object", properties: {} }) as any,
        async execute(_toolCallId: string, params: any) {
          try {
            const result = (await conn.callTool(tool.name, params)) as
              | { content?: Array<{ type?: string; text?: string }> }
              | undefined;
            // MCP 返回 { content: [{ type: "text", text: ... }] }
            const text = Array.isArray(result?.content)
              ? result.content.map((c: any) => c.text ?? "").join("\n")
              : JSON.stringify(result);
            return { content: [{ type: "text", text }], details: result };
          } catch (e) {
            return { content: [{ type: "text", text: `MCP 工具调用失败: ${(e as Error).message}` }], details: undefined };
          }
        },
      });
    }
  };

  return factory;
}
