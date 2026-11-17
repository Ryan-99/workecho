#!/usr/bin/env node
// sangfor-mcp 多平台注册器：检测 → 注册 → 体检（单文件零依赖，跨 Windows/macOS/Linux）
//   node setup.mjs                    自检（node/stdio 握手/tools/list）+ 全客户端体检矩阵 + 打印注册片段
//   node setup.mjs --install          自检通过后注册进所有「已安装」客户端（逐个自动备份原配置）
//   node setup.mjs --install --client zcode,cursor   只注册指定客户端
//   node setup.mjs --remove [--client ...]           从客户端移除注册
//   node setup.mjs --write-zcode      旧参数兼容 = --install --client zcode
//
// 解决"注册了但 MCP 拉不起来"的三类根因（全部来自真实翻车史）：
//   1) command 用裸 "node"，GUI 客户端进程 PATH 与终端不同 → 自动用 process.execPath 绝对路径
//   2) ZCode 桌面端 schema 严格：缺 "type":"stdio"、未知键、command 数组都会整条静默丢弃（2026-11-02）
//   3) 同 scope 其他段（如 hooks）不合法会把整份用户配置拖下水 → doctor 检出"配置文件解析失败"（2026-11-11）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgDir = path.dirname(fileURLToPath(import.meta.url));
const serverJs = path.join(pkgDir, 'server.mjs');
const nodeExe = process.execPath;
const serverJsSlash = serverJs.replaceAll('\\', '/');

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const clientArg = args.find((a) => a.startsWith('--client'))?.split('=').pop();
const wantedClients = clientArg ? clientArg.split(',').map((s) => s.trim()) : null;
const doInstall = has('--install') || has('--write-zcode');
const doRemove = has('--remove');

const downloadsDir = path.join(os.homedir(), 'Downloads').replaceAll('\\', '/');
const backupFile = (p) => {
  const backup = p + '.bak-' + new Date().toISOString().replaceAll(':', '').replaceAll('-', '').slice(0, 15);
  fs.copyFileSync(p, backup);
  return backup;
};

// ---------- 通用 JSON 读写（保序、写后回读校验） ----------
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const writeJson = (p, cfg) => {
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n');
  readJson(p); // 写后回读：保证落盘即合法
};

// ---------- 形状检查（doctor 用，键名白名单来自各家翻车史） ----------
const checkEntry = (client, entry, problems) => {
  if (entry == null || typeof entry !== 'object' || Array.isArray(entry)) {
    problems.push('条目不是对象');
    return;
  }
  const keys = Object.keys(entry);
  for (const k of keys) {
    if (!client.allowKeys.includes(k)) problems.push(`未知键 "${k}"（严格解析器会整条丢弃）`);
  }
  if (client.requireType && entry.type !== 'stdio') problems.push(`缺 "type":"stdio"（会整条静默丢弃）`);
  if (typeof entry.command !== 'string' || !entry.command) problems.push('command 必须是非空字符串（数组形式=OpenCode 风格，不兼容）');
  else if (!path.isAbsolute(entry.command) && !entry.command.includes('/') && !entry.command.includes('\\')) {
    problems.push('command 是裸命令名，GUI 客户端 PATH 不同可能找不到');
  }
  if (entry.args !== undefined && (!Array.isArray(entry.args) || !entry.args.every((a) => typeof a === 'string'))) {
    problems.push('args 必须是字符串数组');
  }
  if (entry.env !== undefined && (typeof entry.env !== 'object' || entry.env === null || Array.isArray(entry.env) ||
      !Object.values(entry.env).every((v) => typeof v === 'string'))) {
    problems.push('env 必须是字符串键值对象');
  }
};

// ---------- 客户端适配器表 ----------
// entry() 返回该客户端的原生条目形状；allowKeys 供 doctor 按各家 schema 宽严检查。
const CLIENTS = [
  {
    id: 'zcode', name: 'ZCode',
    detect: () => fs.existsSync(path.join(os.homedir(), '.zcode')),
    configPath: () => path.join(os.homedir(), '.zcode', 'cli', 'config.json'),
    requireType: true,
    allowKeys: ['type', 'command', 'args', 'env', 'cwd', 'enabled', 'timeoutMs'],
    notes: 'schema 严格：必须显式 type:stdio；未知键整条丢弃；同文件其他段不合法会拖垮整份配置',
    entry: () => ({ type: 'stdio', command: nodeExe, args: [serverJs], env: { SANGFOR_DOWNLOAD_DIR: downloadsDir } }),
    getEntry: (cfg) => cfg?.mcp?.servers?.sangfor,
    setEntry: (cfg, e) => { cfg.mcp ??= {}; cfg.mcp.servers ??= {}; cfg.mcp.servers.sangfor = e; },
    delEntry: (cfg) => { delete cfg?.mcp?.servers?.sangfor; },
  },
  {
    id: 'claude-code', name: 'Claude Code',
    detect: () => fs.existsSync(path.join(os.homedir(), '.claude')) || fs.existsSync(path.join(os.homedir(), '.claude.json')),
    configPath: () => path.join(os.homedir(), '.claude.json'),
    requireType: false,
    allowKeys: ['type', 'command', 'args', 'env'],
    notes: '~/.claude.json 顶层 mcpServers（用户级全项目生效）',
    entry: () => ({ type: 'stdio', command: nodeExe, args: [serverJs], env: { SANGFOR_DOWNLOAD_DIR: downloadsDir } }),
    getEntry: (cfg) => cfg?.mcpServers?.sangfor,
    setEntry: (cfg, e) => { cfg.mcpServers ??= {}; cfg.mcpServers.sangfor = e; },
    delEntry: (cfg) => { delete cfg?.mcpServers?.sangfor; },
  },
  {
    id: 'cursor', name: 'Cursor',
    detect: () => fs.existsSync(path.join(os.homedir(), '.cursor')),
    configPath: () => path.join(os.homedir(), '.cursor', 'mcp.json'),
    requireType: false,
    allowKeys: ['type', 'transport', 'name', 'command', 'args', 'env'],
    notes: '~/.cursor/mcp.json 的 mcpServers（本机 pencil 样本用 transport 字段，照抄）',
    entry: () => ({ transport: 'stdio', command: nodeExe, args: [serverJs], env: { SANGFOR_DOWNLOAD_DIR: downloadsDir } }),
    getEntry: (cfg) => cfg?.mcpServers?.sangfor,
    setEntry: (cfg, e) => { cfg.mcpServers ??= {}; cfg.mcpServers.sangfor = e; },
    delEntry: (cfg) => { delete cfg?.mcpServers?.sangfor; },
  },
  {
    id: 'codex', name: 'Codex CLI', kind: 'toml',
    detect: () => fs.existsSync(path.join(os.homedir(), '.codex', 'config.toml')),
    configPath: () => path.join(os.homedir(), '.codex', 'config.toml'),
    allowKeys: [], // TOML 形状单独检查
    notes: 'config.toml 的 [mcp_servers.sangfor]，路径用单引号字面量+正斜杠免转义',
    entryText: () => [
      '[mcp_servers.sangfor]',
      'type = "stdio"',
      `command = '${nodeExe.replaceAll('\\', '/')}'`,
      `args = ["${serverJsSlash}"]`,
      '',
      '[mcp_servers.sangfor.env]',
      `SANGFOR_DOWNLOAD_DIR = "${downloadsDir}"`,
    ].join('\n'),
    // 粗解析：找出本节并检查关键行（完整 TOML 解析对体检是杀鸡牛刀）
    getStatus: (p) => {
      const text = fs.readFileSync(p, 'utf8');
      const lines = text.split(/\r?\n/);
      const start = lines.findIndex((l) => /^\s*\[mcp_servers\.sangfor\]/.test(l));
      if (start < 0) return { registered: false };
      const end = lines.findIndex((l, i) => i > start && /^\s*\[(?!mcp_servers\.sangfor)/.test(l));
      const block = lines.slice(start, end < 0 ? lines.length : end).join('\n');
      const problems = [];
      if (!/command\s*=\s*['"]/.test(block)) problems.push('缺 command');
      if (!/args\s*=\s*\[/.test(block)) problems.push('缺 args');
      if (/command\s*=\s*"/.test(block) && block.includes('\\')) problems.push('双引号字符串里的反斜杠是转义前缀，路径会被读坏');
      return { registered: true, problems };
    },
    // 按"从节头吃到自己子表结束"的规则做 upsert / remove
    tomlReplace: (text, replacement) => {
      const lines = text.split(/\r?\n/);
      const start = lines.findIndex((l) => /^\s*\[mcp_servers\.sangfor\]/.test(l));
      if (start >= 0) {
        let end = lines.length;
        for (let i = start + 1; i < lines.length; i++) {
          if (/^\s*\[/.test(lines[i]) && !/^\s*\[mcp_servers\.sangfor[.\]]/.test(lines[i])) { end = i; break; }
        }
        lines.splice(start, end - start);
      }
      const out = replacement == null ? lines : [...lines, '', replacement].flat();
      // 去掉节移除后产生的连续空行
      return out.filter((l, i) => !(l.trim() === '' && out[i - 1]?.trim() === '')).join('\n');
    },
  },
  {
    id: 'windsurf', name: 'Windsurf',
    detect: () => fs.existsSync(path.join(os.homedir(), '.codeium', 'windsurf')),
    configPath: () => path.join(os.homedir(), '.codeium', 'windsurf', 'mcp_config.json'),
    requireType: false,
    allowKeys: ['command', 'args', 'env', 'type', 'serverUrl'],
    notes: 'mcp_config.json 的 mcpServers',
    entry: () => ({ command: nodeExe, args: [serverJs], env: { SANGFOR_DOWNLOAD_DIR: downloadsDir } }),
    getEntry: (cfg) => cfg?.mcpServers?.sangfor,
    setEntry: (cfg, e) => { cfg.mcpServers ??= {}; cfg.mcpServers.sangfor = e; },
    delEntry: (cfg) => { delete cfg?.mcpServers?.sangfor; },
  },
  {
    id: 'claude-desktop', name: 'Claude Desktop',
    detect: () => { const p = claudeDesktopPath(); return !!p && fs.existsSync(path.dirname(p)); },
    configPath: claudeDesktopPath,
    requireType: false,
    allowKeys: ['command', 'args', 'env'],
    notes: 'claude_desktop_config.json 的 mcpServers（无 type 字段）',
    entry: () => ({ command: nodeExe, args: [serverJs], env: { SANGFOR_DOWNLOAD_DIR: downloadsDir } }),
    getEntry: (cfg) => cfg?.mcpServers?.sangfor,
    setEntry: (cfg, e) => { cfg.mcpServers ??= {}; cfg.mcpServers.sangfor = e; },
    delEntry: (cfg) => { delete cfg?.mcpServers?.sangfor; },
  },
  {
    id: 'vscode', name: 'VS Code (Copilot MCP)',
    detect: () => !!vscodeUserDir(),
    configPath: () => path.join(vscodeUserDir(), 'mcp.json'),
    requireType: true,
    allowKeys: ['type', 'command', 'args', 'env'],
    notes: '用户级 mcp.json 的 servers 键（VS Code 1.99+）',
    entry: () => ({ type: 'stdio', command: nodeExe, args: [serverJs], env: { SANGFOR_DOWNLOAD_DIR: downloadsDir } }),
    getEntry: (cfg) => cfg?.servers?.sangfor,
    setEntry: (cfg, e) => { cfg.servers ??= {}; cfg.servers.sangfor = e; },
    delEntry: (cfg) => { delete cfg?.servers?.sangfor; },
  },
  {
    id: 'gemini', name: 'Gemini CLI',
    detect: () => fs.existsSync(path.join(os.homedir(), '.gemini')),
    configPath: () => path.join(os.homedir(), '.gemini', 'settings.json'),
    requireType: false,
    allowKeys: ['command', 'args', 'env', 'trust', 'timeout', 'url'],
    notes: 'settings.json 的 mcpServers',
    entry: () => ({ command: nodeExe, args: [serverJs], env: { SANGFOR_DOWNLOAD_DIR: downloadsDir } }),
    getEntry: (cfg) => cfg?.mcpServers?.sangfor,
    setEntry: (cfg, e) => { cfg.mcpServers ??= {}; cfg.mcpServers.sangfor = e; },
    delEntry: (cfg) => { delete cfg?.mcpServers?.sangfor; },
  },
  {
    id: 'agents-generic', name: '通用 .agents/mcp.json',
    detect: () => fs.existsSync(path.join(os.homedir(), '.agents')),
    configPath: () => path.join(os.homedir(), '.agents', 'mcp.json'),
    requireType: true,
    allowKeys: ['type', 'command', 'args', 'env', 'cwd'],
    notes: 'zcode 系客户端兼容回退；注意顶层键是 mcpServers 且同 scope 有 .zcode 配置时会被忽略',
    entry: () => ({ type: 'stdio', command: nodeExe, args: [serverJs], env: { SANGFOR_DOWNLOAD_DIR: downloadsDir } }),
    getEntry: (cfg) => cfg?.mcpServers?.sangfor,
    setEntry: (cfg, e) => { cfg.mcpServers ??= {}; cfg.mcpServers.sangfor = e; },
    delEntry: (cfg) => { delete cfg?.mcpServers?.sangfor; },
  },
];

function claudeDesktopPath() {
  if (process.platform === 'win32' && process.env.APPDATA) return path.join(process.env.APPDATA, 'Claude', 'claude_desktop_config.json');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  return null;
}
function vscodeUserDir() {
  if (process.platform === 'win32' && process.env.APPDATA) {
    const dir = path.join(process.env.APPDATA, 'Code', 'User');
    return fs.existsSync(dir) ? dir : null;
  }
  if (process.platform === 'darwin') {
    const dir = path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User');
    return fs.existsSync(dir) ? dir : null;
  }
  const dir = path.join(os.homedir(), '.config', 'Code', 'User');
  return fs.existsSync(dir) ? dir : null;
}

const selectedClients = CLIENTS.filter((c) => !wantedClients || wantedClients.includes(c.id));

// ---------- 自检：与客户端完全相同的方式 stdio 握手 ----------
let fail = 0;
console.log('== sangfor-mcp 自检 ==');
console.log('node:', nodeExe, '(v' + process.versions.node + ')', process.platform + '/' + os.arch());
if (Number(process.versions.node.split('.')[0]) < 18) { console.log('❌ 需要 Node ≥ 18'); fail = 1; }
if (!fs.existsSync(serverJs)) { console.log('❌ 找不到 server.mjs：' + serverJs); process.exit(1); }

const t0 = Date.now();
const proc = spawn(nodeExe, [serverJs], { stdio: ['pipe', 'pipe', 'pipe'] });
let buf = '';
const pending = new Map();
let nextId = 1;
let toolCount = 0;
proc.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    } catch { /* 忽略非 JSON 行 */ }
  }
});
let stderrTail = '';
proc.stderr.on('data', (d) => { stderrTail = (stderrTail + d.toString()).slice(-400); });
const rpc = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, resolve);
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => reject(new Error('timeout: ' + method)), 30000);
  });

try {
  const init = await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'setup-selftest', version: '1.1' },
  });
  await rpc('notifications/initialized', {});
  const tools = await rpc('tools/list', {});
  const names = (tools.result?.tools ?? []).map((t) => t.name);
  toolCount = names.length;
  console.log(`✅ stdio 握手成功（${Date.now() - t0}ms），服务器 ${init.result?.serverInfo?.name} v${init.result?.serverInfo?.version}，注册工具 ${names.length} 个`);
  if (names.length < 10) { console.log('❌ 工具数异常'); fail = 1; }
} catch (e) {
  console.log('❌ stdio 握手失败：' + e.message);
  if (stderrTail) console.log('   server stderr 尾部：' + stderrTail);
  fail = 1;
} finally {
  proc.kill();
}

// ---------- 多客户端体检矩阵 ----------
console.log('\n== 客户端体检矩阵 ==');
const statuses = new Map();
for (const client of selectedClients) {
  const cfgPath = client.configPath?.();
  const installed = client.detect();
  const status = { client, cfgPath, installed, registered: false, problems: [], fileError: null };

  if (installed && cfgPath) {
    if (client.kind === 'toml') {
      try {
        Object.assign(status, client.getStatus(cfgPath));
      } catch (e) {
        status.fileError = fs.existsSync(cfgPath) ? '配置文件读取失败：' + e.message : null;
        if (!status.fileError) status.registered = false;
      }
    } else {
      let cfg = null;
      try {
        if (fs.existsSync(cfgPath)) cfg = readJson(cfgPath);
        // 文件不存在=客户端装了但还没生成配置，属正常未注册态
      } catch (e) {
        // 整份配置解析失败=今天 2026-11-11 的翻车形态：其他段不合法把 MCP 一起拖下水
        status.fileError = '配置文件解析失败：' + e.message.slice(0, 160);
      }
      if (cfg) {
        const entry = client.getEntry(cfg);
        if (entry) {
          status.registered = true;
          status.entry = entry;
          checkEntry(client, entry, status.problems);
        }
      }
    }
  }
  statuses.set(client.id, status);

  let verdict;
  if (!installed) verdict = '未安装（跳过）';
  else if (status.fileError) verdict = '🔴 ' + status.fileError;
  else if (!status.registered) verdict = '未注册';
  else if (status.problems.length === 0) verdict = '🟢 已注册且形状正确';
  else verdict = '🟡 已注册但有隐患：' + status.problems.join('；');
  const shortPath = cfgPath ? cfgPath.replace(os.homedir(), '~') : '';
  console.log(`【${client.name}】${installed ? '已装' : '    '}  ${verdict}${status.registered || status.fileError ? '  ' + shortPath : ''}`);
}

// ---------- 注册 / 移除 ----------
const targets = selectedClients.filter((c) => statuses.get(c.id)?.installed);
if (doRemove) {
  console.log('\n== 移除注册 ==');
  for (const client of targets) {
    const cfgPath = client.configPath();
    try {
      if (client.kind === 'toml') {
        const text = fs.readFileSync(cfgPath, 'utf8');
        fs.copyFileSync(cfgPath, backupFile(cfgPath));
        fs.writeFileSync(cfgPath, client.tomlReplace(text, null));
      } else {
        if (!fs.existsSync(cfgPath)) continue;
        const cfg = readJson(cfgPath);
        if (!client.getEntry(cfg)) continue;
        fs.copyFileSync(cfgPath, backupFile(cfgPath));
        client.delEntry(cfg);
        writeJson(cfgPath, cfg);
      }
      console.log(`✅ [${client.name}] 已移除（原配置已备份）`);
    } catch (e) {
      console.log(`❌ [${client.name}] 移除失败：` + e.message);
      fail = 1;
    }
  }
} else if (doInstall) {
  if (fail) {
    console.log('\n⚠ 自检未通过，跳过写入（先修服务再注册）。');
  } else {
    console.log('\n== 注册（写入前自动备份原配置） ==');
    for (const client of targets) {
      const cfgPath = client.configPath();
      try {
        fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
        const existed = fs.existsSync(cfgPath);
        if (existed) console.log(`   [${client.name}] 原配置已备份：` + backupFile(cfgPath));
        if (client.kind === 'toml') {
          const text = existed ? fs.readFileSync(cfgPath, 'utf8') : '';
          fs.writeFileSync(cfgPath, client.tomlReplace(text, client.entryText()));
        } else {
          const cfg = existed ? readJson(cfgPath) : {};
          client.setEntry(cfg, client.entry());
          writeJson(cfgPath, cfg);
        }
        console.log(`✅ [${client.name}] 已写入 ${cfgPath.replace(os.homedir(), '~')}${client.notes ? '（' + client.notes + '）' : ''}`);
      } catch (e) {
        console.log(`❌ [${client.name}] 写入失败：` + e.message);
        fail = 1;
      }
    }
    if (!fail) console.log('\n重启对应客户端后在各自的 MCP 管理界面确认 sangfor 已连接。');
  }
}

// ---------- 未安装 / 未注册的客户端：打印可粘贴片段 ----------
if (!doRemove) {
  const printOnes = selectedClients.filter((c) => !statuses.get(c.id)?.installed || (!doInstall && !statuses.get(c.id)?.registered));
  if (printOnes.length) {
    console.log('\n== 注册片段（未注册/未安装的客户端，手动粘贴用） ==');
    for (const client of printOnes) {
      console.log(`\n【${client.name}】${client.configPath().replace(os.homedir(), '~')}${client.notes ? '（' + client.notes + '）' : ''}`);
      console.log(client.kind === 'toml' ? client.entryText() : '  ' + JSON.stringify(client.entry(), null, 2).split('\n').join('\n  '));
    }
    console.log('\n通用 stdio 参数：command=' + nodeExe + '  args=[' + serverJsSlash + ']  cwd=' + pkgDir.replaceAll('\\', '/'));
  }
}

if (!doInstall && !doRemove) {
  console.log('\n提示：--install 注册进所有已装客户端（逐个自动备份）；--client zcode,cursor 挑家；--remove 移除。');
}
process.exit(fail);
