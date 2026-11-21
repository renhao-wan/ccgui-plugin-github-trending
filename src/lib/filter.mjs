/**
 * 榜单内本地筛选。纯函数，不碰网络。
 *
 * 为什么要有这一层：Trending 页面本身没有搜索，25 行只能靠浏览器的 Ctrl+F；
 * 而「今天有没有 Rust 相关的东西」是扫榜时最常问的问题。
 *
 * 只在**已加载的行**里做子串匹配：不发请求，也不改变榜单本身。所以它不会
 * 让某个仓库「消失」，随时把关键词清空就回来。
 */

/** 关键词上限：再长就不是「筛一眼」，而是在写查询语句了。 */
export const KEYWORD_LIMIT = 40;

/**
 * 收敛用户输入：控制字符折叠成空格、合并连续空白、限长。
 * 保留大小写——输入框要原样显示用户打的字。
 *
 * @param {unknown} raw
 * @returns {string}
 */
export function normaliseKeyword(raw) {
  return String(raw === undefined || raw === null ? "" : raw)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, KEYWORD_LIMIT)
    .trim();
}

/**
 * 一行里参与匹配的字段。
 *
 * 仓库名（owner/repo 与单独的名字）是用户最常输入的；描述与语言是「找方向」
 * 时最常输入的。不索引 star 数：那是筛选条件，不是关键词。
 *
 * @param {object} row
 * @returns {string}
 */
export function matchText(row) {
  if (!row || typeof row !== "object") return "";
  return [row.repo, row.name, row.description, row.language]
    .filter((v) => typeof v === "string" && v !== "")
    .join(" ")
    .toLowerCase();
}

/**
 * 按关键词过滤已加载的行。
 *
 * @param {Array<object>} rows
 * @param {unknown} keyword
 * @returns {Array<object>} 空关键词时原样返回同一个数组（调用方可能比较引用）
 */
export function filterRows(rows, keyword) {
  const list = Array.isArray(rows) ? rows : [];
  const want = normaliseKeyword(keyword).toLowerCase();
  if (!want) return list;
  return list.filter((row) => matchText(row).includes(want));
}

/**
 * 筛选是否真的生效了（有词、且列表里有东西）。
 * 界面据此决定要不要说「已筛选」。
 *
 * @param {unknown} keyword
 * @param {Array<object>} rows
 * @returns {boolean}
 */
export function isFiltering(keyword, rows) {
  return normaliseKeyword(keyword) !== "" && Array.isArray(rows) && rows.length > 0;
}

/**
 * 导出标题里的筛选说明。空关键词返回空串，调用方据此不加后缀。
 *
 * @param {unknown} keyword
 * @returns {string}
 */
export function filterScopeNote(keyword) {
  const want = normaliseKeyword(keyword);
  return want ? "已筛选「" + want + "」" : "";
}
