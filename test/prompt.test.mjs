import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDigestPrompt } from "../src/lib/prompt.mjs";

const makeRepo = (i) => ({
  repo: "owner/repo-" + i,
  language: "Python",
  stars: 1000 + i,
  gain: 100 + i,
  gainPeriod: "daily",
  isNew: i === 0,
  rankDelta: i === 1 ? 3 : 0,
  description: "desc " + i,
});

const base = (overrides = {}) => ({
  view: "trending",
  period: "daily",
  language: "",
  repos: [makeRepo(0), makeRepo(1)],
  dropped: [],
  isFirstRun: false,
  ...overrides,
});

test("prompt 带上数据范围与写作要求", () => {
  const { prompt } = buildDigestPrompt(base());
  assert.match(prompt, /GitHub Trending daily/);
  assert.match(prompt, /全文中文/);
  assert.match(prompt, /不要编造/);
});

test("每个仓库一行，含增量与新上榜标记", () => {
  const { prompt } = buildDigestPrompt(base());
  assert.match(prompt, /- owner\/repo-0 \[Python\] ★1000 \+100\/daily 新上榜 \| desc 0/);
  assert.match(prompt, /- owner\/repo-1 \[Python\] ★1001 \+101\/daily ↑3位 \| desc 1/);
});

test("语言筛选写进数据范围", () => {
  const { prompt } = buildDigestPrompt(base({ language: "Rust" }));
  assert.match(prompt, /GitHub Trending daily 榜（Rust）/);
});

test("新星库视图用不同范围描述", () => {
  const { prompt } = buildDigestPrompt(base({ view: "rising", period: "rising" }));
  assert.match(prompt, /近 7 天新建/);
});

test("首次抓取明确说明无历史对比", () => {
  const { prompt } = buildDigestPrompt(base({ isFirstRun: true }));
  assert.match(prompt, /首次抓取，无历史对比/);
});

test("超预算时截断并标注", () => {
  const many = Array.from({ length: 400 }, (_, i) => makeRepo(i));
  const out = buildDigestPrompt(base({ repos: many }), 1200);
  assert.equal(out.truncated, true);
  assert.match(out.prompt, /已截断，仅保留前 \d+ 条/);
  assert.ok(out.included < many.length);
  assert.ok(out.prompt.length < 4000, "截断后不应继续膨胀");
});

test("预算足够时不截断", () => {
  const out = buildDigestPrompt(base(), 100000);
  assert.equal(out.truncated, false);
  assert.equal(out.included, 2);
});

test("掉榜最多列 8 个并标出剩余数量", () => {
  const dropped = Array.from({ length: 11 }, (_, i) => ({ repo: "gone/repo-" + i }));
  const { prompt } = buildDigestPrompt(base({ dropped }));
  assert.match(prompt, /## 掉榜/);
  assert.match(prompt, /另有 3 个/);
});

test("超长描述被裁剪，不会把整榜挤成 0 条", () => {
  const long = { ...makeRepo(0), description: "x".repeat(20000) };
  const out = buildDigestPrompt(base({ repos: [long, makeRepo(1)] }), 3000);
  assert.equal(out.truncated, false);
  assert.equal(out.included, 2, "两条都应保留；描述被裁到上限");
  assert.ok(out.prompt.length < 3000);
});

test("单条独占预算时仍保留一条，而不是全丢", () => {
  const long = { ...makeRepo(0), description: "y".repeat(5000) };
  const out = buildDigestPrompt(base({ repos: [long] }), 2000);
  assert.equal(out.included, 1);
});

test("included 不把掉榜行算进去", () => {
  const out = buildDigestPrompt(
    base({ repos: [makeRepo(0), makeRepo(1)], dropped: [{ repo: "gone/a" }, { repo: "gone/b" }] }),
  );
  assert.equal(out.included, 2);
});

test("空榜单不抛错", () => {
  const out = buildDigestPrompt(base({ repos: [] }));
  assert.equal(out.total, 0);
  assert.equal(out.included, 0);
  assert.match(out.prompt, /共 0 个仓库/);
});

test("坏输入退化为安全默认值", () => {
  const out = buildDigestPrompt({});
  assert.match(out.prompt, /GitHub Trending daily/);
  assert.equal(out.truncated, false);
});
