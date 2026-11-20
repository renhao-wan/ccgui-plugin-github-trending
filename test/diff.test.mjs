import { test } from "node:test";
import assert from "node:assert/strict";
import { diffSnapshot, snapshotSignature } from "../src/lib/diff.mjs";

const rows = (...repos) => repos.map((repo) => ({ repo }));

test("首次使用不标新上榜，但名次要给", () => {
  const out = diffSnapshot(rows("a/b", "c/d"), null);
  assert.equal(out.isFirstRun, true);
  assert.equal(out.dropped.length, 0);
  assert.deepEqual(out.repos.map((r) => r.isNew), [false, false]);
  // 榜单顺序本身就是排名：缺了 rank，整行标题只剩仓库名，看起来像界面坏了
  assert.deepEqual(out.repos.map((r) => r.rank), [1, 2]);
  assert.deepEqual(out.repos.map((r) => r.rankDelta), [null, null]);
});

test("空数组也算首次使用", () => {
  assert.equal(diffSnapshot(rows("a/b"), []).isFirstRun, true);
});

test("标出新上榜、掉榜与升降位", () => {
  const prev = rows("a/b", "c/d", "e/f", "g/h");
  const now = rows("a/b", "g/h", "new/one");
  const out = diffSnapshot(now, prev);

  assert.equal(out.isFirstRun, false);
  const [ab, gh, nu] = out.repos;
  assert.equal(ab.previousRank, 1);
  assert.equal(ab.rankDelta, 0);
  assert.equal(ab.isNew, false);

  assert.equal(gh.rank, 2);
  assert.equal(gh.previousRank, 4);
  assert.equal(gh.rankDelta, 2);

  assert.equal(nu.isNew, true);
  assert.equal(nu.previousRank, null);
  assert.equal(nu.rankDelta, null);

  assert.deepEqual(out.dropped.map((r) => r.repo), ["c/d", "e/f"]);
  assert.deepEqual(out.dropped.map((r) => r.previousRank), [2, 3]);
});

test("排名下降为负 delta", () => {
  const out = diffSnapshot(rows("b/b", "a/a"), rows("a/a", "b/b"));
  assert.equal(out.repos.find((r) => r.repo === "a/a").rankDelta, -1);
  assert.equal(out.repos.find((r) => r.repo === "b/b").rankDelta, 1);
});

test("忽略上一份快照里的坏行，名次按有效行重算", () => {
  const prev = [{ repo: "a/b" }, null, { repo: 42 }, { repo: "c/d" }];
  const out = diffSnapshot(rows("c/d"), prev);
  assert.equal(out.repos[0].previousRank, 2);
});

test("非数组输入不抛错", () => {
  assert.equal(diffSnapshot(null, null).repos.length, 0);
  assert.equal(diffSnapshot(rows("a/b"), "bad").isFirstRun, true);
});

test("签名只反映内容，顺序变化才算变化", () => {
  assert.equal(snapshotSignature(rows("a/b", "c/d")), "a/b|c/d");
  assert.equal(snapshotSignature(rows("c/d", "a/b")), "c/d|a/b");
  assert.equal(snapshotSignature(null), "");
});
