import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TEXT_LIMIT,
  normaliseFeedbackText,
  buildIssueUrl,
  buildFeedbackPayload,
  describeFeedbackResult,
  describeQuota,
} from "../src/lib/feedback.mjs";

test("normaliseFeedbackText 折叠控制字符并限长", () => {
  assert.equal(normaliseFeedbackText("  两行\n\n文字\t带制表  "), "两行 文字 带制表");
  assert.equal(normaliseFeedbackText(null), "");
  assert.equal(normaliseFeedbackText(undefined), "");
  assert.equal(normaliseFeedbackText(123), "123");
  assert.equal(normaliseFeedbackText("\u0000\u001f\ufffd"), "");
  assert.equal(normaliseFeedbackText("a".repeat(TEXT_LIMIT + 50)).length, TEXT_LIMIT);
});

test("normaliseFeedbackText 保留中文与 emoji", () => {
  assert.equal(normaliseFeedbackText("界面卡住了 😵‍💫"), "界面卡住了 😵‍💫");
});

test("buildIssueUrl 预填标题与正文并做编码", () => {
  const url = buildIssueUrl({
    repo: "renhao-wan/ccgui-plugin-github-trending",
    pluginName: "每日热点",
    text: "设置页 #号 & 问号 ? 换行",
    pluginVersion: "0.1.0",
    hostVersion: "1.2.4",
  });
  assert.ok(url.startsWith("https://github.com/renhao-wan/ccgui-plugin-github-trending/issues/new?"));
  assert.ok(!url.includes(" "), "URL 里不能有裸空格");
  assert.ok(url.includes("title="));
  assert.ok(url.includes("body="));
  const q = new URL(url).searchParams;
  assert.equal(q.get("title"), "[反馈] 每日热点");
  assert.match(q.get("body"), /设置页 #号 & 问号 \? 换行/);
  assert.match(q.get("body"), /0\.1\.0/);
  assert.match(q.get("body"), /1\.2\.4/);
});

test("buildIssueUrl 无正文时仍生成合法链接", () => {
  const url = buildIssueUrl({ repo: "a/b", pluginName: "X", text: "", pluginVersion: "1", hostVersion: "2" });
  assert.ok(url.startsWith("https://github.com/a/b/issues/new?"));
  assert.ok(new URL(url).searchParams.get("title"));
});

test("buildFeedbackPayload 只带必要字段，不含任何本机路径", () => {
  const payload = buildFeedbackPayload({
    text: "  建议加个深色模式  ",
    pluginId: "github-trending",
    pluginVersion: "0.1.0",
    hostVersion: "1.2.4",
    now: 1795000000000,
  });
  assert.deepEqual(Object.keys(payload).sort(), ["hostVersion", "pluginId", "pluginVersion", "text", "ts"]);
  assert.equal(payload.text, "建议加个深色模式");
  assert.equal(payload.pluginId, "github-trending");
  assert.equal(payload.ts, 1795000000000);
});

test("buildFeedbackPayload 去掉插件白名单外的字段", () => {
  const payload = buildFeedbackPayload({
    text: "hi",
    pluginId: "evil",
    pluginVersion: "0",
    hostVersion: "0",
    now: 1,
    token: "secret",
    workspacePath: "D:\\secret",
  });
  assert.equal(payload.token, undefined);
  assert.equal(payload.workspacePath, undefined);
});

test("describeFeedbackResult 命中各响应分支", () => {
  assert.equal(describeFeedbackResult({ status: 200, body: '{"ok":true}' }).ok, true);

  const limited = describeFeedbackResult({
    status: 429,
    body: '{"ok":false,"error":"rate_limited","remaining":0}',
  });
  assert.equal(limited.ok, false);
  assert.equal(limited.kind, "rate_limited");
  assert.match(limited.message, /额度/);

  const rejected = describeFeedbackResult({ status: 400, body: '{"ok":false,"error":"invalid_text"}' });
  assert.equal(rejected.kind, "invalid");

  const server = describeFeedbackResult({ status: 500, body: "boom" });
  assert.equal(server.ok, false);
  assert.match(server.message, /GitHub Issue/);
});

test("describeFeedbackResult 对非 JSON 响应不抛错", () => {
  const r = describeFeedbackResult({ status: 502, body: "<html>bad gateway</html>" });
  assert.equal(r.ok, false);
  assert.equal(typeof r.message, "string");
  assert.ok(r.message.length > 0);
});

test("describeFeedbackResult 网络异常转成可读文案", () => {
  const r = describeFeedbackResult({ error: new Error("error sending request") });
  assert.equal(r.ok, false);
  assert.match(r.message, /网络|GitHub Issue/);
  const timeout = describeFeedbackResult({ error: new Error("http timeout") });
  assert.match(timeout.message, /超时|GitHub Issue/);
});

test("describeQuota 生成额度提示文案", () => {
  assert.equal(describeQuota({ remaining: 27, dailyLimit: 30 }).remaining, 27);
  assert.match(describeQuota({ remaining: 27, dailyLimit: 30 }).message, /27/);

  assert.match(describeQuota({ remaining: 0, dailyLimit: 30 }).message, /用完|明天/);

  const unknown = describeQuota(null);
  assert.equal(unknown.remaining, null);
  assert.match(unknown.message, /额度有限/);
});
