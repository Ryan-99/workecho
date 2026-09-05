import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CustomProviderStore } from "../dist/custom-provider-store.js";

async function makeStoreDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "custom-provider-store-test-"));
}

test("set writes api + marker; list round-trips api and defaults to completions", async () => {
  const dir = await makeStoreDir();
  try {
    const store = new CustomProviderStore(join(dir, "models.json"));
    await store.set({
      providerId: "relay-a",
      baseUrl: "https://relay.example.com/v1",
      apiKey: "sk-1",
      api: "openai-responses",
      models: [{ id: "m1" }],
    });
    await store.set({
      providerId: "plain-b",
      baseUrl: "http://localhost:8000/v1",
      models: [{ id: "m2", contextWindow: 64000 }],
    });

    const listed = await store.list();
    const relay = listed.find((entry) => entry.providerId === "relay-a");
    const plain = listed.find((entry) => entry.providerId === "plain-b");
    assert.equal(relay?.api, "openai-responses");
    assert.equal(relay?.apiKey, "sk-1");
    assert.equal(plain?.api, "openai-completions"); // 缺省落盘即 completions，回读一致
    assert.equal(plain?.apiKey, undefined); // 占位 key 不回读

    const onDisk = JSON.parse(await readFile(join(dir, "models.json"), "utf8"));
    assert.equal(onDisk.providers["plain-b"].api, "openai-completions");
    assert.equal(onDisk.providers["relay-a"].piGuiCustomEndpoint, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("hand-edited entry without marker (responses api) is listed and editable", async () => {
  const dir = await makeStoreDir();
  try {
    const modelsPath = join(dir, "models.json");
    // 模拟用户按旧提示手改的条目：无 piGuiCustomEndpoint 标记、api 为 openai-responses
    await writeFile(
      modelsPath,
      JSON.stringify({
        providers: {
          echoly: {
            baseUrl: "https://api.echoly.cn/v1",
            api: "openai-responses",
            apiKey: "sk-hand",
            models: [{ id: "kimi-k2", contextWindow: 128000 }],
          },
        },
      }),
      "utf8",
    );

    const store = new CustomProviderStore(modelsPath);
    const listed = await store.list();
    const entry = listed.find((e) => e.providerId === "echoly");
    assert.ok(entry, "hand-edited custom entry should be listed");
    assert.equal(entry?.api, "openai-responses");
    assert.equal(entry?.apiKey, "sk-hand");

    // 编辑（改 baseUrl、留空 key 沿用旧值）不再被"not managed by pi-gui"拒绝
    await store.set({
      providerId: "echoly",
      baseUrl: "https://api.echoly.cn/v2",
      apiKey: "sk-hand",
      api: "openai-responses",
      models: [{ id: "kimi-k2", contextWindow: 128000 }],
    });
    const relisted = await store.list();
    const updated = relisted.find((e) => e.providerId === "echoly");
    assert.equal(updated?.baseUrl, "https://api.echoly.cn/v2");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("entries with npm/oauth fields stay invisible and are not overwritable", async () => {
  const dir = await makeStoreDir();
  try {
    const modelsPath = join(dir, "models.json");
    await writeFile(
      modelsPath,
      JSON.stringify({
        providers: {
          packaged: { npm: "@scope/some-provider", baseUrl: "https://x.example/v1", models: [{ id: "m" }] },
          oauthish: { oauth: "radius", baseUrl: "https://y.example/v1", models: [{ id: "m" }] },
        },
      }),
      "utf8",
    );
    const store = new CustomProviderStore(modelsPath);
    assert.equal((await store.list()).length, 0);
    await assert.rejects(
      () => store.set({ providerId: "packaged", baseUrl: "https://z.example/v1", models: [{ id: "m" }] }),
      /not managed by pi-gui/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("delete removes marker entries and returns false for foreign entries", async () => {
  const dir = await makeStoreDir();
  try {
    const modelsPath = join(dir, "models.json");
    await writeFile(
      modelsPath,
      JSON.stringify({
        providers: {
          mine: { baseUrl: "https://a.example/v1", api: "openai-completions", models: [{ id: "m" }], piGuiCustomEndpoint: true },
          anthropic: { baseUrl: "https://b.example/v1", models: [{ id: "m" }] },
        },
      }),
      "utf8",
    );
    const store = new CustomProviderStore(modelsPath);
    assert.equal(await store.delete("mine"), true);
    assert.equal(await store.delete("anthropic"), false); // BUILT_IN_PROVIDER_IDS 保护
    const onDisk = JSON.parse(await readFile(modelsPath, "utf8"));
    assert.equal(onDisk.providers.mine, undefined);
    assert.ok(onDisk.providers.anthropic);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("set preserves unrelated provider fields (compat/headers) on overwrite", async () => {
  const dir = await makeStoreDir();
  try {
    const modelsPath = join(dir, "models.json");
    const store = new CustomProviderStore(modelsPath);
    await store.set({ providerId: "keep", baseUrl: "https://k.example/v1", models: [{ id: "m" }] });
    // 手动加一个 pi-gui 不管的字段
    const raw = JSON.parse(await readFile(modelsPath, "utf8"));
    raw.providers.keep.compat = { supportsStore: true };
    await writeFile(modelsPath, JSON.stringify(raw), "utf8");
    // 再编辑
    await store.set({ providerId: "keep", baseUrl: "https://k2.example/v1", apiKey: "sk-k", models: [{ id: "m" }] });
    const after = JSON.parse(await readFile(modelsPath, "utf8"));
    assert.equal(after.providers.keep.compat.supportsStore, true);
    assert.equal(after.providers.keep.baseUrl, "https://k2.example/v1");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
