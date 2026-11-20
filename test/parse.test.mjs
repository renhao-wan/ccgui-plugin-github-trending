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
