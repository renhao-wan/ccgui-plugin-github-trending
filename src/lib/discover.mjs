/**
 * 「随便看看」：换一批随机热门 + 按仓库名搜索。纯函数，不碰网络。
 *
 * 为什么需要这一层而不是直接拼 URL：GitHub Search 的硬约束必须在纯函数里
 * 表达出来，否则 UI 会写出「看起来能随机、其实每次都一样」的东西。
 *
 * 硬约束（2026-11 实测）：
 * - `sort` 只有 stars / forks / updated / best-match，**没有 random**；
 * - 任何查询最多只能翻到前 1000 条，第 35 页（per_page=30）返回
 *   422 `Only the first 1000 search results are available`；
 * - 超出 `total_count` 的页码返回 200 + 空 items，而不是报错。
 *
 * 所以「随机」只能是伪随机：每次做一次随机档位 + 随机页（第 1..10 页，
 * 稳稳落在 1000 条上限内）。各 star 档的仓库池差异很大（实测
 * `stars:1000..3000` 约 4 万、`stars:>50000` 只有 531），混档抽的体感
 * 会明显比只在「前 N 名」里抽好——后者永远是大名鼎鼎的那几十个。
 */

/** 抽样档位：从「有点名气」到「公认名作」，避免每批都是同一批头部仓库。 */
export const STAR_BANDS = [
  { min: 300, max: 1000 },
  { min: 1000, max: 3000 },
  { min: 3000, max: 10000 },
  { min: 10000, max: 50000 },
  { min: 50000, max: 0 }, // max=0 表示无上界
];

/** 每批条数。和 New 星库保持一致，25 行不会把页签撑得太长。 */
export const DISCOVER_PAGE_SIZE = 25;
/**
 * 最多翻到第几页。
 *
 * `per_page=25` 时第 40 页正好是第 1000 条，但为了给「换一批」留出真实
 * 差异，只取前 10 页（250 名以内）；这一档既在配额内，也足够每批都不重样。
 */
export const DISCOVER_MAX_PAGE = 10;

function clampInt(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * 生成一批抽样的请求参数。
 *
 * @param {() => number} [rand] 注入随机源，便于单测得到确定结果
 * @param {{ band: object, page: number }|null} [avoid] 上一批的组合；撞上就重抽，
 *   否则「换一批」偶尔抽回同一批而界面毫无变化，用户会以为按钮坏了。
 * @returns {{ q: string, sort: string, order: string, perPage: number, page: number, band: object }}
 */
export function buildDiscoverQuery(rand = Math.random, avoid = null) {
  const r = typeof rand === "function" ? rand : Math.random;
  const draw = () => {
    const idx = clampInt(Math.floor(r() * STAR_BANDS.length), 0, STAR_BANDS.length - 1);
    return {
      band: STAR_BANDS[idx],
      page: clampInt(Math.floor(r() * DISCOVER_MAX_PAGE) + 1, 1, DISCOVER_MAX_PAGE),
    };
  };
  const last = avoid && typeof avoid === "object" ? avoid : null;
  let pick = draw();
  // 组合只有 档位数 × 页数 种；最多试 8 次，撞不上就认（随机源坏掉时不会死循环）。
  if (last) {
    for (let i = 0; i < 8 && pick.band === last.band && pick.page === last.page; i += 1) pick = draw();
  }
  const stars = pick.band.max > 0
    ? "stars:" + pick.band.min + ".." + pick.band.max
    : "stars:>" + pick.band.min;
  return {
    // 排除 fork 与归档仓：这两类占了热门搜结果的一大半，抽进来只会显得噪音。
    q: stars + " fork:false archived:false",
    sort: "stars",
    order: "desc",
    perPage: DISCOVER_PAGE_SIZE,
    page: pick.page,
    band: pick.band,
  };
}

/**
 * 组装 Search API 的 URL。
 *
 * @param {{ q: string, sort: string, order: string, perPage: number, page: number }} spec
 * @returns {string}
 */
export function discoverUrl(spec) {
  const s = spec || {};
  const params = [
    "q=" + encodeURIComponent(String(s.q || "")),
    "sort=" + encodeURIComponent(String(s.sort || "stars")),
    "order=" + encodeURIComponent(String(s.order || "desc")),
    "per_page=" + clampInt(s.perPage, 1, 100),
    "page=" + clampInt(s.page, 1, 100),
  ];
  return "https://api.github.com/search/repositories?" + params.join("&");
}

/**
 * 搜索词上限：GitHub 的 query 过长会被网关拒掉（414），状态行也放不下。
 * 仓库名的实际长度远小于它，正常输入不会被截断。
 */
export const SEARCH_TERM_LIMIT = 80;

/**
 * 把用户在搜索框里打的字变成 q。
 *
 * 只搜仓库名（用户选的）：`in:name`。输入必须被**当成字面量**：直接把用户
 * 输入拼进查询语法，等于允许他写 `stars:>100000`、`language:rust` 这类限定符，
 * 那不是「搜索仓库名」，结果也会让他看不懂。所以先去掉 `:`（限定符语法）、
 * 引号与反斜杠（转义/短语语法），再折叠空白并限长。
 *
 * @param {string} term
 * @returns {string|null} 空输入返回 null（调用方据此回到「换一批」）
 */
export function buildSearchQuery(term) {
  const cleaned = String(term === undefined || term === null ? "" : term)
    // 换行/制表等控制字符会破坏查询，先去成空格。
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    // 限定符与转义语法：去掉冒号/引号/反斜杠，`stars:>100` 就只剩字面量。
    .replace(/[:"\\]/g, " ")
    // 布尔运算符是查询语法的一部分，不当作仓库名。
    .replace(/\b(?:OR|AND|NOT)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, SEARCH_TERM_LIMIT)
    .trim();
  if (!cleaned) return null;
  // GitHub 的搜索把 `/` 当语法分隔，用户想找 owner/repo 时只取该按名字匹配。
  // 保留它即可——`in:name` 下 "owner/repo" 会命中 full_name。
  return cleaned + " in:name fork:false archived:false";
}

/** 搜索结果的排序用 stars，用户搜名字时想要的多半是「最出名的那个」。 */
export function buildSearchSpec(term) {
  const q = buildSearchQuery(term);
  if (!q) return null;
  return { q, sort: "stars", order: "desc", perPage: DISCOVER_PAGE_SIZE, page: 1 };
}

/**
 * 这条结果是不是用户要找的那个仓库。
 *
 * 只用于给精确命中加一枚「就是它」的标记：GitHub 的 `in:name` 是模糊匹配，
 * 搜 `react` 会先返回 `facebook/react-native` 这类。**不排序、不过滤**——
 * 用户可能就是想找模糊的，标记只是帮他一眼定位。
 *
 * @param {object} row
 * @param {string} term
 * @returns {boolean}
 */
export function isExactNameMatch(row, term) {
  const want = String(term === undefined || term === null ? "" : term).trim().toLowerCase();
  if (!want) return false;
  const full = String((row && row.repo) || "").toLowerCase();
  const given = String((row && row.name) || "").toLowerCase();
  const slash = full.indexOf("/");
  const name = given || (slash > 0 ? full.slice(slash + 1) : full);
  if (!name) return false;
  // 输入 owner/repo 时整串匹配，输入 repo 时只看名字段。
  return name === want || full === want;
}

/** 档位说明里用的数字写法：1000 → 1k，50000 → 50k。 */
function bandNum(n) {
  if (!Number.isFinite(n)) return "";
  if (n >= 1000) return (n / 1000).toFixed(n % 1000 === 0 ? 0 : 1).replace(/\.0$/, "") + "k";
  return String(n);
}

/** 档位的人类可读说明，给状态行用（「★1k–3k」）。 */
export function bandLabel(band) {
  if (!band || !Number.isFinite(band.min)) return "";
  if (!(band.max > 0)) return "★" + bandNum(band.min) + " 以上";
  return "★" + bandNum(band.min) + "–" + bandNum(band.max);
}

/**
 * 把 Search 结果改成「随便看看」语境的行。
 *
 * `parseRising` 会把 star 数塞进 `gain`——对「新星库」是「7 天涨了多少」的
 * 近似，但在这里它就是总数本身，照搬会渲染成「+322k star」，看着像今天涨的。
 * 这里把假的增量抹掉；排名、涨跌同理（这批本来就是随机抽的，没有前后可比）。
 *
 * @param {Array<object>} rows parseRising 的输出
 * @returns {Array<object>}
 */
export function shapeDiscoverRows(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => row && typeof row === "object" && typeof row.repo === "string" && row.repo.indexOf("/") > 0)
    .map((row) => ({ ...row, gain: null, gainPeriod: "", rank: null, rankDelta: null, isNew: false }));
}
