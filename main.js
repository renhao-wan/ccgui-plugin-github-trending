/**
 * 每日 GitHub 热点（CC GUI 插件）。
 *
 * 数据：github.com/trending（公开页面，不占 API 配额）+ GitHub Search API（近 7 天新星库）。
 * 解读：只有用户点「生成解读」才调模型，选中内容之外一律不发。
 *
 * 约定（与工作志同一套）：
 * - 所有异步动作带代际号，晚到的结果不能覆盖新视图。
 * - 所有 host 侧请求带软超时；agent 停止/超时时必须 interrupt 宿主那一侧。
 * - 渲染一律用元素构造，不注入 HTML 字符串。
 *
 * 构建时会把 src/lib/*.mjs 的正文内联到下面两个标记之间（剥掉 `export `
 * 前缀，因为库文件是 ESM 而产物是同作用域的普通脚本）。
 */

// ---- 以下由 src/lib/*.mjs 内联生成 ----
// ---- src/lib/parse.mjs ----
/**
 * GitHub Trending 页面解析。纯函数：输入 HTML 字符串，输出结构化仓库列表。
 * 不依赖 DOM / Node API，宿主与单测共用同一份实现。
 */

const NAMED_ENTITIES = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&nbsp;": " ",
  "&mdash;": "—",
  "&ndash;": "–",
  "&hellip;": "…",
  "&middot;": "·",
  "&rsquo;": "’",
  "&lsquo;": "‘",
  "&ldquo;": "“",
  "&rdquo;": "”",
};

function decodeEntities(input) {
  return String(input)
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&[a-z]+;/gi, (m) => (NAMED_ENTITIES[m.toLowerCase()] ?? m));
}

function safeCodePoint(code) {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return "";
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

function stripTags(input) {
  return String(input).replace(/<[^>]*>/g, "");
}

function cleanText(input) {
  return decodeEntities(stripTags(input)).replace(/\s+/g, " ").trim();
}

function toCount(raw) {
  if (raw === null || raw === undefined) return null;
  const digits = String(raw).replace(/[^\d]/g, "");
  if (!digits) return null;
  const value = Number(digits);
  return Number.isFinite(value) ? value : null;
}

function escapeRegExp(input) {
  return String(input).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 星标/复刻数：锚点内容里夹着 svg path，只认 `</a>` 前的最后一段数字。
 * 不在正则里限定窗口长度——GitHub 给大仓库加 badge 时 path 会变长，写死窗口
 * 会让星数静默变 null。这里先定位到锚点，再取它这一段里最后一个数字。
 *
 * @param {string} article
 * @param {string} slug 调用方已转义好的仓库全名（escapeRegExp 过），
 *   这样整榜 25 行只转义一次，不必每篇再算两遍。
 * @param {string} kind stargazers | forks
 */
function countFromAnchor(article, slug, kind) {
  const anchor = 'href="/' + slug + "/" + kind + '"';
  const at = article.search(new RegExp(anchor));
  if (at < 0) return null;
  const end = article.indexOf("</a>", at);
  if (end < 0) return null;
  const segment = article.slice(at, end);
  const nums = segment.match(/[\d,]+/g);
  if (!nums || nums.length === 0) return null;
  // 锚点 href 里也可能有数字（如 /a/repo2/stargazers），最后一段才是计数
  return toCount(nums[nums.length - 1]);
}

/**
 * GitHub 语言色点只会是 `#abcdef` 或 `rgb(...)` / `rgba(...)`。
 * 白名单不只是美观：这个值会原样进渲染层的 style，而 `background` 接受
 * `url(...)`——一个被改版的页面就能让渲染进程绕过插件的 network 白名单去
 * 发请求。其余所有不可信字段都做过 cleanText，这里不能例外。
 */
const COLOR_RE = /^(#[0-9a-f]{3,8}|rgba?\(\s*[\d.,\s%]{1,40}\))$/i;

function safeColor(raw) {
  const s = String(raw || "").trim();
  return COLOR_RE.test(s) ? s : "";
}

/** GitHub 会重定向 /apps、/marketplace 这类非仓库路径，正文里不该当仓库。 */
const NON_REPO_PREFIX = /^(sponsors|topics|collections|users|login|orgs|apps|marketplace|features|settings|explore|about|pricing|enterprise|security|site|readme)\//i;

function pickSlug(headingHtml) {
  const re = /href="\/([^"\s/]+\/[^"\s/?]+)"/g;
  let m;
  while ((m = re.exec(headingHtml))) {
    const candidate = m[1];
    if (NON_REPO_PREFIX.test(candidate)) continue;
    // 两段都得是合法仓库名形状，挡掉 /apps/foo 之类残留
    if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(candidate)) continue;
    return candidate;
  }
  return null;
}

const ARTICLE_OPEN = '<article class="Box-row">';
const ARTICLE_CLOSE = "</article>";

/**
 * 按开/闭标签线性切分，而不是用 `<article…>[\s\S]*?</article>`。
 * 后者在「有开标签、缺闭标签」时是 O(n²)：GitHub 改版删掉 </article> 会让
 * 主线程卡死几十秒（2MB 实测 2.3s，正则版本更差）。
 */
function splitArticles(html) {
  const out = [];
  let from = 0;
  for (;;) {
    const open = html.indexOf(ARTICLE_OPEN, from);
    if (open < 0) break;
    const close = html.indexOf(ARTICLE_CLOSE, open + ARTICLE_OPEN.length);
    if (close < 0) break;
    out.push(html.slice(open, close + ARTICLE_CLOSE.length));
    from = close + ARTICLE_CLOSE.length;
  }
  return out;
}

/**
 * @param {string} html github.com/trending 页面
 * @returns {{ repos: Array<object>, error: string | null }}
 *   error 取值：empty_html | no_rows | ok 时 null
 */
function parseTrending(html) {
  if (typeof html !== "string" || html.trim() === "") {
    return { repos: [], error: "empty_html" };
  }
  const articles = splitArticles(html);
  const repos = [];

  for (const article of articles) {
    const heading = article.match(/<h2[^>]*>([\s\S]*?)<\/h2>/);
    if (!heading) continue;
    const slug = pickSlug(heading[1]);
    if (!slug) continue;

    const descMatch = article.match(/<p class="col-9[^"]*">\s*([\s\S]*?)\s*<\/p>/);
    const langMatch = article.match(/<span itemprop="programmingLanguage">([^<]+)<\/span>/);
    const colorMatch = article.match(
      /<span class="repo-language-color" style="background-color:\s*([^;"]+)\s*;?"/,
    );
    // 增量只在页脚出现，而描述里也可能写「999 stars today」。先把描述段挖掉，
    // 否则恶意/巧合的描述会盖过真实数字。
    const footer = descMatch ? article.replace(descMatch[0], "") : article;
    const gainMatch = footer.match(/([\d,]+)\s+stars\s+(today|this week|this month)/);
    // 转义一次给两次计数用：整榜 25 行就是这个函数的 25 次调用，
    // 每篇再各算两遍 escapeRegExp 纯属浪费。
    const slugEscaped = escapeRegExp(slug);

    repos.push({
      repo: slug,
      owner: slug.slice(0, slug.indexOf("/")),
      name: slug.slice(slug.indexOf("/") + 1),
      url: "https://github.com/" + slug,
      description: descMatch ? cleanText(descMatch[1]) : "",
      language: langMatch ? cleanText(langMatch[1]) : "",
      languageColor: colorMatch ? safeColor(colorMatch[1]) : "",
      stars: countFromAnchor(article, slugEscaped, "stargazers"),
      forks: countFromAnchor(article, slugEscaped, "forks"),
      gain: gainMatch ? toCount(gainMatch[1]) : null,
      gainPeriod: gainMatch ? normalisePeriod(gainMatch[2]) : null,
    });
  }

  if (repos.length === 0) return { repos: [], error: "no_rows" };
  return { repos, error: null };
}

function normalisePeriod(raw) {
  if (raw === "today") return "daily";
  if (raw === "this week") return "weekly";
  if (raw === "this month") return "monthly";
  return null;
}

// ---- src/lib/rising.mjs ----
/**
 * 「近 7 天新星库」：把 GitHub Search API 响应转成与 Trending 同构的条目。
 * 纯函数，不碰网络。
 */

function asCount(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalise(item) {
  // items 是不可信数组：GitHub 曾经在分页边界返回过 null 元素，直接读
  // item.full_name 会整页抛 TypeError（一个坏元素毁掉整榜）。
  if (!item || typeof item !== "object") return null;
  const full = typeof item.full_name === "string" ? item.full_name : "";
  const slash = full.indexOf("/");
  if (slash <= 0 || slash === full.length - 1) return null;
  const created = typeof item.created_at === "string" ? item.created_at : null;
  const createdTs = created ? Date.parse(created) : NaN;
  return {
    repo: full,
    owner: full.slice(0, slash),
    name: full.slice(slash + 1),
    url: typeof item.html_url === "string" ? item.html_url : "https://github.com/" + full,
    // 折叠空白是安全要求不只是美观：换行能让恶意描述伪造出一整行榜单事实，
    // 直接进入解读 prompt。
    description: typeof item.description === "string" ? item.description.replace(/\s+/g, " ").trim() : "",
    language: typeof item.language === "string" ? item.language : "",
    languageColor: "",
    stars: asCount(item.stargazers_count),
    forks: asCount(item.forks_count),
    gain: asCount(item.stargazers_count),
    gainPeriod: "rising",
    createdAt: created,
    ageDays: Number.isFinite(createdTs) ? Math.max(0, Math.floor((Date.now() - createdTs) / 86400000)) : null,
  };
}

/**
 * @param {unknown} payload Search API JSON
 * @returns {{ repos: Array<object>, error: string | null, message: string, total: number }}
 *   error 取值：bad_payload | rate_limited | no_items | null
 */
function parseRising(payload) {
  if (!payload || typeof payload !== "object") {
    return { repos: [], error: "bad_payload", message: "", total: 0 };
  }

  const rawMessage = typeof payload.message === "string" ? payload.message : "";
  if (rawMessage) {
    const limited = /rate limit|secondary rate|abuse/i.test(rawMessage);
    return {
      repos: [],
      error: limited ? "rate_limited" : "bad_payload",
      message: rawMessage,
      total: 0,
    };
  }

  const items = Array.isArray(payload.items) ? payload.items : [];
  const repos = [];
  for (const item of items) {
    const row = normalise(item);
    if (row) repos.push(row);
  }

  if (repos.length === 0) {
    return {
      repos: [],
      error: "no_items",
      message: "",
      total: asCount(payload.total_count) ?? 0,
    };
  }

  return {
    repos,
    error: null,
    message: "",
    total: asCount(payload.total_count) ?? repos.length,
  };
}

/** 设置里的阈值做一次收敛：既防 0 也防离谱值。空输入回落默认值而不是 1。 */
function normaliseMinStars(value) {
  if (value === null || value === undefined || String(value).trim() === "") return 50;
  const n = Number(value);
  if (!Number.isFinite(n)) return 50;
  return Math.min(100000, Math.max(1, Math.round(n)));
}

/** Search API 的 q：created 用「今天往前 N 天」的日期，必须带时间边界。 */
function buildRisingQuery(minStars, days) {
  const span = Number.isFinite(Number(days)) ? Math.min(90, Math.max(1, Math.round(Number(days)))) : 7;
  const since = new Date(Date.now() - span * 86400000);
  const iso = since.toISOString().slice(0, 10);
  return "created:>" + iso + " stars:>=" + normaliseMinStars(minStars) + " fork:false archived:false";
}

// ---- src/lib/diff.mjs ----
/**
 * 快照对比：给每个仓库标出相对上一次成功快照的位置变化。
 * 纯函数。首次使用（没有上一份快照）时一律不标 isNew，避免整榜都被当成新上榜。
 */

/**
 * @param {Array<object>} repos 当前榜单（顺序即排名）
 * @param {Array<object>|null} previous 上一次快照里的 repos
 * @returns {{ repos: Array<object>, dropped: Array<object>, isFirstRun: boolean }}
 */
function diffSnapshot(repos, previous) {
  const list = Array.isArray(repos) ? repos : [];
  const firstRun = !Array.isArray(previous) || previous.length === 0;

  if (firstRun) {
    return {
      // 首次抓取也要给名次：榜单顺序本身就是排名，缺了它整行标题只剩仓库名，
      // 看起来像界面坏了。没有上一次快照时 rankDelta 为 null，不声称任何变化。
      repos: list.map((row, index) => ({
        ...row,
        rank: index + 1,
        previousRank: null,
        rankDelta: null,
        isNew: false,
      })),
      dropped: [],
      isFirstRun: true,
    };
  }

  // 坏行先剔除再算名次：我们自己写的快照不会有坏行，但读盘失败时留下半截
  // JSON 不该让整榜的排名整体错位。
  const previousValid = previous.filter((row) => row && typeof row.repo === "string");
  const previousRank = new Map();
  previousValid.forEach((row, index) => previousRank.set(row.repo, index + 1));

  const currentSet = new Set();
  const annotated = list.map((row, index) => {
    const rank = index + 1;
    currentSet.add(row.repo);
    const before = previousRank.get(row.repo) ?? null;
    return {
      ...row,
      rank,
      previousRank: before,
      // 正数 = 上升；null = 新上榜
      rankDelta: before === null ? null : before - rank,
      isNew: before === null,
    };
  });

  const dropped = previousValid
    .map((row, index) => {
      if (currentSet.has(row.repo)) return null;
      return { ...row, previousRank: index + 1 };
    })
    .filter(Boolean);

  return { repos: annotated, dropped, isFirstRun: false };
}

/** 榜单签名：只在内容真变化时才覆盖快照，避免「刷新一下日期就变」。 */
function snapshotSignature(repos) {
  const list = Array.isArray(repos) ? repos : [];
  return list.map((row) => String(row && row.repo)).join("|");
}

// ---- src/lib/prompt.mjs ----
/**
 * 解读 prompt 组装。纯函数：把榜单事实拼成模型可读的清单，并做预算裁剪。
 * 只输出事实，不做推演；推演留给模型，prompt 里明确「事实」与「推断」边界。
 */

const DEFAULT_BUDGET = 6000;
/** 单行描述上限：不设它的话，一条超长描述会撑爆预算，把整个榜单挤成 0 条。 */
const MAX_DESCRIPTION = 160;

function clip(text, max) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + "…";
}

function oneLine(row) {
  const bits = ["- " + row.repo];
  if (row.language) bits.push("[" + row.language + "]");
  if (Number.isFinite(row.stars)) bits.push("★" + row.stars);
  if (Number.isFinite(row.gain)) bits.push("+" + row.gain + "/" + (row.gainPeriod || "recent"));
  if (row.isNew) bits.push("新上榜");
  else if (Number.isFinite(row.rankDelta) && row.rankDelta !== 0) {
    bits.push((row.rankDelta > 0 ? "↑" : "↓") + Math.abs(row.rankDelta) + "位");
  }
  if (row.description) bits.push("| " + clip(row.description, MAX_DESCRIPTION));
  return bits.join(" ");
}

/**
 * @param {object} input
 * @param {"trending"|"rising"} input.view
 * @param {string} input.period daily|weekly|monthly|rising
 * @param {string} input.language 空字符串 = 全部语言
 * @param {Array<object>} input.repos
 * @param {Array<object>} input.dropped
 * @param {boolean} input.isFirstRun
 * @param {number} [budget]
 * @returns {{ prompt: string, truncated: boolean, included: number, total: number }}
 */
function buildDigestPrompt(input, budget = DEFAULT_BUDGET) {
  const repos = Array.isArray(input.repos) ? input.repos : [];
  const dropped = Array.isArray(input.dropped) ? input.dropped : [];
  const limit = Number.isFinite(budget) && budget > 0 ? budget : DEFAULT_BUDGET;

  const scope = input.view === "rising"
    ? "近 7 天新建且 star 增长快的新仓库（GitHub Search）"
    : "GitHub Trending " + (input.period || "daily") + " 榜" + (input.language ? "（" + input.language + "）" : "");

  const header = [
    "你在为一位中文开发者解读今天的 GitHub 热点。",
    "",
    "## 数据范围",
    scope,
    "共 " + repos.length + " 个仓库" + (input.isFirstRun ? "（首次抓取，无历史对比）" : ""),
    "",
    "## 榜单事实（按排名）",
  ];

  const footer = [
    "",
    "## 写作要求",
    "- 全文中文，术语保留英文原文。",
    "- 只依据上面的「榜单事实」；事实里没有的信息不要编造，也不要猜技术细节。",
    "- 不要复述榜单，不要用「首先/其次/总之」这类填充词。",
    "- 用 Markdown，但不要写一级标题（不要用 `#`）。",
    "",
    "按这个结构写：",
    "",
    "### 今天在热什么",
    "3-5 句总体判断：哪个方向在升温、有没有共同的技术主题。",
    "",
    "### 值得看的项目",
    "用一个 Markdown 表格，5-8 行，列固定为：",
    "| 仓库 | 方向 | 解决什么问题 | 适合谁 |",
    "每格一句话，仓库名写成 `owner/repo`。不要加评分、不要加星级数字（上面的事实里已有）。",
    "",
    "### 一句话结论",
    "一行，说明今天最值得点开的那一个，以及为什么。",
  ];

  const lines = [];
  let used = header.join("\n").length + footer.join("\n").length;
  let truncated = false;
  let included = 0;

  for (const row of repos) {
    const line = oneLine(row);
    // 预留换行符，避免正好卡在预算边界时多出一个字符
    if (used + line.length + 1 > limit) {
      truncated = true;
      break;
    }
    lines.push(line);
    included += 1;
    used += line.length + 1;
  }

  if (truncated) {
    lines.push("- （事实清单过长，已截断，仅保留前 " + included + " 条）");
  }

  if (dropped.length > 0) {
    const tail = dropped.slice(0, 8).map((row) => row.repo).join("、");
    lines.push("");
    lines.push("## 掉榜");
    lines.push("- " + tail + (dropped.length > 8 ? "（另有 " + (dropped.length - 8) + " 个）" : ""));
  }

  const prompt = header.concat(lines, footer).join("\n");
  return {
    prompt,
    truncated,
    included,
    total: repos.length,
  };
}

/**
 * 讨论 prompt 的默认模板。
 *
 * 做成「模板 + 占位符」而不是一段写死的字符串：用户在设置里可以另存几份，
 * 决定的是**让模型干什么**（评估可投入性 / 找可借鉴的设计 / 当技术选型对比），
 * 而仓库事实永远由插件填，不需要用户每次自己抄一遍 star 数和名次。
 *
 * 占位符（写错不会炸，会原样留在 prompt 里，用户自己能看见）：
 *   {{repo}} {{url}} {{scope}} {{description}} {{language}} {{stars}}
 *   {{gain}} {{rank}} {{age}} {{facts}}
 */
const DEFAULT_DISCUSS_TEMPLATE = [
  "我想认真了解一下这个项目，先帮我弄清楚它是什么、值不值得投入时间。",
  "",
  "## 仓库",
  "{{repo}}",
  "{{url}}",
  "来源：{{scope}}",
  "",
  "## 我这边已知的事实",
  "{{facts}}",
  "",
  "## 你要做的",
  "1. 先在这个工作目录里找有没有这个仓库的本地副本（按仓库名，比如 `{{repo}}` 或只有后半段的目录）。",
  "   找得到就直接读代码，结论以代码为准。",
  "   找不到就读远程仓库（README、目录结构、最近的 release/issue），并在开头用一句话说明「没找到本地代码，以下基于远程信息」。",
  "2. 用自己的话讲清楚：它解决什么问题、核心机制是什么、和同类项目比区别在哪。",
  "3. 给一个明确的判断：什么人适合用、什么情况下不适合。",
  "",
  "## 格式",
  "- 中文，术语保留英文原文。",
  "- 用 Markdown，不要写一级标题。",
  "- 结论要有依据。凡是推测而不是从代码或文档里读到的，明确标成「推测」，不要编造 API、参数、性能数字。",
  "- 最后一行给我一个「下一步」建议（比如读哪个文件、跑什么命令验证）。",
].join("\n");

/** 单份提示词正文上限：两万字符，够写任意详细的分析框架，又不至于让设置页卡住。 */
const PROMPT_TEXT_LIMIT = 20000;
/** 提示词份数上限。设置页要能一眼看完全部，不做分页。 */
const PROMPT_COUNT_LIMIT = 8;
/** 名字上限：侧栏/下拉里只放得下一行。 */
const PROMPT_NAME_LIMIT = 40;

/**
 * 把存下来的提示词列表归一化。
 *
 * 设置是从磁盘读的，可能被手改、可能来自旧版本（那时候只有一个字符串）。
 * 这里必须是**不会抛错**的：一份坏数据不能让整个设置页白屏。
 *
 * @param {unknown} raw
 * @returns {Array<{ id: string, name: string, text: string }>}
 */
function normalisePrompts(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const text = String(item.text === undefined || item.text === null ? "" : item.text);
    if (!text.trim()) continue; // 空正文的条目没有任何用处，直接丢
    let id = String(item.id || "").trim();
    if (!id || seen.has(id)) id = "p" + (out.length + 1) + Math.random().toString(36).slice(2, 6);
    seen.add(id);
    out.push({
      id,
      name: String(item.name || "").trim().slice(0, PROMPT_NAME_LIMIT) || "未命名",
      text: text.slice(0, PROMPT_TEXT_LIMIT),
    });
    if (out.length >= PROMPT_COUNT_LIMIT) break;
  }
  return out;
}

/**
 * 选出这次讨论实际用哪份提示词。
 *
 * 三级回落：设置里的默认 → 列表第一份 → 内置模板。**永远返回一份可用模板**，
 * 因为「没有提示词」不该表现为按钮点了没反应。
 *
 * @param {Array<{ id: string, name: string, text: string }>} prompts
 * @param {string} defaultId
 * @returns {{ id: string, name: string, text: string }}
 */
function pickPrompt(prompts, defaultId) {
  const list = Array.isArray(prompts) ? prompts : [];
  const hit = list.find((p) => p && p.id === defaultId);
  if (hit) return hit;
  if (list.length > 0) return list[0];
  return { id: "", name: "默认", text: DEFAULT_DISCUSS_TEMPLATE };
}

function fillTemplate(template, values) {
  return String(template || DEFAULT_DISCUSS_TEMPLATE).replace(/\{\{\s*([a-z]+)\s*\}\}/g, (whole, key) => {
    if (Object.prototype.hasOwnProperty.call(values, key)) return values[key];
    // 不认识的占位符原样保留：比悄悄替换成空串更容易让用户发现拼错了。
    return whole;
  });
}

/**
 * 单个仓库的讨论 prompt。
 *
 * 与解读的区别不只是范围：讨论是**一次真正的会话**，用户会接着追问，所以
 * prompt 必须交代清楚「上下文只有这些」和「怎么拿到代码」两件事。否则模型
 * 会拿一句榜单描述开始猜代码结构。
 *
 * @param {object} input
 * @param {object} input.row 榜单里的那一行
 * @param {"trending"|"rising"} input.view
 * @param {string} input.period
 * @param {string} input.language
 * @param {string} [input.template] 用户自定义的模板；空 = 内置默认
 * @returns {string}
 */
function buildDiscussPrompt(input) {
  const row = (input && input.row) || {};
  const repo = String(row.repo || "").trim() || "这个仓库";
  const url = repo.indexOf("/") > 0 ? "https://github.com/" + repo : "";
  const scope =
    input.view === "rising"
      ? "近 7 天新建且 star 增长快的新仓库（GitHub Search）"
      : "GitHub Trending " + (input.period || "daily") + " 榜" + (input.language ? "（" + input.language + "）" : "");

  const facts = [];
  if (row.description) facts.push("- 简介：" + clip(row.description, 400));
  if (row.language) facts.push("- 主要语言：" + row.language);
  if (Number.isFinite(row.stars)) facts.push("- 总 star：" + row.stars);
  if (Number.isFinite(row.gain)) facts.push("- 近期增长：+" + row.gain + "/" + (row.gainPeriod || "recent"));
  if (Number.isFinite(row.rank)) facts.push("- 当前名次：" + row.rank + "（" + scope + "）");
  if (Number.isFinite(row.ageDays)) facts.push("- 仓库创建于 " + row.ageDays + " 天前");
  if (row.isNew) facts.push("- 本次新上榜");
  else if (Number.isFinite(row.rankDelta) && row.rankDelta !== 0) {
    facts.push("- 较上次" + (row.rankDelta > 0 ? "上升 " : "下降 ") + Math.abs(row.rankDelta) + " 位");
  }

  const template = String((input && input.template) || "").trim() || DEFAULT_DISCUSS_TEMPLATE;
  const text = fillTemplate(template, {
    repo,
    url,
    scope,
    description: row.description ? clip(row.description, 400) : "",
    language: row.language ? String(row.language) : "",
    stars: Number.isFinite(row.stars) ? String(row.stars) : "",
    gain: Number.isFinite(row.gain) ? "+" + row.gain + "/" + (row.gainPeriod || "recent") : "",
    rank: Number.isFinite(row.rank) ? String(row.rank) : "",
    age: Number.isFinite(row.ageDays) ? String(row.ageDays) + " 天" : "",
    facts: facts.length > 0 ? facts.join("\n") : "- （榜单里只有仓库名，没有更多信息）",
  });
  // 模板里没写 {{facts}} 时也要把事实带上：没有这些数字，模型只能猜。
  // 用户明确写了 {{facts}} 就不重复。
  if (template.indexOf("{{facts}}") < 0 && facts.length > 0) {
    return text + "\n\n## 榜单事实（插件补充）\n" + facts.join("\n");
  }
  return text;
}

// ---- src/lib/catalog.mjs ----
// 宿主 catalog 条目到 agent.start 参数的映射。
//
// 这里最容易出错的是 readOnly：catalog 的 readOnly 是「这个引擎能不能做
// 隔离只读运行」，不是「这次调用想不想只读」。宿主对不支持的引擎是直接
// 拒绝整轮（实测 claude 会返回 "does not support isolated plugin read-only
// runs; only Pi and audited local Codex planning are supported"），不是静默
// 降级。所以只有字段明确为 true 才能请求，undefined 一律当作不支持。

/**
 * 该引擎能否接受隔离只读运行。
 * @param {{ readOnly?: unknown } | null | undefined} entry
 * @returns {boolean}
 */
function supportsReadOnly(entry) {
  return Boolean(entry) && entry.readOnly === true;
}

/**
 * 决定引擎进程的 cwd。优先级：用户显式选择 > 插件数据目录。
 *
 * 默认值这层不是可有可无的兜底：agent 跑一轮会在 ~/.claude/projects 留下会话
 * 记录，cwd 就是这里传的值。挂在真实项目名下，「生成热点解读」这个动作本身
 * 会被那个项目的会话历史记成一次工作产出。
 *
 * 故意没有第三层「侧栏第一个工作区」：留空就该是插件目录，不能悄悄跑到用户的
 * 真实项目里——那样「什么都没选」和「选了项目 A」行为一样，没人能预料 cwd 在哪。
 *
 * @param {{ workspacePath?: unknown }} settings
 * @param {string} ownDir 插件数据目录（拿不到时为空串）
 * @returns {string} 空串表示两者都拿不到，由调用方报错
 */
function pickWorkspace(settings, ownDir) {
  const configured = String((settings && settings.workspacePath) || "").trim();
  if (configured) return configured;
  return String(ownDir || "").trim();
}

// ---- src/lib/markdown.mjs ----
/**
 * 解读正文用的 Markdown 子集解析。纯函数，输出的是「节点描述」而不是
 * HTML —— 渲染端自己把它们变成元素，避免把模型的输出当 HTML 执行。
 *
 * 覆盖模型最常写的那几种：标题、段落、有序/无序列表（含缩进层级）、
 * GFM 表格、代码块、行内代码、粗体、斜体、删除线、链接、引用、分隔线。
 *
 * 流式输入的容错是硬要求：解读是一个字一个字推过来的，任何时刻都可能停在
 * `**粗`、`| a | b`（分隔行还没来）、``` 未闭合这种半截状态。所以：
 * - 未闭合的行内标记按原文输出，不吞字符；
 * - 未闭合的代码块一直吃到末尾；
 * - 没有分隔行的表格行当普通段落。
 */

/** 行内标记。顺序即优先级：`**` 必须先于 `*`，否则粗体会被切成两个斜体。
 * 这里存的是不带 g 的「模板」：带 g 的正则 lastIndex 是实例状态，而 parseInline
 * 会递归，内层一重置就会把外层循环卡在原地。每次调用自己造实例。 */
const INLINE_RE = /(\*\*[^*\n]+\*\*|__[^_\n]+__|`[^`\n]+`|~~[^~\n]+~~|\[[^\]\n]+\]\([^)\s]+\)|\*[^*\n]+\*)/;

/** 链接只放行 http(s)。其他协议（javascript:、file:）一律降级成文字。
 * 名字带 md 前缀：这个文件会被内联进 main.js 顶层作用域，和插件里的
 * safeHref（给仓库链接用）重名就会直接语法错误。 */
function safeMdHref(href) {
  return /^https?:\/\//i.test(href) ? href : "";
}

/**
 * 把一行切成行内节点。
 *
 * 强调类标记（strong/em/del）的内容会递归解析：模型很爱写
 * `**\`owner/repo\`**` 这种「粗体包代码」，不递归的话反引号会原样显示出来。
 * 强调标记本身不嵌套（`*a **b** c*` 会先命中内层的 `**b**`），这是有意的
 * 简化：解读正文里几乎不会出现，换来的是流式输入下不会卡死。递归只往
 * 「非强调」的行内标记里走，层数限死 2 层。
 *
 * 正则每次调用都要新造实例：带 g 的正则 lastIndex 是实例状态，递归共用一个
 * 就会被内层重置，外层 exec 原地打转。
 *
 * @param {string} text
 * @param {number} [depth]
 * @returns {Array<{t: string, v: string, href?: string, children?: Array<object>}>}
 */
function parseInline(text, depth = 0) {
  const src = String(text == null ? "" : text);
  const out = [];
  let last = 0;
  let m;
  // 递归解析强调内容时不能和外层共用同一个带 g 的正则实例。
  const re = new RegExp(INLINE_RE.source, "g");
  while ((m = re.exec(src))) {
    if (m.index > last) out.push({ t: "text", v: src.slice(last, m.index) });
    const tok = m[0];
    const wrap = (t) => {
      const inner = tok.slice(t === "em" ? 1 : 2, t === "em" ? -1 : -2);
      const node = { t: t, v: inner };
      if (depth < 2) node.children = parseInline(inner, depth + 1);
      return node;
    };
    if (tok.startsWith("**")) {
      out.push(wrap("strong"));
    } else if (tok.startsWith("__")) {
      out.push(wrap("strong"));
    } else if (tok.startsWith("`")) {
      out.push({ t: "code", v: tok.slice(1, -1) });
    } else if (tok.startsWith("~~")) {
      out.push(wrap("del"));
    } else if (tok.startsWith("[")) {
      const link = /^\[([^\]\n]+)\]\(([^)\s]+)\)$/.exec(tok);
      const href = link ? safeMdHref(link[2]) : "";
      if (link && href) out.push({ t: "link", v: link[1], href: href });
      else out.push({ t: "text", v: tok });
    } else {
      out.push(wrap("em"));
    }
    last = m.index + tok.length;
  }
  if (last < src.length) out.push({ t: "text", v: src.slice(last) });
  return out;
}

/* ---- 表格与列表的识别 ---- */

const FENCE_RE = /^\s*(```|~~~)\s*([^\s`]*)\s*$/;
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*)$/;
const HR_RE = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;
const QUOTE_RE = /^\s{0,3}>\s?(.*)$/;
const UL_RE = /^(\s*)[-*+]\s+(.*)$/;
const OL_RE = /^(\s*)\d+[.)]\s+(.*)$/;
const TABLE_DIV_RE = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

function hasPipe(line) {
  return String(line || "").indexOf("|") >= 0;
}

/** 表头行 + `|---|` 分隔行；只有表头行时不算表格。 */
function isTableStart(lines, i) {
  return i + 1 < lines.length && hasPipe(lines[i]) && hasPipe(lines[i + 1]) && TABLE_DIV_RE.test(lines[i + 1]);
}

function splitRow(raw) {
  let s = String(raw || "").trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  // 手写扫描而不是 split(/(?<!\\)\|/)：lookbehind 在老版本 Chromium 上不支持，
  // 宿主的内置内核版本不在我们控制范围内。`\|` 是单元格内的转义竖线。
  const cells = [];
  let buf = "";
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === "\\" && s[i + 1] === "|") {
      buf += "|";
      i += 1;
      continue;
    }
    if (ch === "|") {
      cells.push(buf.trim());
      buf = "";
      continue;
    }
    buf += ch;
  }
  cells.push(buf.trim());
  return cells;
}

function cellAlign(spec) {
  const s = String(spec || "").trim();
  const left = s.startsWith(":");
  const right = s.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return "";
}

/** 缩进换算成层级：两个空格或一个 Tab 算一级，最多 4 级（再深也没人看）。 */
function depthOf(indent) {
  const expanded = String(indent || "").replace(/\t/g, "  ").length;
  return Math.min(4, Math.floor(expanded / 2));
}

/** 块级元素是否从这里开始；段落收集到这些行就停。 */
function startsBlock(lines, i) {
  const line = lines[i];
  return (
    FENCE_RE.test(line) ||
    HEADING_RE.test(line) ||
    HR_RE.test(line) ||
    QUOTE_RE.test(line) ||
    UL_RE.test(line) ||
    OL_RE.test(line) ||
    isTableStart(lines, i)
  );
}

/**
 * @param {string} text 模型输出的 Markdown
 * @returns {Array<object>} 块节点数组，结构见文件头注释
 */
function parseMarkdown(text) {
  const lines = String(text == null ? "" : text).replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let i = 0;
  let list = null;

  const flushList = () => {
    if (!list) return;
    out.push(list);
    list = null;
  };

  while (i < lines.length) {
    const line = lines[i];

    const fence = FENCE_RE.exec(line);
    if (fence) {
      flushList();
      const marker = fence[1];
      const lang = fence[2] || "";
      const buf = [];
      i += 1;
      // 闭合行只要以同样的围栏开头即可（```js 和 ``` 都算）
      while (i < lines.length && lines[i].trim().indexOf(marker) !== 0) {
        buf.push(lines[i]);
        i += 1;
      }
      // 未闭合时（流式中途）i 会停在末尾，代码原样输出，不丢内容
      if (i < lines.length) i += 1;
      out.push({ type: "code", lang: lang, text: buf.join("\n") });
      continue;
    }

    if (isTableStart(lines, i)) {
      flushList();
      const head = splitRow(line).map(parseInline);
      const align = splitRow(lines[i + 1]).map(cellAlign);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim() && hasPipe(lines[i]) && !startsBlock(lines, i)) {
        const cells = splitRow(lines[i]);
        // 列数按表头补齐/截断：模型偶尔少写一格，不能让整行错位
        const row = [];
        for (let c = 0; c < head.length; c += 1) row.push(parseInline(cells[c] == null ? "" : cells[c]));
        rows.push(row);
        i += 1;
      }
      out.push({ type: "table", align: align, head: head, rows: rows });
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      flushList();
      out.push({ type: "heading", level: Math.min(6, heading[1].length), inlines: parseInline(heading[2]) });
      i += 1;
      continue;
    }

    if (HR_RE.test(line)) {
      flushList();
      out.push({ type: "hr" });
      i += 1;
      continue;
    }

    if (QUOTE_RE.test(line)) {
      flushList();
      const buf = [];
      while (i < lines.length) {
        const q = QUOTE_RE.exec(lines[i]);
        if (!q) break;
        buf.push(q[1]);
        i += 1;
      }
      out.push({ type: "quote", inlines: parseInline(buf.join(" ")) });
      continue;
    }

    const ul = UL_RE.exec(line);
    const ol = OL_RE.exec(line);
    if (ul || ol) {
      const type = ul ? "ul" : "ol";
      // 有序/无序切换或缩进回退都要重开一个列表：混在一个 <ul> 里会全变成圆点
      if (!list || list.type !== type || list.depth !== depthOf((ul || ol)[1])) {
        flushList();
        list = { type: type, depth: depthOf((ul || ol)[1]), items: [] };
      }
      list.items.push({ inlines: parseInline((ul || ol)[2]), depth: depthOf((ul || ol)[1]) });
      i += 1;
      continue;
    }

    if (!line.trim()) {
      flushList();
      i += 1;
      continue;
    }

    flushList();
    const buf = [line];
    i += 1;
    while (i < lines.length && lines[i].trim() && !startsBlock(lines, i)) {
      buf.push(lines[i]);
      i += 1;
    }
    out.push({ type: "paragraph", inlines: parseInline(buf.join(" ")) });
  }

  flushList();
  return out;
}

// ---- src/lib/report.mjs ----
/**
 * 榜单 → Markdown。纯函数：输入结构化行，输出能直接粘进任何 Markdown 编辑器
 * 的一段文本（工作志周报、issue、笔记都行）。
 *
 * 不接收格式化好的时间字符串以外的任何「展示态」字段：名次、涨跌、掉榜这些
 * 都由这里从原始字段推出来，免得界面上改一次文案这里就跟不上。
 */

const BOARD_PERIOD_LABEL = { daily: "今日", weekly: "本周", monthly: "本月" };

/** 单行描述上限。描述可以很长，整段搬进 Markdown 会把榜单读成文章。 */
const BOARD_DESC_LIMIT = 120;

/** 与界面一致的数字写法（12.3k），让粘出去的榜单和屏幕上看到的是同一个数。 */
function boardNum(n) {
  if (!Number.isFinite(n)) return "";
  if (n >= 1000) {
    const k = n / 1000;
    return (k >= 100 ? String(Math.round(k)) : k.toFixed(1).replace(/\.0$/, "")) + "k";
  }
  return String(n);
}

/**
 * 描述里的 Markdown 控制字符转义。
 *
 * 仓库名与 URL 由我们自己拼（GitHub 只允许 [A-Za-z0-9._-]），不用管；但描述是
 * 上游页面里的任意文本，里面出现 `*`、`[`、`|` 会把整段渲染歪，尤其 `[` 会
 * 拼出一个半开的链接。
 */
function boardEscape(text) {
  return String(text || "").replace(/([\\`*_[\]<>])/g, "\\$1");
}

function boardUrl(row) {
  const raw = String((row && row.url) || "");
  if (/^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(raw)) return raw;
  const repo = String((row && row.repo) || "");
  return repo.indexOf("/") > 0 ? "https://github.com/" + repo : "";
}

/** 一行榜单的 Markdown 条目；返回数组，每条是 Markdown 的一行（不含换行符）。 */
function boardItem(row) {
  if (!row || typeof row !== "object") return [];
  const repo = String(row.repo || "").trim();
  if (!repo) return [];
  const url = boardUrl(row);
  const head = url ? "**[" + repo + "](" + url + ")**" : "**" + repo + "**";
  const desc = String(row.description || "").replace(/\s+/g, " ").trim();
  const first = "- " + head + (desc ? " — " + boardEscape(desc.slice(0, BOARD_DESC_LIMIT) + (desc.length > BOARD_DESC_LIMIT ? "…" : "")) : "");

  const meta = [];
  if (Number.isFinite(row.stars)) meta.push("★ " + boardNum(row.stars));
  if (Number.isFinite(row.gain)) {
    const label = { daily: "日", weekly: "周", monthly: "月" }[row.gainPeriod] || "近期";
    meta.push("+" + boardNum(row.gain) + "/" + label);
  }
  if (row.language) meta.push(String(row.language));
  if (row.isNew) meta.push("新上榜");
  else if (Number.isFinite(row.rankDelta) && row.rankDelta !== 0) {
    meta.push((row.rankDelta > 0 ? "↑" : "↓") + Math.abs(row.rankDelta) + " 位");
  }
  if (Number.isFinite(row.ageDays)) meta.push(row.ageDays + " 天前创建");

  // 续行缩进两个空格：无序列表的续行在 CommonMark 里就是这个宽度。
  return meta.length > 0 ? [first, "  " + meta.join(" · ")] : [first];
}

/**
 * @param {object} input
 * @param {"trending"|"rising"} input.view
 * @param {string} input.period  daily|weekly|monthly
 * @param {string} input.language 空字符串 = 全部语言
 * @param {Array<object>} input.rows
 * @param {Array<object>} input.dropped
 * @param {string} input.capturedAt 已格式化好的抓取时间（由调用方负责本地化）
 * @returns {string} Markdown 文本；没有可导出的行时返回空串
 */
function buildBoardMarkdown(input) {
  const rows = Array.isArray(input && input.rows) ? input.rows : [];
  const dropped = Array.isArray(input && input.dropped) ? input.dropped : [];
  const items = rows.map(boardItem).filter((lines) => lines.length > 0);
  if (items.length === 0) return "";

  const scope =
    input.view === "rising"
      ? "近 7 天新星库"
      : "GitHub Trending · " + (BOARD_PERIOD_LABEL[input.period] || input.period || "今日");
  const heading = "# 每日热点 · " + scope + (input.view === "trending" && input.language ? " · " + input.language : "");

  const out = [heading];
  // 引用块写在标题下面：粘到别处时，「这是哪天的数据」比格式更重要。
  if (input.capturedAt) out.push("", "> 抓取时间 " + input.capturedAt + " · 数据来自 github.com");

  out.push("");
  for (const lines of items) out.push(...lines);

  const droppedNames = dropped
    .map((row) => String((row && row.repo) || "").trim())
    .filter((name) => name !== "");
  if (droppedNames.length > 0) {
    out.push("", "## 掉榜（" + droppedNames.length + "）", "", droppedNames.map((n) => "- " + n).join("\n"));
  }

  return out.join("\n");
}

// ---- src/lib/readme.mjs ----
/**
 * README 预览的文本处理。纯函数：把 GitHub 返回的 README 原文整理成
 * 「我们的 Markdown 子集能吃下去」的样子，并做长度裁剪。
 *
 * 为什么不直接把原文丢给 renderMarkdown：真实 README 里大量是 GitHub
 * 特有的写法——badge 图片套链接、`<div align="center">`、`<img />`、
 * `<details>`。解析器只认标准 Markdown，这些会原样变成尖括号文字，
 * 读起来比没有预览更糟。
 */

/** 预览长度上限。够看清「这是什么项目」，又不至于把整页撑成一份文档。 */
const README_PREVIEW_LIMIT = 2000;

/**
 * 去掉 YAML frontmatter（Jekyll / Hugo 等静态站项目的 README 常见）。
 *
 * 只在文件**开头**是 `---` 才认：正文中间的分隔线不能当 frontmatter 吃掉，
 * 否则会静默丢一大段。
 */
function stripFrontmatter(text) {
  const src = String(text || "");
  if (!/^---\r?\n/.test(src)) return src;
  const end = src.indexOf("\n---", 3);
  if (end < 0) return src;
  const after = src.slice(end + 4);
  return after.replace(/^\r?\n/, "");
}

/**
 * 去掉 badge 与图片。
 *
 * 顺序是硬要求：
 * 1. 先整块删 `[![alt](img)](link)`——barrier badge 最外层是链接，先删外层的
 *    话内层图片会留下半截 `](img)` 文本；
 * 2. 再删独立的 `![alt](img)`；
 * 3. 最后删残余 HTML 标签。
 *
 * 图片一律删而不是替换成 alt：README 顶部的 badge 墙有十几个，渲染成文字
 * 会把预览前两百字全占满，而它们几乎不携带信息。
 */
function stripBadgesAndImages(text) {
  return String(text || "")
    .replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "");
}

/**
 * 去 HTML 标签。只保留内部文字（`<b>粗</b>` → `粗`），
 * `<br>`、`<hr>` 这类无内容的换成换行，避免两段被粘成一行。
 */
function stripHtmlTags(text) {
  return String(text || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<hr\s*\/?>/gi, "\n\n")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\/?[a-zA-Z][^>]*>/g, "");
    // 只删「看起来是标签」的：`a < b` 里的 `<` 后面不是字母，不会被误删。
}

/** 折叠连续空行与行尾空白。 */
function tidyWhitespace(text) {
  return String(text || "")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * README 原文 → 可渲染的预览文本。
 * @param {string} text
 * @returns {string}
 */
function prepareReadme(text) {
  if (!text) return "";
  return tidyWhitespace(stripHtmlTags(stripBadgesAndImages(stripFrontmatter(String(text)))));
}

/**
 * 按字符截断，并尽量在边界上停（换行 > 句号 > 硬切）。
 *
 * 在句子中间硬切会让「前 2000 字」读起来像断线；优先在最近的换行处收口，
 * 没有换行再退到句子边界，都没有才硬切。
 * @param {string} text
 * @param {number} [limit]
 * @returns {{ text: string, truncated: boolean, total: number }}
 */
function truncateReadme(text, limit = README_PREVIEW_LIMIT) {
  const src = String(text || "");
  const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : README_PREVIEW_LIMIT;
  if (src.length <= max) return { text: src, truncated: false, total: src.length };

  // 只在前 80%~100% 区间找断点：太靠前会白白丢掉一大段。
  const floor = Math.floor(max * 0.8);
  const window = src.slice(floor, max);
  const candidates = ["\n\n", "\n", "。", ". ", "；", "; "];
  for (const sep of candidates) {
    const at = window.lastIndexOf(sep);
    if (at >= 0) {
      const cut = floor + at + sep.length;
      return { text: src.slice(0, cut).trimEnd(), truncated: true, total: src.length };
    }
  }
  return { text: src.slice(0, max).trimEnd(), truncated: true, total: src.length };
}

/**
 * GitHub 的 readme 接口在 `Accept: application/vnd.github.raw` 下直接回文件正文；
 * 但某些代理/网关会无视 Accept 继续回 JSON（`{content: "<base64>"}`）。
 * 这里把两种形状都还原成文本，免得用户看到一个 base64 大字符串。
 *
 * @param {string} body
 * @returns {string}
 */
function readmeTextFromBody(body) {
  const raw = String(body || "");
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return raw;
  let payload = null;
  try {
    payload = JSON.parse(trimmed);
  } catch {
    return raw;
  }
  if (!payload || typeof payload.content !== "string") return raw;
  // base64 里带换行，先去掉再解码；解码失败就退回原文，绝不抛。
  try {
    const compact = payload.content.replace(/\s+/g, "");
    if (payload.encoding && payload.encoding !== "base64") return raw;
    const binary = typeof atob === "function" ? atob(compact) : "";
    if (!binary) return raw;
    // README 是 UTF-8，atob 给的是 latin1 逐字节字符串，必须自己还原成 UTF-8。
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i) & 0xff;
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
    return raw;
  }
}


const PLUGIN_ID = "github-trending";
const HISTORY_DIR = "history";
const REQUEST_TIMEOUT_MS = 20000;
const AGENT_TIMEOUT_MS = 120000;
/**
 * 开会话的超时。这条路径不能像解读那样等 120s：`discussing` 非空期间全榜的
 * 「讨论」按钮都是禁用的，挂住就等于整页这个功能不可用，而且没有别的出口。
 * startRun 只是 spawn，不包含推理，30s 足够；超时后用户可以直接再点一次。
 */
const DISCUSS_TIMEOUT_MS = 30000;

/**
 * 登记侧栏工作区的超时。这只是宿主本地的一张表，正常几十毫秒就回来了；给它
 * 10s 是为了不让一个卡住的 IPC 把「讨论」按钮一直挂在「打开中」——超时后照常
 * 开会话，只在回执里说明会话可能不在侧栏显示。
 */
const WORKSPACE_REGISTER_TIMEOUT_MS = 10000;
const TRENDING_TEXT_LIMIT = 2_000_000;

/**
 * 激活期间由 activate 注入。卸载时不置空：宿主可能在卸载动画期间再渲染一次
 * 组件，置空会让那次渲染直接抛错。生命周期隔离靠 activateSeq / genSeq /
 * digestSeq 三代际号，不靠这个引用。
 */
let appCtx = null;

const PERIODS = [
  { key: "daily", label: "今日" },
  { key: "weekly", label: "本周" },
  { key: "monthly", label: "本月" },
];

const RISING_PERIOD = { key: "rising", label: "新星库" };

const DEFAULT_SETTINGS = {
  period: "daily",
  language: "",
  minStars: 50,
  engine: "",
  model: "",
  workspacePath: "",
  token: "",
  /** 讨论用的提示词列表（空列表 = 用内置模板）。 */
  prompts: [],
  /** 点「讨论」时用哪一份；空 = 用列表第一份。 */
  defaultPromptId: "",
};

const DEFAULT_STATE = {
  view: "trending",
  settings: { ...DEFAULT_SETTINGS },
  repos: [],
  dropped: [],
  isFirstRun: true,
  loadedAt: null,
  source: "",
  httpError: "",
  errorKind: "",
  loading: false,
  loaded: false,
  digest: "",
  /** 用户主动停止：正文是半截的，界面要说清楚，不能装成写完了。 */
  digestStopped: false,
  digestTruncated: false,
  digestIncluded: 0,
  digestTotal: 0,
  generating: false,
  /** 正在为哪一行开会话（仓库全名）；空串 = 没有在开。 */
  discussing: "",
  /** 开会话失败的原因。会话是真 token，失败必须说明白，不能静默。 */
  discussError: "",
  /**
   * 已开好会话的仓库全名；空串 = 没有待确认的会话。
   *
   * 本页不会自动跳到新会话（`startRun` 没有这个能力，详见 discussRepo），
   * 所以「已经开了」这件事必须由页面说出来，否则点完跟没点一样。
   */
  discussNotice: "",
  /** 会话实际挂在哪个侧栏工作区分组下（目录名）；空串 = 没登记成功。 */
  discussWorkspace: "",
  /** 会话建起来了、但没挂进侧栏工作区时的说明。不阻塞会话，只解释为什么可能看不见。 */
  discussWarning: "",
  /** 这次开会话是续接了旧会话还是新开的；空串 = 没开会话。用于回执说明。 */
  discussResumed: false,
  /** 这次开会话用的是哪份提示词的名字；空串 = 内置默认。 */
  discussPromptName: "",
  /**
   * README 预览。同一时刻只展开一个仓库：
   * `open` 是仓库全名，空串 = 全部收起。
   */
  readmeOpen: "",
  readmeLoading: false,
  readmeError: "",
  /** 已处理（去 badge/HTML、截断）的正文；渲染时直接过 Markdown 子集。 */
  readmeText: "",
  readmeTruncated: false,
  readmeTotal: 0,
  catalog: [],
  catalogLoaded: false,
  modelsLoading: false,
  modelsError: "",
  /** 插件数据目录的绝对路径；生成解读时的默认 cwd。 */
  storagePath: "",
};

const store = { snap: { ...DEFAULT_STATE }, listeners: new Set() };

function set(patch) {
  store.snap = Object.assign({}, store.snap, patch);
  for (const fn of store.listeners) {
    try {
      fn();
    } catch {
      /* 单个订阅者出错不影响其他 */
    }
  }
}

function setSettings(patch) {
  set({ settings: Object.assign({}, store.snap.settings, patch) });
}

async function persistSettings(ctx, patch) {
  if (patch) setSettings(patch);
  try {
    await ctx.storage.set("settings", store.snap.settings);
    return true;
  } catch {
    set({ httpError: "设置保存失败" });
    return false;
  }
}

function useSnap() {
  return appCtx.react.useSyncExternalStore(
    (cb) => {
      store.listeners.add(cb);
      return () => store.listeners.delete(cb);
    },
    () => store.snap,
  );
}

let genSeq = 0;
let digestSeq = 0;
let activateSeq = 0;

const THIN_ICON = {
  width: 16,
  height: 16,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  "stroke-width": 1.5,
  "stroke-linecap": "round",
  "stroke-linejoin": "round",
  "aria-hidden": "true",
};

/**
 * 应用内图标：三根递增柱，与 docs/icon.png 同一套符号。
 * 侧栏/页签里只有 16px，线条一律 1.5px、不画刻度与指针——细节到这个尺寸只会糊。
 */
function Icon(props) {
  const h = appCtx.react.createElement;
  return h(
    "svg",
    Object.assign({}, THIN_ICON, props && props.className ? { className: props.className } : {}),
    h("path", { d: "M3.2 12.6V9.4" }),
    h("path", { d: "M8 12.6V6.6" }),
    h("path", { d: "M12.8 12.6V3.4" }),
    h("path", { d: "M2.2 12.6h11.6", "stroke-width": 1.2 }),
  );
}

/**
 * Build artefacts inline lib/*.mjs verbatim, but those files are ES modules.
 * A literal `export ` inside a function body is a syntax error, so drop the
 * keyword — every declaration is already a top-level function declaration.
 */

function fmtNumber(n) {
  if (!Number.isFinite(n)) return "";
  if (n >= 1000) {
    const k = n / 1000;
    return (k >= 100 ? String(Math.round(k)) : k.toFixed(1).replace(/\.0$/, "")) + "k";
  }
  return String(n);
}

function fmtTime(ts) {
  if (!ts) return "";
  try {
    return new Date(ts).toLocaleString("zh-CN", {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

/** 只允许 https 链接进 DOM；其它一律当纯文本。 */
function safeHref(url) {
  return typeof url === "string" && /^https:\/\/[a-z0-9.-]+(\/|$)/i.test(url) ? url : null;
}

/**
 * 写剪贴板。宿主是 Electron，正常都有 `navigator.clipboard`；缺失时直接 reject，
 * 由调用方把「复制失败」显示出来——静默失败比不支持更糟，用户会以为已经复制了。
 *
 * 返回值是「这次复制自己的」Promise，不是布尔：连点两次导出时，两个 Promise
 * 各自 resolve，调用方不必靠一个共享的 timestamp 去猜哪次结果该留下了。
 */
function copyText(text) {
  try {
    const clip = typeof navigator !== "undefined" ? navigator.clipboard : null;
    if (clip && typeof clip.writeText === "function") {
      return Promise.resolve(clip.writeText(String(text)));
    }
  } catch {
    /* 落到下面统一 reject */
  }
  return Promise.reject(new Error("clipboard unavailable"));
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label + " timeout")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * 语言名会进 URL 与快照文件名，先收敛成安全形状：
 * 只允许字母/数字/加号/井号/点/连字符（覆盖 c++、c#、objective-c、f# 等），
 * 其余一律换成连字符——这样 `../../evil`、`a/b`、绝对路径都拼不出目录穿越。
 */
function safeLanguage(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return "";
  const cleaned = s.replace(/[^a-z0-9+#.-]/g, "-").replace(/^[.-]+/, "").replace(/[.-]+$/, "");
  return cleaned.slice(0, 40);
}

function trendingUrl(period, language) {
  const lang = safeLanguage(language);
  const base = "https://github.com/trending" + (lang ? "/" + encodeURIComponent(lang) : "");
  return base + "?since=" + encodeURIComponent(period);
}

function historyPath(period, language) {
  const suffix = safeLanguage(language) || "all";
  return HISTORY_DIR + "/" + period + "-" + suffix + ".json";
}

function messageOf(error) {
  const raw = error && error.message ? String(error.message) : String(error || "");
  if (/network:|no declared network|missing permission|without declaring/i.test(raw)) {
    return "网络授权未生效，请重新安装插件";
  }
  if (/timed?\s*out|timeout/i.test(raw)) return "请求超时，请稍后重试";
  return raw || "请求失败";
}

async function httpGet(url, headers) {
  const res = await withTimeout(
    appCtx.bridge.invoke("plugin_http_request", {
      method: "GET",
      url,
      headers: headers || {},
      body: null,
    }),
    REQUEST_TIMEOUT_MS,
    "http",
  );
  return { status: Number(res && res.status) || 0, body: res && typeof res.body === "string" ? res.body : "" };
}

async function fetchTrending(ctx, period, language) {
  const res = await httpGet(trendingUrl(period, language), {
    Accept: "text/html,application/xhtml+xml",
    "User-Agent": "ccgui-github-trending/" + ctx.version,
  });
  if (res.status === 429 || res.status === 403) {
    return { ok: false, kind: "rate_limited", message: "GitHub 拒绝了这次请求（HTTP " + res.status + "），稍后再试" };
  }
  if (res.status < 200 || res.status >= 300) {
    return { ok: false, kind: "http", message: "GitHub 返回 HTTP " + res.status };
  }
  if (res.body.length > TRENDING_TEXT_LIMIT) {
    return { ok: false, kind: "http", message: "页面体积异常，已放弃解析" };
  }
  const parsed = parseTrending(res.body);
  if (parsed.error) {
    return {
      ok: false,
      kind: parsed.error,
      message: parsed.error === "no_rows" ? "没解析到仓库行，GitHub 页面结构可能已变化" : "GitHub 返回了空页面",
    };
  }
  return { ok: true, repos: parsed.repos };
}

async function fetchRising(settings) {
  const url =
    "https://api.github.com/search/repositories?q=" +
    encodeURIComponent(buildRisingQuery(settings.minStars, 7)) +
    "&sort=stars&order=desc&per_page=25";
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "ccgui-github-trending",
  };
  const token = String(settings.token || "").trim();
  if (token) headers.Authorization = "Bearer " + token;

  const res = await httpGet(url, headers);
  let payload = null;
  try {
    payload = JSON.parse(res.body);
  } catch {
    payload = null;
  }
  const parsed = parseRising(payload);
  if (parsed.error === "rate_limited") {
    return {
      ok: false,
      kind: "rate_limited",
      message: token
        ? "GitHub 限流了，请等一会儿再刷新"
        : "GitHub 未认证限流（10 次/分钟），可在设置里填 Token 提高额度",
    };
  }
  if (parsed.error) {
    return {
      ok: false,
      kind: parsed.error,
      message: res.status >= 400 ? "GitHub 返回 HTTP " + res.status : "新星库结果为空，可调低 star 阈值",
    };
  }
  return { ok: true, repos: parsed.repos };
}

/* ---------- README 预览 ---------- */

/**
 * README 的接口选在 api.github.com 而不是 raw.githubusercontent.com：前者已经在
 * `network:api.github.com` 的授权里，后者要新增一条网络权限、重装后才生效，而
 * 换来的只是省一次 API 配额（README 是低频动作，配额不是瓶颈）。设置里的 Token
 * 也自动复用——私有仓的 README 因此能读。
 *
 * `Accept: application/vnd.github.raw` 让接口直接回文件正文而不是 base64 JSON；
 * 但网关可能无视它，所以 `readmeTextFromBody` 两种形状都认。
 */
async function fetchReadme(repo, settings) {
  const url = "https://api.github.com/repos/" + repo + "/readme";
  const headers = {
    Accept: "application/vnd.github.raw",
    "User-Agent": "ccgui-github-trending",
  };
  const token = String((settings && settings.token) || "").trim();
  if (token) headers.Authorization = "Bearer " + token;

  const res = await httpGet(url, headers);
  if (res.status === 404) return { ok: false, message: "这个仓库没有 README" };
  if (res.status === 403 || res.status === 429) {
    return {
      ok: false,
      message: token ? "GitHub 限流了，请等一会儿再试" : "GitHub 未认证限流（10 次/分钟），可在设置里填 Token",
    };
  }
  if (res.status < 200 || res.status >= 300) return { ok: false, message: "GitHub 返回 HTTP " + res.status };

  const prepared = prepareReadme(readmeTextFromBody(res.body));
  if (!prepared) return { ok: false, message: "README 是空的" };
  const clipped = truncateReadme(prepared);
  return { ok: true, text: clipped.text, truncated: clipped.truncated, total: clipped.total };
}

/** 只允许「看上去像 GitHub 仓库名」的输入拼进 URL，避免路径注入到别的接口路径上。 */
function readmeRepoKey(repo) {
  const s = String(repo || "").trim();
  return /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(s) ? s : "";
}

let readmeSeq = 0;

/**
 * 展开 / 收起某行的 README。
 *
 * 同时只开一个：README 预览占了整行高度，开两个就得滚很远才能回到榜单，
 * 而用户的动作本身就是「看这一行的 README」。
 *
 * 不做「所有展开过的都缓存」：一个会话里翻十几个仓库、每个都常驻一份全文，
 * 收益抵不上缓存失效判断的复杂度。收起即丢弃，再展开就重拉。
 */
async function toggleReadme(ctx, row) {
  const repo = readmeRepoKey(row && row.repo);
  if (!repo) return;
  if (store.snap.readmeOpen === repo) {
    // 收起：作废在飞的请求，否则回来时会把已经收起的行重新展开。
    readmeSeq += 1;
    set({ readmeOpen: "", readmeLoading: false, readmeError: "", readmeText: "", readmeTruncated: false, readmeTotal: 0 });
    return;
  }
  const seq = ++readmeSeq;
  // 换行展开时先清掉上一份正文：否则新行会短暂显示上一个仓库的 README。
  set({ readmeOpen: repo, readmeLoading: true, readmeError: "", readmeText: "", readmeTruncated: false, readmeTotal: 0 });
  try {
    const result = await fetchReadme(repo, store.snap.settings);
    if (seq !== readmeSeq) return;
    if (!result.ok) {
      set({ readmeLoading: false, readmeError: result.message });
      return;
    }
    set({
      readmeLoading: false,
      readmeError: "",
      readmeText: result.text,
      readmeTruncated: result.truncated,
      readmeTotal: result.total,
    });
  } catch (error) {
    if (seq !== readmeSeq) return;
    set({ readmeLoading: false, readmeError: "读取 README 失败：" + messageOf(error) });
  }
}

/* ---------- 快照读写 ---------- */

async function readSnapshot(ctx, period, language) {
  try {
    const doc = await ctx.documentStorage.readText(historyPath(period, language));
    if (!doc) return null;
    const data = JSON.parse(doc.content);
    return Array.isArray(data && data.repos) ? data.repos : null;
  } catch {
    // 读失败 = 真的读不了（权限/目录失效），不要伪装成「没有历史」；
    // 但对比失败不该阻塞主流程，退化为首次使用。
    return null;
  }
}

/**
 * 写快照。同一路径的并发写会 CAS 冲突：快速切语言/时间档时两次写会读到同一个
 * version，后者被吞掉，导致快照停在旧数据、下次刷新把已上榜的重标成「新上榜」。
 * 这里按路径串行化，并在冲突后重读 version 重试一次。
 */
const snapshotLocks = new Map();

async function writeSnapshot(ctx, period, language, repos) {
  const rel = historyPath(period, language);
  const prev = snapshotLocks.get(rel) || Promise.resolve();
  const run = () => writeSnapshotOnce(ctx, rel, period, language, repos);
  // prev 失败也要继续：上一轮的写盘错误不该让这一轮静默不写。
  const next = prev.then(run, run);
  // 记进 Map 的必须是这一轮真正的「队尾」引用，否则 finally 里的 === 判断
  // 永远不成立（存 next.catch() 存的是另一个 Promise），锁表只增不减。
  const tail = next.catch(() => {});
  snapshotLocks.set(rel, tail);
  try {
    await next;
  } finally {
    // 只有自己还是队尾才删：后面已有新写入排队时，删了就会让它们并发。
    if (snapshotLocks.get(rel) === tail) snapshotLocks.delete(rel);
  }
}

async function writeSnapshotOnce(ctx, rel, period, language, repos) {
  const content = JSON.stringify({ savedAt: new Date().toISOString(), repos });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      let expected = null;
      const existing = await ctx.documentStorage.readText(rel);
      if (existing) expected = existing.version;
      // 内容没变就不覆盖：省一次写盘，也不必清理 .bak。
      if (existing) {
        try {
          const parsed = JSON.parse(existing.content);
          if (Array.isArray(parsed && parsed.repos) && snapshotSignature(parsed.repos) === snapshotSignature(repos)) {
            return;
          }
        } catch {
          /* 旧文件损坏：直接覆盖 */
        }
      }
      await ctx.documentStorage.writeTextAtomic(rel, content, expected);
      await cleanupBackups(ctx, rel);
      return;
    } catch (error) {
      // 只有 CAS 冲突值得重试；其它错误（权限、目录）重试也没用。
      if (attempt === 0 && /conflict/i.test(String(error && error.message))) continue;
      // 快照只是增强：写失败不该让用户看不到榜单。
      return;
    }
  }
}

async function cleanupBackups(ctx, rel) {
  try {
    const backup = rel + ".bak";
    const doc = await ctx.documentStorage.readText(backup);
    if (doc) await ctx.documentStorage.remove(backup, doc.version);
  } catch {
    /* 清理失败无害 */
  }
}

/**
 * 快照文件按 period+language 分槽，同一槽只有一份，所以不需要按天清理；
 * 这里只清宿主覆盖时留下的 .bak（宿主在覆盖前留备份，插件负责清理）。
 */
async function pruneHistory(ctx) {
  try {
    const files = await ctx.documentStorage.list(HISTORY_DIR);
    const backups = (Array.isArray(files) ? files : [])
      .map((f) => String(f).replace(/\\/g, "/"))
      .filter((f) => f.startsWith(HISTORY_DIR + "/") && f.endsWith(".bak"));
    for (const name of backups) {
      try {
        const doc = await ctx.documentStorage.readText(name);
        if (doc) await ctx.documentStorage.remove(name, doc.version);
      } catch {
        /* 单个清理失败不影响其他 */
      }
    }
  } catch {
    /* 目录不存在或 list 不支持前缀都很正常 */
  }
}

/* ---------- 加载 ---------- */

async function refresh(ctx, options) {
  const force = Boolean(options && options.force);
  const snap = store.snap;
  const settings = snap.settings;
  const view = snap.view;
  const period = view === "rising" ? RISING_PERIOD.key : settings.period;
  const language = view === "rising" ? "" : settings.language;

  // 同一视图已经有数据且不是强制刷新：不重复打网络。
  if (!force && snap.loaded && snap.source === view + ":" + period + ":" + language) return;

  const seq = ++genSeq;

  // 榜单要换掉了：这份榜单里续接过的会话属于旧话题，不能再往新讨论里接。
  resetDiscussSessions();

  // 讨论的回执只服务于那一次点击：刷新是用户明确表示的「再来一次」，
  // 回执要让位给榜单本身的状态说明，失败的那条同理。
  set({
    loading: true,
    httpError: "",
    errorKind: "",
    discussError: "",
    discussNotice: "",
    discussWorkspace: "",
    discussWarning: "",
    discussResumed: false,
    discussPromptName: "",
    readmeOpen: "",
    readmeLoading: false,
    readmeError: "",
    readmeText: "",
    readmeTruncated: false,
    readmeTotal: 0,
  });

  let result;
  try {
    result = view === "rising" ? await fetchRising(settings) : await fetchTrending(ctx, period, language);
  } catch (error) {
    result = { ok: false, kind: "network", message: messageOf(error) };
  }

  // 代际校验：用户可能已经切了视图、或发起了新一轮。
  // 宿主桥没有 AbortSignal，晚到的响应只能靠这里丢弃。
  if (seq !== genSeq) return;

  if (!result.ok) {
    const key = view + ":" + period + ":" + language;
    // 失败时优先保住用户正在看的内容：同一视图的旧数据 > 本地快照 > 空。
    const sameView = snap.source === key && snap.repos.length > 0;
    const cached = view === "rising" ? null : await readSnapshot(ctx, period, language);
    if (seq !== genSeq) return;
    const fallback = sameView ? snap.repos : cached ? diffSnapshot(cached, null).repos : [];
    set({
      loading: false,
      loaded: true,
      errorKind: result.kind,
      httpError: result.message,
      source: key,
      repos: fallback,
      dropped: sameView ? snap.dropped : [],
      isFirstRun: sameView ? snap.isFirstRun : Boolean(cached),
      loadedAt: sameView ? snap.loadedAt : cached ? Date.now() : null,
    });
    return;
  }

  let previous = null;
  if (view !== "rising") {
    previous = await readSnapshot(ctx, period, language);
    if (seq !== genSeq) return;
  }

  const diff = diffSnapshot(result.repos, previous);
  set({
    loading: false,
    loaded: true,
    errorKind: "",
    httpError: "",
    repos: diff.repos,
    dropped: diff.dropped,
    isFirstRun: diff.isFirstRun,
    source: view + ":" + period + ":" + language,
    loadedAt: Date.now(),
  });

  // 快照只对 Trending 有意义（新星库是滚动窗口，排名不可比）。
  if (view !== "rising") await writeSnapshot(ctx, period, language, result.repos);
}

/* ---------- AI 解读 ---------- */

/**
 * 插件自己的数据目录（宿主隔离存储根，通常是 ~/.ccgui-next/plugin-data/<id>）。
 * 拿不到时返回空串，由调用方回退。
 */
async function pluginDataDir(ctx) {
  const cached = store.snap.storagePath;
  if (cached) return cached;
  const ds = ctx && ctx.documentStorage;
  if (!ds || typeof ds.getLocation !== "function") return "";
  try {
    const loc = await ds.getLocation();
    const path = String(loc && loc.path ? loc.path : "").replace(/[\\/]+$/, "");
    if (path) set({ storagePath: path });
    return path;
  } catch {
    return "";
  }
}

/**
 * 解读与「讨论」时引擎进程的 cwd。
 *
 * 顺序：用户显式选择 > 插件数据目录。
 *
 * 默认值不是可有可无的兜底：agent 跑一轮会在 ~/.claude/projects 留下会话记录，
 * cwd 就是这里传的值。挂在真实项目名下，「生成热点解读」这个动作本身会被那个
 * 项目的会话历史记成一次工作产出。收到插件目录后，这类会话归在
 * plugin-data/github-trending 下，谁产生的也一眼看得出。
 *
 * 没有第三层「侧栏第一个工作区」：留空就该是插件目录，不能悄悄跑到用户的
 * 真实项目里——那样「我什么都没选」和「我选了项目 A」的行为一模一样，没人能
 * 预料 cwd 到底在哪。宿主的 documentStorage 不可用时返回空串，由调用方报错
 * 让用户自己用「选择…」指定。
 */
async function resolveWorkspace(ctx, settings) {
  return pickWorkspace(settings, await pluginDataDir(ctx));
}

/** 用于比较的两个路径是否指向同一个目录：大小写、分隔符、尾部分隔符都不敏感。 */
function samePathKey(p) {
  return String(p || "")
    .trim()
    .replace(/[\\/]+$/, "")
    .replace(/\//g, "\\")
    .toLowerCase();
}

/** 侧栏分组名：宿主用目录名命名工作区，回执里照实说，用户才好去侧栏找。 */
function baseName(p) {
  const s = String(p || "").trim().replace(/[\\/]+$/, "");
  const i = Math.max(s.lastIndexOf("\\"), s.lastIndexOf("/"));
  return i >= 0 ? s.slice(i + 1) : s;
}

let workspaceRegistrations = new Map();

/**
 * 确保会话所在目录已经是宿主的侧栏工作区——「点了讨论，侧栏却没有会话」的根因修复。
 *
 * 宿主扫描会话目录时以工作区表为起点：`~/.claude/projects/<编码路径>/` 里写了
 * 多少 jsonl 都没用，只要对应目录不在侧栏工作区里，宿主就不会把它收进会话表，
 * 侧栏自然看不见（本机实测：所有已登记工作区的会话都在表里，plugin-data 下的
 * 会话一条都没有，但 jsonl 明明写得好好的）。
 *
 * 所以开会话前先登记工作目录。副作用是该目录会以目录名出现在侧栏工作区列表里，
 * 这恰好是「会话挂在哪个工作区下」的可见形式，用户随时可以在侧栏移除。
 *
 * 失败不阻断会话：宿主版本没有 workspaces API、权限没到位、或登记被拒时，仍照常
 * startRun，由调用方把「可能看不见」写进回执——按钮不能假死。
 *
 * 同一路径登记成功后就记住：不必每点一行都再查一遍列表；失败的不缓存，
 * 下次点击还会重试（偶发 IPC 失败不该让本页从此都看不见会话）。
 */
async function ensureWorkspaceRegistered(ctx, workspace) {
  const key = samePathKey(workspace);
  if (!key) return { visible: false, error: "" };
  const cached = workspaceRegistrations.get(key);
  if (cached) return cached;
  const remember = (result) => {
    if (result.visible) workspaceRegistrations.set(key, result);
    return result;
  };
  if (!ctx || !ctx.workspaces || typeof ctx.workspaces.add !== "function") {
    return { visible: false, error: "当前宿主不支持登记侧栏工作区，会话可能不会出现在侧栏" };
  }
  try {
    if (typeof ctx.workspaces.list === "function") {
      const rows = await withTimeout(ctx.workspaces.list(), WORKSPACE_REGISTER_TIMEOUT_MS, "工作区列表");
      const listed = (Array.isArray(rows) ? rows : []).some(
        (r) => r && samePathKey(r.path || r.workspacePath || r.dir) === key,
      );
      if (listed) return remember({ visible: true, error: "" });
    }
    await withTimeout(ctx.workspaces.add(workspace), WORKSPACE_REGISTER_TIMEOUT_MS, "登记工作区");
    // 新登记的工作区宿主还没扫过。补一次会话目录刷新：之前点过「讨论」、
    // jsonl 已经落盘但没进侧栏的会话能立刻找回来。startRun 建的新会话
    // 不依赖这次刷新（文档写明会立即出现在侧栏），所以这里不等待、失败也不报。
    if (ctx.sessions && typeof ctx.sessions.refresh === "function") {
      void Promise.resolve(ctx.sessions.refresh()).catch(() => {});
    }
    return remember({ visible: true, error: "" });
  } catch (error) {
    // 用原始 message 判权限：messageOf 会把 missing permission 归到网络那一套，
    // 这里的失败是 manifest 权限，不是网络授权。
    const raw = error && error.message ? String(error.message) : String(error || "");
    const hint = /host:workspace|permission|not declared/i.test(raw)
      ? "缺少登记工作区的权限，请重新安装插件（manifest 已声明 host:workspace）"
      : "登记侧栏工作区失败：" + messageOf(error);
    return remember({ visible: false, error: hint });
  }
}

/** 界面展示统一用本机分隔符；传给宿主与存储的仍是原始路径。 */
function displayPath(p) {
  const s = String(p || "").trim();
  if (!s) return "";
  return /^[A-Za-z]:[\\/]|^\\\\/.test(s) ? s.replace(/\//g, "\\") : s.replace(/\\/g, "/");
}

/**
 * 引擎目录。与工作志同一套：走 ctx.agent.catalog()，一次调用就同时拿到
 * 引擎、可用性、模型与 readOnly 标记。
 *
 * 不用 ctx.models：那是宿主模型目录接口，需要额外的 host:models 权限，
 * 且要分两次调（引擎一次、每个引擎的模型再一次），还没有 available 标记。
 */
let catalogLoading = false;

async function loadCatalog(ctx, options) {
  if (catalogLoading) return;
  const force = Boolean(options && options.force);
  if (!force && store.snap.catalogLoaded) return;
  catalogLoading = true;
  set({ modelsLoading: true, modelsError: "" });
  try {
    // 目录也按生成时真正会用的 cwd 去查，免得下拉里看到的引擎和实际跑的不是一套。
    const workspace = await resolveWorkspace(ctx, store.snap.settings);
    const list = await ctx.agent.catalog(workspace || undefined);
    const entries = (Array.isArray(list) ? list : []).filter(
      (e) => e && typeof e.engine === "string" && e.engine.trim() !== "",
    );
    set({ catalog: entries, catalogLoaded: true, modelsLoading: false });
  } catch (error) {
    // 「读不到引擎目录」和「没有可用引擎」是两回事，提示不能混。
    set({
      catalog: [],
      catalogLoaded: false,
      modelsLoading: false,
      modelsError: "读取引擎目录失败：" + messageOf(error),
    });
  } finally {
    catalogLoading = false;
  }
}

const ENGINE_LABELS = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  qoder: "Qoder",
  "qoder-cn": "Qoder (CN)",
  kimi: "Kimi CLI",
  grok: "Grok CLI",
  codebuddy: "CodeBuddy",
  minimax: "MiniMax",
  omp: "OMP",
  dsh: "DSH",
  agy: "AGY",
  pi: "Pi",
};

/** 宿主 catalog 的 id 是不可信输入：只认表里的自有属性。 */
function engineLabel(id) {
  const key = String(id || "").trim();
  if (!key) return "";
  const hit = Object.prototype.hasOwnProperty.call(ENGINE_LABELS, key)
    ? ENGINE_LABELS[key]
    : Object.prototype.hasOwnProperty.call(ENGINE_LABELS, key.toLowerCase())
      ? ENGINE_LABELS[key.toLowerCase()]
      : "";
  return hit || key;
}

/** 可用的排前面，组内按显示名排序（与工作志、CLI 安装检测插件一致）。 */
function sortCatalog(list) {
  return (Array.isArray(list) ? list.slice() : []).sort((a, b) => {
    const ai = a && a.available === false ? 1 : 0;
    const bi = b && b.available === false ? 1 : 0;
    if (ai !== bi) return ai - bi;
    return engineLabel(a && a.engine).localeCompare(engineLabel(b && b.engine), "en");
  });
}

/** 取选中引擎的目录条目；没显式选就返回第一个可用的。 */
function pickEntry(catalog, preferred) {
  const list = Array.isArray(catalog) ? catalog : [];
  const want = String(preferred || "").trim();
  if (want) return list.find((e) => e && e.engine === want) || null;
  return list.find((e) => e && e.available !== false) || null;
}

/**
 * 一轮解读的完整生命周期。把它收成一个对象而不是散在闭包里，是为了让
 * 「start 还在飞的时候用户点停止」也能被正确处理——那种时刻还没有 runId，
 * 只有会话对象知道这一轮已经作废。
 */
let activeDigest = null;

function newDigestSession(seq) {
  return {
    seq,
    runId: null,
    // start 还没 resolve 就被停止/切走：拿到 runId 后必须立刻 interrupt，
    // 否则宿主那侧的进程会跑到底、一直烧 token。
    cancelled: false,
    interrupted: false,
    settled: false,
    timer: null,
    off: null,
  };
}

/** 释放这一轮的事件订阅与定时器；幂等。 */
function releaseSession(session) {
  if (!session) return;
  session.settled = true;
  if (session.timer) {
    clearTimeout(session.timer);
    session.timer = null;
  }
  if (session.off) {
    try {
      session.off();
    } catch {
      /* 宿主可能已回收 */
    }
    session.off = null;
  }
  if (activeDigest === session) activeDigest = null;
}

/**
 * 打断这一轮在宿主侧的 run。
 *
 * 与 releaseSession 分开，是因为「停止」可能发生在 start 还没返回的时候：
 * 那一刻没有 runId 可打断，只能先记下 cancelled；等 start resolve 拿到 runId
 * 后再补这一刀。合并进幂等清理里就会被 settled 守卫挡掉，留下孤儿进程。
 *
 * 判据是「有没有真的起来一轮」（runId 是否存在），**不是** cancelled：超时、
 * 引擎报错同样是「插件放手了、宿主还在跑」，也必须打断。之前用 cancelled
 * 当闸门，导致 finish(error) 传了 interrupt 也被挡掉，120s 超时后宿主那侧
 * 继续烧 token 到自然结束。要不要打断由调用方决定（传不传 interruptRun），
 * 这里只保证不重复打断。
 */
function interruptSession(session, interruptRun) {
  if (!session || !session.runId || session.interrupted) return;
  if (typeof interruptRun !== "function") return;
  session.interrupted = true;
  try {
    void interruptRun(session.runId);
  } catch {
    /* 已结束 */
  }
}

function disposeSession(session, interruptRun) {
  releaseSession(session);
  interruptSession(session, interruptRun);
}

/**
 * 作废这一轮并打断宿主侧。
 *
 * 「先标记 cancelled、再打断」原本在停止/超时/卸载三处各写一遍，靠每个
 * 调用方记得两件事都做。收成一个动作后，漏掉任何一半都不可能发生。
 */
function cancelSession(session, ctx) {
  if (!session) return;
  session.cancelled = true;
  disposeSession(session, (runId) => ctx.agent.interrupt(runId));
}

/** 停止当前解读：无论它处于「准备中」「start 在飞」还是「流式中」。 */
function abortDigest(ctx) {
  digestSeq += 1;
  cancelSession(activeDigest, ctx);
  // 已经写出来的半截正文留着（用户可能还想看），但要标成「已停止」：
  // 否则它和一份正常写完的解读长得一模一样。
  set({ generating: false, digestStopped: Boolean(store.snap.digest) });
}

/* ---------- 单个仓库的讨论会话 ---------- */

/**
 * 和「生成解读」是两种东西，不能混用同一个 API：
 * - `agent.start` 的输出去向只有本插件，用户只能在面板里看完；
 * - `sessions.startRun` 会在侧栏起一个**宿主聊天会话**，用户能接着追问、能停、
 *   能我们之外的人接管。这正是「进项目里聊聊」需要的形态。
 *
 * 能力探测而不是硬用：`sessions` 是 0.3.18 才有的，宿主版本不达标时
 * `ctx.sessions` 不存在。这里必须给出可读文案，不能让按钮点了没反应。
 */
function supportsDiscuss(ctx) {
  const s = ctx && ctx.sessions;
  return Boolean(s && typeof s.startRun === "function");
}

let discussSeq = 0;

/**
 * 这份榜单里已经为哪些仓库开过会话：`仓库全名 -> sessionId`。
 *
 * 只在**同一份榜单**内有效——刷新、切日/周/月、切新星库时清空。理由：榜单
 * 每天在变，昨天为 beta/two 开的会话里积累的是昨天的结论；把它当今天新话题
 * 的上下文，会让模型拿旧事实说话。同一次浏览内续接则相反：用户已经追问过
 * 「它的插件机制怎么实现的」，再点一次不该从零开始。
 *
 * sessionId 可能拿不到：`startRun` 文档写明引擎稍后才 announce，此时返回 null。
 * 那条路径记成 `null`（表示「开过但没有 id」），点第二次仍然新开——续接是
 * 加分项，拿不到 id 时不能因此让按钮失败。
 */
let discussSessions = new Map();

/** 清空续接表。刷新/切视图/卸载时调用。 */
function resetDiscussSessions() {
  discussSessions = new Map();
}

/**
 * 为一行榜单开一个会话。
 *
 * 不走 activeDigest 那套「start 在飞时点停止」的状态机：会话一旦建起来就归
 * 宿主聊天托管，插件的责任只有「别开两轮」和「失败要说清楚」。
 *
 * **不会跳转**，这是 API 决定的：`startRun` 只承诺「会话立刻出现在侧栏」，
 * 入参里没有任何切视图的字段。真正切视图的是 `selectSession(engine,
 * sessionId, workspacePath)`，而新会话的 sessionId 从 `startRun` 拿不到可靠值
 * （文档：引擎稍后才 announce 时为 null）。所以这里不硬凑一条「订阅回执再补
 * 跳」的链子——那种延迟跳转会在用户已经切去别处之后把人拽回来。代价是本页
 * 停在原地，由 `discussNotice` 在提示行里说明会话去哪了。
 */
async function discussRepo(ctx, row) {
  const snap = store.snap;
  if (!row || !row.repo) return;
  if (snap.discussing) return;
  if (!supportsDiscuss(ctx)) {
    set({ discussError: "当前 CC GUI 版本不支持从插件发起会话，请升级宿主" });
    return;
  }

  const seq = ++discussSeq;
  // 新的一轮先把上一条「已开会话」提示收掉：否则连续点两行，页面会同时说
  // 两个仓库都开了会话，而实际只留了最后那条。
  set({
    discussing: row.repo,
    discussError: "",
    discussNotice: "",
    discussWorkspace: "",
    discussWarning: "",
    discussResumed: false,
    discussPromptName: "",
  });
  const settings = snap.settings;
  const bailed = (message) => {
    if (seq === discussSeq) set({ discussing: "", discussError: message });
  };

  try {
    const workspace = await resolveWorkspace(ctx, settings);
    if (seq !== discussSeq) return;
    // 工作目录是会话的 cwd，拿不到就没法保证 agent 在哪读文件。
    if (!workspace) return bailed("读不到插件数据目录，请到设置里点「选择…」指定一个 AI 工作区");

    // 会话要出现在侧栏，前提是它挂在一个宿主已登记的工作区下。不登记就
    // startRun，jsonl 会照写、进程会照跑，但侧栏里一条都看不到——先登记再开会话。
    const registration = await ensureWorkspaceRegistered(ctx, workspace);
    if (seq !== discussSeq) return;

    // 引擎目录可能还没加载（用户直接从页签点进来看榜单）。
    if (!store.snap.catalogLoaded) {
      await loadCatalog(ctx);
      if (seq !== discussSeq) return;
    }
    if (store.snap.modelsError) return bailed(store.snap.modelsError);

    const entry = pickEntry(store.snap.catalog, settings.engine);
    if (!entry) return bailed("没有可用引擎，请先在设置里选择");
    if (entry.available === false) return bailed(engineLabel(entry.engine) + " 当前不可用，请换一个引擎");

    const models = (entry.models || []).filter((m) => m && typeof m.id === "string" && m.id.trim());
    const model = String(settings.model || "").trim() || (models[0] ? models[0].id : undefined);

    // 设置里可能维护了多份提示词，用选中的那份；没设置过就用内置模板。
    const chosen = pickPrompt(settings.prompts, settings.defaultPromptId);
    const prompt = buildDiscussPrompt({
      row,
      view: snap.view,
      period: snap.view === "rising" ? RISING_PERIOD.key : settings.period,
      language: snap.view === "rising" ? "" : settings.language,
      template: chosen.text,
    });

    // 同一份榜单里已经为这个仓库开过、且拿得到 sessionId → 续接。
    // 拿不到 id（引擎稍后才 announce）时退回新开：续接是加分项，不能因此失败。
    const known = discussSessions.get(row.repo);
    const resumeId = typeof known === "string" && known ? known : "";

    // 新会话不带 sessionId：宿主会建一个，侧栏立即可见。
    // 续接时传 sessionId 会切回那个会话并沿用它的模型/强度（文档明确覆盖会被忽略）。
    const started = await withTimeout(
      ctx.sessions.startRun({
        sessionId: resumeId || undefined,
        engine: entry.engine,
        model: model || undefined,
        prompt,
        workspacePath: workspace,
      }),
      DISCUSS_TIMEOUT_MS,
      "会话启动",
    );

    // 记住这一行的 sessionId，供同榜内再次点击时续接。
    // `started.sessionId` 可能为 null——那就存 null，下次照常新开。
    const sessionId = started && typeof started.sessionId === "string" && started.sessionId ? started.sessionId : "";
    discussSessions.set(row.repo, sessionId);

    // 不跳转这件事必须写在页面上。侧栏多一行对正在扫榜的人是很容易错过的，
    // 不给提示就会被理解成「按钮没反应」，进而连点，多开一轮真 token。
    if (seq === discussSeq)
      set({
        discussing: "",
        discussError: "",
        discussNotice: row.repo,
        discussWorkspace: registration.visible ? baseName(workspace) : "",
        discussWarning: registration.visible ? "" : registration.error,
        discussResumed: Boolean(resumeId),
        // 用哪份提示词要说出来：用户维护了好几份，回执不写名字就分不清刚才
        // 点的是哪一套要求。内置默认时不显示（那是没有选择的选择）。
        discussPromptName: chosen.id ? chosen.name : "",
      });
  } catch (error) {
    // 用原始 message 判权限，不要过 messageOf：那边把 "missing permission"
    // 一概当网络授权问题，会把「没装 host:session」误报成「重新安装插件」。
    const rawMessage = error && error.message ? String(error.message) : String(error || "");
    const hint = /host:session|permission|not declared/i.test(rawMessage)
      ? "缺少会话权限，请重新安装插件（manifest 已声明 host:session）"
      : /会话启动\s*timeout/i.test(rawMessage)
        ? "宿主没有及时建起会话（30 秒），可以直接再点一次"
        : messageOf(error);
    bailed("开会话失败：" + hint);
  }
}

async function generateDigest(ctx) {
  const snap = store.snap;
  if (snap.repos.length === 0) {
    set({ httpError: "先刷新出榜单再生成解读" });
    return;
  }
  if (snap.generating || activeDigest) return;

  const settings = snap.settings;
  const view = snap.view;
  const period = view === "rising" ? RISING_PERIOD.key : settings.period;
  const seq = ++digestSeq;

  // 立刻置 generating：下面有两个 await，等到那时再置，双击就能开出两轮。
  set({
    generating: true,
    digest: "",
    digestStopped: false,
    httpError: "",
  });
  const session = newDigestSession(seq);
  activeDigest = session;

  const bailed = (message) => {
    if (activeDigest === session) activeDigest = null;
    session.settled = true;
    if (seq === digestSeq) set({ generating: false, httpError: message });
  };

  const built = buildDigestPrompt({
    view,
    period,
    language: view === "rising" ? "" : settings.language,
    repos: snap.repos,
    dropped: snap.dropped,
    isFirstRun: snap.isFirstRun,
  });
  set({ digestTruncated: built.truncated, digestIncluded: built.included, digestTotal: built.total });

  const workspace = await resolveWorkspace(ctx, settings);
  if (seq !== digestSeq || session.cancelled) return bailed("");
  if (!workspace) return bailed("读不到插件数据目录，请到设置里点「选择…」指定一个工作区");

  // 中央页签不会先打开设置页，引擎目录要在这里按需补一次。
  if (!store.snap.catalogLoaded) {
    await loadCatalog(ctx);
    if (seq !== digestSeq || session.cancelled) return bailed("");
  }
  if (store.snap.modelsError) return bailed(store.snap.modelsError);

  const entry = pickEntry(store.snap.catalog, settings.engine);
  if (!entry) return bailed("没有可用引擎，请先在设置里选择");
  if (entry.available === false) return bailed(engineLabel(entry.engine) + " 当前不可用，请换一个引擎");

  // 模型：用户选的优先，否则用该引擎的第一个；catalog 的 label 是显示名。
  const models = (entry.models || []).filter((m) => m && typeof m.id === "string" && m.id.trim());
  const model = String(settings.model || "").trim() || (models[0] ? models[0].id : undefined);
  const engine = entry.engine;

  let queued = [];
  let text = "";

  const finish = (error, value) => {
    if (session.settled) return;
    if (error) {
      // 超时/引擎报错时宿主那侧未必已经停：和「用户点停止」走同一条打断
      // 路径，否则 120s 后插件放手、宿主进程继续烧 token 到自然结束。
      cancelSession(session, ctx);
    } else {
      disposeSession(session, null);
    }
    if (seq !== digestSeq) return;
    if (error) {
      set({ generating: false, httpError: messageOf(error) });
      return;
    }
    set({ generating: false, digest: value, digestStopped: false });
  };

  const handleEvent = (event) => {
    if (session.settled) return;
    if (event.kind === "delta") {
      const piece =
        typeof event.data === "object" && event.data
          ? event.data.text || event.data.delta || event.data.content || ""
          : typeof event.data === "string"
            ? event.data
            : "";
      if (!piece) return;
      text += piece;
      if (seq === digestSeq) set({ digest: text });
      return;
    }
    if (event.kind === "done") {
      finish(null, text);
      return;
    }
    if (event.kind === "error") {
      const detail = (event.data && (event.data.message || event.data.error)) || "模型返回了错误";
      finish(new Error(String(detail)));
    }
  };

  // 订阅必须在 start 之前建立：宿主可能先推 delta，再 resolve runId。
  session.off = ctx.events.on("agent://" + PLUGIN_ID, (event) => {
    if (!event || typeof event !== "object" || session.settled) return;
    if (!session.runId) {
      queued.push(event);
      if (queued.length > 500) queued.shift();
      return;
    }
    if (event.runId !== session.runId) return;
    handleEvent(event);
  });

  session.timer = setTimeout(() => finish(new Error("生成超时")), AGENT_TIMEOUT_MS);

  try {
    const started = await ctx.agent.start({
      engine,
      model,
      workspacePath: workspace,
      prompt: built.prompt,
      // 宿主里 claude 不支持隔离只读，传 true 会被整轮拒绝（不是降级）。
      // 只有 catalog 明确声明支持的引擎（Pi、Codex 规划）才请求只读。
      readOnly: supportsReadOnly(entry),
    });
    const runId = started && started.runId ? started.runId : null;
    session.runId = runId;

    // 用户在 start 期间点了停止 / 切了视图 / 卸载了插件：这一轮已经作废，
    // 但宿主的进程刚起来，必须当场打断。
    if (session.cancelled || seq !== digestSeq) {
      cancelSession(session, ctx);
      return;
    }

    const buffered = queued;
    queued = [];
    // 没有 runId 时退化为接收全部：本插件同一时刻只跑一轮解读，没有别的轮次可混淆。
    for (const event of buffered) {
      if (runId && event.runId !== runId) continue;
      handleEvent(event);
    }
  } catch (error) {
    finish(error);
  }
}

/* ---------- 渲染 ---------- */

function Chip(props) {
  const h = appCtx.react.createElement;
  return h(
    "button",
    {
      type: "button",
      className: "gt-chip" + (props.active ? " gt-chip--on" : ""),
      onClick: props.onClick,
      disabled: props.disabled,
      "aria-pressed": props.active ? "true" : "false",
    },
    props.children,
  );
}

function Dot({ color }) {
  const h = appCtx.react.createElement;
  return h("span", { className: "gt-dot", style: color ? { background: color } : undefined, "aria-hidden": "true" });
}

/** 增量单位跟着榜单时间档走，周榜不能写「今日」。 */
const GAIN_LABEL = { daily: "今日", weekly: "本周", monthly: "本月", rising: "star" };
function gainLabel(period) {
  return GAIN_LABEL[period] || "近期";
}

function movementLabel(row) {
  if (row.isNew) return "新上榜";
  const delta = row.rankDelta;
  if (!Number.isFinite(delta) || delta === 0) return "";
  return delta > 0 ? "↑" + delta : "↓" + Math.abs(delta);
}

function movementClass(row) {
  if (row.isNew) return " gt-move--new";
  const delta = row.rankDelta;
  if (!Number.isFinite(delta) || delta === 0) return "";
  return delta > 0 ? " gt-move--up" : " gt-move--down";
}

function RepoRow({ row, ctx, discussing, readme }) {
  const h = appCtx.react.createElement;
  const href = safeHref(row.url);
  const movement = movementLabel(row);
  // owner/name 可能缺失：掉榜行直接来自磁盘快照，只校验过 repo 是字符串。
  // 少一个字段就会渲染成 "undefined / undefined"，比不显示更糟。
  const repoName = String(row.repo || "");
  const slash = repoName.indexOf("/");
  const owner = row.owner || (slash > 0 ? repoName.slice(0, slash) : repoName);
  const name = row.name || (slash > 0 ? repoName.slice(slash + 1) : "");
  const busy = Boolean(discussing) && discussing === row.repo;
  // 一次只能开一个：别的行在开的时候按钮禁用，避免连点开出好几个真会话。
  const blocked = Boolean(discussing) && !busy;
  // readme 传的是整块快照，展开状态由 readmeOpen 决定——同一时刻只开一行。
  const readmeOpen = Boolean(readme) && readme.readmeOpen === repoName;

  return h(
    "li",
    { className: "gt-row" },
    h(
      "div",
      { className: "gt-row-main" },
      h(
        "div",
        { className: "gt-row-title" },
        Number.isFinite(row.rank) ? h("span", { className: "gt-rank" }, row.rank) : null,
        href
          ? h(
              "a",
              { className: "gt-repo", href, target: "_blank", rel: "noreferrer noopener", title: row.repo },
              h("span", { className: "gt-repo-owner" }, owner + (name ? " /" : "")),
              name ? h("span", { className: "gt-sep" }, " ") : null,
              name || null,
            )
          : h("span", { className: "gt-repo" }, repoName),
        movement
          ? h("span", { className: "gt-move" + movementClass(row) }, movement)
          : null,
        // 放在标题行末尾：跟仓库名同一视觉层级，用户扫榜时顺手就能点。
        // 两个按钮共用一条 CSS（.gt-discuss）管淡入，一起浮现，不会一高一低。
        h(
          "button",
          {
            type: "button",
            className: "gt-btn gt-discuss gt-discuss--lead",
            onClick: () => void toggleReadme(ctx, row),
            // 不跟 discussing 联动：读 README 和开会话是两件互不冲突的事，
            // 唯一要防的是同一时刻开两个 README（那由 readmeOpen 单例保证）。
            "aria-expanded": readmeOpen ? "true" : "false",
            title: readmeOpen ? "收起 README" : "就地展开 README，不用跳浏览器",
            "aria-label": (readmeOpen ? "收起 " : "展开 ") + row.repo + " 的 README",
          },
          readmeOpen ? "收起 README" : "README",
        ),
        h(
          "button",
          {
            type: "button",
            className: "gt-btn gt-discuss" + (busy ? " gt-discuss--busy" : ""),
            onClick: () => void discussRepo(ctx, row),
            disabled: blocked || busy,
            title: "在 AI 工作区里开一个会话，分析这个项目",
            "aria-label": "就 " + row.repo + " 开会话",
          },
          busy ? "打开中…" : "讨论",
        ),
      ),
      row.description ? h("p", { className: "gt-desc" }, row.description) : null,
      h(
        "div",
        { className: "gt-meta" },
        row.language ? h("span", { className: "gt-lang" }, h(Dot, { color: row.languageColor }), row.language) : null,
        Number.isFinite(row.stars) ? h("span", { className: "gt-stat" }, "★ " + fmtNumber(row.stars)) : null,
        Number.isFinite(row.gain)
          ? h(
              "span",
              { className: "gt-gain" },
              "+" + fmtNumber(row.gain) + " " + gainLabel(row.gainPeriod),
            )
          : null,
        Number.isFinite(row.ageDays) ? h("span", { className: "gt-stat" }, row.ageDays + " 天前创建") : null,
      ),
      readmeOpen ? h(ReadmePanel, { readme, href }) : null,
    ),
  );
}

/**
 * 行内 README 预览。
 *
 * 挂在行内（而不是浮层/新页签）是为了「扫到哪个看哪个」：浮层会盖住榜单，
 * 关掉之后又是滚回原处，来回两三次人就不看了。
 *
 * 正文一律走自写的 Markdown 子集渲染，不拼 HTML——README 是远端不可信内容。
 */
function ReadmePanel({ readme, href }) {
  const h = appCtx.react.createElement;
  const status = readme.readmeLoading
    ? h(
        "p",
        { className: "gt-readme-note" },
        h("span", { className: "gt-spinner", "aria-hidden": "true" }),
        "正在读 README…",
      )
    : readme.readmeError
      ? h("p", { className: "gt-readme-note gt-readme-note--error" }, readme.readmeError)
      : readme.readmeText
        ? h(
            "p",
            { className: "gt-readme-note" },
            readme.readmeTruncated
              ? "只显示前 " + readme.readmeText.length + " 字（共 " + readme.readmeTotal + " 字）"
              : "README 全文",
            href
              ? h(
                  "a",
                  { className: "gt-readme-more", href, target: "_blank", rel: "noreferrer noopener" },
                  "在 GitHub 上查看",
                )
              : null,
          )
        : null;

  return h(
    "section",
    { className: "gt-readme", "aria-busy": readme.readmeLoading ? "true" : "false" },
    status,
    readme.readmeText
      ? h("div", { className: "gt-readme-body" }, renderMarkdown(readme.readmeText))
      : null,
  );
}

function Toolbar({ snap, ctx }) {
  const h = appCtx.react.createElement;
  const R = appCtx.react;
  // 导出状态放在这一层而不是 status store：它只描述「刚才那次复制」，跟榜单
  // 数据无关，放进全局反而要在每个刷新点清一遍。
  const exportState = R.useState("");
  const exportStatus = exportState[0];
  const setExportStatus = exportState[1];
  const exportTimer = R.useRef(null);
  R.useEffect(() => () => {
    if (exportTimer.current) clearTimeout(exportTimer.current);
  }, []);
  const flashExport = (text) => {
    setExportStatus(text);
    if (exportTimer.current) clearTimeout(exportTimer.current);
    exportTimer.current = setTimeout(() => setExportStatus(""), 2000);
  };
  const exportMarkdown = () => {
    const markdown = buildBoardMarkdown({
      view: snap.view,
      period: snap.settings.period,
      language: snap.view === "trending" ? snap.settings.language : "",
      rows: snap.repos,
      dropped: snap.dropped,
      capturedAt: fmtTime(snap.loadedAt),
    });
    // 空榜单不该给出一个「已复制」，那等于让用户粘出一张空白表。
    if (!markdown) {
      flashExport("没有可导出的内容");
      return;
    }
    copyText(markdown).then(
      () => flashExport("已复制"),
      () => flashExport("复制失败"),
    );
  };
  // 切视图/时间档会让榜单换掉，正在生成的解读说的是旧榜单，必须一并停掉，
  // 否则旧轮次的 delta 会继续写进新视图，而且宿主那侧还在烧 token。
  const onView = (view) => {
    if (view === snap.view) return;
    if (snap.generating) abortDigest(ctx);
    resetDiscussSessions();
    set({
      view,
      digest: "",
      digestStopped: false,
      dropped: [],
      isFirstRun: true,
      repos: [],
      loaded: false,
      discussError: "",
      discussNotice: "",
      discussWorkspace: "",
      discussWarning: "",
      discussResumed: false,
      discussPromptName: "",
      readmeOpen: "",
    readmeLoading: false,
    readmeError: "",
    readmeText: "",
    readmeTruncated: false,
    readmeTotal: 0,
    });
    void refresh(ctx, { force: true });
  };
  const onPeriod = (period) => {
    if (period === snap.settings.period) return;
    if (snap.generating) abortDigest(ctx);
    resetDiscussSessions();
    setSettings({ period });
    void persistSettings(ctx, { period });
    set({
      loaded: false,
      repos: [],
      digest: "",
      digestStopped: false,
      dropped: [],
      discussError: "",
      discussNotice: "",
      discussWorkspace: "",
      discussWarning: "",
      discussResumed: false,
      discussPromptName: "",
      readmeOpen: "",
    readmeLoading: false,
    readmeError: "",
    readmeText: "",
    readmeTruncated: false,
    readmeTotal: 0,
    });
    void refresh(ctx, { force: true });
  };

  return h(
    "div",
    { className: "gt-toolbar" },
    h(
      "div",
      { className: "gt-group", role: "group", "aria-label": "数据视图" },
      h(Chip, { active: snap.view === "trending", onClick: () => onView("trending") }, "Trending"),
      h(Chip, { active: snap.view === "rising", onClick: () => onView("rising") }, "新星库（7 天）"),
    ),
    snap.view === "trending"
      ? h(
          "div",
          { className: "gt-group", role: "group", "aria-label": "时间档" },
          PERIODS.map((p) =>
            h(Chip, { key: p.key, active: snap.settings.period === p.key, onClick: () => onPeriod(p.key) }, p.label),
          ),
        )
      : null,
    h(
      "div",
      { className: "gt-group gt-group--end" },
      snap.loadedAt ? h("span", { className: "gt-stamp" }, "更新于 " + fmtTime(snap.loadedAt)) : null,
      // 定宽：文案在「导出 Markdown / 已复制 / 复制失败」之间切，右侧按钮不能跟着挪。
      h(
        "button",
        {
          type: "button",
          className: "gt-btn gt-btn--export",
          onClick: exportMarkdown,
          disabled: snap.loading || snap.repos.length === 0,
          title: "把当前榜单复制成 Markdown（可直接粘进周报或 issue）",
        },
        exportStatus || "导出 Markdown",
      ),
      h(
        "button",
        {
          type: "button",
          className: "gt-btn gt-btn--refresh" + (snap.loading ? " gt-btn--busy" : ""),
          onClick: () => void refresh(ctx, { force: true }),
          disabled: snap.loading,
          "aria-busy": snap.loading ? "true" : "false",
        },
        // 文案与宽度都不随状态变化，右侧按钮不会跟着挪
        snap.loading ? h("span", { className: "gt-spinner", "aria-hidden": "true" }) : null,
        snap.loading ? "刷新中…" : "刷新",
      ),
      h(
        "button",
        {
          type: "button",
          className: "gt-btn gt-btn--primary",
          onClick: () => (snap.generating ? abortDigest(ctx) : void generateDigest(ctx)),
          // 生成中不能跟着 loading 一起禁用：刷新一进来就把 loading 置真，而
          // 刷新并不中止解读——那样「停止生成」会变成一个点不动的按钮，
          // 用户只能等 20s 超时，看着 token 继续烧。
          disabled: snap.generating ? false : snap.loading || snap.repos.length === 0,
        },
        snap.generating ? "停止生成" : "生成解读",
      ),
      h("button", { type: "button", className: "gt-btn", onClick: () => ctx.ui.openSettings() }, "设置"),
    ),
  );
}

function StatusLine({ snap }) {
  const h = appCtx.react.createElement;
  if (snap.loading) {
    // 刷新时列表还在：只转圈 + 一句话，不抢走用户正在看的内容。
    // 首次加载没有列表：文案改成「首次抓取」的口吻。
    const first = snap.repos.length === 0;
    return h(
      "p",
      { className: "gt-notice gt-running", role: "status", "aria-live": "polite" },
      h("span", { className: "gt-spinner", "aria-hidden": "true" }),
      h("span", { className: "gt-running-text" }, first ? "正在抓取 GitHub…" : "正在刷新榜单…"),
    );
  }
  // 讨论的回执讲的是「你刚才那一按的结果」，比榜单状态更该优先显示：
  // 先判回执，再判 httpError / loaded。否则上一次生成超时的红字会原样留着，
  // 把「开会话失败了，因为…」整个吞掉——用户看到的还是几分钟前的错误。
  if (snap.discussError || snap.discussNotice) {
    const base = snap.loaded
      ? h(
          "p",
          { className: "gt-notice" },
          snap.view === "rising" ? "近 7 天新建的高增长仓库" : "GitHub Trending · " + snap.settings.period,
          snap.view === "trending" && snap.settings.language ? " · " + snap.settings.language : "",
          snap.isFirstRun ? " · 首次抓取，下次刷新可看到排名变化" : "",
          !snap.isFirstRun && snap.repos.length > 0 && !hasRankChange(snap.repos) ? " · 与上次相比排名无变化" : "",
        )
      : null;
    return h(
      "div",
      { className: "gt-status-rows" },
      base,
      snap.discussError
        ? h("p", { className: "gt-notice gt-notice--error", role: "status" }, snap.discussError)
        : h(
            "p",
            { className: "gt-notice gt-notice--ok", role: "status" },
            h(
              "span",
              null,
              (snap.discussResumed ? "已在侧栏续接为 " : "已在侧栏为 ") +
                snap.discussNotice +
                " " +
                (snap.discussResumed ? "的会话（接着上次的话题）" : "开了会话"),
            ),
            h(
              "span",
              { className: "gt-notice-hint" },
              // 说清会话挂在哪个分组下：侧栏工作区一多，光说「在侧栏」等于没说。
              (snap.discussWorkspace ? "分组「" + snap.discussWorkspace + "」· " : "") +
                "本页不会自动跳转，点侧栏里那一行打开",
            ),
            // 用户维护了好几份提示词，回执不说名字就分不清刚才用的是哪套要求。
            snap.discussPromptName
              ? h("span", { className: "gt-notice-hint" }, "提示词「" + snap.discussPromptName + "」")
              : null,
            // 会话真的建起来了，只是没挂进侧栏工作区：不能说成失败，更不能不说。
            snap.discussWarning ? h("span", { className: "gt-notice-hint" }, snap.discussWarning) : null,
          ),
      // 榜单自己的错误不能被回执顶掉：两件事并列说清楚，别二选一。
      snap.httpError
        ? h(
            "p",
            { className: "gt-notice gt-notice--error", role: "status" },
            h("span", null, snap.httpError),
            snap.repos.length > 0 ? h("span", { className: "gt-notice-hint" }, "（当前显示的是上次的结果）") : null,
          )
        : null,
    );
  }
  if (snap.httpError) {
    const cacheHint = snap.repos.length > 0;
    return h(
      "div",
      { className: "gt-notice gt-notice--error", role: "status" },
      h("span", null, snap.httpError),
      cacheHint ? h("span", { className: "gt-notice-hint" }, "（当前显示的是上次的结果）") : null,
    );
  }
  if (!snap.loaded) return h("p", { className: "gt-notice" }, "点「刷新」拉取榜单。");
  // 回执和榜单说明并列，不互相顶替：回执说的是「你刚才那一按的结果」，
  // 榜单行说的是「你现在在看什么数据」，两件事都得在场。
  return h(
    "p",
    { className: "gt-notice" },
    snap.view === "rising" ? "近 7 天新建的高增长仓库" : "GitHub Trending · " + snap.settings.period,
    snap.view === "trending" && snap.settings.language ? " · " + snap.settings.language : "",
    snap.isFirstRun ? " · 首次抓取，下次刷新可看到排名变化" : "",
    // 没有变化时整榜都没有涨跌标签，不说明会让人以为标签没渲染出来
    !snap.isFirstRun && snap.repos.length > 0 && !hasRankChange(snap.repos) ? " · 与上次相比排名无变化" : "",
  );
}

/** 整榜是否有任何涨跌/新上榜。全为 false 时列表里不会出现任何变化标签。 */
function hasRankChange(repos) {
  const list = Array.isArray(repos) ? repos : [];
  return list.some((row) => row && (row.isNew || (Number.isFinite(row.rankDelta) && row.rankDelta !== 0)));
}

/** 骨架屏：条数与真实榜单接近，让加载完的落位不跳。 */
function SkeletonList() {
  const h = appCtx.react.createElement;
  // 6 行刚好铺满常见窗口高度，又不会撑出滚动条；
  // 骨架屏加载完就撤掉，行数与真实榜单不必一致。
  const rows = [];
  for (let i = 0; i < 6; i += 1) {
    rows.push(
      h(
        "li",
        { className: "gt-skel", "aria-hidden": "true" },
        h("span", { className: "gt-skel-badge" }),
        h(
          "span",
          { className: "gt-skel-body" },
          h("span", { className: "gt-skel-line gt-skel-line--title" }),
          h("span", { className: "gt-skel-line gt-skel-line--desc" }),
          h("span", { className: "gt-skel-line gt-skel-line--meta" }),
        ),
      ),
    );
  }
  return h("ul", { className: "gt-skel-list" }, rows);
}

/* ---------- 解读正文的 Markdown 渲染 ---------- */

/**
 * 行内节点。解析结果来自 src/lib/markdown.mjs，这里只负责变成元素，
 * 全程不拼 HTML 字符串——模型输出属于不可信内容。
 *
 * 强调类节点带 children（解析器会对它们递归，处理 `**\`repo\`**` 这种嵌套），
 * 没带 children 的老式节点退化成纯文本。
 */
function inlineNodes(inlines, keyBase) {
  const h = appCtx.react.createElement;
  return (inlines || []).map((n, i) => {
    const key = keyBase + "i" + i;
    const kids = n.children ? inlineNodes(n.children, key + "_") : n.v;
    if (n.t === "strong") return h("strong", { key }, kids);
    if (n.t === "em") return h("em", { key }, kids);
    if (n.t === "del") return h("del", { key }, kids);
    if (n.t === "code") return h("code", { key, className: "gt-md-code" }, n.v);
    if (n.t === "link") {
      return h("a", { key, href: n.href, target: "_blank", rel: "noreferrer noopener" }, n.v);
    }
    return n.v;
  });
}

/**
 * 解析结果缓存。流式输出时每个 delta 都会重渲染整棵解读树，而解析要扫全文；
 * 内容没变（别处 set 触发的重渲染）就不该再解析一遍。
 *
 * 存最近 4 份而不是 1 份：现在同时有两个 Markdown 消费者（解读正文、行内
 * README 预览），单槽缓存会互相顶掉——每渲染一次榜单都要重新解析一遍 README。
 * 4 份足够覆盖「一个展开的 README + 一份解读 + 切换时的过渡」，且总量有上限。
 */
const mdCache = new Map();
const MD_CACHE_LIMIT = 4;

function markdownBlocks(text) {
  const src = String(text || "");
  const hit = mdCache.get(src);
  if (hit) {
    // 命中后挪到队尾：Map 保持插入序，删第一个就是删最久没用的。
    mdCache.delete(src);
    mdCache.set(src, hit);
    return hit;
  }
  const blocks = parseMarkdown(src);
  mdCache.set(src, blocks);
  while (mdCache.size > MD_CACHE_LIMIT) mdCache.delete(mdCache.keys().next().value);
  return blocks;
}

/** 块节点 → 元素。表格单独包一层可横向滚动，窄窗口下不会把整页撑宽。 */
function renderMarkdown(text) {
  const h = appCtx.react.createElement;
  const blocks = markdownBlocks(text);
  return blocks.map((b, i) => {
    const key = "md" + i;
    if (b.type === "heading") return h("h" + b.level, { key, className: "gt-md-h" + b.level }, inlineNodes(b.inlines, key));
    if (b.type === "paragraph") return h("p", { key, className: "gt-md-p" }, inlineNodes(b.inlines, key));
    if (b.type === "hr") return h("hr", { key, className: "gt-md-hr" });
    if (b.type === "quote") return h("blockquote", { key, className: "gt-md-quote" }, inlineNodes(b.inlines, key));
    if (b.type === "code") {
      return h(
        "pre",
        { key, className: "gt-md-pre" },
        h("code", { className: b.lang ? "language-" + b.lang : "" }, b.text),
      );
    }
    if (b.type === "ul" || b.type === "ol") {
      return h(
        b.type,
        { key, className: "gt-md-list" },
        b.items.map((item, j) =>
          h(
            "li",
            {
              key: key + "li" + j,
              // 缩进用内边距表达层级：嵌套列表在窄面板里越缩越窄，不如一级一档
              style: item.depth ? { marginLeft: item.depth * 14 } : undefined,
            },
            inlineNodes(item.inlines, key + "li" + j),
          ),
        ),
      );
    }
    if (b.type === "table") {
      const cellStyle = (ci) => (b.align[ci] ? { textAlign: b.align[ci] } : undefined);
      return h(
        "div",
        { key, className: "gt-md-table-wrap" },
        h(
          "table",
          { className: "gt-md-table" },
          h(
            "thead",
            null,
            h(
              "tr",
              null,
              b.head.map((cell, ci) => h("th", { key: key + "th" + ci, style: cellStyle(ci) }, inlineNodes(cell, key + "th" + ci))),
            ),
          ),
          h(
            "tbody",
            null,
            b.rows.map((row, ri) =>
              h(
                "tr",
                { key: key + "tr" + ri },
                row.map((cell, ci) => h("td", { key: key + "td" + ci, style: cellStyle(ci) }, inlineNodes(cell, key + "td" + ri + "_" + ci))),
              ),
            ),
          ),
        ),
      );
    }
    return null;
  });
}

function DigestPanel({ snap }) {
  const R = appCtx.react;
  const h = R.createElement;
  const bodyRef = R.useRef(null);
  const wasGenerating = R.useRef(false);
  const copyState = R.useState("");
  const copyStatus = copyState[0];
  const setCopyStatus = copyState[1];
  const copyTimer = R.useRef(null);

  // 解读面板在一个可滚动区域的底部：点「生成解读」后如果不滚过去，用户看到的
  // 是「什么都没发生」。只在「开始生成」这一刻滚，之后不抢用户正在看的位置。
  R.useEffect(() => {
    if (snap.generating && !wasGenerating.current) {
      wasGenerating.current = true;
      const el = bodyRef.current;
      if (el && typeof el.scrollIntoView === "function") {
        try {
          el.scrollIntoView({ block: "nearest", behavior: "smooth" });
        } catch {
          /* 老内核不支持参数对象：不滚也不影响阅读 */
        }
      }
    } else if (!snap.generating) {
      wasGenerating.current = false;
    }
  }, [snap.generating]);

  R.useEffect(() => () => {
    if (copyTimer.current) clearTimeout(copyTimer.current);
  }, []);

  if (!snap.generating && !snap.digest) return null;

  const note = snap.digestTruncated
    ? "事实过长，已截断（" + snap.digestIncluded + "/" + snap.digestTotal + "）"
    : "";
  const chars = snap.digest ? snap.digest.length : 0;

  const copy = () => {
    const text = snap.digest || "";
    if (!text) return;
    const done = () => {
      setCopyStatus("已复制");
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopyStatus(""), 2000);
    };
    const fail = () => setCopyStatus("复制失败");
    try {
      const clip = typeof navigator !== "undefined" ? navigator.clipboard : null;
      if (clip && typeof clip.writeText === "function") {
        clip.writeText(text).then(done, fail);
        return;
      }
    } catch {
      /* 落到下面 */
    }
    fail();
  };

  const status = snap.generating
    ? h(
        "span",
        { className: "gt-digest-run" },
        h("span", { className: "gt-spinner", "aria-hidden": "true" }),
        chars ? "生成中 · " + chars + " 字" : "生成中…",
      )
    : snap.digestStopped
      ? h("span", { className: "gt-digest-run gt-digest-stopped" }, "已停止，下面是写到这里的内容")
      : null;

  return h(
    "section",
    { className: "gt-digest", "aria-busy": snap.generating ? "true" : "false" },
    h(
      "header",
      { className: "gt-digest-head" },
      h("h3", null, "解读"),
      status,
      note ? h("span", { className: "gt-stamp" }, note) : null,
      snap.digest
        ? h(
            "button",
            {
              type: "button",
              className: "gt-btn gt-digest-copy",
              onClick: copy,
              disabled: snap.generating,
              title: "复制 Markdown 原文",
            },
            copyStatus || "复制",
          )
        : null,
    ),
    // aria-live 放在正文外层而不是 section 上：正文逐字追加时，读屏软件会
    // 把每个字都念一遍。这里只在「生成中/已完成」这类状态变化时播报。
    h(
      "div",
      { className: "gt-digest-body", ref: bodyRef },
      snap.digest
        ? renderMarkdown(snap.digest)
        : h("p", { className: "gt-md-p gt-digest-wait" }, "正在整理今天的榜单…"),
    ),
    snap.digest && !snap.generating
      ? h("p", { className: "gt-notice", role: "status" }, "解读只在本机显示，未写入任何文件。")
      : null,
  );
}

function MainTab() {
  const h = appCtx.react.createElement;
  const ctx = appCtx;
  const snap = useSnap();

  appCtx.react.useEffect(() => {
    void refresh(ctx, { force: false });
    // 首次挂载自动拉一次；后续由用户动作触发。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return h(
    "div",
    { className: "gt-root" },
    h(
      "header",
      { className: "gt-head" },
      h(
        "div",
        { className: "gt-head-text" },
        h("h2", { className: "gt-title" }, "每日热点"),
        h("p", { className: "gt-sub" }, "GitHub Trending 与新星库，数据只在本机处理"),
      ),
    ),
    h(Toolbar, { snap, ctx }),
    h(StatusLine, { snap }),
    h(
      "div",
      { className: "gt-scroll" },
      snap.repos.length > 0
        ? h("ol", { className: "gt-list" }, snap.repos.map((row) => h(RepoRow, { key: row.repo, row, ctx, discussing: snap.discussing, readme: snap })))
        : snap.loading
          ? h(SkeletonList, null)
          : snap.loaded
            ? h("p", { className: "gt-empty" }, snap.errorKind ? "没有可显示的数据" : "榜单为空")
            : null,
      snap.view === "trending" && snap.dropped.length > 0
        ? h(
            "section",
            { className: "gt-dropped" },
            h("h3", null, "掉榜（" + snap.dropped.length + "）"),
            h(
              "p",
              null,
              snap.dropped
                .slice(0, 12)
                .map((row) => row.repo)
                .join("、") + (snap.dropped.length > 12 ? " 等" : ""),
            ),
          )
        : null,
      h(DigestPanel, { snap }),
    ),
  );
}

/* ---------- 设置页 ---------- */

/**
 * 自绘下拉：原生 <select> 的展开层由系统绘制，不跟宿主的深浅色主题。
 * 键盘、方向键、Esc、点击外部关闭都对齐宿主习惯。
 */
function Dropdown(props) {
  const R = appCtx.react;
  const h = R.createElement;
  const openState = R.useState(false);
  const open = openState[0];
  const setOpen = openState[1];
  const focusState = R.useState(-1);
  const focusIdx = focusState[0];
  const setFocusIdx = focusState[1];
  // 触发器下方空间不够时向上弹，避免菜单被视口底部裁掉
  const upState = R.useState(false);
  const up = upState[0];
  const setUp = upState[1];
  const triggerRef = R.useRef(null);
  const itemRefs = R.useRef([]);

  const items = Array.isArray(props.items) ? props.items : [];
  const value = props.value == null ? "" : String(props.value);
  const selectedIdx = items.findIndex((it) => String(it.value) === value);
  const selected = selectedIdx >= 0 ? items[selectedIdx] : null;
  const placeholder = props.placeholder || "请选择";

  R.useEffect(() => {
    if (!open) return;
    const el = itemRefs.current[focusIdx];
    if (el && typeof el.focus === "function") el.focus();
  }, [open, focusIdx]);

  const openMenu = () => {
    if (props.disabled || items.length === 0) return;
    let i = selectedIdx;
    if (i < 0) i = items.findIndex((it) => !it.disabled);
    setFocusIdx(i < 0 ? 0 : i);
    const est = Math.min(260, items.length * 32 + 8);
    const el = triggerRef.current;
    if (el && typeof el.getBoundingClientRect === "function" && typeof window !== "undefined") {
      const rect = el.getBoundingClientRect();
      const below = (window.innerHeight || 800) - rect.bottom;
      setUp(below < est + 12 && rect.top > below);
    }
    setOpen(true);
  };

  const choose = (item) => {
    if (!item || item.disabled) return;
    setOpen(false);
    if (String(item.value) !== value) props.onChange(item.value);
  };

  const move = (step) => {
    if (!items.length) return;
    let i = focusIdx;
    for (let n = 0; n < items.length; n += 1) {
      i = (i + step + items.length) % items.length;
      if (!items[i].disabled) break;
    }
    setFocusIdx(i);
  };

  /**
   * 键盘处理挂在**容器**上，不是 trigger 上。
   *
   * 菜单一打开，useEffect 会把焦点移到 option 上（option 带 tabIndex=-1），
   * 此后按键事件从 option 冒泡到容器。只挂在 trigger 上的话，打开之后方向键、
   * Enter 确认、Esc 关闭全部失灵——只剩鼠标能用。
   *
   * 容器与 trigger 不能各挂一个：同一事件会冒泡两遍，Enter 会触发两次
   * onChange。所以只有一个 handler，靠 `ev.target` 认来源。
   */
  const onKeyDown = (ev) => {
    if (props.disabled) return;
    // 按 className 认来源，不用 triggerRef.current：ref 在假宿主/替身里
    // 未必被赋值，一旦为 null 判断就会恒假，空格键静默失效。
    const t = ev && ev.target;
    const onTrigger = Boolean(
      t && typeof t.className === "string" && t.className.split(/\s+/).includes("gt-dd-trigger"),
    );
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      if (!open) openMenu();
      else move(ev.key === "ArrowDown" ? 1 : -1);
    } else if (ev.key === "Enter") {
      ev.preventDefault();
      if (open) choose(items[focusIdx]);
      else openMenu();
    } else if (ev.key === " ") {
      // 空格只在 trigger 上当「打开」：菜单项里按空格同理会冒泡到这里，
      // 但那是可滚动列表，别为了这个吃掉滚动键。
      if (onTrigger) {
        ev.preventDefault();
        if (open) choose(items[focusIdx]);
        else openMenu();
      }
    } else if (ev.key === "Escape" && open) {
      ev.preventDefault();
      setOpen(false);
    } else if (ev.key === "Tab" && open) {
      // 焦点会离开这个组件；scrim 是 fixed 全屏，不关掉会留下一层看不见的
      // 遮罩继续吞点击。
      setOpen(false);
    }
  };

  return h(
    "div",
    {
      className: "gt-dd" + (open ? " is-open" : "") + (up ? " is-up" : ""),
      onKeyDown,
    },
    h(
      "button",
      {
        type: "button",
        className: "gt-dd-trigger",
        ref: triggerRef,
        disabled: props.disabled,
        "aria-haspopup": "listbox",
        "aria-expanded": open,
        onClick: () => (open ? setOpen(false) : openMenu()),
      },
      h("span", { className: "gt-dd-value" + (selected ? "" : " is-empty") }, selected ? selected.label : placeholder),
      h("span", { className: "gt-dd-caret", "aria-hidden": "true" }),
    ),
    open ? h("div", { className: "gt-dd-scrim", onClick: () => setOpen(false) }) : null,
    open
      ? h(
          "div",
          { className: "gt-dd-menu", role: "listbox" },
          items.length
            ? items.map((item, i) =>
                h(
                  "div",
                  {
                    key: String(item.value) + ":" + i,
                    ref: (el) => {
                      itemRefs.current[i] = el;
                    },
                    className:
                      "gt-dd-item" +
                      (i === focusIdx ? " is-active" : "") +
                      (item.disabled ? " is-disabled" : ""),
                    role: "option",
                    "aria-selected": String(item.value) === value,
                    "aria-disabled": item.disabled ? true : undefined,
                    tabIndex: -1,
                    onClick: () => choose(item),
                    onMouseEnter: () => {
                      if (!item.disabled) setFocusIdx(i);
                    },
                  },
                  h("span", { className: "gt-dd-label" }, item.label),
                  h("span", { className: "gt-dd-check", "aria-hidden": "true" }, "✓"),
                ),
              )
            : h("div", { className: "gt-dd-empty" }, props.emptyText || "没有可选项"),
        )
      : null,
  );
}

function segField(label, control, hint) {
  const h = appCtx.react.createElement;
  return h(
    "div",
    { className: "gt-field" },
    h("label", null, label),
    control,
    hint ? h("span", { className: "gt-hint" }, hint) : null,
  );
}

function SettingsSection() {
  const R = appCtx.react;
  const h = R.createElement;
  const ctx = appCtx;
  const snap = useSnap();

  const formState = R.useState(null);
  const form = formState[0] || snap.settings;
  const setForm = formState[1];
  // "" -> "saving" -> "saved"/"error"；改动即生效，不需要用户记得点保存。
  const saveState = R.useState("");
  const saveStatus = saveState[0];
  const setSaveStatus = saveState[1];
  const baseline = R.useRef("");
  const saveTimer = R.useRef(null);
  const ready = R.useRef(false);

  const patch = (key, value) => {
    setForm((prev) => Object.assign({}, prev || snap.settings, { [key]: value }));
  };

  R.useEffect(() => {
    if (!snap.catalogLoaded) void loadCatalog(ctx);
    void pluginDataDir(ctx);
  }, []);

  const [flashMsg, setFlashMsg] = R.useState("");
  const flashTimer = R.useRef(null);
  const flash = (text) => {
    setFlashMsg(text);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlashMsg(""), 2600);
  };
  R.useEffect(() => () => {
    if (flashTimer.current) clearTimeout(flashTimer.current);
  }, []);

  // 路径只能来自宿主的系统文件夹选择器，不接受手填：手打的路径没有对应 grant，
  // 引擎跑起来会因为没授权而失败。
  async function chooseWorkspace() {
    if (!ctx.assets || typeof ctx.assets.grantDirectory !== "function") {
      flash("当前宿主不支持目录选择");
      return;
    }
    try {
      const grant = await ctx.assets.grantDirectory();
      const picked = grant && grant.path ? String(grant.path) : "";
      if (!picked) return;
      patch("workspacePath", picked);
      flash("已选择 " + displayPath(picked));
    } catch {
      /* 用户取消选择：按正常操作静默处理 */
    }
  }

  R.useEffect(() => {
    if (!form) return;
    const key = JSON.stringify(form);
    if (!ready.current) {
      ready.current = true;
      baseline.current = key;
      return;
    }
    if (key === baseline.current) return;
    setSaveStatus("saving");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void (async () => {
        const ok = await persistSettings(ctx, form);
        if (ok) {
          baseline.current = key;
          setSaveStatus("saved");
        } else {
          setSaveStatus("error");
        }
      })();
    }, 500);
  }, [form]);

  R.useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    },
    [],
  );

  // 引擎选项来自 agent.catalog：不可用的保留在列表里但禁用，用户能看到
  // 「装了这个引擎但没配好」，而不是莫名其妙少一项。
  const engineItems = [{ value: "", label: "自动（第一个可用引擎）" }];
  for (const e of sortCatalog(snap.catalog)) {
    engineItems.push({
      value: e.engine,
      label: engineLabel(e.engine) + (e.available === false ? "（不可用）" : ""),
      disabled: e.available === false,
    });
  }
  if (snap.modelsLoading && snap.catalog.length === 0) {
    engineItems.push({ value: "", label: "读取引擎目录中…", disabled: true });
  }
  // 配置里已有、但这次目录没列出来的引擎：保留一项，避免下拉把它吃掉
  if (form.engine && !snap.catalog.some((e) => e.engine === form.engine)) {
    engineItems.push({ value: form.engine, label: engineLabel(form.engine) });
  }

  // 模型跟着所选引擎走；catalog 的 label 已是显示名。
  const entry = pickEntry(snap.catalog, form.engine);
  const entryModels = entry && Array.isArray(entry.models) ? entry.models : [];
  const modelItems = [{ value: "", label: "自动（该引擎的第一个模型）" }];
  for (const m of entryModels) {
    if (m && typeof m.id === "string" && m.id) {
      modelItems.push({ value: m.id, label: m.label || m.id });
    }
  }
  if (form.model && !entryModels.some((m) => m && m.id === form.model)) {
    modelItems.push({ value: form.model, label: form.model });
  }

  /** 模型一栏的说明文字：要能回答「现在实际会用哪个引擎」。 */
  const modelHint = () => {
    if (!entry) return "先选引擎，模型列表会跟着变。";
    const name = engineLabel(entry.engine);
    if (entry.available === false) return name + " 当前不可用，请在宿主的引擎配置里启用它。";
    if (!entryModels.length) return name + " 没有报告模型列表，留空即可。";
    const prefix = form.engine ? "" : "当前跟随「自动」选中的 " + name + "；";
    return prefix + "留空则用该引擎的第一个可用模型。";
  };

  /* ---- 讨论提示词 ---- */

  // 归一化是幂等的，且必须每次都过：磁盘上可能是手改过的数据。
  const prompts = normalisePrompts(form.prompts);
  const defaultId = prompts.some((p) => p.id === form.defaultPromptId)
    ? form.defaultPromptId
    : prompts.length > 0
      ? prompts[0].id
      : "";

  /** 写回列表。顺手修正默认值——默认指向一份刚被删掉的提示词时不能悬空。 */
  const writePrompts = (next, nextDefault) => {
    const list = normalisePrompts(next);
    const wanted = nextDefault === undefined ? form.defaultPromptId : nextDefault;
    const fixed = list.some((p) => p.id === wanted) ? wanted : list.length > 0 ? list[0].id : "";
    setForm((prev) => Object.assign({}, prev || snap.settings, { prompts: list, defaultPromptId: fixed }));
  };

  const addPrompt = () => {
    if (prompts.length >= PROMPT_COUNT_LIMIT) {
      flash("最多 " + PROMPT_COUNT_LIMIT + " 份，先删掉一份再添加");
      return;
    }
    // 新条目给内置模板当底稿：空白文本框等于让用户从零开始想，不如给一份能用的。
    // 名字用「提示词 N」而不是空串：空名字在列表里无法区分。
    const id = "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    const next = prompts.concat([{ id, name: "提示词 " + (prompts.length + 1), text: DEFAULT_DISCUSS_TEMPLATE }]);
    // 第一份自动成为默认，否则用户加完还得再点一次「设为默认」。
    writePrompts(next, prompts.length === 0 ? id : form.defaultPromptId);
  };

  const removePrompt = (id) => {
    writePrompts(prompts.filter((p) => p.id !== id), undefined);
  };

  /** 点某份提示词展开/收起它的编辑区。同一时刻只展开一份，设置页才不长。 */
  const openPromptState = R.useState("");
  const openPrompt = openPromptState[0];
  const setOpenPrompt = openPromptState[1];

  const promptRows = prompts.length === 0
    ? [
        h(
          "p",
          { className: "gt-note-line" },
          "还没有自定义提示词。点「讨论」会用内置模板（先在本机找同名仓库，找不到再读远程，给出适合谁用的判断）。",
        ),
      ]
    : prompts.map((item) => {
        const isDefault = item.id === defaultId;
        const isOpen = openPrompt === item.id;
        return h(
          "div",
          { className: "gt-prompt", key: item.id },
          h(
            "div",
            { className: "gt-prompt-head" },
            h(
              "button",
              {
                type: "button",
                className: "gt-prompt-name",
                onClick: () => setOpenPrompt(isOpen ? "" : item.id),
                "aria-expanded": isOpen ? "true" : "false",
                "aria-label": (isOpen ? "收起 " : "展开 ") + item.name + " 的正文",
                title: "展开编辑正文",
              },
              h("span", { className: "gt-prompt-chevron", "aria-hidden": "true" }, isOpen ? "▾" : "▸"),
              h("span", { className: "gt-prompt-label" }, item.name),
            ),
            // 默认那份用「已设为默认」的静态标记，而不是一个点下去没反应的按钮：
            // 三份提示词里哪份在生效，是这一节最重要的一条信息。
            isDefault
              ? h("span", { className: "gt-prompt-default" }, "默认")
              : h(
                  "button",
                  {
                    type: "button",
                    className: "gt-btn gt-path-pick",
                    onClick: () => writePrompts(prompts, item.id),
                    title: "点「讨论」时用这一份",
                    "aria-label": "把 " + item.name + " 设为默认提示词",
                  },
                  "设为默认",
                ),
            h(
              "button",
              {
                type: "button",
                className: "gt-btn ghost gt-path-pick",
                onClick: () => removePrompt(item.id),
                title: "删除这份提示词（不影响内置模板）",
                "aria-label": "删除 " + item.name,
              },
              "删除",
            ),
          ),
          isOpen
            ? h(
                "div",
                { className: "gt-prompt-body" },
                h(
                  "div",
                  { className: "gt-path" },
                  h("input", {
                    className: "gt-input",
                    value: item.name,
                    maxLength: PROMPT_NAME_LIMIT,
                    placeholder: "名字，例如「评估可投入性」",
                    spellCheck: false,
                    "aria-label": "提示词名字",
                    onChange: (e) => {
                      const name = e.target.value.slice(0, PROMPT_NAME_LIMIT);
                      writePrompts(
                        prompts.map((p) => (p.id === item.id ? Object.assign({}, p, { name }) : p)),
                      );
                    },
                  }),
                ),
                h("textarea", {
                  className: "gt-input gt-prompt-text",
                  value: item.text,
                  rows: 14,
                  spellCheck: false,
                  "aria-label": item.name + " 的提示词正文",
                  onChange: (e) => {
                    // 超长只截断不报错：一边打字一边弹红字比截断更烦。
                    const text = e.target.value.slice(0, PROMPT_TEXT_LIMIT);
                    writePrompts(prompts.map((p) => (p.id === item.id ? Object.assign({}, p, { text }) : p)));
                  },
                }),
                h(
                  "p",
                  { className: "gt-hint" },
                  "可用占位符：{{repo}} {{url}} {{scope}} {{description}} {{language}} {{stars}} {{gain}} {{rank}} {{age}} {{facts}}。"
                    + "它们会被这一行的真实数据替换；没写 {{facts}} 时插件会在末尾补一节事实。",
                ),
              )
            : null,
        );
      });

  const promptEditor = h(
    "div",
    { className: "gt-prompts" },
    h(
      "p",
      { className: "gt-note-line" },
      "「讨论」每次只用其中一份（标「默认」的那份）。想换个角度分析时，存一份新的再切默认即可，不用来回改同一段话。",
    ),
    promptRows,
    h(
      "div",
      { className: "gt-prompts-actions" },
      h(
        "button",
        {
          type: "button",
          className: "gt-btn gt-path-pick",
          onClick: addPrompt,
          disabled: prompts.length >= PROMPT_COUNT_LIMIT,
          title: "以内置模板为底稿新建一份",
          "aria-label": "新增提示词",
        },
        "新增提示词",
      ),
      h("span", { className: "gt-prompt-count" }, prompts.length + " / " + PROMPT_COUNT_LIMIT),
      flashMsg ? h("span", { className: "gt-prompt-flash" }, flashMsg) : null,
    ),
  );

  // 工作区只读展示 + 文件夹选择按钮（与工作志同一套）：路径只能由系统选择器
  // 产生。手打的路径没有对应 grant，引擎跑起来会因为没授权而失败。
  // 没设置时显示插件数据目录的真实路径——只写「默认」等于没说 cwd 在哪。
  const ownDataDir = snap.storagePath || "";
  const workspaceShown = form.workspacePath
    ? displayPath(form.workspacePath)
    : ownDataDir
      ? displayPath(ownDataDir)
      : "";
  const workspaceValue = h(
    "span",
    {
      className:
        "gt-path-value" + (form.workspacePath ? "" : ownDataDir ? " is-default" : " is-empty"),
      title: form.workspacePath
        ? workspaceShown
        : ownDataDir
          ? "默认值，即插件数据目录：" + displayPath(ownDataDir)
          : "正在读取插件数据目录…",
    },
    workspaceShown || "插件数据目录（正在读取…）",
  );
  const workspaceControl = h(
    "div",
    { className: "gt-path gt-workspace-path" },
    workspaceValue,
    h(
      "button",
      {
        type: "button",
        className: "gt-btn gt-path-pick",
        title: "打开系统文件夹选择器",
        onClick: () => void chooseWorkspace(),
      },
      "选择…",
    ),
    // 空值本来就是「用默认」，没有可清除的东西时就不渲染
    form.workspacePath
      ? h(
          "button",
          {
            type: "button",
            className: "gt-btn ghost gt-path-pick",
            title: "清除并回到默认行为",
            onClick: () => patch("workspacePath", ""),
          },
          "默认",
        )
      : null,
  );

  const periodItems = PERIODS.map((p) => ({ value: p.key, label: p.label }));
  const starItems = [
    { value: 10, label: "10（很宽）" },
    { value: 50, label: "50（默认）" },
    { value: 200, label: "200" },
    { value: 500, label: "500" },
    { value: 1000, label: "1000（很严）" },
  ];

  const languageControl = h(
    "div",
    { className: "gt-path" },
    h("input", {
      className: "gt-input",
      value: form.language || "",
      placeholder: "留空 = 全部语言",
      spellCheck: false,
      onChange: (e) => patch("language", e.target.value.trim().toLowerCase()),
    }),
    form.language
      ? h(
          "button",
          {
            type: "button",
            className: "gt-btn ghost gt-path-pick",
            title: "回到全部语言",
            onClick: () => patch("language", ""),
          },
          "全部",
        )
      : null,
  );

  const tokenControl = h(
    "details",
    { className: "gt-disclosure" },
    h("summary", null, "限流了再加 Token（可选）"),
    h(
      "div",
      { className: "gt-disclosure-body" },
      h(
        "p",
        { className: "gt-hint" },
        "不填也能正常使用：未认证时搜索接口 10 次/分钟，一般够每天刷新一两次。Token 只存在本机，只发给 api.github.com。",
      ),
      h(
        "div",
        { className: "gt-path" },
        h("input", {
          className: "gt-input",
          type: "password",
          value: form.token || "",
          placeholder: "ghp_… / github_pat_…",
          spellCheck: false,
          onChange: (e) => patch("token", e.target.value.trim()),
        }),
        form.token
          ? h(
              "button",
              {
                type: "button",
                className: "gt-btn ghost gt-path-pick",
                onClick: () => patch("token", ""),
              },
              "清除",
            )
          : null,
      ),
    ),
  );

  const saveHint =
    saveStatus === "saving"
      ? "保存中…"
      : saveStatus === "saved"
        ? "已保存"
        : saveStatus === "error"
          ? "保存失败，请重试"
          : "改动会自动保存";

  return h(
    "div",
    { className: "gt-settings" },
    h("p", { className: "gt-settings-intro" }, "榜单与解读只在这台机器上处理，插件不上传任何内容。"),

    h(
      "section",
      { className: "gt-section" },
      h(
        "div",
        { className: "gt-section-label" },
        h("h2", null, "显示"),
        h("p", null, "打开面板时看到的默认视图与时间档。"),
      ),
      h(
        "div",
        { className: "gt-section-panel" },
        segField(
          "默认时间档",
          h(Dropdown, { items: periodItems, value: form.period, onChange: (v) => patch("period", v) }),
          "Trending 榜按天 / 周 / 月统计，切换后立刻重新抓取。",
        ),
        segField(
          "语言筛选",
          languageControl,
          "对应 github.com/trending/<语言>，填英文语言名，例如 python、rust、typescript。",
        ),
        segField(
          "新星库 star 阈值",
          h(Dropdown, {
            items: starItems,
            value: form.minStars,
            onChange: (v) => patch("minStars", normaliseMinStars(v)),
          }),
          "「新星库」只看近 7 天创建、star 达到这个数的仓库。",
        ),
      ),
    ),

    h(
      "section",
      { className: "gt-section" },
      h(
        "div",
        { className: "gt-section-label" },
        h("h2", null, "中文解读"),
        h("p", null, "只有点「生成解读」时才调用模型，其余时间不耗 token。"),
      ),
      h(
        "div",
        { className: "gt-section-panel" },
        segField(
          "引擎",
          h(Dropdown, {
            items: engineItems,
            value: form.engine,
            onChange: (v) => {
              // 换引擎时模型要清空：旧引擎的 model id 对新引擎无意义
              patch("engine", v);
              patch("model", "");
            },
            disabled: snap.modelsLoading && snap.catalog.length === 0,
            emptyText: "宿主没有返回引擎",
          }),
          snap.modelsError
            ? snap.modelsError
            : "选项来自宿主当前可用的引擎；标「不可用」的是已安装但没配置好。",
        ),
        segField(
          "模型",
          h(Dropdown, {
            items: modelItems,
            value: form.model,
            onChange: (v) => patch("model", v),
            // 「自动」时按第一个可用引擎的模型列表给选项，用户仍能先挑模型。
            disabled: !entry || entry.available === false,
            emptyText: entry
              ? entry.available === false
                ? "该引擎当前不可用"
                : "该引擎未报告可用模型"
              : "先选引擎",
          }),
          modelHint(),
        ),
        segField(
          "AI 工作区",
          workspaceControl,
          "解读与「讨论」都会在这个目录下运行。"
            + "点榜单某行的「讨论」时，模型先在这里找同名仓库的本地副本，找不到再读远程。"
            + "默认落在插件数据目录，免得这些会话混进某个项目的会话历史。"
            + (flashMsg ? " " + flashMsg : ""),
        ),
      ),
    ),

    h(
      "section",
      { className: "gt-section" },
      h(
        "div",
        { className: "gt-section-label" },
        h("h2", null, "讨论提示词"),
        h("p", null, "点榜单某行的「讨论」时发给模型的那段话。可以存几份不同角度，选一份当默认。"),
      ),
      h("div", { className: "gt-section-panel" }, promptEditor),
    ),

    h(
      "section",
      { className: "gt-section" },
      h(
        "div",
        { className: "gt-section-label" },
        h("h2", null, "网络"),
        h("p", null, "只访问 github.com 与 api.github.com。"),
      ),
      h(
        "div",
        { className: "gt-section-panel" },
        h(
          "p",
          { className: "gt-note-line" },
          "榜单来自 ",
          h("code", null, "github.com/trending"),
          " 的公开页面，不占 API 配额；新星库走 GitHub 搜索接口，未认证时 10 次/分钟。",
        ),
        tokenControl,
      ),
    ),

    h("p", { className: "gt-settings-foot" }, "版本 " + ctx.version + " · " + saveHint),
  );
}

/* ---------- CSS ---------- */

const CSS = `
/* 一套自足的 token：不依赖宿主变量名（各版本命名不保证稳定），
 * 也保证浅色/深色在任何宿主下都读得清。 */
.gt-root {
  --gt-text: #0a0a0a; --gt-muted: #6b6b6b;
  --gt-border: #e6e6e6; --gt-surface: #ffffff; --gt-raised: #f6f7f9;
  --gt-accent: #1d5fbf; --gt-positive: #2e7d32; --gt-negative: #c4242a;
  /* 骨架屏色块单独一档：raised 压在白色底上几乎看不见，会显得「没反应」 */
  --gt-skel: #e4e7ec;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  gap: 10px;
  padding: 16px 18px 0;
  color: var(--gt-text);
  container-type: inline-size;
}
.dark .gt-root {
  --gt-text: #f2f3f5; --gt-muted: #a3a7ad;
  --gt-border: #2a2d32; --gt-surface: #17191c; --gt-raised: #1d2024;
  --gt-skel: #2b2f35;
  --gt-accent: #5b9bf0; --gt-positive: #4fc27a; --gt-negative: #e5566f;
}
@media (prefers-color-scheme: dark) {
  .gt-root { --gt-text: #f2f3f5; --gt-muted: #a3a7ad; --gt-border: #2a2d32;
    --gt-surface: #17191c; --gt-raised: #1d2024; --gt-skel: #2b2f35;
    --gt-accent: #5b9bf0;
    --gt-positive: #4fc27a; --gt-negative: #e5566f; }
  .light .gt-root, html.light .gt-root {
    --gt-text: #0a0a0a; --gt-muted: #6b6b6b; --gt-border: #e6e6e6;
    --gt-surface: #ffffff; --gt-raised: #f6f7f9; --gt-skel: #e4e7ec;
    --gt-accent: #1d5fbf;
    --gt-positive: #2e7d32; --gt-negative: #c4242a;
  }
}
.gt-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.gt-title { margin: 0; font-size: 17px; font-weight: 600; letter-spacing: -0.01em; }
.gt-sub { margin: 2px 0 0; font-size: 12px; opacity: 0.62; }
.gt-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.gt-group { display: flex; align-items: center; gap: 4px; }
.gt-group--end { margin-left: auto; }
.gt-chip, .gt-btn {
  font: inherit;
  font-size: 12px;
  line-height: 1;
  padding: 6px 10px;
  border-radius: 7px;
  border: 1px solid var(--gt-border);
  background: transparent;
  color: inherit;
  cursor: pointer;
  white-space: nowrap;
  transition: background-color 120ms ease, border-color 120ms ease;
}
.gt-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
/* 「刷新 / 刷新中…」来回切时宽度不跳，右边的按钮不会跟着挪。
 * 转圈 12px + 间距 6px + 「刷新中…」实测 63px，加内边距 20 刚好 86px。 */
.gt-btn--refresh { min-width: 86px; }
/* 「导出 Markdown / 已复制 / 复制失败」来回切时宽度不跳。 */
.gt-btn--export { min-width: 104px; }
.gt-chip:hover, .gt-btn:hover { background: var(--gt-raised); }
.gt-chip--on {
  background: var(--gt-raised);
  border-color: var(--gt-accent);
  font-weight: 600;
}
.gt-btn--primary { border-color: var(--gt-accent); font-weight: 600; }
.gt-chip:disabled, .gt-btn:disabled { opacity: 0.45; cursor: not-allowed; }
/* 抓取中按钮不能用 opacity:.45 冒充禁用：那样转圈也被一起淡掉了。
 * 底色压暗、光标改成等待，转圈保持不透明。放在 disabled 之后才盖得住。 */
.gt-btn--busy:disabled { opacity: 1; cursor: progress; background: var(--gt-raised); }
.gt-btn--busy .gt-spinner { border-color: var(--gt-border); border-top-color: var(--gt-accent); }
.gt-chip:focus-visible, .gt-btn:focus-visible, .gt-input:focus-visible, .gt-repo:focus-visible {
  outline: 2px solid var(--gt-accent);
  outline-offset: 2px;
}
.gt-stamp { font-size: 11px; opacity: 0.55; white-space: nowrap; }
.gt-notice { margin: 0; font-size: 12px; opacity: 0.7; }
/* 状态区可能同时有两件事要说（在看什么数据 + 刚才那一按的结果）。
 * 合成一列而不是二选一，两句话都短，叠起来还不到原来两行的钱。 */
.gt-status-rows { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.gt-notice--error { color: var(--gt-negative); opacity: 1; display: flex; gap: 6px; flex-wrap: wrap; }
/* 开会话成功：用正向色而不是中性灰。它是一条「你做了一件事，结果是好的」
 * 的回执，不是背景说明，灰掉就等于没说。 */
.gt-notice--ok { color: var(--gt-positive); opacity: 1; display: flex; gap: 6px; flex-wrap: wrap; }
.gt-notice-hint { opacity: 0.7; }
/* 抓取中：提示行里放一枚转圈，用户能确认进程还活着，而不是页面卡住了 */
.gt-notice.gt-running {
  display: flex; align-items: center; gap: 7px; flex-wrap: wrap;
  transition: opacity 120ms ease;
}
.gt-running-text { flex: none; }

@keyframes gt-spin { to { transform: rotate(360deg); } }
.gt-spinner {
  flex: none; display: inline-block; width: 12px; height: 12px; box-sizing: border-box;
  border: 2px solid var(--gt-border); border-top-color: var(--gt-accent);
  border-radius: 50%; animation: gt-spin 0.8s linear infinite;
}

/* 第一次加载没有旧数据可看：用骨架屏占住列表高度，
 * 避免「一行灰字 → 突然长出一整屏卡片」的跳动。 */
.gt-skel-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.gt-skel {
  position: relative; overflow: hidden;
  display: flex; gap: 12px; padding: 11px 14px; border-radius: 10px;
  background: var(--gt-surface); border: 1px solid var(--gt-border);
}
.gt-skel-badge { flex: none; width: 22px; height: 22px; border-radius: 6px; background: var(--gt-skel); }
.gt-skel-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 12px; }
.gt-skel-line { height: 11px; border-radius: 5px; background: var(--gt-skel); }
.gt-skel-line--title { width: 42%; height: 13px; }
.gt-skel-line--desc { width: 78%; }
.gt-skel-line--meta { width: 30%; }
/* 只有一道高光从左往右扫，色块本身不呼吸：比整块脉冲安静得多 */
.gt-skel::after {
  content: ""; position: absolute; inset: 0; pointer-events: none;
  background-image: linear-gradient(100deg, transparent 30%, rgba(255, 255, 255, 0.75) 50%, transparent 70%);
  background-size: 240% 100%; background-position: 140% 0;
  animation: gt-sweep 1.5s ease-in-out infinite;
}
.dark .gt-skel::after {
  background-image: linear-gradient(100deg, transparent 30%, rgba(255, 255, 255, 0.05) 50%, transparent 70%);
}
@keyframes gt-sweep { to { background-position: -140% 0; } }

/* 新榜单落位时轻轻淡入，替代“整块内容瞬间替换” */
@keyframes gt-fade-in { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: none; } }

@media (prefers-reduced-motion: reduce) {
  .gt-spinner { animation: none; }
  .gt-skel::after { animation: none; opacity: 0; }
  .gt-list { animation: none; }
  .gt-row, .gt-chip, .gt-btn, .gt-discuss { transition: none; }
}
.gt-scroll { flex: 1; min-height: 0; overflow-y: auto; padding-bottom: 18px; }
.gt-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; animation: gt-fade-in 180ms ease; }
.gt-row {
  display: flex; gap: 12px; padding: 11px 14px; border-radius: 10px;
  background: var(--gt-surface); border: 1px solid var(--gt-border);
  transition: background-color 120ms ease, border-color 120ms ease;
}
.gt-row:hover { background: var(--gt-raised); border-color: var(--gt-accent); }
.gt-row-main { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 4px; }
.gt-row-title { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
/* 名次做成定宽徽章：一眼能看出这是榜单的第几条，也把标题行对齐成一条线 */
.gt-rank {
  flex: none; min-width: 22px; height: 22px; padding: 0 5px;
  display: inline-flex; align-items: center; justify-content: center;
  border-radius: 6px; border: 1px solid var(--gt-border);
  background: var(--gt-raised);
  font-size: 11px; font-weight: 600; color: var(--gt-muted);
  font-variant-numeric: tabular-nums;
}
.gt-repo { font-size: 13.5px; font-weight: 600; text-decoration: none; color: inherit; word-break: break-all; }
.gt-repo:hover { text-decoration: underline; }
.gt-repo-owner { font-weight: 400; color: var(--gt-muted); }
/* 讨论入口：平时压得很轻，不抢仓库名的注意力；悬停/聚焦时才浮起来。
 * 25 行各摆一个显眼按钮会让整个榜显得吵闹，而且误触是一轮真 token。 */
.gt-discuss {
  flex: none; padding: 2px 9px;
  font-size: 11px; border-radius: 6px; opacity: 0;
  transition: opacity 120ms ease;
}
/* 只有最左边那个按钮吃 auto 外边距：三个都写的话余量会被均分，
 * 悬停时按钮之间空出一大块、整行标题横向抖一下。 */
.gt-discuss--lead { margin-left: auto; }
.gt-row:hover .gt-discuss, .gt-row:focus-within .gt-discuss { opacity: 1; }
.gt-discuss:focus-visible { opacity: 1; }
.gt-discuss--busy { opacity: 1; }
.gt-sep { white-space: pre; }
.gt-move {
  flex: none; font-size: 10.5px; padding: 1px 6px; border-radius: 5px;
  background: var(--gt-raised); color: var(--gt-muted);
  font-variant-numeric: tabular-nums; white-space: nowrap;
}
/* 涨跌用颜色区分方向，箭头字形在窄体终端字体里常缺失，颜色更可靠 */
.gt-move--up { color: #2e7d32; background: rgba(46,160,67,0.12); }
.gt-move--down { color: #c4242a; background: rgba(196,36,42,0.1); }
.dark .gt-move--up { color: #4fc27a; }
.dark .gt-move--down { color: #e5566f; }
.gt-move--new { background: rgba(46,160,67,0.18); color: #2e7d32; font-weight: 600; }
.dark .gt-move--new { color: #4fc27a; }
.gt-desc { margin: 0; font-size: 12.5px; line-height: 1.55; color: var(--gt-muted); }
.gt-meta {
  display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
  font-size: 11.5px; color: var(--gt-muted);
}
.gt-lang { display: inline-flex; align-items: center; gap: 5px; }
.gt-dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; opacity: 0.8; display: inline-block; }
.gt-gain { font-variant-numeric: tabular-nums; }
.gt-stat { font-variant-numeric: tabular-nums; }
.gt-empty { font-size: 12.5px; opacity: 0.6; padding: 24px 4px; }
.gt-dropped { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--gt-border); }
.gt-dropped h3 { margin: 0 0 4px; font-size: 12px; font-weight: 600; opacity: 0.7; }
.gt-dropped p { margin: 0; font-size: 12px; opacity: 0.6; word-break: break-all; }
/* 解读面板：和榜单卡片同一套表面，再用一条强调色左边框区分「这是模型写的」 */
.gt-digest {
  margin-top: 14px; padding: 14px 16px; border-radius: 10px;
  background: var(--gt-surface); border: 1px solid var(--gt-border);
  border-left: 3px solid var(--gt-accent);
}
.gt-digest-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
/* 只管头部那个「解读」标题。写成 .gt-digest h3 会顺带压过正文里
 * .gt-md-h3 的字号（元素选择器比单个类更具体）。 */
.gt-digest-head > h3 { margin: 0; font-size: 13px; font-weight: 600; }
/* 生成中：转圈 + 已收字数。让用户确认进程活着，也知道还要等多久 */
.gt-digest-run {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 11.5px; color: var(--gt-muted); font-variant-numeric: tabular-nums;
}
.gt-digest-stopped { color: var(--gt-muted); font-weight: 600; }
.gt-digest-copy { margin-left: auto; padding: 3px 9px; font-size: 11.5px; }
.gt-digest-body { font-size: 13px; line-height: 1.7; word-break: break-word; }
.gt-digest-wait { color: var(--gt-muted); }
.gt-digest-body > *:first-child { margin-top: 0; }
.gt-digest-body > *:last-child { margin-bottom: 0; }
/* 行内 README：不用强调色左边框，它和「解读」是并列的两块内容，
 * 左边框会让整页变成两根竖线。 */
.gt-readme {
  margin-top: 10px; padding: 10px 12px; border-radius: 8px;
  background: var(--gt-raised); border: 1px solid var(--gt-border);
}
.gt-readme-note {
  margin: 0 0 8px; display: flex; align-items: center; gap: 8px;
  font-size: 11.5px; color: var(--gt-muted);
}
.gt-readme-note--error { color: var(--gt-negative); }
.gt-readme-more { margin-left: auto; color: var(--gt-accent); }
/* 正文限高：README 可以很长，展开一整份会把下面十几行榜单推到屏幕外。
 * 2000 字配这个高度刚好露出开头和结构，剩下的滚一下就够。 */
.gt-readme-body {
  max-height: 360px; overflow-y: auto;
  font-size: 12.5px; line-height: 1.65; word-break: break-word;
}
.gt-readme-body > *:first-child { margin-top: 0; }
.gt-readme-body > *:last-child { margin-bottom: 0; }
/* README 的一级标题和仓库名重复，而且比行标题还大，压到次要位置。 */
.gt-readme-body .gt-md-h1 { font-size: 14px; }

/* 解读正文里的 Markdown。只覆盖本插件自己的类名，不影响宿主样式。
 * 正文是 13px，标题梯度要拉到能一眼分节——模型最爱写三级标题，只比正文大
 * 1px 的话读起来和段落没区别。 */
.gt-md-p { margin: 0 0 10px; }
.gt-md-h1, .gt-md-h2, .gt-md-h3, .gt-md-h4, .gt-md-h5, .gt-md-h6 {
  margin: 18px 0 8px; font-weight: 600; line-height: 1.35;
}
.gt-md-h1 { font-size: 18px; }
.gt-md-h2 { font-size: 16.5px; }
.gt-md-h3 { font-size: 15px; }
.gt-md-h4 { font-size: 14px; }
.gt-md-h5, .gt-md-h6 { font-size: 13px; }
.gt-md-list { margin: 0 0 10px; padding-left: 20px; display: flex; flex-direction: column; gap: 4px; }
.gt-md-list .gt-md-list { margin: 4px 0 0; }
.gt-md-quote {
  margin: 0 0 10px; padding: 2px 0 2px 10px;
  border-left: 2px solid var(--gt-border); color: var(--gt-muted);
}
.gt-md-hr { margin: 14px 0; border: 0; border-top: 1px solid var(--gt-border); }
.gt-md-code {
  padding: 1px 5px; border-radius: 4px; background: var(--gt-raised);
  font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
  font-size: 12px;
}
.gt-md-pre {
  margin: 0 0 10px; padding: 10px 12px; border-radius: 8px;
  background: var(--gt-raised); border: 1px solid var(--gt-border);
  overflow-x: auto;
}
.gt-md-pre code {
  font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
  font-size: 12px; line-height: 1.6; white-space: pre;
}
/* 表格外壳负责横向滚动：解读面板在窄窗口里不能把整页撑宽 */
.gt-md-table-wrap {
  margin: 0 0 10px; overflow-x: auto;
  border: 1px solid var(--gt-border); border-radius: 8px;
}
/* 宽度 100% 让宽窗口铺满；min-width 是内容下限——窄窗口里宁可横向滚动，
 * 也不要把四列中文挤成一条条竖排。 */
.gt-md-table { width: 100%; min-width: 420px; border-collapse: collapse; font-size: 12.5px; line-height: 1.55; }
.gt-md-table th, .gt-md-table td {
  padding: 7px 10px; text-align: left; vertical-align: top;
  border-bottom: 1px solid var(--gt-border); word-break: break-word;
}
.gt-md-table th { background: var(--gt-raised); font-weight: 600; white-space: nowrap; }
.gt-md-table tbody tr:last-child td { border-bottom: 0; }
.gt-md-table tbody tr:nth-child(even) td { background: var(--gt-raised); }
.gt-digest-body a { color: var(--gt-accent); }
.gt-settings {
  --gt-control: #d4d4d4;
  --gt-text: #0a0a0a; --gt-muted: #6b6b6b; --gt-border: #e6e6e6;
  --gt-surface: #ffffff; --gt-raised: #f6f7f9; --gt-accent: #1d5fbf;
  max-width: 1080px; margin: 0 auto; display: flex; flex-direction: column;
  color: var(--gt-text); font-size: 14px; line-height: 1.6;
  container-type: inline-size;
}
.dark .gt-settings, .dark.gt-settings {
  --gt-text: #f2f3f5; --gt-muted: #a3a7ad; --gt-border: #2a2d32;
  --gt-surface: #17191c; --gt-raised: #1d2024; --gt-control: #3a3e44;
  --gt-accent: #5b9bf0;
}
@media (prefers-color-scheme: dark) {
  .gt-settings {
    --gt-text: #f2f3f5; --gt-muted: #a3a7ad; --gt-border: #2a2d32;
    --gt-surface: #17191c; --gt-raised: #1d2024; --gt-control: #3a3e44;
    --gt-accent: #5b9bf0;
  }
}
.gt-settings-intro { margin: 0 0 8px; font-size: 13px; color: var(--gt-muted); }
.gt-section {
  display: grid; grid-template-columns: 260px minmax(0, 1fr); gap: 32px;
  padding: 26px 0; border-top: 1px solid var(--gt-border);
}
.gt-section:first-of-type { border-top: 0; padding-top: 8px; }
.gt-section-label h2 { margin: 0; font-size: 16px; font-weight: 600; line-height: 1.4; }
.gt-section-label p { margin: 6px 0 0; font-size: 13px; line-height: 1.55; color: var(--gt-muted); }
.gt-section-panel {
  display: flex; flex-direction: column; gap: 18px;
  background: var(--gt-surface); border: 1px solid var(--gt-border);
  border-radius: 12px; padding: 18px;
}
.gt-field { display: flex; flex-direction: column; gap: 6px; }
.gt-field > label { font-size: 14px; font-weight: 500; }
.gt-field .gt-hint { font-size: 12px; line-height: 1.5; color: var(--gt-muted); }
.gt-settings .gt-input {
  width: 100%; height: 36px; box-sizing: border-box; font: inherit; font-size: 13px;
  padding: 0 12px; border-radius: 6px;
  border: 1px solid var(--gt-control); background: var(--gt-surface); color: var(--gt-text);
}
.gt-settings .gt-input::placeholder { color: var(--gt-muted); }
.gt-settings .gt-input:focus { outline: 2px solid var(--gt-accent); outline-offset: -1px; }
.gt-settings .gt-path { display: flex; align-items: center; gap: 8px; min-width: 0; }
.gt-settings .gt-btn {
  height: 36px; padding: 0 14px; font-size: 13px; border-radius: 6px;
  border: 1px solid var(--gt-control); background: var(--gt-surface); color: var(--gt-text);
}
.gt-settings .gt-btn:hover:not(:disabled) { background: var(--gt-raised); }
.gt-settings .gt-btn.ghost { border-color: transparent; background: transparent; color: var(--gt-muted); }
.gt-settings .gt-btn.ghost:hover:not(:disabled) { background: var(--gt-raised); color: var(--gt-text); }
.gt-settings .gt-path-pick { flex: none; }
/* 路径字段：只读展示 + 文件夹选择按钮，路径只能通过系统选择器产生 */
.gt-settings .gt-path-value {
  flex: 1 1 auto; min-width: 0; height: 36px; box-sizing: border-box;
  display: block; padding: 0 12px; line-height: 34px;
  border: 1px solid var(--gt-control); border-radius: 6px;
  background: var(--gt-raised); color: var(--gt-text); font-size: 13px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.gt-settings .gt-path-value.is-empty { color: var(--gt-muted); }

/* 讨论提示词：一份一行的折叠列表。默认那份只在收起时也一眼可见，
 * 因为「点讨论会用哪份」是这一节唯一不能猜的信息。 */
.gt-settings .gt-prompts { display: flex; flex-direction: column; gap: 10px; }
.gt-settings .gt-prompt {
  border: 1px solid var(--gt-control); border-radius: 8px; overflow: hidden;
}
.gt-settings .gt-prompt-head {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 10px; background: var(--gt-raised);
}
.gt-settings .gt-prompt-name {
  flex: 1 1 auto; min-width: 0; display: flex; align-items: center; gap: 6px;
  font: inherit; font-size: 13px; font-weight: 500; text-align: left;
  padding: 2px 0; border: 0; background: transparent; color: inherit; cursor: pointer;
}
.gt-settings .gt-prompt-name:hover { color: var(--gt-accent); }
.gt-settings .gt-prompt-chevron { flex: none; font-size: 10px; opacity: 0.7; }
.gt-settings .gt-prompt-label {
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.gt-settings .gt-prompt-default {
  flex: none; padding: 2px 8px; border-radius: 5px; font-size: 11px; font-weight: 600;
  color: var(--gt-accent); background: transparent;
  border: 1px solid var(--gt-accent);
}
.gt-settings .gt-prompt-head .gt-btn { height: 26px; padding: 0 10px; font-size: 12px; }
.gt-settings .gt-prompt-body {
  display: flex; flex-direction: column; gap: 10px; padding: 12px;
  border-top: 1px solid var(--gt-control);
}
/* 正文是多行提示词：等宽字体比比例字体更容易看出缩进和条目结构。 */
.gt-settings .gt-prompt-text {
  height: auto; min-height: 200px; padding: 10px 12px; line-height: 1.6;
  resize: vertical; font-family: var(--gt-mono, ui-monospace, "Cascadia Code", Consolas, monospace);
  font-size: 12.5px;
}
.gt-settings .gt-prompts-actions {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
}
.gt-settings .gt-prompt-count { font-size: 12px; color: var(--gt-muted); font-variant-numeric: tabular-nums; }
.gt-settings .gt-prompt-flash { font-size: 12px; color: var(--gt-muted); }
/* 没设置时显示的默认路径：虚框表示「这不是你选的，是插件自己的目录」 */
.gt-settings .gt-path-value.is-default {
  color: var(--gt-text); border-style: dashed; background: transparent;
}

/* 自绘下拉 */
.gt-dd { position: relative; width: 100%; }
.gt-dd-trigger {
  width: 100%; height: 36px; box-sizing: border-box; padding: 0 12px;
  display: flex; align-items: center; gap: 8px; cursor: pointer;
  font: inherit; font-size: 13px; text-align: left;
  border: 1px solid var(--gt-control); border-radius: 6px;
  background: var(--gt-surface); color: var(--gt-text);
}
.gt-dd-trigger:hover:not(:disabled) { border-color: var(--gt-muted); }
.gt-dd-trigger:focus-visible { outline: 2px solid var(--gt-accent); outline-offset: -1px; }
.gt-dd-trigger:disabled { opacity: 0.55; cursor: not-allowed; }
.gt-dd.is-open .gt-dd-trigger { border-color: var(--gt-accent); }
.gt-dd-value { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gt-dd-value.is-empty { color: var(--gt-muted); }
.gt-dd-caret {
  flex: none; width: 7px; height: 7px; margin-top: -4px;
  border-right: 1.5px solid var(--gt-muted); border-bottom: 1.5px solid var(--gt-muted);
  transform: rotate(45deg); transition: transform 120ms ease;
}
.gt-dd.is-open .gt-dd-caret { transform: rotate(-135deg); margin-top: 3px; }
.gt-dd-scrim { position: fixed; inset: 0; z-index: 80; }
.gt-dd-menu {
  position: absolute; left: 0; right: 0; top: calc(100% + 6px); z-index: 81;
  max-height: 260px; overflow-y: auto; padding: 4px;
  background: var(--gt-surface); border: 1px solid var(--gt-border);
  border-radius: 8px; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.16);
}
.gt-dd.is-up .gt-dd-menu { top: auto; bottom: calc(100% + 6px); }
.gt-dd-item {
  display: flex; align-items: center; gap: 8px; padding: 7px 9px;
  border-radius: 5px; font-size: 13px; cursor: pointer; outline: none;
}
.gt-dd-item.is-active { background: var(--gt-raised); }
.gt-dd-item.is-disabled { opacity: 0.45; cursor: default; }
.gt-dd-item.is-disabled.is-active { background: transparent; }
.gt-dd-label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gt-dd-check { flex: none; font-size: 12px; color: var(--gt-accent); opacity: 0; }
.gt-dd-item[aria-selected="true"] .gt-dd-check { opacity: 1; }
.gt-dd-empty { padding: 8px 10px; font-size: 12px; color: var(--gt-muted); }

/* 可折叠的次要项：Token 之类默认收起来 */
.gt-disclosure { border-top: 1px solid var(--gt-border); padding-top: 14px; }
.gt-disclosure:last-child { padding-bottom: 0; }
.gt-disclosure > summary {
  cursor: pointer; font-size: 13px; color: var(--gt-muted); list-style: none;
  display: flex; align-items: center; gap: 6px; padding: 2px 0;
}
.gt-disclosure > summary::-webkit-details-marker { display: none; }
.gt-disclosure > summary::before { content: "▸"; font-size: 10px; line-height: 1; }
.gt-disclosure[open] > summary::before { content: "▾"; }
.gt-disclosure > summary:hover { color: var(--gt-text); }
.gt-disclosure-body { display: flex; flex-direction: column; gap: 10px; margin-top: 12px; }
.gt-disclosure-body .gt-hint { margin: 0; font-size: 12px; line-height: 1.6; color: var(--gt-muted); }

/* 只放一段说明的卡片：别留出字段间距那么大的尾部空白 */
.gt-section-panel > .gt-note-line:last-child { margin-bottom: 0; }

.gt-note-line { margin: 0; font-size: 13px; line-height: 1.6; color: var(--gt-muted); }
.gt-note-line code {
  padding: 1px 5px; border-radius: 4px; font-size: 12px;
  background: var(--gt-raised); border: 1px solid var(--gt-border);
}
.gt-settings-foot { font-size: 12px; color: var(--gt-muted); margin: 16px 0 0; }

@container (max-width: 720px) {
  .gt-section { grid-template-columns: minmax(0, 1fr); gap: 12px; padding: 20px 0; }
}
@container (max-width: 520px) {
  .gt-group--end { margin-left: 0; width: 100%; }
  .gt-row { padding: 8px 6px; }
}
`;

/* ---------- 激活 ---------- */

export default function activate(ctx) {
  appCtx = ctx;
  const mySeq = ++activateSeq;
  // 重新激活时工作区表可能变了（用户在侧栏删过、或换了 AI 工作区），
  // 上次的「已登记」结论不能直接沿用。
  workspaceRegistrations = new Map();

  const cssDisposer = ctx.theme.injectCss(CSS);

  ctx.ui.registerCommand({
    key: "open",
    title: () => "热点：打开今日榜单",
    keywords: () => ["github", "trending", "热点", "榜单"],
    run: () => ctx.ui.openCenterTab("main"),
  });

  ctx.ui.registerCommand({
    key: "refresh",
    title: () => "热点：刷新榜单",
    keywords: () => ["github", "trending", "refresh", "刷新"],
    run: () => {
      ctx.ui.openCenterTab("main");
      void refresh(ctx, { force: true });
    },
  });

  const tabDisposer = ctx.ui.registerCenterTab({
    key: "main",
    title: () => "每日热点",
    icon: Icon,
    component: MainTab,
  });

  const sideDisposer = ctx.ui.registerSidebarNav({
    key: "main",
    label: () => "每日热点",
    icon: Icon,
    badge: () => {
      const snap = store.snap;
      if (!snap.loaded || snap.loading) return null;
      const fresh = snap.repos.filter((row) => row.isNew).length;
      return fresh > 0 ? String(fresh) : null;
    },
    onOpen: () => ctx.ui.openCenterTab("main"),
  });

  const settingsDisposer = ctx.ui.registerSettingsSection({
    key: "main",
    label: () => "每日热点",
    component: SettingsSection,
  });

  // 恢复设置与非敏感缓存；失败不影响激活。
  void (async () => {
    try {
      const saved = await ctx.storage.get("settings");
      if (mySeq !== activateSeq) return;
      if (saved && typeof saved === "object") {
        const merged = Object.assign({}, DEFAULT_SETTINGS);
        for (const key of Object.keys(DEFAULT_SETTINGS)) {
          if (saved[key] !== undefined && saved[key] !== null) merged[key] = saved[key];
        }
        merged.minStars = normaliseMinStars(merged.minStars);
        // 提示词来自磁盘：可能是旧版本的空值、也可能是手改过的坏形状。
        // 归一化在这里做一次，后面所有读取点都不用再防。
        merged.prompts = normalisePrompts(merged.prompts);
        if (!merged.prompts.some((p) => p.id === merged.defaultPromptId)) {
          merged.defaultPromptId = merged.prompts.length > 0 ? merged.prompts[0].id : "";
        }
        set({ settings: merged });
      }
    } catch {
      /* 用默认设置 */
    }
    await pruneHistory(ctx);
  })();

  // 数据目录既是快照的落盘位置，也是解读默认的 cwd。早点读到，设置页才能
  // 把真实路径显示出来；读不到不影响刷新榜单，只影响解读能不能跑。
  void pluginDataDir(ctx);

  const dispose = () => {
    activateSeq += 1;
    genSeq += 1;
    digestSeq += 1;
    // 讨论也一起作废：卸载期间在飞的 startRun 回来后不能往 store 里写回执。
    discussSeq += 1;
    // 续接表跟着这次激活作废：重新安装/重新激活后 sessionId 未必还有效，
    // 拿旧 id 去续接会变成一个「刚开就报错」的按钮。
    resetDiscussSessions();
    // README 预览也作废：卸载后回来的 http 响应不能往 store 里写正文。
    readmeSeq += 1;
    cancelSession(activeDigest, ctx);
    try {
      cssDisposer();
    } catch {
      /* 忽略 */
    }
    set({
      generating: false,
      loading: false,
      digest: "",
      digestStopped: false,
      repos: [],
      loaded: false,
      httpError: "",
      discussing: "",
      discussError: "",
      discussNotice: "",
      discussWorkspace: "",
      discussWarning: "",
      discussResumed: false,
      discussPromptName: "",
      readmeOpen: "",
    readmeLoading: false,
    readmeError: "",
    readmeText: "",
    readmeTruncated: false,
    readmeTotal: 0,
    });
  };

  return dispose;
}
