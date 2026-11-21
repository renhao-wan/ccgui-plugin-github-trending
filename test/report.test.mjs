import assert from "node:assert/strict";
import { test } from "node:test";
import { buildBoardMarkdown } from "../src/lib/report.mjs";

const row = {
  repo: "acme/tool",
  url: "https://github.com/acme/tool",
  description: "A tiny tool",
  language: "TypeScript",
  stars: 12345,
  gain: 300,
  gainPeriod: "daily",
  rank: 3,
  isNew: true,
  ageDays: null,
};

test("导出 Markdown：标题写明时间档，条目含链接与元信息", () => {
  const md = buildBoardMarkdown({
    view: "trending",
    period: "daily",
    language: "TypeScript",
    rows: [row],
    dropped: [],
    capturedAt: "11/21 09:30",
  });
  assert.match(md, /^# 每日热点 · GitHub Trending · 今日 · TypeScript/);
  assert.match(md, /> 抓取时间 11\/21 09:30/);
  assert.match(md, /\*\*\[acme\/tool\]\(https:\/\/github\.com\/acme\/tool\)\*\*/);
  assert.match(md, /A tiny tool/);
  // 数字写法必须与界面一致，否则粘出去和屏幕上对不上
  assert.match(md, /★ 12\.3k/);
  assert.match(md, /\+300\/日/);
  assert.match(md, /新上榜/);
});

test("导出 Markdown：新星库没有名次与时间档标签", () => {
  const md = buildBoardMarkdown({
    view: "rising",
    period: "rising",
    language: "",
    rows: [{ repo: "new/kid", url: "https://github.com/new/kid", stars: 90, ageDays: 2 }],
    dropped: [],
    capturedAt: "",
  });
  assert.match(md, /^# 每日热点 · 近 7 天新星库/);
  assert.match(md, /2 天前创建/);
  assert.doesNotMatch(md, /今日|本周|本月/);
});

test("导出 Markdown：空榜单返回空串，不产出空表格", () => {
  assert.equal(buildBoardMarkdown({ view: "trending", period: "daily", rows: [], dropped: [] }), "");
  assert.equal(buildBoardMarkdown(null), "");
  // 只有掉榜、没有在榜的也属于「没内容可导」
  assert.equal(buildBoardMarkdown({ view: "trending", period: "daily", rows: [], dropped: [{ repo: "a/b" }] }), "");
});

test("导出 Markdown：缺 repo 的行被跳过，不会产出 undefined 条目", () => {
  const md = buildBoardMarkdown({
    view: "trending",
    period: "weekly",
    rows: [{ repo: "" }, null, { repo: "ok/one" }],
    dropped: [],
  });
  assert.equal((md.match(/^- /gm) || []).length, 1);
  assert.doesNotMatch(md, /undefined/);
  assert.doesNotMatch(md, /null/);
});

test("导出 Markdown：描述里的 Markdown 控制字符被转义", () => {
  const md = buildBoardMarkdown({
    view: "trending",
    period: "daily",
    rows: [{ repo: "x/y", description: "a [half link and *stars* and `code`" }],
    dropped: [],
  });
  assert.match(md, /a \\\[half link and \\\*stars\\\* and \\`code\\`/);
  // 不转义的话这里会拼出一个半开的链接，整段渲染歪掉。不用 lookbehind：
  // 「最后一个 `[` 前面必须是反斜杠」直接按位置断言即可。
  const openBracket = md.lastIndexOf("[half");
  assert.ok(openBracket > 0 && md[openBracket - 1] === "\\", "描述里的 [ 必须被转义");
});

test("导出 Markdown：URL 不是 github 形状时按仓库名重拼", () => {
  const md = buildBoardMarkdown({
    view: "trending",
    period: "daily",
    rows: [{ repo: "a/b", url: "javascript:alert(1)" }],
    dropped: [],
  });
  assert.doesNotMatch(md, /javascript:/);
  assert.match(md, /https:\/\/github\.com\/a\/b/);
});

test("导出 Markdown：掉榜单独一节，且不与在榜重复", () => {
  const md = buildBoardMarkdown({
    view: "trending",
    period: "daily",
    rows: [{ repo: "still/here" }],
    dropped: [{ repo: "gone/one" }, { repo: "gone/two" }, { repo: "" }],
  });
  assert.match(md, /## 掉榜（2）/);
  assert.match(md, /- gone\/one\n- gone\/two/);
});
