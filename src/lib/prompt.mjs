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
export function buildDigestPrompt(input, budget = DEFAULT_BUDGET) {
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
