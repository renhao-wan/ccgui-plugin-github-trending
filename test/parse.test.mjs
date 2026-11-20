import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTrending } from "../src/lib/parse.mjs";

/** 从真实 github.com/trending 页面裁剪出的两条，保留解析依赖的全部结构。 */
const FIXTURE = `
<article class="Box-row">
  <h2 class="h3 lh-condensed">
    <a data-hydro-click="{&quot;x&quot;:1}" href="/elementalsouls/Claude-BugHunter" class="Link"><svg aria-hidden="true"><path d="M8 1.5"></path></svg>
      <span class="text-normal">
        elementalsouls /
</span>
      Claude-BugHunter</a>  </h2>
  <p class="col-9 color-fg-muted my-1 tmp-pr-4">
    A Claude Code skill bundle for bug hunting &amp; red-team work.
  </p>
  <div class="f6 color-fg-muted mt-2">
    <span class="tmp-mr-3 d-inline-block ml-0">
      <span class="repo-language-color" style="background-color: #3572A5"></span>
      <span itemprop="programmingLanguage">Python</span>
    </span>
    <a href="/elementalsouls/Claude-BugHunter/stargazers" class="Link Link--muted"><svg><path d="M8 .25"></path></svg> 12,687</a>
    <a href="/elementalsouls/Claude-BugHunter/forks" class="Link Link--muted"><svg><path d="M5 5"></path></svg> 1,601</a>
    <span class="d-inline-block"><span class="d-inline-block float-sm-right">1,349 stars today</span></span>
  </div>
</article>
<article class="Box-row">
  <h2 class="h3 lh-condensed">
    <a href="/obra/superpowers" class="Link">obra / superpowers</a>
  </h2>
  <p class="col-9 color-fg-muted my-1 tmp-pr-4">
    An agentic skills framework.
  </p>
  <div class="f6 color-fg-muted mt-2">
    <span class="tmp-mr-3 d-inline-block ml-0">
      <span class="repo-language-color" style="background-color: #89e051"></span>
      <span itemprop="programmingLanguage">Shell</span>
    </span>
    <a href="/obra/superpowers/stargazers" class="Link Link--muted"><svg></svg> 322,174</a>
    <a href="/obra/superpowers/forks" class="Link Link--muted"><svg></svg> 28,636</a>
    <span class="d-inline-block"><span>2,028 stars today</span></span>
  </div>
</article>
`;

test("parseTrending 提取全部字段", () => {
  const { repos, error } = parseTrending(FIXTURE);
  assert.equal(error, null);
  assert.equal(repos.length, 2);

  const first = repos[0];
  assert.equal(first.repo, "elementalsouls/Claude-BugHunter");
  assert.equal(first.owner, "elementalsouls");
  assert.equal(first.name, "Claude-BugHunter");
  assert.equal(first.url, "https://github.com/elementalsouls/Claude-BugHunter");
  assert.equal(first.description, "A Claude Code skill bundle for bug hunting & red-team work.");
  assert.equal(first.language, "Python");
  assert.equal(first.languageColor, "#3572A5");
  assert.equal(first.stars, 12687);
  assert.equal(first.forks, 1601);
  assert.equal(first.gain, 1349);
  assert.equal(first.gainPeriod, "daily");
});

test("parseTrending 跳过 sponsors 等非仓库链接", () => {
  const html = `<article class="Box-row"><h2><a href="/sponsors/foo">x</a><a href="/a/b">a/b</a></h2></article>`;
  const { repos } = parseTrending(html);
  assert.equal(repos.length, 1);
  assert.equal(repos[0].repo, "a/b");
});

test("parseTrending 支持周榜/月榜的增量文案", () => {
  const html = `<article class="Box-row"><h2><a href="/a/b">x</a></h2><span>12 stars this week</span></article>`;
  const { repos } = parseTrending(html);
  assert.equal(repos[0].gainPeriod, "weekly");

  const monthly = `<article class="Box-row"><h2><a href="/a/b">x</a></h2><span>9 stars this month</span></article>`;
  assert.equal(parseTrending(monthly).repos[0].gainPeriod, "monthly");
});

test("星数锚点带长 svg path 时仍能解析", () => {
  // 真实页面的 svg path 约 150 字符；GitHub 加大 badge 时会更长。
  // 旧实现写死 2000 字符窗口，超窗时星数会静默变 null。
  const html = `<article class="Box-row"><h2><a href="/a/b">x</a></h2>
<a href="/a/b/stargazers" class="Link"><svg>${"M8 1.5 ".repeat(400)}</svg> 12,687</a></article>`;
  assert.equal(parseTrending(html).repos[0].stars, 12687);
});

test("描述里的「N stars today」不会抢走真实增量", () => {
  const html = `<article class="Box-row"><h2><a href="/a/b">x</a></h2>
<p class="col-9 color-fg-muted">We got 999 stars today, wow</p>
<div class="f6"><span>5 stars today</span></div></article>`;
  assert.equal(parseTrending(html).repos[0].gain, 5);
});

test("未闭合的 article 不会拖住主线程", () => {
  // O(n²) 正则在 2MB 未闭合输入上会卡数秒；线性切分应在毫秒级返回。
  const bad = ('<article class="Box-row">' + "y".repeat(100)).repeat(16000);
  const t0 = Date.now();
  const out = parseTrending(bad);
  const elapsed = Date.now() - t0;
  assert.equal(out.error, "no_rows");
  assert.ok(elapsed < 500, `解析耗时 ${elapsed}ms，应保持线性`);
});

test("/apps/ 之类的非仓库路径不会被当成仓库", () => {
  const html = `<article class="Box-row"><h2><a href="/apps/foo">x</a><a href="/real/repo">y</a></h2></article>`;
  assert.equal(parseTrending(html).repos[0].repo, "real/repo");
});

test("parseTrending 空输入与无行分别给出可区分的错误", () => {
  assert.deepEqual(parseTrending(""), { repos: [], error: "empty_html" });
  assert.deepEqual(parseTrending("   "), { repos: [], error: "empty_html" });
  assert.equal(parseTrending("<html><body>nope</body></html>").error, "no_rows");
});

test("parseTrending 缺描述/语言时给空串而不是 undefined", () => {
  const html = `<article class="Box-row"><h2><a href="/a/b">x</a></h2></article>`;
  const { repos } = parseTrending(html);
  assert.equal(repos[0].description, "");
  assert.equal(repos[0].language, "");
  assert.equal(repos[0].stars, null);
  assert.equal(repos[0].gain, null);
});

test("parseTrending 解码实体与数字实体", () => {
  const html = `<article class="Box-row"><h2><a href="/a/b">x</a></h2><p class="col-9">&#128293; hot &mdash; ok</p></article>`;
  assert.equal(parseTrending(html).repos[0].description, "🔥 hot — ok");
});

/** 色点值会原样进渲染层的 style，不能只看正常值的用例。 */
test("语言色点只接受颜色白名单，其余一律丢弃", () => {
  const dot = (value) => `<article class="Box-row"><h2><a href="/a/b">x</a></h2>
    <span class="repo-language-color" style="background-color: ${value}"></span></article>`;
  const color = (value) => parseTrending(dot(value)).repos[0].languageColor;

  assert.equal(color("#3572A5"), "#3572A5", "正常十六进制应保留");
  assert.equal(color("#89e051"), "#89e051");
  assert.equal(color("rgb(46, 160, 67)"), "rgb(46, 160, 67)");
  assert.equal(color("rgba(46,160,67,0.5)"), "rgba(46,160,67,0.5)");

  // url() 是合法 CSS 值，会让渲染进程绕过插件的 network 白名单直接发请求
  assert.equal(color("url(https://attacker.example/x.png)"), "", "url() 必须丢弃");
  assert.equal(color("red; background: url(http://x/y)"), "");
  assert.equal(color("expression(alert(1))"), "");
  assert.equal(color("var(--evil)"), "");
  assert.equal(color(""), "");
});
