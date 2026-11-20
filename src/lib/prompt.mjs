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
    "- 只依据上面的「榜单事实」；事实里没有的信息不要编造，也不要猜技术细节。",
    "- 不要复述榜单，不要用「首先/其次/总之」这类填充词。",
    "- 用 Markdown，但不要写一级标题（不要用 `#`）。",
    "",
    "按这个结构写：",
    "",
    "### 今天在热什么",
    "3-5 句总体判断：哪个方向在升温、有没有共同的技术主题。",
    "",
    "### 值得看的项目",
    "用一个 Markdown 表格，5-8 行，列固定为：",
    "| 仓库 | 方向 | 解决什么问题 | 适合谁 |",
    "每格一句话，仓库名写成 `owner/repo`。不要加评分、不要加星级数字（上面的事实里已有）。",
    "",
    "### 一句话结论",
    "一行，说明今天最值得点开的那一个，以及为什么。",
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

/**
 * 单个仓库的讨论 prompt。
 *
 * 与解读的区别不只是范围：讨论是**一次真正的会话**，用户会接着追问，所以
 * prompt 必须交代清楚「上下文只有这些」和「怎么拿到代码」两件事。否则模型
 * 会拿一句榜单描述开始猜代码结构。
 *
 * @param {object} input
 * @param {object} input.row 榜单里的那一行
 * @param {"trending"|"rising"} input.view
 * @param {string} input.period
 * @param {string} input.language
 * @returns {string}
 */
export function buildDiscussPrompt(input) {
  const row = (input && input.row) || {};
  const repo = String(row.repo || "").trim() || "这个仓库";
  const url = repo.indexOf("/") > 0 ? "https://github.com/" + repo : "";
  const scope =
    input.view === "rising"
      ? "近 7 天新建且 star 增长快的新仓库（GitHub Search）"
      : "GitHub Trending " + (input.period || "daily") + " 榜" + (input.language ? "（" + input.language + "）" : "");

  const facts = [];
  if (row.description) facts.push("- 简介：" + clip(row.description, 400));
  if (row.language) facts.push("- 主要语言：" + row.language);
  if (Number.isFinite(row.stars)) facts.push("- 总 star：" + row.stars);
  if (Number.isFinite(row.gain)) facts.push("- 近期增长：+" + row.gain + "/" + (row.gainPeriod || "recent"));
  if (Number.isFinite(row.rank)) facts.push("- 当前名次：" + row.rank + "（" + scope + "）");
  if (Number.isFinite(row.ageDays)) facts.push("- 仓库创建于 " + row.ageDays + " 天前");
  if (row.isNew) facts.push("- 本次新上榜");
  else if (Number.isFinite(row.rankDelta) && row.rankDelta !== 0) {
    facts.push("- 较上次" + (row.rankDelta > 0 ? "上升 " : "下降 ") + Math.abs(row.rankDelta) + " 位");
  }

  return [
    "我想认真了解一下这个项目，先帮我弄清楚它是什么、值不值得投入时间。",
    "",
    "## 仓库",
    repo,
    url,
    // 来源单独一行，不依附于「名次」：新星库没有名次，但它同样是榜单来的，
    // 模型需要知道自己在看什么范围的数据。
    "来源：" + scope,
    "",
    "## 我这边已知的事实",
    facts.length > 0 ? facts.join("\n") : "- （榜单里只有仓库名，没有更多信息）",
    "",
    "## 你要做的",
    "1. 先在这个工作目录里找有没有这个仓库的本地副本（按仓库名，比如 `" + repo + "` 或只有后半段的目录）。",
    "   找得到就直接读代码，结论以代码为准。",
    "   找不到就读远程仓库（README、目录结构、最近的 release/issue），并在开头用一句话说明「没找到本地代码，以下基于远程信息」。",
    "2. 用自己的话讲清楚：它解决什么问题、核心机制是什么、和同类项目比区别在哪。",
    "3. 给一个明确的判断：什么人适合用、什么情况下不适合。",
    "",
    "## 格式",
    "- 中文，术语保留英文原文。",
    "- 用 Markdown，不要写一级标题。",
    "- 结论要有依据。凡是推测而不是从代码或文档里读到的，明确标成「推测」，不要编造 API、参数、性能数字。",
    "- 最后一行给我一个「下一步」建议（比如读哪个文件、跑什么命令验证）。",
  ].join("\n");
}
