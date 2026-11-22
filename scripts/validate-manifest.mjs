#!/usr/bin/env node
// 每日热点的插件自检。
// 通用规则（manifest 形状、权限白名单、产物黑名单、权限↔用法一致性、展示素材、
// 版本一致）在 scripts/validate-core.mjs 里，四插件共用一份；这里只放本插件
// 特有的检查。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validatePlugin } from "./validate-core.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// 纯函数库与产物的一致性由 build.mjs 断言；这里确认源文件都在，
// 免得删了一个文件后只在 build 时才报错。
const LIB = [
  "parse",
  "rising",
  "diff",
  "discover",
  "filter",
  "prompt",
  "catalog",
  "markdown",
  "report",
  "readme",
  "feedback",
  "feedback-net",
];

const result = validatePlugin({
  root: ROOT,
  extraRules({ fail }) {
    for (const name of LIB) {
      if (!fs.existsSync(path.join(ROOT, "src", "lib", name + ".mjs"))) fail(`缺少 src/lib/${name}.mjs`);
    }
  },
});

process.exit(result.code);
