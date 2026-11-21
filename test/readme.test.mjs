import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareReadme, truncateReadme, readmeTextFromBody } from "../src/lib/readme.mjs";

test("README 预处理：badge 链接整块删掉，不留半截括号", () => {
  const out = prepareReadme("[![build](https://img.shields.io/b.svg)](https://ci.x/y)\n# 项目");
  assert.equal(out, "# 项目");
  // 顺序写反的话这里会剩 "](https://ci.x/y)"
  assert.doesNotMatch(out, /\]\(/);
});

test("README 预处理：去 HTML 标签但保留内部文字", () => {
  const out = prepareReadme('<div align="center">\n<b>标题</b><br>下一行\n</div>');
  assert.match(out, /标题/);
  assert.doesNotMatch(out, /<|>/);
  assert.match(out, /标题\n下一行/);
});

test("README 预处理：只去掉开头是 --- 的 frontmatter，正文里的分隔线保留", () => {
  assert.equal(prepareReadme("---\ntitle: x\nslug: y\n---\n# Hi"), "# Hi");
  // 开头不是 --- 的一律不动
  assert.equal(prepareReadme("# Hi\n\n---\n\n正文"), "# Hi\n\n---\n\n正文");
});

test("README 预处理：a < b 这种小于号不会被当成标签删掉", () => {
  assert.match(prepareReadme("当 a < b 时成立"), /a < b/);
});

test("README 预处理：连续空行折叠成一段空行", () => {
  assert.equal(prepareReadme("一\n\n\n\n二"), "一\n\n二");
});

test("截断：短文本原样返回且不标截断", () => {
  const r = truncateReadme("短短一段", 2000);
  assert.equal(r.text, "短短一段");
  assert.equal(r.truncated, false);
  assert.equal(r.total, 4);
});

test("截断：在最近的换行处收口，不在句子中间硬切", () => {
  // 换行放在上限前 100 字内（落进 80%~100% 的搜索区间），应当从这里收口。
  const src = "a".repeat(1900) + "\n\n" + "x".repeat(3000);
  const r = truncateReadme(src, 2000);
  assert.equal(r.truncated, true);
  assert.equal(r.text, "a".repeat(1900), "应在换行边界收口");
});

test("截断：断点太靠前（早于 80%）时宁可硬切，不把正文砍成一句", () => {
  const src = "短\n\n" + "x".repeat(3000);
  const r = truncateReadme(src, 2000);
  assert.equal(r.truncated, true);
  assert.equal(r.text.length, 2000, "断点只在开头时不能采用，否则预览只剩 1 个字");
});

test("截断：没有换行时退到句号边界", () => {
  const src = "a".repeat(1800) + "。" + "b".repeat(400);
  const r = truncateReadme(src, 2000);
  assert.ok(r.text.endsWith("。"));
  assert.equal(r.truncated, true);
});

test("截断：完全找不到边界才硬切，且不超上限", () => {
  const r = truncateReadme("z".repeat(5000), 2000);
  assert.equal(r.text.length, 2000);
  assert.equal(r.truncated, true);
  assert.equal(r.total, 5000);
});

test("响应还原：raw 正文原样返回", () => {
  assert.equal(readmeTextFromBody("# 标题"), "# 标题");
  // 看起来像 JSON 但解析失败，退回原文
  assert.equal(readmeTextFromBody("{不是 json"), "{不是 json");
});

test("响应还原：base64 JSON 形态也能解出 UTF-8 正文", () => {
  const text = "# 中文标题\n\nREADME 正文";
  const b64 = Buffer.from(text, "utf8").toString("base64");
  const body = JSON.stringify({ encoding: "base64", content: b64.replace(/(.{20})/g, "$1\n") });
  assert.equal(readmeTextFromBody(body), text);
});

test("响应还原：非 base64 编码的 JSON 不瞎解码", () => {
  const body = JSON.stringify({ encoding: "utf-8", content: "x" });
  assert.equal(readmeTextFromBody(body), body);
});
