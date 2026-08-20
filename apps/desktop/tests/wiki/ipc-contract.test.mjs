/**
 * P1 契约测试：preload ↔ PiDesktopApi 接口 ↔ main handler 三方对齐。
 *
 * 背景：preload 实际暴露 161 个方法而类型接口只声明 97 个、且无人发现
 * （积累了 148 个类型错误）；setSteeringMode 死链也是同类问题。
 * 本测试静态解析三方源码，任何一侧新增/删除方法而其他侧未同步时立即失败。
 *
 * 通道名约定：preload 优先使用 src/ipc.ts 导出的 desktopIpc 常量表
 * （字面量）；Workecho 新增通道直接用字符串字面量。两者都被解析。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const preloadSrc = readFileSync(path.join(appDir, "electron/preload.ts"), "utf-8");
const ipcSrc = readFileSync(path.join(appDir, "src/ipc.ts"), "utf-8");

/** src/ipc.ts 的 desktopIpc 常量表：属性名 → 通道字符串 */
function collectDesktopIpcTable() {
  const start = ipcSrc.indexOf("export const desktopIpc");
  assert.ok(start >= 0, "src/ipc.ts 应导出 desktopIpc 常量表");
  const body = ipcSrc.slice(start);
  const map = new Map();
  for (const m of body.matchAll(/^ {2}([a-zA-Z][a-zA-Z0-9]*):\s*"([^"]+)"/gm)) {
    map.set(m[1], m[2]);
  }
  assert.ok(map.size > 0, "desktopIpc 常量表解析结果不应为空");
  return map;
}

/** 收集 electron/ 下所有主进程源的 ipcMain.handle/on 通道名（字符串字面量或 desktopIpc.X） */
function collectMainChannels() {
  const table = collectDesktopIpcTable();
  const channels = new Set();
  const dir = path.join(appDir, "electron");
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".ts")) continue;
    const src = readFileSync(path.join(dir, f), "utf-8");
    for (const m of src.matchAll(/ipcMain\.(?:handle|on)\(\s*([^,)]+)/g)) {
      const firstArg = m[1].trim();
      const literal = firstArg.match(/^"([^"]+)"$/);
      if (literal) {
        channels.add(literal[1]);
        continue;
      }
      const ref = firstArg.match(/^desktopIpc\.([a-zA-Z][a-zA-Z0-9]*)$/);
      if (ref && table.has(ref[1])) channels.add(table.get(ref[1]));
    }
  }
  return channels;
}

/** preload 暴露的成员名（exposeInMainWorld 对象体里两空格缩进的键） */
function collectPreloadMembers() {
  const names = new Set();
  for (const m of preloadSrc.matchAll(/^ {2}([a-zA-Z][a-zA-Z0-9]*):/gm)) {
    names.add(m[1]);
  }
  return names;
}

/** preload 里所有 invoke/send/sendSync 的通道（字面量或 desktopIpc.X；其余报动态） */
function collectPreloadChannels() {
  const table = collectDesktopIpcTable();
  const channels = new Set();
  const dynamic = [];
  for (const m of preloadSrc.matchAll(/ipcRenderer\.(?:invoke|send|sendSync)\((\s*)([^,)]+)/g)) {
    const firstArg = m[2].trim();
    if (/^"[^"]*"$/.test(firstArg)) {
      channels.add(firstArg.slice(1, -1));
    } else {
      const ref = firstArg.match(/^desktopIpc\.([a-zA-Z][a-zA-Z0-9]*)$/);
      if (ref && table.has(ref[1])) {
        channels.add(table.get(ref[1]));
      } else {
        dynamic.push(firstArg);
      }
    }
  }
  return { channels, dynamic };
}

/** PiDesktopApi 接口成员名（方法 `name(` 与属性 `name:` 都算） */
function collectInterfaceMembers() {
  const start = ipcSrc.indexOf("export interface PiDesktopApi {");
  assert.ok(start >= 0, "ipc.ts 中应存在 PiDesktopApi 接口");
  const body = ipcSrc.slice(start);
  const names = new Set();
  for (const m of body.matchAll(/^ {2}([a-zA-Z][a-zA-Z0-9]*)[:(]/gm)) {
    names.add(m[1]);
  }
  return names;
}

test("preload 每个 invoke/send 通道在主进程有对应 handler", () => {
  const { channels, dynamic } = collectPreloadChannels();
  assert.deepEqual(dynamic, [], "preload 不应使用无法解析的动态通道名");
  const mainChannels = collectMainChannels();
  const missing = [...channels].filter((c) => !mainChannels.has(c));
  assert.deepEqual(
    missing,
    [],
    `以下 preload 通道没有主进程 handler（新增 IPC 时 main.ts 忘了 ipcMain.handle？）: ${missing.join(", ")}`,
  );
});

test("preload 暴露的每个成员都在 PiDesktopApi 接口有声明", () => {
  const preloadMembers = collectPreloadMembers();
  const ifaceMembers = collectInterfaceMembers();
  const missing = [...preloadMembers].filter((m) => !ifaceMembers.has(m));
  assert.deepEqual(
    missing,
    [],
    `以下 preload 成员未在 src/ipc.ts 的 PiDesktopApi 声明（类型与实现脱节，会积累 TS 错误）: ${missing.join(", ")}`,
  );
});

test("PiDesktopApi 接口的每个成员在 preload 有实现（无死接口）", () => {
  const preloadMembers = collectPreloadMembers();
  const ifaceMembers = collectInterfaceMembers();
  const dead = [...ifaceMembers].filter((m) => !preloadMembers.has(m));
  assert.deepEqual(
    dead,
    [],
    `以下接口成员 preload 未暴露（死接口或 preload 误删）: ${dead.join(", ")}`,
  );
});

test("规模回归锚点：preload 暴露面 ≥ 150 成员（意外大幅缩小时报警）", () => {
  const preloadMembers = collectPreloadMembers();
  assert.ok(
    preloadMembers.size >= 150,
    `preload 成员数 ${preloadMembers.size} 低于预期下限 150——是否误删了暴露面？`,
  );
});
