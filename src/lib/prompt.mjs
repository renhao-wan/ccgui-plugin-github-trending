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
  // 「随便看看」给的不是榜单：随机抽样/搜索结果之间没有排名与涨跌，
  // 照搬「按排名」「今天在热什么」会让模型把一批随机仓库写成趋势判断。
  const random = input.view === "browse";

  const scope = String((input && input.scopeText) || "").trim() ||
    (input.view === "rising"
      ? "近 7 天新建且 star 增长快的新仓库（GitHub Search）"
      : "GitHub Trending " + (input.period || "daily") + " 榜" + (input.language ? "（" + input.language + "）" : ""));

  const header = [
    random ? "你在为一位中文开发者挑 GitHub 上值得一看的项目。" : "你在为一位中文开发者解读今天的 GitHub 热点。",
    "",
    "## 数据范围",
    scope,
    "共 " + repos.length + " 个仓库" + (input.isFirstRun ? "（首次抓取，无历史对比）" : ""),
    "",
    random ? "## 这批仓库" : "## 榜单事实（按排名）",
  ];

  const footer = [
    "",
    "## 写作要求",
    "- 全文中文，术语保留英文原文。",
    "- 只依据上面的「" + (random ? "这批仓库" : "榜单事实") + "」；事实里没有的信息不要编造，也不要猜技术细节。",
    "- 不要复述榜单，不要用「首先/其次/总之」这类填充词。",
    "- 用 Markdown，但不要写一级标题（不要用 `#`）。",
    // 随机批次最容易被模型写成趋势判断，这条必须显式在场。
    ...(random ? ["- 这批不是排行榜：没有名次、没有涨跌，也不代表今天的热点。不要写「今天在热什么」这类趋势判断。"] : []),
    "",
    "按这个结构写：",
    "",
    random ? "### 这几个项目在做什么" : "### 今天在热什么",
    random
      ? "3-5 句：这批项目大致落在哪些方向、有没有共同的技术主题。用「这批里」而不是「今天」。"
      : "3-5 句总体判断：哪个方向在升温、有没有共同的技术主题。",
    "",
    "### 值得看的项目",
    "用一个 Markdown 表格，5-8 行，列固定为：",
    "| 仓库 | 方向 | 解决什么问题 | 适合谁 |",
    "每格一句话，仓库名写成 `owner/repo`。不要加评分、不要加星级数字（上面的事实里已有）。",
    "",
    "### 一句话结论",
    random
      ? "一行，说明这批里最值得点开的那一个，以及为什么。"
      : "一行，说明今天最值得点开的那一个，以及为什么。",
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
 * 讨论 prompt 的默认模板。
 *
 * 做成「模板 + 占位符」而不是一段写死的字符串：用户在设置里可以另存几份，
 * 决定的是**让模型干什么**（评估可投入性 / 找可借鉴的设计 / 当技术选型对比），
 * 而仓库事实永远由插件填，不需要用户每次自己抄一遍 star 数和名次。
 *
 * 占位符（写错不会炸，会原样留在 prompt 里，用户自己能看见）：
 *   {{repo}} {{url}} {{scope}} {{description}} {{language}} {{stars}}
 *   {{gain}} {{rank}} {{age}} {{facts}}
 */
export const DEFAULT_DISCUSS_TEMPLATE = [
  "我想认真了解一下这个项目，先帮我弄清楚它是什么、值不值得投入时间。",
  "",
  "## 仓库",
  "{{repo}}",
  "{{url}}",
  "来源：{{scope}}",
  "",
  "## 我这边已知的事实",
  "{{facts}}",
  "",
  "## 你要做的",
  "1. 先在这个工作目录里找有没有这个仓库的本地副本（按仓库名，比如 `{{repo}}` 或只有后半段的目录）。",
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

/** 单份提示词正文上限：两万字符，够写任意详细的分析框架，又不至于让设置页卡住。 */
export const PROMPT_TEXT_LIMIT = 20000;
/** 提示词份数上限。设置页要能一眼看完全部，不做分页。 */
export const PROMPT_COUNT_LIMIT = 8;
/** 名字上限：侧栏/下拉里只放得下一行。 */
export const PROMPT_NAME_LIMIT = 40;

/** 生成一个不与 seen 冲突的 id。确定性而非随机：每次渲染 id 跳变会让「设为默认」点不中。 */
function freshId(seen, start) {
  let n = start;
  while (seen.has("p" + n)) n += 1;
  return "p" + n;
}

/**
 * 把存下来的提示词列表归一化。
 *
 * 设置是从磁盘读的，可能被手改、可能来自旧版本（那时候只有一个字符串）。
 * 这里必须是**不会抛错**的：一份坏数据不能让整个设置页白屏。
 *
 * 只丢「完全空的壳」（没有名字也没有正文）。**有名字但正文空**的必须保留：
 * 用户全选删除正文准备重写时，这一份不能当场消失——读盘与编辑走同一个
 * 函数，只有一套行为，才不会出现「编辑时还在、重开就没了」。
 * 空正文不会真的喂给模型：pickPrompt 会跳过它们。
 *
 * @param {unknown} raw
 * @returns {Array<{ id: string, name: string, text: string }>}
 */
export function normalisePrompts(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const text = String(item.text === undefined || item.text === null ? "" : item.text);
    const name = String(item.name === undefined || item.name === null ? "" : item.name).trim();
    if (!text.trim() && !name) continue; // 连名字都没有：旧版/手改留下的空壳
    let id = String(item.id || "").trim();
    if (!id || seen.has(id)) id = freshId(seen, out.length + 1);
    seen.add(id);
    out.push({
      id,
      name: name.slice(0, PROMPT_NAME_LIMIT) || "未命名",
      text: text.slice(0, PROMPT_TEXT_LIMIT),
    });
    if (out.length >= PROMPT_COUNT_LIMIT) break;
  }
  return out;
}

/**
 * 选出这次讨论实际用哪份提示词。
 *
 * 三级回落：设置里的默认 → 列表第一份 → 内置模板。**永远返回一份可用模板**，
 * 因为「没有提示词」不该表现为按钮点了没反应。空正文的条目（正在编辑/被清空）
 * 不能当选：选它等于给模型一个空 prompt。
 *
 * @param {Array<{ id: string, name: string, text: string }>} prompts
 * @param {string} defaultId
 * @returns {{ id: string, name: string, text: string }}
 */
export function pickPrompt(prompts, defaultId) {
  const list = (Array.isArray(prompts) ? prompts : []).filter(
    (p) => p && typeof p === "object" && String(p.text || "").trim() !== "",
  );
  const hit = list.find((p) => p.id === defaultId);
  if (hit) return hit;
  if (list.length > 0) return list[0];
  return { id: "", name: "默认", text: DEFAULT_DISCUSS_TEMPLATE };
}

function fillTemplate(template, values) {
  return String(template || DEFAULT_DISCUSS_TEMPLATE).replace(/\{\{\s*([a-z]+)\s*\}\}/g, (whole, key) => {
    if (Object.prototype.hasOwnProperty.call(values, key)) return values[key];
    // 不认识的占位符原样保留：比悄悄替换成空串更容易让用户发现拼错了。
    return whole;
  });
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
 * @param {string} [input.template] 用户自定义的模板；空 = 内置默认
 * @returns {string}
 */
export function buildDiscussPrompt(input) {
  const row = (input && input.row) || {};
  const repo = String(row.repo || "").trim() || "这个仓库";
  const url = repo.indexOf("/") > 0 ? "https://github.com/" + repo : "";
  const scope = String((input && input.scopeText) || "").trim() ||
    (input.view === "rising"
      ? "近 7 天新建且 star 增长快的新仓库（GitHub Search）"
      : "GitHub Trending " + (input.period || "daily") + " 榜" + (input.language ? "（" + input.language + "）" : ""));

  const facts = [];
  if (row.description) facts.push("- 简介：" + clip(row.description, 400));
  if (row.language) facts.push("- 主要语言：" + row.language);
  if (Number.isFinite(row.stars)) facts.push("- 总 star：" + row.stars);
  if (Number.isFinite(row.gain)) facts.push("- 近期增长：+" + row.gain + "/" + (row.gainPeriod || "recent"));
  if (Number.isFinite(row.rank)) facts.push("- 当前名次：" + row.rank + "（" + scope + "）");
  // 「随便看看」没有名次也没有涨跌，「X 天前创建」对随机批次只是噪音。
  if (Number.isFinite(row.ageDays) && input.view !== "browse") facts.push("- 仓库创建于 " + row.ageDays + " 天前");
  if (row.isNew) facts.push("- 本次新上榜");
  else if (Number.isFinite(row.rankDelta) && row.rankDelta !== 0) {
    facts.push("- 较上次" + (row.rankDelta > 0 ? "上升 " : "下降 ") + Math.abs(row.rankDelta) + " 位");
  }

  const template = String((input && input.template) || "").trim() || DEFAULT_DISCUSS_TEMPLATE;
  const text = fillTemplate(template, {
    repo,
    url,
    scope,
    description: row.description ? clip(row.description, 400) : "",
    language: row.language ? String(row.language) : "",
    stars: Number.isFinite(row.stars) ? String(row.stars) : "",
    gain: Number.isFinite(row.gain) ? "+" + row.gain + "/" + (row.gainPeriod || "recent") : "",
    rank: Number.isFinite(row.rank) ? String(row.rank) : "",
    age: Number.isFinite(row.ageDays) ? String(row.ageDays) + " 天" : "",
    facts: facts.length > 0 ? facts.join("\n") : "- （榜单里只有仓库名，没有更多信息）",
  });
  // 模板里没写 {{facts}} 时也要把事实带上：没有这些数字，模型只能猜。
  // 用户明确写了 {{facts}} 就不重复。
  if (template.indexOf("{{facts}}") < 0 && facts.length > 0) {
    return text + "\n\n## 榜单事实（插件补充）\n" + facts.join("\n");
  }
  return text;
}

/* ---------- 重复讨论时的续接策略 ---------- */

/**
 * 「同一个仓库再点一次讨论」该新开还是接着聊。做成设置项而不是写死：
 * 两种做法都对，取决于用户在拿它干什么——扫榜时想要每次干净的新会话，
 * 深挖一个项目时希望追问的上下文还在。写死任何一种都会让另一半人别扭。
 */
export const RESUME_MODES = [
  { key: "session", label: "同一份榜单内续接", hint: "榜单刷新、换日/周/月之后新开" },
  { key: "always", label: "总是续接", hint: "只要拿得到上次的会话就接着聊" },
  { key: "never", label: "总是新开", hint: "每次都从零开始，侧栏会多出几行" },
];

export const DEFAULT_RESUME_MODE = "session";

/** 归一化从磁盘读到的值：不认识的、空的都退回默认，绝不返回 undefined。 */
export function normaliseResumeMode(raw) {
  const s = String(raw === undefined || raw === null ? "" : raw).trim();
  return RESUME_MODES.some((m) => m.key === s) ? s : DEFAULT_RESUME_MODE;
}

/**
 * 这次点击能不能续接上次的会话。
 *
 * @param {string} mode RESUME_MODES 里的 key
 * @param {boolean} resetSince 自上次开会话以来榜单是否已经换过（仅在 session 模式下有意义）
 * @param {boolean} hasSession 有没有拿到可用的 sessionId
 * @returns {boolean}
 */
export function shouldResume(mode, resetSince, hasSession) {
  if (!hasSession) return false; // 没有 id 就没有可续的东西，任何模式下都新开
  const key = normaliseResumeMode(mode);
  if (key === "never") return false;
  if (key === "always") return true;
  return !resetSince;
}

/** 续接策略的说明文字，给设置项用。 */
export function resumeModeHint(mode) {
  const key = normaliseResumeMode(mode);
  const hit = RESUME_MODES.find((m) => m.key === key);
  return hit ? hit.hint : "";
}
