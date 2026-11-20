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

/** 星标/复刻数：锚点内容里夹着 svg path，只认 `</a>` 前的最后一段数字。 */
function countFromAnchor(article, slug, kind) {
  const re = new RegExp(
    'href="/' + escapeRegExp(slug) + "/" + kind + '"[\\s\\S]{0,2000}?([\\d,]+)\\s*</a>',
  );
  const m = article.match(re);
  return m ? toCount(m[1]) : null;
}

function pickSlug(headingHtml) {
  const re = /href="\/([^"\s/]+\/[^"\s/?]+)"/g;
  let m;
  while ((m = re.exec(headingHtml))) {
    const candidate = m[1];
    if (/^(sponsors|topics|collections|users|login|orgs)\//i.test(candidate)) continue;
    return candidate;
  }
  return null;
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
  const articles = html.match(/<article class="Box-row">[\s\S]*?<\/article>/g) || [];
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
    const gainMatch = article.match(/([\d,]+)\s+stars\s+(today|this week|this month)/);

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
