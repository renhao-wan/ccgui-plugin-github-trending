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
  return {
    repo: full,
    owner: full.slice(0, slash),
    name: full.slice(slash + 1),
    url: typeof item.html_url === "string" ? item.html_url : "https://github.com/" + full,
    description: typeof item.description === "string" ? item.description.trim() : "",
    language: typeof item.language === "string" ? item.language : "",
    languageColor: "",
    stars: asCount(item.stargazers_count),
    forks: asCount(item.forks_count),
    gain: asCount(item.stargazers_count),
    gainPeriod: "rising",
    createdAt: created,
    ageDays: created ? Math.max(0, Math.floor((Date.now() - Date.parse(created)) / 86400000)) : null,
  };
}

/**
 * @param {unknown} payload Search API JSON
 * @returns {{ repos: Array<object>, error: string | null, message: string, total: number }}
 *   error 取值：bad_payload | rate_limited | no_items | null
 */
export function parseRising(payload) {
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

/** 设置里的阈值做一次收敛：既防 0 也防离谱值。 */
export function normaliseMinStars(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 50;
  return Math.min(100000, Math.max(1, Math.round(n)));
}

/** Search API 的 q：created 用「今天往前 N 天」的日期，必须带时间边界。 */
export function buildRisingQuery(minStars, days) {
  const span = Number.isFinite(Number(days)) ? Math.min(90, Math.max(1, Math.round(Number(days)))) : 7;
  const since = new Date(Date.now() - span * 86400000);
  const iso = since.toISOString().slice(0, 10);
  return "created:>" + iso + " stars:>=" + normaliseMinStars(minStars) + " fork:false archived:false";
}
