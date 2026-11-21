import { test } from "node:test";
import assert from "node:assert/strict";
import {
  STAR_BANDS,
  DISCOVER_PAGE_SIZE,
  DISCOVER_MAX_PAGE,
  SEARCH_TERM_LIMIT,
  buildDiscoverQuery,
  discoverUrl,
  buildSearchQuery,
  buildSearchSpec,
  isExactNameMatch,
  bandLabel,
  shapeDiscoverRows,
} from "../src/lib/discover.mjs";

/** 依次吐出给定值的随机源，便于把「随机」变成确定的。 */
function seeded(values) {
  let i = 0;
  return () => {
    const v = values[i % values.length];
    i += 1;
    return v;
  };
}

test("换一批：随机源决定档位与页码，都在合法范围内", () => {
  for (const r of [0, 0.19, 0.4, 0.61, 0.99]) {
    const spec = buildDiscoverQuery(seeded([r, r]));
    const idx = Math.min(STAR_BANDS.length - 1, Math.floor(r * STAR_BANDS.length));
    assert.deepEqual(spec.band, STAR_BANDS[idx], r + " 应落在对应档位");
    assert.ok(spec.page >= 1 && spec.page <= DISCOVER_MAX_PAGE);
    assert.equal(spec.perPage, DISCOVER_PAGE_SIZE);
    assert.equal(spec.sort, "stars");
    assert.equal(spec.order, "desc");
  }
});

test("换一批：页码永远不超过 1000 条上限对应的页数", () => {
  // 翻过 1000 条会 422，这里把边界写死，避免以后有人调大 DISCOVER_MAX_PAGE。
  assert.ok(DISCOVER_MAX_PAGE * DISCOVER_PAGE_SIZE <= 1000);
  for (const r of [0, 0.5, 0.999999]) {
    const spec = buildDiscoverQuery(seeded([r, 0.999999]));
    assert.ok(spec.page * spec.perPage <= 1000);
  }
});

test("换一批：query 排除 fork 与归档仓", () => {
  const spec = buildDiscoverQuery(seeded([0.5, 0.5]));
  assert.match(spec.q, /fork:false/);
  assert.match(spec.q, /archived:false/);
  assert.match(spec.q, /stars:/);
});

test("换一批：最高档是无上界写法，不是 stars:50000..0", () => {
  const spec = buildDiscoverQuery(seeded([0.999, 0]));
  assert.equal(spec.band.max, 0);
  assert.match(spec.q, /stars:>50000/);
  assert.doesNotMatch(spec.q, /\.\.0/);
});

test("换一批：随机源坏掉时不抛错，退回第一档第一页", () => {
  for (const bad of [undefined, null, 42, "x"]) {
    const spec = buildDiscoverQuery(bad);
    assert.ok(spec.q);
    assert.ok(spec.page >= 1);
  }
  // 返回 NaN 的随机源也要收敛
  const spec = buildDiscoverQuery(() => NaN);
  assert.deepEqual(spec.band, STAR_BANDS[0]);
  assert.equal(spec.page, 1);
});

test("URL 组装：参数全部编码，页数与条数都被收敛", () => {
  const url = discoverUrl({ q: "a b&c", sort: "stars", order: "desc", perPage: 999, page: 0 });
  assert.match(url, /^https:\/\/api\.github\.com\/search\/repositories\?/);
  assert.match(url, /q=a%20b%26c/);
  assert.match(url, /per_page=100/);
  assert.match(url, /page=1/);
});

test("URL 组装：缺字段时用默认值而不是 undefined", () => {
  const url = discoverUrl({});
  assert.doesNotMatch(url, /undefined|null/);
  assert.match(url, /sort=stars/);
  assert.match(url, /order=desc/);
});

test("搜索：只匹配仓库名，且排除 fork/归档", () => {
  const q = buildSearchQuery("react");
  assert.equal(q, "react in:name fork:false archived:false");
  assert.match(buildSearchQuery("  vite  "), /^vite in:name/);
  // 用户输入里的换行不能进查询语法
  assert.equal(buildSearchQuery("a\nb"), "a b in:name fork:false archived:false");
});

test("搜索：限定符语法被拆成字面量，不能借搜索框注入 stars:/language:", () => {
  // `in:name` 只作用在紧邻前一个词上，原样拼入会让 stars: 变成真正的过滤条件
  assert.equal(buildSearchQuery("stars:>100000"), "stars >100000 in:name fork:false archived:false");
  assert.equal(buildSearchQuery("language:rust"), "language rust in:name fork:false archived:false");
  // 布尔运算符不能穿透
  assert.equal(buildSearchQuery("language:rust OR repo:foo"), "language rust repo foo in:name fork:false archived:false");
  // 引号/反斜杠是转义语法，一并去掉
  assert.equal(buildSearchQuery('"a b"'), "a b in:name fork:false archived:false");
});

test("搜索：超长输入被限长，不会拼出会让网关 414 的 URL", () => {
  const q = buildSearchQuery("x".repeat(3000));
  assert.ok(q.length <= SEARCH_TERM_LIMIT + 40, "query 长度应受 SEARCH_TERM_LIMIT 约束");
  // 只剩标点在转义后应当视作空输入
  assert.equal(buildSearchQuery(":::\\\\"), null);
});

test("换一批：与上一批撞上组合时重抽一次", () => {
  const fixed = () => 0; // 恒定第一档第一页
  const first = buildDiscoverQuery(fixed);
  const again = buildDiscoverQuery(fixed, { band: first.band, page: first.page });
  // 随机源输出恒定，无法真的换一批；但不能抛错，且仍落在合法范围
  assert.ok(again.page >= 1 && again.page <= DISCOVER_MAX_PAGE);
  // 序列推进后能换到别的组合
  const seq = seeded([0, 0, 0.99, 0.99]);
  const a = buildDiscoverQuery(seq);
  const b = buildDiscoverQuery(seq, { band: a.band, page: a.page });
  assert.notEqual(b.band + ":" + b.page, a.band + ":" + a.page, "撞上时应重抽");
});

test("搜索：空输入返回 null，让调用方回到换一批", () => {
  for (const bad of ["", "   ", "\n\t", null, undefined]) {
    assert.equal(buildSearchQuery(bad), null);
    assert.equal(buildSearchSpec(bad), null);
  }
});

test("搜索：spec 走 stars 排序的第一页", () => {
  const spec = buildSearchSpec("rust");
  assert.equal(spec.page, 1);
  assert.equal(spec.sort, "stars");
  assert.equal(spec.perPage, DISCOVER_PAGE_SIZE);
  assert.match(spec.q, /^rust in:name/);
});

test("精确命中：owner/repo 与单独名字都认，模糊结果不认", () => {
  const row = { repo: "facebook/react", name: "react" };
  assert.equal(isExactNameMatch(row, "react"), true);
  assert.equal(isExactNameMatch(row, "React"), true, "不区分大小写");
  assert.equal(isExactNameMatch(row, "facebook/react"), true);
  assert.equal(isExactNameMatch(row, "react-native"), false);
  assert.equal(isExactNameMatch({ repo: "facebook/react-native", name: "react-native" }, "react"), false);
  assert.equal(isExactNameMatch(row, ""), false);
  assert.equal(isExactNameMatch(null, "react"), false);
});

test("精确命中：没有 name 字段时从 repo 里切", () => {
  assert.equal(isExactNameMatch({ repo: "a/next" }, "next"), true);
  assert.equal(isExactNameMatch({ repo: "a/next" }, "a/next"), true);
  assert.equal(isExactNameMatch({ repo: "noslash" }, "noslash"), true);
});

test("bandLabel：人类可读的 star 档", () => {
  assert.equal(bandLabel({ min: 1000, max: 3000 }), "★1k–3k");
  assert.equal(bandLabel({ min: 50000, max: 0 }), "★50k 以上");
  assert.equal(bandLabel({ min: 300, max: 1000 }), "★300–1k");
  assert.equal(bandLabel(null), "");
});

test("shapeDiscoverRows：抹掉假增量与名次", () => {
  // parseRising 把 star 总数写进了 gain，照搬会渲染成「+322k 今日」
  const rows = shapeDiscoverRows([
    { repo: "a/b", stars: 322190, gain: 322190, gainPeriod: "rising", rank: 3, rankDelta: 2, isNew: true },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].gain, null);
  assert.equal(rows[0].gainPeriod, "");
  assert.equal(rows[0].rank, null);
  assert.equal(rows[0].rankDelta, null);
  assert.equal(rows[0].isNew, false);
  assert.equal(rows[0].stars, 322190, "star 总数本身要保留");
});

test("shapeDiscoverRows：坏行剔除，不抛错", () => {
  const rows = shapeDiscoverRows([
    null,
    "x",
    { repo: "noslash" },
    { repo: "a/b" },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].repo, "a/b");
  for (const bad of [null, undefined, "x", {}]) assert.deepEqual(shapeDiscoverRows(bad), []);
});
