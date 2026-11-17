// stdio 冒烟测试：起 server 子进程，跑 initialize → tools/list → 匿名工具调用
import { spawn } from 'node:child_process';

const proc = spawn('node', ['server.mjs'], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
let buf = '';
const pending = new Map();
let nextId = 1;

proc.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    } catch {}
  }
});
proc.stderr.on('data', (d) => process.stderr.write('[server] ' + d));

function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => reject(new Error(`timeout: ${method}`)), 45000);
  });
}

const init = await rpc('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'smoke', version: '0' },
});
console.log('== initialize:', init.result?.serverInfo?.name, init.result?.serverInfo?.version);
await rpc('notifications/initialized', {});
const tools = await rpc('tools/list', {});
console.log('== tools:', tools.result.tools.map((t) => t.name).join(', '));

async function call(name, args) {
  const r = await rpc('tools/call', { name, arguments: args });
  const txt = r.result?.content?.[0]?.text ?? JSON.stringify(r);
  console.log(`\n===== ${name} ${JSON.stringify(args ?? {})} =====`);
  console.log(r.result?.isError ? '[isError] ' : '', txt.slice(0, 1200));
}

await call('sangfor_login_status', {});
await call('sangfor_products', { keyword: 'AF' });
await call('sangfor_search', { keyword: 'HCI 升级', page: 1 });
await call('sangfor_case_search', { keyword: 'VDC' });
await call('sangfor_case_filters', {});
await call('sangfor_doc_read', {
  doc_url: 'https://support.sangfor.com.cn/productDocument/read?product_id=182&version_id=962&category_id=259698',
});

// 未登录时应给出明确错误而不是崩
await call('sangfor_software_list', { product_id: 33 });
await call('sangfor_related', { product_id: 33, base_keyword: '6.12.0' });

proc.kill();
process.exit(0);
