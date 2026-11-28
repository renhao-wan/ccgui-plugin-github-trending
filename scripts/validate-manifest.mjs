#!/usr/bin/env node
// 每日热点的插件自检。
// 通用规则（manifest 形状、权限白名单、产物黑名单、权限↔用法一致性、展示素材、
// 版本一致）在 ccgui-plugin-shared/validate-core 里，六插件共用一份；这里只声明
// 本插件特有的检查。
//
// 库清单不在这里写：读 plugin.libs.mjs，与 build.mjs 是同一份。
import { runValidateCli } from "ccgui-plugin-shared/validate-core";

runValidateCli(import.meta.url, { libSpec: "plugin.libs.mjs" }).then((r) => process.exit(r.code));
