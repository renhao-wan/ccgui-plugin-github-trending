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

/** 代码围栏行（``` 或 ~~~）。行内的反引号不在此列：只认行首。 */
const FENCE_LINE = /^\s*(```+|~~~+)/;

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
 * `<br>`、`<hr>` 这类无内容的换成换行，块级结束标签也换成换行，
 * 避免 `<summary>a</summary>b` 被粘成 `ab`。
 */
function stripHtmlTags(text) {
  return String(text || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<hr\s*\/?>/gi, "\n\n")
    .replace(/<\/(p|div|li|ul|ol|summary|details|h[1-6]|tr|td|th|blockquote|section|article|table)\s*>/gi, "\n")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\/?[a-zA-Z][^>]*>/g, "");
    // 只删「看起来是标签」的：`a < b` 里的 `<` 后面不是字母，不会被误删。
}

/**
 * 只对**行内代码之外**的文字跑 fn。
 *
 * `Use \`<T>\` generics.` 里的尖括号是代码，去标签会把内容整段删掉。
 * 做法：先把行内代码换成占位符，跑完 fn 再原样换回来。
 *
 * @param {string} text
 * @param {(chunk: string) => string} fn
 * @returns {string}
 */
function mapInlineCode(text, fn) {
  const parts = [];
  const masked = String(text || "").replace(/`[^`\n]*`/g, (whole) => {
    parts.push(whole);
    return "\u0000" + (parts.length - 1) + "\u0000";
  });
  const out = String(fn(masked));
  return out.replace(/\u0000(\d+)\u0000/g, (whole, i) => {
    const hit = parts[Number(i)];
    return hit === undefined ? whole : hit;
  });
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
 * 只对**代码围栏之外**的行跑 fn，围栏内的内容逐字保留。
 *
 * 为什么必须分段：`Array<string>`、`Vec<T>`、代码块里的 `![alt](url)` 都是
 * 合法代码，却被去标签/去图片的正则当成 HTML 与图片删掉——Rust / C++ / TS
 * 项目的 README 开头恰好全是这类代码。README 预览的价值就在这些代码上。
 *
 * @param {string} text
 * @param {(chunk: string) => string} fn
 * @returns {string}
 */
function mapOutsideFences(text, fn) {
  const lines = String(text || "").split("\n");
  const out = [];
  let plain = [];
  let fence = ""; // 当前开启围栏的标记（``` / ~~~），空串 = 围栏外
  const flush = () => {
    if (plain.length === 0) return;
    out.push(...String(fn(plain.join("\n"))).split("\n"));
    plain = [];
  };
  for (const line of lines) {
    const hit = FENCE_LINE.exec(line);
    if (hit) {
      const mark = hit[1];
      if (!fence) {
        flush();
        fence = mark;
      } else if (mark[0] === fence[0] && mark.length >= fence.length) {
        // 关闭围栏：同字符且不短于开启标记（CommonMark 的规则）
        fence = "";
      }
      out.push(line);
      continue;
    }
    if (fence) out.push(line);
    else plain.push(line);
  }
  flush();
  return out.join("\n");
}

/**
 * README 原文 → 可渲染的预览文本。
 * @param {string} text
 * @returns {string}
 */
export function prepareReadme(text) {
  if (!text) return "";
  const body = mapOutsideFences(stripFrontmatter(String(text)), (chunk) =>
    // 行内代码里的 `<T>`、`![x](y)` 也属于代码，一并保护。
    mapInlineCode(chunk, (masked) => stripHtmlTags(stripBadgesAndImages(masked))),
  );
  return tidyWhitespace(body);
}

/**
 * 找出代码围栏区间，偏移量以字符计。末尾未闭合的那一处 `end = Infinity`。
 * 用于两件事：断点别落在代码块里、硬切之后补闭合。
 */
function fenceSpans(text) {
  const spans = [];
  let offset = 0;
  let open = null;
  for (const line of String(text || "").split("\n")) {
    const hit = FENCE_LINE.exec(line);
    if (hit) {
      const mark = hit[1];
      if (!open) open = { start: offset, mark };
      else if (mark[0] === open.mark[0] && mark.length >= open.mark.length) {
        spans.push({ start: open.start, end: offset + line.length, mark: open.mark });
        open = null;
      }
    }
    offset += line.length + 1;
  }
  if (open) spans.push({ start: open.start, end: Infinity, mark: open.mark });
  return spans;
}

/**
 * 按字符截断，并尽量在边界上停（换行 > 句号 > 硬切）。
 *
 * 在句子中间硬切会让「前 2000 字」读起来像断线；优先在最近的换行处收口，
 * 没有换行再退到句子边界，都没有才硬切。
 *
 * 代码块要特殊对待：切在 ``` 中间会让渲染器把后文全当成代码，所以断点只认
 * 围栏之外的位置；实在找不到就停在围栏开头；最后再兜一次未闭合围栏。
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
  const spans = fenceSpans(src);
  const inFence = (at) => spans.some((s) => at > s.start && at < s.end);

  const candidates = ["\n\n", "\n", "。", ". ", "；", "; "];
  let cut = -1;
  for (const sep of candidates) {
    let at = window.lastIndexOf(sep);
    // 落进代码块的断点不能用，接着往前找。
    while (at >= 0 && inFence(floor + at + sep.length)) at = at > 0 ? window.lastIndexOf(sep, at - 1) : -1;
    if (at >= 0) {
      cut = floor + at + sep.length;
      break;
    }
  }
  if (cut < 0) {
    // 候选断点全在代码块里：停在围栏开头，至少不产出半截代码。
    const nextFence = spans.find((s) => s.start > floor && s.start < max);
    cut = nextFence ? nextFence.start : max;
  }

  let out = src.slice(0, cut).trimEnd();
  // 兜底：硬切落在代码块中间时补一个闭合围栏，否则后文会被吞进代码块。
  const dangling = fenceSpans(out).find((s) => !Number.isFinite(s.end));
  if (dangling) out = out + "\n" + dangling.mark;
  return { text: out, truncated: true, total: src.length };
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
