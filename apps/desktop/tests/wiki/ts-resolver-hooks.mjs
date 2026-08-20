/**
 * 测试专用模块解析钩子。
 *
 * Node 的 --experimental-strip-types 运行 .ts 文件时，要求相对 import 带
 * 明确扩展名。但生产代码（electron/）内部互相 import 不带扩展名（依赖
 * electron-vite 打包时解析）。这个 loader 给测试运行时补上 .ts 解析，
 * 不影响生产构建配置。
 *
 * 用法：node --import ./tests/wiki/ts-resolver.mjs --test ...
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import { isBuiltin } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export async function resolve(specifier, context, nextResolve) {
  // 只处理相对/绝对路径且无扩展名的 .ts 解析
  if (
    (specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("/")) &&
    !specifier.endsWith(".ts") &&
    !specifier.endsWith(".js") &&
    !specifier.endsWith(".mjs") &&
    !specifier.endsWith(".json") &&
    !isBuiltin(specifier)
  ) {
    const importerDir = context.parentURL ? dirname(fileURLToPath(context.parentURL)) : process.cwd();
    const candidate = join(importerDir, specifier + ".ts");
    if (existsSync(candidate)) {
      return nextResolve(pathToFileURL(candidate).href, context);
    }
  }
  return nextResolve(specifier, context);
}
