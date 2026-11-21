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
export function prepareReadme(text) {
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
export function truncateReadme(text, limit = README_PREVIEW_LIMIT) {
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
export function readmeTextFromBody(body) {
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
