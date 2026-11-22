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

test("describeFeedbackResult 区分突发限流与日额度耗尽", () => {
  // 突发：10 分钟 3 条撞了。让用户「明天再来」是错的——等十分钟就好。
  const burst = describeFeedbackResult({
    status: 429,
    body: '{"ok":false,"error":"rate_limited","kind":"burst","remaining":0}',
  });
  assert.equal(burst.kind, "rate_limited");
  assert.match(burst.message, /太快|稍候|分钟/);
  assert.doesNotMatch(burst.message, /明天/);

  // 日额度：真的今天没了。
  const daily = describeFeedbackResult({
    status: 429,
    body: '{"ok":false,"error":"rate_limited","kind":"daily","remaining":0}',
  });
  assert.match(daily.message, /明天/);

  // 服务端没给 kind 时保守按日额度处理，不能说「稍候再试」骗人白等。
  const unknownKind = describeFeedbackResult({
    status: 429,
    body: '{"ok":false,"error":"rate_limited","remaining":0}',
  });
  assert.match(unknownKind.message, /明天/);
});

test("describeFeedbackResult 把 400 的几种原因分开说", () => {
  // 插件 id 没在 Worker 白名单里：是版本错位，不是用户写错了字。
  const unknown = describeFeedbackResult({
    status: 400,
    body: '{"ok":false,"error":"unknown_plugin"}',
  });
  assert.equal(unknown.kind, "invalid");
  assert.match(unknown.message, /GitHub Issue/);
  assert.doesNotMatch(unknown.message, /缩短/, "不该叫用户去缩短一段本来就不长的话");

  const empty = describeFeedbackResult({ status: 400, body: '{"ok":false,"error":"empty_text"}' });
  assert.match(empty.message, /空|写点|内容/);
});

test("describeFeedbackResult 把 502 说成服务端发不出，而不是用户的错", () => {
  const smtp = describeFeedbackResult({ status: 502, body: '{"ok":false,"error":"smtp_failed"}' });
  assert.equal(smtp.ok, false);
  assert.match(smtp.message, /GitHub Issue/);
  assert.match(smtp.message, /暂时|中转|稍后/);
  assert.doesNotMatch(smtp.message, /缩短|写得|内容不合/);
});

test("describeFeedbackResult 对未知状态码与 0 也有话说", () => {
  const zero = describeFeedbackResult({ status: 0, body: "" });
  assert.equal(zero.ok, false);
  assert.match(zero.message, /连不上|网络|GitHub Issue/);
  assert.doesNotMatch(zero.message, /HTTP 0/);

  const teapot = describeFeedbackResult({ status: 418, body: "" });
  assert.match(teapot.message, /418/);
  assert.match(teapot.message, /GitHub Issue/);

  const notFound = describeFeedbackResult({ status: 404, body: '{"ok":false,"error":"not_found"}' });
  assert.match(notFound.message, /GitHub Issue/);
});

test("describeFeedbackResult 网络异常时提示检查网络或代理", () => {
  // 国内最常见的失败：workers.dev 被 DNS 污染，连接直接超时。
  // 光说「连不上」用户不知道能干什么。
  const r = describeFeedbackResult({ error: new Error("SocketException: Failed host lookup") });
  assert.equal(r.ok, false);
  assert.match(r.message, /网络|代理/);
  assert.match(r.message, /GitHub Issue/);
});

test("describeFeedbackResult 权限未生效时让用户重装，而不是去查网络", () => {
  // network: 授权是安装时授予的。从旧版本升级、没重新安装的机器就会撞这条，
  // 提示「检查网络」会让他白白排查半天。
  const r = describeFeedbackResult({
    error: new Error('plugin_http_request denied: network:ccgui-feedback.2653990378.workers.dev not granted'),
  });
  assert.equal(r.ok, false);
  assert.equal(r.kind, "denied");
  assert.match(r.message, /重新安装/);
  assert.doesNotMatch(r.message, /检查网络/);
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

test("describeQuota 中转连不上时不冒充「额度有限」", () => {
  // 「额度有限，请勿刷屏」暗示是用户发太多。可如果是网络不通，
  // 用户会一直以为是自己的问题，而不是去检查代理。
  const r = describeQuota({ offline: true });
  assert.equal(r.remaining, null);
  assert.match(r.message, /连不上|暂时|服务/);
  assert.doesNotMatch(r.message, /刷屏/, "网络故障不该说成用户刷屏");
});

test("describeQuota 额度字段是脏数据时退回安全文案而不是显示 NaN", () => {
  for (const bad of [{ remaining: "abc" }, { remaining: null }, { remaining: NaN }, {}]) {
    const r = describeQuota(bad);
    assert.equal(r.remaining, null);
    assert.doesNotMatch(r.message, /NaN|undefined/, "不能把 NaN/undefined 漏到界面上");
    assert.ok(r.message.length > 0);
  }
});
