import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildDigestPrompt,
  buildDiscussPrompt,
  DEFAULT_DISCUSS_TEMPLATE,
  normalisePrompts,
  pickPrompt,
  PROMPT_COUNT_LIMIT,
  PROMPT_TEXT_LIMIT,
  RESUME_MODES,
  DEFAULT_RESUME_MODE,
  normaliseResumeMode,
  shouldResume,
  resumeModeHint,
} from "../src/lib/prompt.mjs";

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

test("要求用表格给「值得看的项目」，并固定列", () => {
  // 结果页要渲染 Markdown 表格，前提是模型真的用表格回答。
  const { prompt } = buildDigestPrompt(base());
  assert.match(prompt, /\| 仓库 \| 方向 \| 解决什么问题 \| 适合谁 \|/);
  assert.match(prompt, /### 今天在热什么/);
  assert.match(prompt, /### 一句话结论/);
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

/* ---------- 单个仓库的讨论 prompt ---------- */

const discussRow = (overrides = {}) => ({
  repo: "obra/superpowers",
  language: "Shell",
  stars: 322190,
  gain: 2028,
  gainPeriod: "daily",
  rank: 2,
  rankDelta: -1,
  description: "An agentic skills framework & software development methodology that works.",
  ...overrides,
});

test("讨论 prompt 带上仓库名、URL 与已知事实", () => {
  const p = buildDiscussPrompt({ row: discussRow(), view: "trending", period: "daily", language: "" });
  assert.match(p, /obra\/superpowers/);
  assert.match(p, /https:\/\/github\.com\/obra\/superpowers/);
  assert.match(p, /Shell/);
  assert.match(p, /322190/);
  assert.match(p, /下降 1 位/);
  assert.match(p, /GitHub Trending daily 榜/);
});

test("讨论 prompt 要求先找本地副本，找不到再读远程并说明", () => {
  const p = buildDiscussPrompt({ row: discussRow(), view: "trending", period: "weekly", language: "python" });
  assert.match(p, /本地副本/);
  assert.match(p, /没找到本地代码/);
  // 时间档与语言要如实反映，不能写死 daily
  assert.match(p, /GitHub Trending weekly 榜（python）/);
});

test("讨论 prompt 禁止编造，推测要标出来", () => {
  const p = buildDiscussPrompt({ row: discussRow(), view: "trending", period: "daily", language: "" });
  assert.match(p, /推测/);
  assert.match(p, /不要编造/);
  assert.match(p, /下一步/);
});

test("讨论 prompt 在事实缺失时不崩，也不写空行", () => {
  const p = buildDiscussPrompt({ row: { repo: "a/b" }, view: "rising" });
  assert.match(p, /a\/b/);
  assert.match(p, /只有仓库名/);
  assert.match(p, /近 7 天新建/);
  // 不应该出现 "undefined" 或 "null"
  assert.ok(!/undefined|null|NaN/.test(p));
});

test("讨论 prompt 对空输入也返回可用的字符串", () => {
  const p = buildDiscussPrompt({});
  assert.equal(typeof p, "string");
  assert.match(p, /这个仓库/);
  assert.ok(p.length > 100);
});

test("讨论 prompt 会截断超长描述", () => {
  const p = buildDiscussPrompt({ row: discussRow({ description: "x".repeat(2000) }), view: "trending" });
  // 单行描述不能撑爆整个 prompt
  assert.ok(p.length < 2000);
});


test("自定义模板：占位符被这一行的真实数据替换", () => {
  const p = buildDiscussPrompt({
    row: discussRow(),
    view: "trending",
    period: "daily",
    template: ["看看 {{repo}}（{{stars}} star，{{language}}），在 {{scope}} 里排第 {{rank}}。", "事实：", "{{facts}}"].join("\n"),
  });
  assert.match(p, /看看 obra\/superpowers/);
  assert.match(p, /322190 star/);
  assert.match(p, /Shell/);
  assert.match(p, /GitHub Trending daily 榜/);
  assert.match(p, /排第 2/);
  // 自定义模板完全取代默认模板：默认那套「先找本地副本」不该再出现
  assert.doesNotMatch(p, /本地副本/);
});

test("自定义模板：没写 {{facts}} 时插件补一节事实，写了就不重复", () => {
  const withFacts = buildDiscussPrompt({
    row: discussRow(),
    view: "trending",
    template: ["分析 {{repo}}。", "{{facts}}"].join("\n"),
  });
  assert.equal(withFacts.match(/榜单事实/g), null, "用户写了 {{facts}} 就不该再补一节");
  assert.match(withFacts, /322190/);

  const withoutFacts = buildDiscussPrompt({ row: discussRow(), view: "trending", template: "分析 {{repo}}。" });
  assert.match(withoutFacts, /## 榜单事实（插件补充）/);
  assert.match(withoutFacts, /322190/);
});

test("自定义模板：拼错的占位符原样保留，不悄悄吞掉", () => {
  const p = buildDiscussPrompt({
    row: discussRow(),
    view: "trending",
    template: "{{repo}} {{ repoo }} {{unknown}}",
  });
  assert.match(p, /\{\{ repoo \}\}/);
  assert.match(p, /\{\{unknown\}\}/);
});

test("自定义模板：空串/纯空白时退回内置模板", () => {
  const blankLine = ["", ""].join("\n");
  for (const template of ["", "   ", blankLine]) {
    const p = buildDiscussPrompt({ row: discussRow(), view: "trending", template });
    // 内置模板的两个特征句
    assert.match(p, /本地副本/, "空白模板应退回内置模板");
    assert.match(p, /下一步/);
  }
});

test("normalisePrompts：丢掉完全空的壳，补齐缺失 id 与名字", () => {
  const list = normalisePrompts([
    { name: "  ", text: "   " },
    { text: "正文" },
    { id: "dup", name: "甲", text: "A" },
    { id: "dup", name: "乙", text: "B" },
    "不是对象",
    null,
  ]);
  assert.equal(list.length, 3, "一条纯空壳和两条非对象都该丢掉");
  assert.ok(list[0].id, "缺 id 的要补一个");
  assert.equal(list[0].name, "未命名");
  assert.equal(list[1].id, "dup");
  assert.notEqual(list[2].id, "dup", "重复 id 要重新生成，否则「设为默认」会误伤两份");
});

test("normalisePrompts：非数组输入返回空列表，不抛错", () => {
  for (const raw of [null, undefined, "", 0, {}, "x"]) {
    assert.deepEqual(normalisePrompts(raw), []);
  }
});

test("normalisePrompts：有名字但正文为空的那份要保留（编辑时不能当场消失）", () => {
  const raw = [{ id: "a", name: "甲", text: "" }, { id: "b", name: "乙", text: "正文" }];
  const list = normalisePrompts(raw);
  assert.equal(list.length, 2, "用户删空正文准备重写时，这一份不能消失");
  assert.equal(list[0].text, "");
  // 读盘与编辑走同一个函数：同一份输入重开一次结果不变
  assert.deepEqual(normalisePrompts(list), list);
});

test("normalisePrompts：对同一份输入幂等（id 不会每次跳变）", () => {
  const raw = [{ name: "无 id", text: "x" }, { name: "重复", id: "x", text: "a" }, { name: "又重复", id: "x", text: "b" }];
  const once = normalisePrompts(raw);
  assert.deepEqual(normalisePrompts(once), once, "归一化过的输入再归一化必须不变，否则「设为默认」会点不中");
});

test("normalisePrompts：重复 id 补齐是确定性的，不靠随机", () => {
  const raw = [{ id: "dup", name: "甲", text: "A" }, { id: "dup", name: "乙", text: "B" }];
  assert.deepEqual(normalisePrompts(raw).map((p) => p.id), normalisePrompts(raw).map((p) => p.id));
});

test("normalisePrompts：份数与长度都有上限", () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ id: "p" + i, name: "n" + i, text: "t" + i }));
  assert.equal(normalisePrompts(many).length, PROMPT_COUNT_LIMIT);
  const long = normalisePrompts([{ id: "a", name: "x".repeat(200), text: "x".repeat(PROMPT_TEXT_LIMIT + 500) }])[0];
  assert.equal(long.text.length, PROMPT_TEXT_LIMIT);
  assert.ok(long.name.length <= 40);
});

test("pickPrompt：默认命中 → 第一份 → 内置模板，永远有可用结果", () => {
  const prompts = [
    { id: "a", name: "甲", text: "A" },
    { id: "b", name: "乙", text: "B" },
  ];
  assert.deepEqual(pickPrompt(prompts, "b"), prompts[1]);
  assert.deepEqual(pickPrompt(prompts, "不存在"), prompts[0], "默认悬空时用第一份");
  assert.equal(pickPrompt([], "x").text, DEFAULT_DISCUSS_TEMPLATE);
  assert.equal(pickPrompt(null, "").text, DEFAULT_DISCUSS_TEMPLATE);
});

test("pickPrompt：空正文的条目不能当选（否则模型收到空 prompt）", () => {
  const prompts = [
    { id: "a", name: "空", text: "   " },
    { id: "b", name: "有", text: "B" },
  ];
  assert.equal(pickPrompt(prompts, "a").id, "b", "默认指向空正文时回落到第一份有内容的");
  assert.equal(pickPrompt([{ id: "a", name: "空", text: "" }], "a").text, DEFAULT_DISCUSS_TEMPLATE);
});

test("pickPrompt 的结果能直接喂给 buildDiscussPrompt", () => {
  const chosen = pickPrompt(normalisePrompts([{ id: "a", name: "甲", text: "只看 {{repo}} 的 README 结构" }]), "a");
  const p = buildDiscussPrompt({ row: discussRow(), view: "trending", template: chosen.text });
  assert.match(p, /只看 obra\/superpowers 的 README 结构/);
});

test("续接策略：normaliseResumeMode 只认已知值，其余退回默认", () => {
  for (const m of RESUME_MODES) assert.equal(normaliseResumeMode(m.key), m.key);
  for (const bad of ["", null, undefined, "resume", 0, {}, "ALWAYS"]) {
    assert.equal(normaliseResumeMode(bad), DEFAULT_RESUME_MODE);
  }
  assert.equal(DEFAULT_RESUME_MODE, "session");
});

test("续接策略：never 永远新开，always 拿得到就续，session 只在榜单没换时续", () => {
  // 没有 sessionId 时任何策略都新开——没有可续的东西
  for (const m of RESUME_MODES) {
    assert.equal(shouldResume(m.key, false, false), false);
    assert.equal(shouldResume(m.key, true, false), false);
  }
  assert.equal(shouldResume("never", false, true), false);
  assert.equal(shouldResume("never", true, true), false);
  assert.equal(shouldResume("always", false, true), true);
  assert.equal(shouldResume("always", true, true), true, "跨榜单也要接着聊");
  assert.equal(shouldResume("session", false, true), true);
  assert.equal(shouldResume("session", true, true), false, "榜单换过就新开");
  // 脏值当成默认，不能返回 undefined
  assert.equal(shouldResume("乱写", false, true), true);
});

test("续接策略：每种模式都有说明文字，且互不相同", () => {
  const hints = RESUME_MODES.map((m) => resumeModeHint(m.key));
  for (const hint of hints) assert.ok(hint.length > 0);
  assert.equal(new Set(hints).size, hints.length, "三个说明不该长一样");
  assert.equal(resumeModeHint("乱写"), resumeModeHint(DEFAULT_RESUME_MODE));
});

test("随便看看的解读：不冒充「今天的榜单」，也不写趋势判断", () => {
  const { prompt } = buildDigestPrompt(base({ view: "browse", scopeText: "从热门仓库里随机抽的一批（★1k–3k）" }));
  assert.match(prompt, /这批里/, "结论句应说「这批里」而不是「今天」");
  assert.match(prompt, /这批不是排行榜/);
  assert.match(prompt, /随机抽的一批/);
  // 「今天在热什么」是小标题：随机抽样不该出现这个标题
  assert.doesNotMatch(prompt, /### 今天在热什么/);
  assert.match(prompt, /## 这批仓库/);
});

test("随便看看：榜单视图的措辞不受影响", () => {
  const { prompt } = buildDigestPrompt(base());
  assert.match(prompt, /### 今天在热什么/);
  assert.match(prompt, /## 榜单事实（按排名）/);
  assert.doesNotMatch(prompt, /这批不是排行榜/);
});

test("scopeText 覆盖默认范围说明（三个视图共用同一入口）", () => {
  assert.match(buildDigestPrompt(base({ scopeText: "自定义范围" })).prompt, /自定义范围/);
  assert.match(
    buildDiscussPrompt({ row: discussRow(), view: "browse", scopeText: "GitHub 上按仓库名搜索「react」的结果" }),
    /来源：GitHub 上按仓库名搜索「react」的结果/,
  );
});

test("讨论 prompt：随便看看的行没有名次时不编排名", () => {
  const p = buildDiscussPrompt({
    row: discussRow({ rank: null, rankDelta: null, gain: null, gainPeriod: "" }),
    view: "browse",
    scopeText: "从热门仓库里随机抽的一批",
  });
  assert.doesNotMatch(p, /排第|当前名次/);
  assert.doesNotMatch(p, /undefined|null|NaN/);
});
