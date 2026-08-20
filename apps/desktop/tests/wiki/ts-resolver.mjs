/**
 * 测试运行时的模块解析注册入口。
 * 通过 --import 加载，注册 ts-resolver-hooks.mjs 为 ESM resolve 钩子。
 * 这样 electron/ 目录内部不带扩展名的 .ts 互相 import 能在 node 原生
 * type-stripping 下正确解析。
 */
import { register } from "node:module";

register("./ts-resolver-hooks.mjs", import.meta.url);
