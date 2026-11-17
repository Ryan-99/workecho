import { createInterface } from 'node:readline';

const token = process.env.CHANNEL_OPS_MCP_TOKEN?.trim();
let endpoint;
try {
  endpoint = new URL(process.env.CHANNEL_OPS_MCP_URL);
  const localHttp = endpoint.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname);
  if ((!localHttp && endpoint.protocol !== 'https:') || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error();
} catch {
  console.error('请设置 CHANNEL_OPS_MCP_URL 为平台 HTTPS MCP 地址，本机测试可使用回环 HTTP 地址。');
  process.exit(1);
}
if (!token || token.length < 24) {
  console.error('请在客户端环境中配置平台的 CHANNEL_OPS_MCP_TOKEN（至少 24 个字符）。');
  process.exit(1);
}

let sessionId;
let protocolVersion;
function error(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

async function relay(message) {
  const { id, method } = message;
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  if (!['initialize', 'notifications/initialized', 'tools/list', 'tools/call'].includes(method)) {
    return error(id, -32601, 'Method not found');
  }
  const headers = {
    Authorization: 'Bearer ' + token,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (method !== 'initialize') {
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;
    if (protocolVersion) headers['MCP-Protocol-Version'] = protocolVersion;
  }
  const response = await fetch(endpoint, {
    method: 'POST', headers, body: JSON.stringify(message),
    redirect: 'error', signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) {
    const hint = {401:'请核对平台和客户端的 MCP 令牌', 404:'请核对 MCP 地址', 503:'请检查平台令牌配置和数据初始化状态'}[response.status];
    return error(id, -32000, '平台返回 HTTP ' + response.status + (hint ? '，' + hint : ''));
  }
  if (id === undefined) return;
  const rpc = await response.json();
  if (rpc.jsonrpc !== '2.0' || rpc.id !== id || (!rpc.error && !rpc.result)) {
    return error(id, -32603, '平台响应与请求不匹配');
  }
  if (method === 'initialize' && rpc.result) {
    sessionId = response.headers.get('mcp-session-id');
    protocolVersion = rpc.result.protocolVersion;
  }
  return rpc;
}

function send(reply) {
  process.stdout.write(JSON.stringify(reply) + '\n');
}

for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  if (!line.trim()) continue;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    send(error(null, -32700, 'Invalid JSON'));
    continue;
  }
  if (message?.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    send(error(null, -32600, 'Invalid request'));
    continue;
  }
  try {
    const reply = await relay(message);
    if (message.id !== undefined) send(reply);
  } catch {
    if (message.id !== undefined) send(error(message.id, -32000, '无法读取平台 MCP 响应，请检查地址、网络和证书信任。'));
  }
}
