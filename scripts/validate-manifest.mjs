#!/usr/bin/env node
// 每日热点的插件自检。
// 通用规则（manifest 形状、权限白名单、产物黑名单、权限↔用法一致性、展示素材、
// 版本一致）在 ccgui-plugin-shared/validate-core 里，四插件共用一份；这里只放
// 本插件特有的检查。
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { validatePlugin } from "ccgui-plugin-shared/validate-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

// 本插件私有的纯函数库。共用库（feedback* / markdown*）在 ccgui-plugin-shared 里，
// 不在这里列——它们的存在性由下面那一段单独确认。
const LIB = ["parse", "rising", "diff", "discover", "filter", "prompt", "catalog", "report", "readme"];

// 构建时要从包里读的入口。缺任何一个，build.mjs 都会失败，但那要等到
// 跑构建才知道；这里先报出来，让 npm run validate 单独也能发现。
const SHARED_ENTRIES = ["feedback", "feedback-net", "feedback-ui", "markdown", "markdown-view"];

const result = validatePlugin({
  root: ROOT,
  extraRules({ fail }) {
    for (const name of LIB) {
      if (!fs.existsSync(path.join(ROOT, "src", "lib", name + ".mjs"))) fail(`缺少 src/lib/${name}.mjs`);
    }
    for (const name of SHARED_ENTRIES) {
      try {
        require.resolve("ccgui-plugin-shared/" + name);
      } catch {
        fail(`读不到共用库 ccgui-plugin-shared/${name}：先跑 npm install`);
      }
    }
  },
});

process.exit(result.code);
