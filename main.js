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
 */
function countFromAnchor(article, slug, kind) {
  const anchor = 'href="/' + escapeRegExp(slug) + "/" + kind + '"';
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

    repos.push({
      repo: slug,
      owner: slug.slice(0, slug.indexOf("/")),
      name: slug.slice(slug.indexOf("/") + 1),
      url: "https://github.com/" + slug,
      description: descMatch ? cleanText(descMatch[1]) : "",
      language: langMatch ? cleanText(langMatch[1]) : "",
      languageColor: colorMatch ? colorMatch[1].trim() : "",
      stars: countFromAnchor(article, slug, "stargazers"),
      forks: countFromAnchor(article, slug, "forks"),
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
      repos: list.map((row) => ({ ...row, rank: null, previousRank: null, rankDelta: null, isNew: false })),
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
    "- 先给 3-5 句总体判断（今天什么方向在升温）。",
    "- 再挑 5-8 个最值得看的仓库，每个一句：它解决什么问题、适合谁、要不要现在看。",
    "- 只依据上面的「榜单事实」；事实里没有的信息不要编造，也不要猜技术细节。",
    "- 不要复述榜单，不要用「首先/其次/总之」这类填充词。",
    "- 用 Markdown，但不要写一级标题。",
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


const PLUGIN_ID = "github-trending";
const HISTORY_DIR = "history";
const REQUEST_TIMEOUT_MS = 20000;
const AGENT_TIMEOUT_MS = 120000;
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
};

const DEFAULT_STATE = {
  view: "trending",
  settings: { ...DEFAULT_SETTINGS },
  repos: [],
  dropped: [],
  isFirstRun: true,
  loadedAt: null,
  source: "",
  parseError: "",
  httpError: "",
  errorKind: "",
  loading: false,
  loaded: false,
  digest: "",
  digestTruncated: false,
  digestIncluded: 0,
  digestTotal: 0,
  generating: false,
  engines: [],
  engineModels: [],
  modelsLoading: false,
  modelsError: "",
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
  const next = prev.then(
    () => writeSnapshotOnce(ctx, rel, period, language, repos),
    () => writeSnapshotOnce(ctx, rel, period, language, repos),
  );
  snapshotLocks.set(rel, next.catch(() => {}));
  try {
    await next;
  } finally {
    if (snapshotLocks.get(rel) === next || snapshotLocks.get(rel) === undefined) snapshotLocks.delete(rel);
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

  set({ loading: true, httpError: "", parseError: "", errorKind: "" });

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
    parseError: "",
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

async function resolveWorkspace(ctx, settings) {
  const configured = String(settings.workspacePath || "").trim();
  if (configured) return configured;
  try {
    const rows = await ctx.workspaces.list();
    const first = (Array.isArray(rows) ? rows : []).find(
      (row) => row && typeof row.path === "string" && row.path.trim(),
    );
    if (first) return first.path;
  } catch {
    /* 没有工作区授权或列表为空都走下面的失败路径 */
  }
  return "";
}

async function loadEngines(ctx) {
  set({ modelsLoading: true, modelsError: "" });
  try {
    const engines = await ctx.models.listEngines();
    const list = (Array.isArray(engines) ? engines : []).filter(
      (e) => e && typeof e.id === "string" && e.enabled !== false,
    );
    set({ engines: list, modelsLoading: false });
    const chosen = store.snap.settings.engine || (list[0] && list[0].id) || "";
    if (chosen) await loadModels(ctx, chosen);
  } catch (error) {
    // 「读不到引擎列表」和「一个引擎都没装」是两回事，提示不能混。
    set({
      engines: [],
      engineModels: [],
      modelsLoading: false,
      modelsError: "读取引擎列表失败：" + messageOf(error),
    });
  }
}

async function loadModels(ctx, engine) {
  if (!engine) {
    set({ engineModels: [] });
    return;
  }
  try {
    const workspace = await resolveWorkspace(ctx, store.snap.settings);
    const catalog = await ctx.models.listEngineModels(engine, workspace || undefined);
    const models = (catalog && Array.isArray(catalog.models) ? catalog.models : [])
      .map((m) => (typeof m === "string" ? m : m && m.id))
      .filter((m) => typeof m === "string" && m);
    set({ engineModels: models });
  } catch {
    set({ engineModels: [] });
  }
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
 */
function interruptSession(session, interruptRun) {
  if (!session || !session.cancelled || !session.runId || session.interrupted) return;
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

/** 停止当前解读：无论它处于「准备中」「start 在飞」还是「流式中」。 */
function abortDigest(ctx) {
  digestSeq += 1;
  const session = activeDigest;
  if (session) session.cancelled = true;
  disposeSession(session, (runId) => ctx.agent.interrupt(runId));
  set({ generating: false });
}

/** 兼容旧调用名。 */
function stopDigest(ctx) {
  abortDigest(ctx);
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
  if (!workspace) return bailed("还没有可用工作区：请先在设置里填写 agent 的工作区路径");

  // 中央页签不会先打开设置页，引擎列表要在这里按需补一次。
  if (store.snap.engines.length === 0) {
    await loadEngines(ctx);
    if (seq !== digestSeq || session.cancelled) return bailed("");
  }

  const engine = String(settings.engine || (store.snap.engines[0] && store.snap.engines[0].id) || "").trim();
  if (!engine) {
    return bailed(store.snap.modelsError || "没有可用引擎，请先在设置里选择");
  }

  let queued = [];
  let text = "";

  const finish = (error, value) => {
    if (session.settled) return;
    disposeSession(session, null);
    if (seq !== digestSeq) return;
    if (error) {
      set({ generating: false, httpError: messageOf(error) });
      return;
    }
    set({ generating: false, digest: value });
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
      model: settings.model || undefined,
      workspacePath: workspace,
      prompt: built.prompt,
      readOnly: true,
    });
    const runId = started && started.runId ? started.runId : null;
    session.runId = runId;

    // 用户在 start 期间点了停止 / 切了视图 / 卸载了插件：这一轮已经作废，
    // 但宿主的进程刚起来，必须当场打断。
    if (session.cancelled || seq !== digestSeq) {
      session.cancelled = true;
      interruptSession(session, (id) => ctx.agent.interrupt(id));
      releaseSession(session);
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
  if (row.isNew) return "新";
  const delta = row.rankDelta;
  if (!Number.isFinite(delta) || delta === 0) return "";
  return delta > 0 ? "↑" + delta : "↓" + Math.abs(delta);
}

function RepoRow({ row }) {
  const h = appCtx.react.createElement;
  const href = safeHref(row.url);
  const movement = movementLabel(row);

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
              h("span", { className: "gt-repo-owner" }, row.owner + " /"),
              h("span", { className: "gt-sep" }, " "),
              row.name,
            )
          : h("span", { className: "gt-repo" }, row.repo),
        movement
          ? h("span", { className: "gt-move" + (row.isNew ? " gt-move--new" : "") }, movement)
          : null,
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
    ),
  );
}

function Toolbar({ snap, ctx }) {
  const h = appCtx.react.createElement;
  // 切视图/时间档会让榜单换掉，正在生成的解读说的是旧榜单，必须一并停掉，
  // 否则旧轮次的 delta 会继续写进新视图，而且宿主那侧还在烧 token。
  const onView = (view) => {
    if (view === snap.view) return;
    if (snap.generating) stopDigest(ctx);
    set({ view, digest: "", dropped: [], isFirstRun: true, repos: [], loaded: false });
    void refresh(ctx, { force: true });
  };
  const onPeriod = (period) => {
    if (period === snap.settings.period) return;
    if (snap.generating) stopDigest(ctx);
    setSettings({ period });
    void persistSettings(ctx, { period });
    set({ loaded: false, repos: [], digest: "", dropped: [] });
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
      h(
        "button",
        {
          type: "button",
          className: "gt-btn",
          onClick: () => void refresh(ctx, { force: true }),
          disabled: snap.loading,
        },
        snap.loading ? "刷新中…" : "刷新",
      ),
      h(
        "button",
        {
          type: "button",
          className: "gt-btn gt-btn--primary",
          onClick: () => (snap.generating ? stopDigest(ctx) : void generateDigest(ctx)),
          disabled: snap.loading || snap.repos.length === 0,
        },
        snap.generating ? "停止生成" : "生成解读",
      ),
      h("button", { type: "button", className: "gt-btn", onClick: () => ctx.ui.openSettings() }, "设置"),
    ),
  );
}

function StatusLine({ snap }) {
  const h = appCtx.react.createElement;
  if (snap.loading) return h("p", { className: "gt-notice" }, "正在抓取 GitHub…");
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
  return h(
    "p",
    { className: "gt-notice" },
    snap.view === "rising" ? "近 7 天新建的高增长仓库" : "GitHub Trending · " + snap.settings.period,
    snap.view === "trending" && snap.settings.language ? " · " + snap.settings.language : "",
    snap.isFirstRun ? " · 首次抓取，下次刷新可看到排名变化" : "",
  );
}

function DigestPanel({ snap }) {
  const h = appCtx.react.createElement;
  if (!snap.generating && !snap.digest) return null;
  const note = snap.digestTruncated
    ? "事实过长，已截断（" + snap.digestIncluded + "/" + snap.digestTotal + "）"
    : "";
  return h(
    "section",
    { className: "gt-digest", "aria-live": "polite" },
    h("header", { className: "gt-digest-head" }, h("h3", null, "解读"), note ? h("span", { className: "gt-stamp" }, note) : null),
    h("pre", { className: "gt-digest-body" }, snap.digest || "…"),
    snap.digest && !snap.generating ? h("p", { className: "gt-notice" }, "解读只在本机显示，未写入任何文件。") : null,
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
        ? h("ol", { className: "gt-list" }, snap.repos.map((row) => h(RepoRow, { key: row.repo, row })))
        : !snap.loading && snap.loaded
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

function field(h, label, control, hint) {
  return h(
    "label",
    { className: "gt-field" },
    h("span", { className: "gt-field-label" }, label),
    control,
    hint ? h("span", { className: "gt-field-hint" }, hint) : null,
  );
}

function SettingsSection() {
  const h = appCtx.react.createElement;
  const ctx = appCtx;
  const snap = useSnap();

  appCtx.react.useEffect(() => {
    if (snap.engines.length === 0) void loadEngines(ctx);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = (patch) => void persistSettings(ctx, patch);

  const engineOptions = snap.engines.length
    ? snap.engines
    : [
        {
          id: "",
          name: snap.modelsLoading
            ? "读取引擎列表中…"
            : snap.modelsError || "（没有可用引擎）",
        },
      ];
  const modelOptions = snap.engineModels.length ? snap.engineModels : [""];

  return h(
    "div",
    { className: "gt-settings" },
    h("h3", null, "显示"),
    field(
      h,
      "默认时间档",
      h(
        "select",
        {
          className: "gt-input",
          value: snap.settings.period,
          onChange: (e) => save({ period: e.target.value }),
        },
        PERIODS.map((p) => h("option", { key: p.key, value: p.key }, p.label)),
      ),
    ),
    field(
      h,
      "语言筛选",
      h("input", {
        className: "gt-input",
        value: snap.settings.language,
        placeholder: "留空 = 全部语言，例如 python",
        onBlur: (e) => save({ language: e.target.value.trim().toLowerCase() }),
        onChange: (e) => setSettings({ language: e.target.value }),
      }),
      "对应 github.com/trending/<语言>，填英文语言名；离开输入框后保存。",
    ),
    field(
      h,
      "新星库 star 阈值",
      h("input", {
        className: "gt-input",
        type: "number",
        min: 1,
        value: snap.settings.minStars,
        onChange: (e) => setSettings({ minStars: normaliseMinStars(e.target.value) }),
        onBlur: (e) => save({ minStars: normaliseMinStars(e.target.value) }),
      }),
      "近 7 天创建、star 不少于该值的仓库。",
    ),

    h("h3", null, "解读"),
    field(
      h,
      "引擎",
      h(
        "select",
        {
          className: "gt-input",
          value: snap.settings.engine,
          onChange: (e) => {
            const engine = e.target.value;
            save({ engine, model: "" });
            void loadModels(ctx, engine);
          },
        },
        engineOptions.map((e) => h("option", { key: e.id, value: e.id }, e.name || e.id)),
      ),
    ),
    field(
      h,
      "模型",
      h(
        "select",
        {
          className: "gt-input",
          value: snap.settings.model,
          onChange: (e) => save({ model: e.target.value }),
        },
        modelOptions.map((m) => h("option", { key: m, value: m }, m || "（引擎默认）")),
      ),
      snap.modelsLoading ? "读取模型列表中…" : "",
    ),
    field(
      h,
      "agent 工作区",
      h("input", {
        className: "gt-input",
        value: snap.settings.workspacePath,
        placeholder: "留空 = 侧栏第一个工作区",
        onBlur: (e) => save({ workspacePath: e.target.value.trim() }),
        onChange: (e) => setSettings({ workspacePath: e.target.value }),
      }),
      "只作为 agent 进程的工作目录，解读内容来自当前榜单，不读该目录里的文件。",
    ),

    h("h3", null, "网络"),
    field(
      h,
      "GitHub Token（可选）",
      h("input", {
        className: "gt-input",
        type: "password",
        value: snap.settings.token,
        placeholder: "仅用于新星库搜索，提高限流额度",
        onBlur: (e) => save({ token: e.target.value.trim() }),
        onChange: (e) => setSettings({ token: e.target.value }),
      }),
      "不填也能用：未认证时搜索接口 10 次/分钟。Token 只存本机插件数据，只发给 api.github.com。",
    ),
    h("p", { className: "gt-settings-foot" }, "版本 " + ctx.version + " · 只访问 github.com 与 api.github.com"),
  );
}

/* ---------- CSS ---------- */

const CSS = `
.gt-root {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  gap: 10px;
  padding: 16px 18px 0;
  color: var(--text-primary, inherit);
  container-type: inline-size;
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
  border: 1px solid var(--separator-border, rgba(127,127,127,0.28));
  background: transparent;
  color: inherit;
  cursor: pointer;
  transition: background-color 120ms ease, border-color 120ms ease;
}
.gt-chip:hover, .gt-btn:hover { background: var(--background-secondary-hover, rgba(127,127,127,0.12)); }
.gt-chip--on {
  background: var(--background-secondary-hover, rgba(127,127,127,0.16));
  border-color: var(--border-focus-ring, currentColor);
  font-weight: 600;
}
.gt-btn--primary { border-color: var(--border-focus-ring, currentColor); font-weight: 600; }
.gt-chip:disabled, .gt-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.gt-chip:focus-visible, .gt-btn:focus-visible, .gt-input:focus-visible, .gt-repo:focus-visible {
  outline: 2px solid var(--border-focus-ring, currentColor);
  outline-offset: 2px;
}
.gt-stamp { font-size: 11px; opacity: 0.55; white-space: nowrap; }
.gt-notice { margin: 0; font-size: 12px; opacity: 0.7; }
.gt-notice--error { color: var(--text-error-primary, #c0392b); opacity: 1; display: flex; gap: 6px; flex-wrap: wrap; }
.gt-notice-hint { opacity: 0.7; }
.gt-scroll { flex: 1; min-height: 0; overflow-y: auto; padding-bottom: 18px; }
.gt-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.gt-row {
  display: flex; gap: 10px; padding: 9px 10px; border-radius: 9px;
  border: 1px solid transparent; transition: background-color 120ms ease, border-color 120ms ease;
}
.gt-row:hover { background: var(--background-secondary-hover, rgba(127,127,127,0.09)); border-color: var(--separator-border, rgba(127,127,127,0.2)); }
.gt-row-main { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 3px; }
.gt-row-title { display: flex; align-items: baseline; gap: 7px; flex-wrap: wrap; }
.gt-rank { font-size: 11px; min-width: 16px; opacity: 0.42; font-variant-numeric: tabular-nums; }
.gt-repo { font-size: 13.5px; font-weight: 600; text-decoration: none; color: inherit; word-break: break-all; }
.gt-repo:hover { text-decoration: underline; }
.gt-repo-owner { font-weight: 400; opacity: 0.6; }
.gt-sep { white-space: pre; }
.gt-move { font-size: 10.5px; padding: 1px 5px; border-radius: 5px; background: var(--background-secondary-default, rgba(127,127,127,0.14)); opacity: 0.8; font-variant-numeric: tabular-nums; }
.gt-move--new { background: var(--accent-300, rgba(46,160,67,0.2)); font-weight: 600; opacity: 1; }
.gt-desc { margin: 0; font-size: 12.5px; line-height: 1.55; opacity: 0.75; }
.gt-meta { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; font-size: 11.5px; opacity: 0.66; }
.gt-lang { display: inline-flex; align-items: center; gap: 5px; }
.gt-dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; opacity: 0.8; display: inline-block; }
.gt-gain { font-variant-numeric: tabular-nums; }
.gt-stat { font-variant-numeric: tabular-nums; }
.gt-empty { font-size: 12.5px; opacity: 0.6; padding: 24px 4px; }
.gt-dropped { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--separator-border, rgba(127,127,127,0.2)); }
.gt-dropped h3 { margin: 0 0 4px; font-size: 12px; font-weight: 600; opacity: 0.7; }
.gt-dropped p { margin: 0; font-size: 12px; opacity: 0.6; word-break: break-all; }
.gt-digest { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--separator-border, rgba(127,127,127,0.2)); }
.gt-digest-head { display: flex; align-items: baseline; gap: 10px; }
.gt-digest h3 { margin: 0 0 6px; font-size: 13px; font-weight: 600; }
.gt-digest-body {
  margin: 0; white-space: pre-wrap; word-break: break-word;
  font: inherit; font-size: 13px; line-height: 1.7;
}
.gt-settings { display: flex; flex-direction: column; gap: 14px; max-width: 560px; }
.gt-settings h3 { margin: 6px 0 0; font-size: 13px; font-weight: 600; opacity: 0.8; }
.gt-field { display: flex; flex-direction: column; gap: 5px; }
.gt-field-label { font-size: 12.5px; font-weight: 500; }
.gt-field-hint { font-size: 11.5px; opacity: 0.6; line-height: 1.5; }
.gt-input {
  font: inherit; font-size: 13px; padding: 7px 9px; border-radius: 7px;
  border: 1px solid var(--separator-border, rgba(127,127,127,0.3));
  background: var(--background-primary-default, transparent); color: inherit;
}
.gt-settings-foot { font-size: 11.5px; opacity: 0.5; margin: 4px 0 0; }
@container (max-width: 520px) {
  .gt-group--end { margin-left: 0; width: 100%; }
  .gt-row { padding: 8px 6px; }
}
`;

/* ---------- 激活 ---------- */

export default function activate(ctx) {
  appCtx = ctx;
  const mySeq = ++activateSeq;

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
    icon: (props) =>
      ctx.react.createElement(
        "svg",
        Object.assign({}, THIN_ICON, props && props.className ? { className: props.className } : {}),
        ctx.react.createElement("path", { d: "M8 1.8v5.4l3.6 2.1" }),
        ctx.react.createElement("circle", { cx: 8, cy: 8, r: 6.2 }),
      ),
    component: MainTab,
  });

  const sideDisposer = ctx.ui.registerSidebarNav({
    key: "main",
    label: () => "每日热点",
    icon: (props) =>
      ctx.react.createElement(
        "svg",
        Object.assign({}, THIN_ICON, props && props.className ? { className: props.className } : {}),
        ctx.react.createElement("path", { d: "M8 1.8v5.4l3.6 2.1" }),
        ctx.react.createElement("circle", { cx: 8, cy: 8, r: 6.2 }),
      ),
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
        set({ settings: merged });
      }
    } catch {
      /* 用默认设置 */
    }
    await pruneHistory(ctx);
  })();

  const dispose = () => {
    activateSeq += 1;
    genSeq += 1;
    digestSeq += 1;
    const session = activeDigest;
    if (session) session.cancelled = true;
    disposeSession(session, (runId) => ctx.agent.interrupt(runId));
    try {
      cssDisposer();
    } catch {
      /* 忽略 */
    }
    set({
      generating: false,
      loading: false,
      digest: "",
      repos: [],
      loaded: false,
      httpError: "",
    });
  };

  return dispose;
}
