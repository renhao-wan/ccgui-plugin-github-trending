import { test } from "node:test";
import assert from "node:assert/strict";
import { supportsReadOnly, pickWorkspace } from "../src/lib/catalog.mjs";

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

test("用户显式选择的 cwd 优先于插件数据目录", () => {
  assert.equal(pickWorkspace({ workspacePath: "/proj/mine" }, "/data/github-trending"), "/proj/mine");
});

test("没设置时落在插件数据目录", () => {
  // 挂到真实项目名下，解读会话会被那个项目的会话历史记成工作产出。
  assert.equal(pickWorkspace({ workspacePath: "" }, "/data/github-trending"), "/data/github-trending");
});

test("两者都拿不到时返回空串，由调用方报错", () => {
  assert.equal(pickWorkspace({}, ""), "");
  assert.equal(pickWorkspace(null, null), "");
  assert.equal(pickWorkspace(undefined, undefined), "");
});

test("空白设置不算显式选择", () => {
  assert.equal(pickWorkspace({ workspacePath: "   " }, "/data/x"), "/data/x");
  assert.equal(pickWorkspace({ workspacePath: " /proj/a " }, "/data/x"), "/proj/a");
});
