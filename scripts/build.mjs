#!/usr/bin/env node
/**
 * 把 src/lib/*.mjs 内联进 src/main.head.js，产出可分发的单文件 main.js。
 *
 * 宿主以 ESM blob 加载插件，不能 import 兄弟文件，所以纯函数库必须内联。
 * 库文件本身是 ESM（为了单测能直接 import），内联时要剥掉 `export ` 前缀，
 * 否则函数体里出现 `export function` 是语法错误。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const START = "/*__LIB_SOURCE__*/";
const END = "/*__LIB_SOURCE_END__*/";

const LIB_ORDER = ["parse", "rising", "diff", "prompt", "catalog"];

function stripExports(source) {
  // 只动行首的 export 关键字，避免误伤字符串里的 "export"。
  return source.replace(/^export\s+(?=(?:function|const|let|var|class)\s)/gm, "");
}

const head = fs.readFileSync(path.join(ROOT, "src", "main.head.js"), "utf8");
if (!head.includes(START) || !head.includes(END)) {
  throw new Error(`main.head.js 缺少内联标记 ${START} / ${END}`);
}
const startAt = head.indexOf(START);
const endAt = head.indexOf(END);
if (endAt < startAt) throw new Error("内联标记顺序颠倒");

const chunks = [];
for (const name of LIB_ORDER) {
  const file = path.join(ROOT, "src", "lib", name + ".mjs");
  const src = fs.readFileSync(file, "utf8");
  if (/\bimport\s/.test(src)) throw new Error(`${name}.mjs 必须零 import`);
  if (/\beval\s*\(|\bnew\s+Function\s*\(/.test(src)) throw new Error(`${name}.mjs 含禁用写法`);
  chunks.push(
    "// ---- src/lib/" + name + ".mjs ----\n" + stripExports(src).trim() + "\n",
  );
}

const body = chunks.join("\n");

// 用函数形式替换：字符串替换值会把 $&、$' 当成特殊模式。
// 连标记一起替换掉，产物里不留内联注释（标记本身没有运行时意义）。
const splice =
  head.slice(0, startAt) +
  "// ---- 以下由 src/lib/*.mjs 内联生成 ----\n" +
  body +
  head.slice(endAt + END.length);
fs.writeFileSync(path.join(ROOT, "main.js"), splice, "utf8");

// 自检：内联内容必须与源文件逐字一致（去掉 export 前缀后）。
const written = fs.readFileSync(path.join(ROOT, "main.js"), "utf8");
for (const name of LIB_ORDER) {
  const src = stripExports(fs.readFileSync(path.join(ROOT, "src", "lib", name + ".mjs"), "utf8")).trim();
  if (!written.includes(src)) throw new Error(`内联校验失败：${name}.mjs 与产物不一致`);
}
if (written.includes("__LIB_SOURCE__")) throw new Error("产物里残留内联标记");

process.stdout.write("main.js " + Buffer.byteLength(splice) + " bytes\n");
