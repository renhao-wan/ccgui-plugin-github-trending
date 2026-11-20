import { test } from "node:test";
import assert from "node:assert/strict";
import { supportsReadOnly } from "../src/lib/catalog.mjs";

test("字段缺失时视为不支持隔离只读", () => {
  // 这是 claude 在宿主里的真实形态。写成 `!== false` 会把它算成支持，
  // 宿主随即整轮拒绝：does not support isolated plugin read-only runs。
  assert.equal(supportsReadOnly({ engine: "claude", available: true }), false);
  assert.equal(supportsReadOnly({ engine: "claude", readOnly: undefined }), false);
});

test("显式 false 与各种假值都不支持", () => {
  assert.equal(supportsReadOnly({ readOnly: false }), false);
  assert.equal(supportsReadOnly({ readOnly: 0 }), false);
  assert.equal(supportsReadOnly({ readOnly: "" }), false);
  assert.equal(supportsReadOnly({ readOnly: "true" }), false, "只认布尔 true");
  assert.equal(supportsReadOnly(null), false);
  assert.equal(supportsReadOnly(undefined), false);
});

test("显式 true 才请求只读", () => {
  assert.equal(supportsReadOnly({ readOnly: true }), true);
});
