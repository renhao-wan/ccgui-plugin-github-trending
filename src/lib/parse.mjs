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
export function parseTrending(html) {
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
