import { test } from "node:test";
import assert from "node:assert/strict";
import {
  KEYWORD_LIMIT,
  normaliseKeyword,
  matchText,
  filterRows,
  isFiltering,
  filterScopeNote,
} from "../src/lib/filter.mjs";

const row = (repo, extra = {}) => Object.assign({ repo }, extra);

const rows = [
  row("facebook/react", { name: "react", description: "A UI library", language: "JavaScript" }),
  row("rust-lang/rust", { name: "rust", description: "Systems language", language: "Rust" }),
  row("vitejs/vite", { name: "vite", description: "Frontend tooling", language: "TypeScript" }),
];

test("筛选：空关键词原样返回，不复制也不丢行", () => {
  for (const kw of ["", "   ", null, undefined]) {
    assert.equal(filterRows(rows, kw), rows, "空词必须返回原数组引用");
  }
});

test("筛选：按仓库全名 / 单独名字 / 描述 / 语言匹配", () => {
  assert.deepEqual(filterRows(rows, "react").map((r) => r.repo), ["facebook/react"]);
  assert.deepEqual(filterRows(rows, "rust-lang").map((r) => r.repo), ["rust-lang/rust"]);
  assert.deepEqual(filterRows(rows, "frontend").map((r) => r.repo), ["vitejs/vite"]);
  assert.deepEqual(filterRows(rows, "typescript").map((r) => r.repo), ["vitejs/vite"]);
});

test("筛选：不区分大小写，输入两侧空白被忽略", () => {
  assert.deepEqual(filterRows(rows, "  REACT  ").map((r) => r.repo), ["facebook/react"]);
  assert.deepEqual(filterRows(rows, "RUST").map((r) => r.repo), ["rust-lang/rust"]);
});

test("筛选：无匹配返回空数组，不返回 null", () => {
  assert.deepEqual(filterRows(rows, "没有这个东西"), []);
});

test("筛选：不索引 star 数——那不是关键词", () => {
  const list = [row("a/b", { stars: 12345, description: "" })];
  assert.deepEqual(filterRows(list, "12345"), []);
});

test("筛选：坏行被跳过而不是抛错", () => {
  const dirty = [null, "x", 42, row("ok/one", { description: "hit" })];
  assert.deepEqual(filterRows(dirty, "hit").map((r) => r && r.repo), ["ok/one"]);
  assert.deepEqual(filterRows(null, "x"), []);
  assert.deepEqual(filterRows(undefined, "x"), []);
});

test("关键词收敛：控制字符折叠、超长截断", () => {
  assert.equal(normaliseKeyword("a\nb\tc"), "a b c");
  assert.equal(normaliseKeyword("  x  "), "x");
  assert.equal(normaliseKeyword(null), "");
  assert.equal(normaliseKeyword("x".repeat(500)).length, KEYWORD_LIMIT);
});

test("matchText：缺字段不产出 undefined 字符串", () => {
  assert.doesNotMatch(matchText({ repo: "a/b" }), /undefined|null|NaN/);
  assert.equal(matchText(null), "");
  assert.equal(matchText({}), "");
});

test("isFiltering：有词且有行才算生效", () => {
  assert.equal(isFiltering("react", rows), true);
  assert.equal(isFiltering("", rows), false);
  assert.equal(isFiltering("react", []), false);
  assert.equal(isFiltering("react", null), false);
});

test("filterScopeNote：导出标题只用一句话说明", () => {
  assert.equal(filterScopeNote("react"), "已筛选「react」");
  assert.equal(filterScopeNote("  "), "");
  assert.equal(filterScopeNote(null), "");
});
