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
function boardItem(row, showAge = true) {
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
  // 「随便看看」是随机批次/搜索结果，「X 天前创建」在这里只是噪音。
  if (showAge && Number.isFinite(row.ageDays)) meta.push(row.ageDays + " 天前创建");

  // 续行缩进两个空格：无序列表的续行在 CommonMark 里就是这个宽度。
  return meta.length > 0 ? [first, "  " + meta.join(" · ")] : [first];
}

/**
 * @param {object} input
 * @param {"trending"|"rising"|"browse"} input.view
 * @param {string} input.period  daily|weekly|monthly
 * @param {string} input.language 空字符串 = 全部语言
 * @param {string} [input.scopeText] 覆盖默认范围说明（「随便看看」用：随机抽样/搜索结果）
 * @param {Array<object>} input.rows
 * @param {Array<object>} input.dropped
 * @param {string} input.capturedAt 已格式化好的抓取时间（由调用方负责本地化）
 * @returns {string} Markdown 文本；没有可导出的行时返回空串
 */
export function buildBoardMarkdown(input) {
  const rows = Array.isArray(input && input.rows) ? input.rows : [];
  const dropped = Array.isArray(input && input.dropped) ? input.dropped : [];
  const items = rows.map((row) => boardItem(row, input.view !== "browse")).filter((lines) => lines.length > 0);
  if (items.length === 0) return "";

  const scope =
    String((input && input.scopeText) || "").trim() ||
    (input.view === "rising"
      ? "近 7 天新星库"
      : "GitHub Trending · " + (BOARD_PERIOD_LABEL[input.period] || input.period || "今日"));
  const heading =
    "# 每日热点 · " + scope + (input.view === "trending" && input.language ? " · " + input.language : "");

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
