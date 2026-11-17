/**
 * 内置 MCP 安装：目录复制 + mcp-servers.json 幂等合并 + ${ENV} 解析。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installBundledMcpServers,
  resolveEnvTemplates,
  readMcpLocalSecrets,
} from "../../electron/mcp-bundled.ts";

function makeResources(root, { withSecrets = false } = {}) {
  const mcp = join(root, "mcp");
  mkdirSync(join(mcp, "channel-ops"), { recursive: true });
  writeFileSync(join(mcp, "channel-ops", "index.js"), "console.log('channel-ops')\n");
  mkdirSync(join(mcp, "sangfor-mcp"), { recursive: true });
  writeFileSync(join(mcp, "sangfor-mcp", "index.js"), "console.log('sangfor')\n");
  writeFileSync(
    join(mcp, "manifest.json"),
    JSON.stringify({
      servers: [
        {
          id: "channel-ops",
          dirname: "channel-ops",
          command: "node",
          args: ["${MCP_ROOT}/index.js"],
          env: { CHANNEL_OPS_MCP_TOKEN: "${CHANNEL_OPS_MCP_TOKEN}" },
        },
        {
          id: "sangfor-mcp",
          dirname: "sangfor-mcp",
          command: "node",
          args: ["${MCP_ROOT}/index.js"],
        },
      ],
    }),
  );
  if (withSecrets) {
    writeFileSync(
      join(mcp, "secrets.local.json"),
      JSON.stringify({ CHANNEL_OPS_MCP_TOKEN: "from-secrets-file" }),
    );
  }
  return root;
}

test("resolveEnvTemplates: process.env 优先于 secrets", () => {
  process.env.CHANNEL_OPS_MCP_TOKEN = "from-env";
  try {
    const env = resolveEnvTemplates(
      { CHANNEL_OPS_MCP_TOKEN: "${CHANNEL_OPS_MCP_TOKEN}" },
      { CHANNEL_OPS_MCP_TOKEN: "from-secrets" },
    );
    assert.equal(env.CHANNEL_OPS_MCP_TOKEN, "from-env");
  } finally {
    delete process.env.CHANNEL_OPS_MCP_TOKEN;
  }
});

test("resolveEnvTemplates: 无 env 时回退 secrets", () => {
  delete process.env.CHANNEL_OPS_MCP_TOKEN;
  const env = resolveEnvTemplates(
    { CHANNEL_OPS_MCP_TOKEN: "${CHANNEL_OPS_MCP_TOKEN}" },
    { CHANNEL_OPS_MCP_TOKEN: "from-secrets" },
  );
  assert.equal(env.CHANNEL_OPS_MCP_TOKEN, "from-secrets");
});

test("installBundledMcpServers: 首次安装写入配置与目录", () => {
  const resources = makeResources(mkdtempSync(join(tmpdir(), "mcp-res-")));
  const agentDir = mkdtempSync(join(tmpdir(), "mcp-agent-"));
  process.env.CHANNEL_OPS_MCP_TOKEN = "tok-1";
  try {
    const r = installBundledMcpServers(resources, agentDir);
    assert.deepEqual(r.installedDirs.sort(), ["channel-ops", "sangfor-mcp"]);
    assert.deepEqual(r.configuredServers.sort(), ["channel-ops", "sangfor-mcp"]);
    assert.equal(r.skippedExisting.length, 0);
    assert.ok(existsSync(join(agentDir, "bundled-mcp", "channel-ops", "index.js")));
    const cfg = JSON.parse(readFileSync(join(agentDir, "mcp-servers.json"), "utf-8"));
    assert.equal(cfg["channel-ops"].command, "node");
    assert.ok(cfg["channel-ops"].args[0].endsWith("/index.js"));
    assert.equal(cfg["channel-ops"].env.CHANNEL_OPS_MCP_TOKEN, "tok-1");
    assert.ok(cfg["sangfor-mcp"]);
  } finally {
    delete process.env.CHANNEL_OPS_MCP_TOKEN;
    rmSync(resources, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("installBundledMcpServers: 已有同名配置不覆盖", () => {
  const resources = makeResources(mkdtempSync(join(tmpdir(), "mcp-res-")));
  const agentDir = mkdtempSync(join(tmpdir(), "mcp-agent-"));
  writeFileSync(
    join(agentDir, "mcp-servers.json"),
    JSON.stringify({
      "channel-ops": { command: "python", args: ["keep-me.py"] },
    }),
  );
  try {
    const r = installBundledMcpServers(resources, agentDir);
    assert.ok(r.skippedExisting.includes("channel-ops"));
    assert.ok(r.configuredServers.includes("sangfor-mcp"));
    const cfg = JSON.parse(readFileSync(join(agentDir, "mcp-servers.json"), "utf-8"));
    assert.equal(cfg["channel-ops"].command, "python");
    assert.deepEqual(cfg["channel-ops"].args, ["keep-me.py"]);
  } finally {
    rmSync(resources, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("installBundledMcpServers: 缺密钥时只复制目录不写配置", () => {
  const resources = makeResources(mkdtempSync(join(tmpdir(), "mcp-res-")));
  const agentDir = mkdtempSync(join(tmpdir(), "mcp-agent-"));
  delete process.env.CHANNEL_OPS_MCP_TOKEN;
  try {
    const r = installBundledMcpServers(resources, agentDir);
    assert.ok(r.installedDirs.includes("channel-ops"));
    assert.ok(r.skippedMissingSecrets.includes("channel-ops"));
    assert.ok(!r.configuredServers.includes("channel-ops"));
    assert.ok(r.configuredServers.includes("sangfor-mcp"));
    assert.ok(existsSync(join(agentDir, "bundled-mcp", "channel-ops", "index.js")));
    const cfg = JSON.parse(readFileSync(join(agentDir, "mcp-servers.json"), "utf-8"));
    assert.equal(cfg["channel-ops"], undefined);
    assert.ok(cfg["sangfor-mcp"]);
  } finally {
    rmSync(resources, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("readMcpLocalSecrets: 读取 secrets.local.json", () => {
  const resources = makeResources(mkdtempSync(join(tmpdir(), "mcp-res-")), { withSecrets: true });
  try {
    const secrets = readMcpLocalSecrets(resources);
    assert.equal(secrets.CHANNEL_OPS_MCP_TOKEN, "from-secrets-file");
  } finally {
    rmSync(resources, { recursive: true, force: true });
  }
});

test("readMcpLocalSecrets: local 覆盖 packaged", () => {
  const resources = makeResources(mkdtempSync(join(tmpdir(), "mcp-res-")));
  const mcp = join(resources, "mcp");
  writeFileSync(
    join(mcp, "secrets.packaged.json"),
    JSON.stringify({ CHANNEL_OPS_MCP_TOKEN: "from-packaged", CHANNEL_OPS_MCP_URL: "https://packaged.example/mcp" }),
  );
  writeFileSync(
    join(mcp, "secrets.local.json"),
    JSON.stringify({ CHANNEL_OPS_MCP_TOKEN: "from-local" }),
  );
  try {
    const secrets = readMcpLocalSecrets(resources);
    assert.equal(secrets.CHANNEL_OPS_MCP_TOKEN, "from-local");
    assert.equal(secrets.CHANNEL_OPS_MCP_URL, "https://packaged.example/mcp");
  } finally {
    rmSync(resources, { recursive: true, force: true });
  }
});
