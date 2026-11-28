#!/usr/bin/env node
/**
 * 把 plugin.libs.mjs 声明的库内联进 src/main.head.js，产出单文件 main.js。
 *
 * 宿主以 ESM blob 加载插件，不能 import 兄弟文件，所以纯函数库必须内联。
 * 骨架（读 head → 剥 export / 兄弟 import → 拼接 → 自检）在
 * ccgui-plugin-shared/build-lib 里，六插件共用一份。
 *
 * 库清单一律从 plugin.libs.mjs 读：validate-manifest.mjs 读的是同一份，
 * 两边不会漂开。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPlugin } from "ccgui-plugin-shared/build-lib";
import spec from "../plugin.libs.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const { bytes } = buildPlugin({ root: ROOT, libs: spec });
process.stdout.write("main.js " + bytes + " bytes\n");
