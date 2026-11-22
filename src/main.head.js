/**
 * 每日 GitHub 热点（CC GUI 插件）。
 *
 * 数据：github.com/trending（公开页面，不占 API 配额）+ GitHub Search API（近 7 天新星库）。
 * 解读：只有用户点「生成解读」才调模型，选中内容之外一律不发。
 *
 * 约定（与工作志同一套）：
 * - 所有异步动作带代际号，晚到的结果不能覆盖新视图。
 * - 所有 host 侧请求带软超时；agent 停止/超时时必须 interrupt 宿主那一侧。
 * - 渲染一律用元素构造，不注入 HTML 字符串。
 *
 * 构建时会把 src/lib/*.mjs 的正文内联到下面两个标记之间（剥掉 `export `
 * 前缀，因为库文件是 ESM 而产物是同作用域的普通脚本）。
 */

/*__LIB_SOURCE__*/

/*__LIB_SOURCE_END__*/

const PLUGIN_ID = "github-trending";
const HISTORY_DIR = "history";
const REQUEST_TIMEOUT_MS = 20000;

/**
 * 反馈中转。主机名必须与 manifest.json 的 network: 授权逐字一致——
 * exec/network 授权是精确匹配，不支持通配。
 */
const FEEDBACK_ENDPOINT = "https://ccgui-feedback.2653990378.workers.dev";
const FEEDBACK_REPO = "renhao-wan/ccgui-plugin-github-trending";
/** 发反馈比拉榜单轻，挂 15s 就该让用户改走 Issue。 */
const FEEDBACK_TIMEOUT_MS = 15000;
const AGENT_TIMEOUT_MS = 120000;
/**
 * 开会话的超时。这条路径不能像解读那样等 120s：`discussing` 非空期间全榜的
 * 「讨论」按钮都是禁用的，挂住就等于整页这个功能不可用，而且没有别的出口。
 * startRun 只是 spawn，不包含推理，30s 足够；超时后用户可以直接再点一次。
 */
const DISCUSS_TIMEOUT_MS = 30000;

/**
 * 登记侧栏工作区的超时。这只是宿主本地的一张表，正常几十毫秒就回来了；给它
 * 10s 是为了不让一个卡住的 IPC 把「讨论」按钮一直挂在「打开中」——超时后照常
 * 开会话，只在回执里说明会话可能不在侧栏显示。
 */
const WORKSPACE_REGISTER_TIMEOUT_MS = 10000;
const TRENDING_TEXT_LIMIT = 2_000_000;

/**
 * 激活期间由 activate 注入。卸载时不置空：宿主可能在卸载动画期间再渲染一次
 * 组件，置空会让那次渲染直接抛错。生命周期隔离靠 activateSeq / genSeq /
 * digestSeq 三代际号，不靠这个引用。
 */
let appCtx = null;

const PERIODS = [
  { key: "daily", label: "今日" },
  { key: "weekly", label: "本周" },
  { key: "monthly", label: "本月" },
];

const RISING_PERIOD = { key: "rising", label: "新星库" };

/** 视图的中文名，给下拉/状态行/导出标题共用同一套说法。 */
const VIEW_LABEL = { trending: "Trending", rising: "新星库", browse: "随便看看" };

/**
 * 「你现在看的是什么数据」的一句话说明。
 *
 * 三个视图的数据来源差异很大（爬页面 / Search 时间窗 / Search 随机或搜索），
 * 状态行、解读 prompt、导出标题都要交代清楚，否则模型和用户都会把一批随机
 * 抽样当成「今日榜单」来理解。
 */
function scopeTextOf(snap) {
  const v = snap || {};
  if (v.view === "rising") return "近 7 天新建且 star 增长快的新仓库（GitHub Search）";
  if (v.view === "browse") {
    const term = String(v.discoverTerm || "").trim();
    if (term) return "GitHub 上按仓库名搜索「" + term + "」的结果";
    return "从热门仓库里随机抽的一批" + (v.discoverBand ? "（" + v.discoverBand + "）" : "") + "（GitHub Search）";
  }
  const period = (v.settings && v.settings.period) || "daily";
  const language = v.settings && v.settings.language;
  return "GitHub Trending " + period + " 榜" + (language ? "（" + language + "）" : "");
}

const DEFAULT_SETTINGS = {
  period: "daily",
  language: "",
  minStars: 50,
  engine: "",
  model: "",
  workspacePath: "",
  token: "",
  /** 讨论用的提示词列表（空列表 = 用内置模板）。 */
  prompts: [],
  /** 点「讨论」时用哪一份；空 = 用列表第一份。 */
  defaultPromptId: "",
  /** 同一个仓库再点一次「讨论」时：session / always / never，见 prompt.mjs 的 RESUME_MODES。 */
  resumeMode: DEFAULT_RESUME_MODE,
  /** 仓库 → 会话 id 的落盘表。内存表熬不过重装/重启，这份才是「只该有一条会话」的保证。 */
  discussSessionIds: {},
  /** 「生成解读」固定复用的后台会话 id；空 = 还没建过。 */
  digestSessionId: "",
};

const DEFAULT_STATE = {
  view: "trending",
  settings: { ...DEFAULT_SETTINGS },
  repos: [],
  dropped: [],
  isFirstRun: true,
  loadedAt: null,
  source: "",
  httpError: "",
  errorKind: "",
  loading: false,
  loaded: false,
  digest: "",
  /** 用户主动停止：正文是半截的，界面要说清楚，不能装成写完了。 */
  digestStopped: false,
  digestTruncated: false,
  digestIncluded: 0,
  digestTotal: 0,
  generating: false,
  /** 正在为哪一行开会话（仓库全名）；空串 = 没有在开。 */
  discussing: "",
  /** 开会话失败的原因。会话是真 token，失败必须说明白，不能静默。 */
  discussError: "",
  /**
   * 已开好会话的仓库全名；空串 = 没有待确认的会话。
   *
   * 本页不会自动跳到新会话（`startRun` 没有这个能力，详见 discussRepo），
   * 所以「已经开了」这件事必须由页面说出来，否则点完跟没点一样。
   */
  discussNotice: "",
  /** 会话实际挂在哪个侧栏工作区分组下（目录名）；空串 = 没登记成功。 */
  discussWorkspace: "",
  /** 会话建起来了、但没挂进侧栏工作区时的说明。不阻塞会话，只解释为什么可能看不见。 */
  discussWarning: "",
  /** 这次开会话是续接了旧会话还是新开的；空串 = 没开会话。用于回执说明。 */
  discussResumed: false,
  /** 这次是**直接打开**已有会话（selectSession，不跑模型）；false = 新开或旧宿主续接。 */
  discussOpened: false,
  /** 这次开会话用的是哪份提示词的名字；空串 = 内置默认。 */
  discussPromptName: "",
  /**
   * README 预览。同一时刻只展开一个仓库：
   * `open` 是仓库全名，空串 = 全部收起。
   */
  readmeOpen: "",
  readmeLoading: false,
  readmeError: "",
  /** 已处理（去 badge/HTML、截断）的正文；渲染时直接过 Markdown 子集。 */
  readmeText: "",
  readmeTruncated: false,
  readmeTotal: 0,
  /**
   * 「随便看看」当前生效的搜索词；空串 = 换一批（随机档位 + 随机页）。
   * 输入框里的未提交内容不在这里，否则每敲一个字就换一批。
   */
  discoverTerm: "",
  /** 当前这批是从哪个 star 档抽的（「★1k–3k」）；搜索模式下为空。 */
  discoverBand: "",
  /** Search API 报的总命中数，只用于说明「一共多少条里挑了这些」。 */
  discoverTotal: 0,
  /**
   * 榜单内本地筛选的关键词；空串 = 不筛选。
   * 唯一数据源：输入框直接绑在这里，不存在「输入框和实际生效的词不同步」。
   */
  keyword: "",
  catalog: [],
  catalogLoaded: false,
  modelsLoading: false,
  modelsError: "",
  /** 插件数据目录的绝对路径；生成解读时的默认 cwd。 */
  storagePath: "",
};

const store = { snap: { ...DEFAULT_STATE }, listeners: new Set() };

function set(patch) {
  store.snap = Object.assign({}, store.snap, patch);
  for (const fn of store.listeners) {
    try {
      fn();
    } catch {
      /* 单个订阅者出错不影响其他 */
    }
  }
}

function setSettings(patch) {
  set({ settings: Object.assign({}, store.snap.settings, patch) });
}

async function persistSettings(ctx, patch) {
  if (patch) setSettings(patch);
  try {
    await whenSettingsLoaded();
    await ctx.storage.set("settings", store.snap.settings);
    return true;
  } catch {
    set({ httpError: "设置保存失败" });
    return false;
  }
}

function useSnap() {
  return appCtx.react.useSyncExternalStore(
    (cb) => {
      store.listeners.add(cb);
      return () => store.listeners.delete(cb);
    },
    () => store.snap,
  );
}

let genSeq = 0;
let digestSeq = 0;
let activateSeq = 0;

const THIN_ICON = {
  width: 16,
  height: 16,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  "stroke-width": 1.5,
  "stroke-linecap": "round",
  "stroke-linejoin": "round",
  "aria-hidden": "true",
};

/**
 * 应用内图标：三根递增柱，与 docs/icon.png **同一套符号、同一套几何比例**。
 *
 * 两处必须是同一个东西：市场页/侧栏缩略图是 docs/icon.png，侧栏与页签标签
 * 用的是这个组件。早先 PNG 画箭头、这里画「三根柱 + 基线」，同一个插件在
 * 两个位置显示两种图形，用户根本认不出是同一个插件。改几何时两边必须一起改
 * （`test/icon.test.mjs` 会比对两边的数值）。
 *
 * 几何来源是 make-icon.mjs 的比例常量（柱宽 5.5%、间距 8.5%、底边 80%、
 * 三档高度 30/46/62%），换算到 16×16：
 *   视觉范围   x 5.76 / 8 / 10.24，底边 12.80，顶端 8.00 / 5.44 / 2.88
 *
 * **`V` 的端点是笔画中心线，不是视觉边界**：圆头还会从端点向外伸出一个
 * 半径（strokeWidth/2 = 0.44）。所以端点要在视觉边界的基础上内缩：
 *   底端 12.80 - 0.44 = 12.36，顶端 8.00 + 0.44 = 8.44（其余同理）
 * 少了这一步，应用内图标会比 PNG 大约 5.5%，两处并排看就是「一大一小」。
 *
 * **间距必须大于柱宽**：等宽或更窄时，缩到 16px 下三根柱会糊成一块。
 * 换算过来的包围盒占画布约 34%×62%，与斜杠面板那 32%×62% 基本一致——
 * 符号画得比别人的大，缩到 18px 就会显得填满了。
 *
 * 16px 下不画基线、不做双色：一根异色柱只会变成一个偏色的点。
 */
const ICON_GEOM = {
  strokeWidth: 0.88,
  bars: ["M5.76 8.44V12.36", "M8 5.88V12.36", "M10.24 3.32V12.36"],
};

function Icon(props) {
  const h = appCtx.react.createElement;
  return h(
    "svg",
    Object.assign({}, THIN_ICON, { "stroke-width": ICON_GEOM.strokeWidth }, props && props.className ? { className: props.className } : {}),
    ...ICON_GEOM.bars.map((d) => h("path", { d })),
  );
}

/**
 * Build artefacts inline lib/*.mjs verbatim, but those files are ES modules.
 * A literal `export ` inside a function body is a syntax error, so drop the
 * keyword — every declaration is already a top-level function declaration.
 */

function fmtNumber(n) {
  if (!Number.isFinite(n)) return "";
  if (n >= 1000) {
    const k = n / 1000;
    return (k >= 100 ? String(Math.round(k)) : k.toFixed(1).replace(/\.0$/, "")) + "k";
  }
  return String(n);
}

function fmtTime(ts) {
  if (!ts) return "";
  try {
    return new Date(ts).toLocaleString("zh-CN", {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

/** 只允许 https 链接进 DOM；其它一律当纯文本。 */
function safeHref(url) {
  return typeof url === "string" && /^https:\/\/[a-z0-9.-]+(\/|$)/i.test(url) ? url : null;
}

/**
 * 写剪贴板。宿主是 Electron，正常都有 `navigator.clipboard`；缺失时直接 reject，
 * 由调用方把「复制失败」显示出来——静默失败比不支持更糟，用户会以为已经复制了。
 *
 * 返回值是「这次复制自己的」Promise，不是布尔：连点两次导出时，两个 Promise
 * 各自 resolve，调用方不必靠一个共享的 timestamp 去猜哪次结果该留下了。
 */
function copyText(text) {
  try {
    const clip = typeof navigator !== "undefined" ? navigator.clipboard : null;
    if (clip && typeof clip.writeText === "function") {
      return Promise.resolve(clip.writeText(String(text)));
    }
  } catch {
    /* 落到下面统一 reject */
  }
  return Promise.reject(new Error("clipboard unavailable"));
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label + " timeout")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * 语言名会进 URL 与快照文件名，先收敛成安全形状：
 * 只允许字母/数字/加号/井号/点/连字符（覆盖 c++、c#、objective-c、f# 等），
 * 其余一律换成连字符——这样 `../../evil`、`a/b`、绝对路径都拼不出目录穿越。
 */
function safeLanguage(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return "";
  const cleaned = s.replace(/[^a-z0-9+#.-]/g, "-").replace(/^[.-]+/, "").replace(/[.-]+$/, "");
  return cleaned.slice(0, 40);
}

function trendingUrl(period, language) {
  const lang = safeLanguage(language);
  const base = "https://github.com/trending" + (lang ? "/" + encodeURIComponent(lang) : "");
  return base + "?since=" + encodeURIComponent(period);
}

function historyPath(period, language) {
  const suffix = safeLanguage(language) || "all";
  return HISTORY_DIR + "/" + period + "-" + suffix + ".json";
}

/** 连接层错误的判据：这类错误重放一次通常就过了，对用户也该换个说法。 */
const TRANSIENT_NET = /error sending request|econnreset|econnrefused|connection reset|connection closed|socket hang up|dns|tls|certificate|unexpected eof/i;

function messageOf(error) {
  const raw = error && error.message ? String(error.message) : String(error || "");
  if (/network:|no declared network|missing permission|without declaring/i.test(raw)) {
    return "网络授权未生效，请重新安装插件";
  }
  if (/timed?\s*out|timeout/i.test(raw)) return "请求超时，请稍后重试";
  // 宿主桥把 reqwest 的底层错误原样抛过来。原样显示等于把 `error sending
  // request` 丢给用户——既不知道是哪里断了，也不知道能做什么。
  if (TRANSIENT_NET.test(raw)) return "连不上 GitHub：检查本机网络或系统代理后重试";
  return raw || "请求失败";
}

async function httpGetOnce(url, headers) {
  const res = await withTimeout(
    appCtx.bridge.invoke("plugin_http_request", {
      method: "GET",
      url,
      headers: headers || {},
      body: null,
    }),
    REQUEST_TIMEOUT_MS,
    "http",
  );
  return { status: Number(res && res.status) || 0, body: res && typeof res.body === "string" ? res.body : "" };
}

/**
 * 一次 GET，连接层失败时重试一次。
 *
 * 宿主桥把 reqwest 的错误原样抛出来，本地实测 `error sending request` 是偶发的
 * （同一 URL 隔几秒就通）。GET 是幂等的，重放一次比让用户自己点「刷新」强。
 *
 * 不重试的：超时（再等 20 秒只是把等待翻倍）、授权错误（重放也拿不到权限）、
 * 以及桥正常返回的 4xx/5xx（那是服务端的答复，重试只会更快撞限流）。
 */
async function httpGet(url, headers) {
  try {
    return await httpGetOnce(url, headers);
  } catch (error) {
    const raw = error && error.message ? String(error.message) : String(error || "");
    if (!TRANSIENT_NET.test(raw) || /timed?\s*out|timeout|permission|network:/i.test(raw)) throw error;
    await new Promise((resolve) => setTimeout(resolve, 500));
    return await httpGetOnce(url, headers);
  }
}

/** 宿主版本。老版本宿主可能没有这一项，取不到就留空，不能因此发不出反馈。 */
function hostAppVersion(ctx) {
  try {
    return ctx && ctx.host && typeof ctx.host.appVersion === "string" ? ctx.host.appVersion : "";
  } catch {
    return "";
  }
}

/**
 * 反馈的网络层由 createFeedbackNet 统一提供（src/lib/feedback-net.mjs）。
 *
 * 只用同一个延迟初始化的实例：端点与自己的插件 id 都从常量来，不可能
 * 出现「请求体是 A、User-Agent 是 B」的错位。装好后 send / quota 就是
 * 四插件逐字相同的那两个函数。
 */
let feedbackNet = null;
function getFeedbackNet() {
  if (!feedbackNet) {
    feedbackNet = createFeedbackNet(appCtx, {
      endpoint: FEEDBACK_ENDPOINT,
      pluginId: PLUGIN_ID,
      timeoutMs: FEEDBACK_TIMEOUT_MS,
    });
  }
  return feedbackNet;
}
async function sendFeedback(ctx, text) {
  return getFeedbackNet().send(text);
}
async function fetchQuota(ctx) {
  return getFeedbackNet().quota();
}

async function fetchTrending(ctx, period, language) {
  const res = await httpGet(trendingUrl(period, language), {
    Accept: "text/html,application/xhtml+xml",
    "User-Agent": "ccgui-github-trending/" + ctx.version,
  });
  if (res.status === 429 || res.status === 403) {
    return { ok: false, kind: "rate_limited", message: "GitHub 拒绝了这次请求（HTTP " + res.status + "），稍后再试" };
  }
  if (res.status < 200 || res.status >= 300) {
    return { ok: false, kind: "http", message: "GitHub 返回 HTTP " + res.status };
  }
  if (res.body.length > TRENDING_TEXT_LIMIT) {
    return { ok: false, kind: "http", message: "页面体积异常，已放弃解析" };
  }
  const parsed = parseTrending(res.body);
  if (parsed.error) {
    return {
      ok: false,
      kind: parsed.error,
      message: parsed.error === "no_rows" ? "没解析到仓库行，GitHub 页面结构可能已变化" : "GitHub 返回了空页面",
    };
  }
  return { ok: true, repos: parsed.repos };
}

/**
 * Search API 的通用取数。新星库、随便看看、仓库搜索三条路径共用一套：
 * URL 组装交给纯函数（各视图的 query 语义差得远），这里只管网络、限流与
 * 空结果的口径。
 *
 * @param {{ q: string, sort: string, order: string, perPage: number, page: number }} spec
 * @param {object} settings
 * @param {{ emptyMessage: string }} hints
 */
async function fetchSearch(spec, settings, hints) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "ccgui-github-trending",
  };
  const token = String((settings && settings.token) || "").trim();
  if (token) headers.Authorization = "Bearer " + token;

  const res = await httpGet(discoverUrl(spec), headers);
  let payload = null;
  try {
    payload = JSON.parse(res.body);
  } catch {
    payload = null;
  }
  const parsed = parseRising(payload);
  if (parsed.error === "rate_limited") {
    return {
      ok: false,
      kind: "rate_limited",
      message: token
        ? "GitHub 限流了，请等一会儿再刷新"
        : "GitHub 未认证限流（10 次/分钟），可在设置里填 Token 提高额度",
    };
  }
  if (parsed.error) {
    return {
      ok: false,
      kind: parsed.error,
      message: res.status >= 400
        ? "GitHub 返回 HTTP " + res.status
        : (hints && hints.emptyMessage) || "没有结果",
    };
  }
  return { ok: true, repos: parsed.repos, total: parsed.total };
}

async function fetchRising(settings) {
  return fetchSearch(
    {
      q: buildRisingQuery(settings.minStars, 7),
      sort: "stars",
      order: "desc",
      perPage: 25,
      page: 1,
    },
    settings,
    { emptyMessage: "新星库结果为空，可调低 star 阈值" },
  );
}

/** 「换一批」：伪随机档位 + 随机页，见 src/lib/discover.mjs 的说明。 */
// 上一批的档位/页：撞上了就重抽，避免点了「换一批」列表一模一样。
let lastDiscoverPick = null;
async function fetchDiscover(settings) {
  const spec = buildDiscoverQuery(Math.random, lastDiscoverPick);
  const result = await fetchSearch(spec, settings, { emptyMessage: "这一批没抽到仓库，再换一批" });
  if (result.ok) {
    lastDiscoverPick = { band: spec.band, page: spec.page };
    // 把星档带回去，状态行要说出「这批是从哪个档位抽的」。
    result.band = spec.band;
    result.repos = shapeDiscoverRows(result.repos);
  }
  return result;
}

/** 按仓库名搜索。空输入由调用方先行拦截，这里再兜一次。 */
async function fetchRepoSearch(term, settings) {
  const spec = buildSearchSpec(term);
  if (!spec) return { ok: true, repos: [], total: 0, term: "" };
  const result = await fetchSearch(spec, settings, {
    emptyMessage: "没搜到叫「" + String(term).trim() + "」的仓库",
  });
  if (result.ok) {
    result.term = String(term).trim();
    result.repos = shapeDiscoverRows(result.repos);
  }
  return result;
}

/* ---------- README 预览 ---------- */

/**
 * raw 域名上按优先级试的文件名。GitHub 自己的 readme 接口认更多变体
 * （README.txt、README.adoc 等），这里只试最常见的三种：命中即停，
 * 全落空时回落 API——那条路认全部变体，只是要花配额。
 */
const README_RAW_NAMES = ["README.md", "README.markdown", "README.rst"];

/**
 * 先试 raw.githubusercontent.com。
 *
 * 为什么值得多一条网络权限：**raw 不占 API 配额**。未认证的 60 次/小时是
 * 按**出口 IP** 算的，不是按人算的——共享代理/VPN 后面别人把额度用光，
 * 用户自己点两次 README 就会看到「限流」，而他什么都没做错。raw 不受这个影响，
 * 也不需要 Token（因此也绝不把 Token 发给这个域名）。
 *
 * 代价是 raw 只认确切文件名（大小写敏感）、读不了私有仓。所以它只是**快路径**：
 * 拿不到就回落 API，私有仓与冷门文件名照旧能读。
 *
 * @returns {Promise<string|null>} 成功时返回正文；任何失败都返回 null（交给回落）
 */
async function fetchReadmeFromRaw(repo) {
  for (const name of README_RAW_NAMES) {
    const res = await httpGet("https://raw.githubusercontent.com/" + repo + "/HEAD/" + name, {
      "User-Agent": "ccgui-github-trending",
    });
    if (res.status === 200) {
      // 空文件不能算命中：继续试下一个，都空再回落 API 让它给出结论。
      if (res.body.trim()) return res.body;
      continue;
    }
    // 404 = 这个文件名不存在，试下一个；其余状态（403/5xx）继续试也没意义。
    if (res.status !== 404) return null;
  }
  return null;
}

/**
 * API 那条路：`Accept: application/vnd.github.raw` 让接口直接回文件正文而不是
 * base64 JSON；但网关可能无视它，所以 `readmeTextFromBody` 两种形状都认。
 * 认 Token，私有仓的 README 靠它。
 */
async function fetchReadmeViaApi(repo, settings) {
  const url = "https://api.github.com/repos/" + repo + "/readme";
  const headers = {
    Accept: "application/vnd.github.raw",
    "User-Agent": "ccgui-github-trending",
  };
  const token = String((settings && settings.token) || "").trim();
  if (token) headers.Authorization = "Bearer " + token;

  const res = await httpGet(url, headers);
  // 把状态码与正文前几十字带进文案：同样是 403，「配额用完」「请求太密」
  // 「仓库被限制」「Token 无效」要用户做的事完全不同，靠猜不如照实说。
  const snippet = String(res.body || "").replace(/\s+/g, " ").slice(0, 90).trim();
  const detail = "（HTTP " + res.status + (snippet ? "：" + snippet : "") + "）";
  if (res.status === 404) return { ok: false, message: "这个仓库没有 README" };
  if (res.status === 401) {
    return { ok: false, message: "Token 无效或已过期，请到设置里更新" + detail };
  }
  // 403 不一定都是限流：仓库被限制访问、命中二次限流也会给 403。只有正文
  // 明确说了 rate limit 才按配额解释，否则会把「没权限」说成「等一会儿」。
  // 429 一定是限流，不用看正文。
  if (res.status === 429 || (res.status === 403 && /rate limit|too many requests/i.test(res.body))) {
    // 「配额用完」和「请求太密」是两种限流，用户能做的事不一样：前者要等一小时
    // 或填 Token，后者等十几秒就好。
    if (/secondary rate limit/i.test(res.body)) {
      return {
        ok: false,
        message: "请求太密被 GitHub 暂时限制，等十几秒再展开" + (token ? "" : "，或在设置里填 Token 提高额度") + detail,
      };
    }
    // 走到这里说明 raw 那条免费的路也没成（私有仓/冷门文件名），
    // 而配额是按出口 IP 算的：共享代理后面额度可能是别人用掉的，说清楚比让用户
    // 怀疑自己「没点几次怎么就限流了」有用。
    return {
      ok: false,
      message:
        (token
          ? "GitHub 限流了，请等一会儿再试"
          : "GitHub 未认证限流（60 次/小时，按出口 IP 算），可在设置里填 Token 提高额度") + detail,
    };
  }
  if (res.status === 403) return { ok: false, message: "GitHub 拒绝访问这个仓库" + detail };
  if (res.status < 200 || res.status >= 300) return { ok: false, message: "GitHub 返回 HTTP " + res.status };

  const prepared = prepareReadme(readmeTextFromBody(res.body));
  if (!prepared) return { ok: false, message: "README 是空的" };
  const clipped = truncateReadme(prepared);
  return { ok: true, text: clipped.text, truncated: clipped.truncated, total: clipped.total };
}

/**
 * 读一个仓库的 README：raw 快路径 → API 回落。
 *
 * raw 抛网络错误时静默回落：那只是「快路径没走通」，不该让用户看到一次失败，
 * 尤其是 API 那条路未必有问题。
 */
async function fetchReadme(repo, settings) {
  let rawText = null;
  try {
    rawText = await fetchReadmeFromRaw(repo);
  } catch {
    rawText = null;
  }
  if (rawText) {
    const prepared = prepareReadme(rawText);
    if (prepared) {
      const clipped = truncateReadme(prepared);
      return { ok: true, text: clipped.text, truncated: clipped.truncated, total: clipped.total };
    }
  }
  return await fetchReadmeViaApi(repo, settings);
}

/** 只允许「看上去像 GitHub 仓库名」的输入拼进 URL，避免路径注入到别的接口路径上。 */
function readmeRepoKey(repo) {
  const s = String(repo || "").trim();
  return /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(s) ? s : "";
}

let readmeSeq = 0;

/**
 * README 的会话内缓存：同一份榜单里来回比对两三个仓库是真实场景，
 * 每次收起再展开都重走一遍网络与解析是白费。
 *
 * 只存**成功**结果：404 / 限流的失败不缓存，否则一次限流会让「没有 README」
 * 粘在这场会话的每一次展开上。上限 30 条（2000 字 × 30 ≈ 60KB），按插入序淘汰。
 */
const README_CACHE_LIMIT = 30;
const readmeCache = new Map();

function cacheReadme(repo, value) {
  if (readmeCache.has(repo)) readmeCache.delete(repo);
  readmeCache.set(repo, value);
  while (readmeCache.size > README_CACHE_LIMIT) {
    const oldest = readmeCache.keys().next().value;
    readmeCache.delete(oldest);
  }
}

/**
 * 展开 / 收起某行的 README。
 *
 * 同时只开一个：README 预览占了整行高度，开两个就得滚很远才能回到榜单，
 * 而用户的动作本身就是「看这一行的 README」。
 *
 * 不做「所有展开过的都缓存」：一个会话里翻十几个仓库、每个都常驻一份全文，
 * 收益抵不上缓存失效判断的复杂度。收起即丢弃，再展开就重拉。
 */
async function toggleReadme(ctx, row) {
  const repo = readmeRepoKey(row && row.repo);
  if (!repo) return;
  if (store.snap.readmeOpen === repo) {
    // 收起：作废在飞的请求，否则回来时会把已经收起的行重新展开。
    readmeSeq += 1;
    set({ readmeOpen: "", readmeLoading: false, readmeError: "", readmeText: "", readmeTruncated: false, readmeTotal: 0 });
    return;
  }
  const seq = ++readmeSeq;
  // 换行展开时先清掉上一份正文：否则新行会短暂显示上一个仓库的 README。
  set({ readmeOpen: repo, readmeLoading: true, readmeError: "", readmeText: "", readmeTruncated: false, readmeTotal: 0 });
  // 会话内缓存命中：别再走一次网络，用户要的就是「立刻看到」。
  // 仍要校验 seq，否则收起/刷新之后晚到的写回会重新展开一行。
  const cached = readmeCache.get(repo);
  if (cached) {
    if (seq !== readmeSeq) return;
    set({
      readmeLoading: false,
      readmeError: "",
      readmeText: cached.text,
      readmeTruncated: cached.truncated,
      readmeTotal: cached.total,
    });
    return;
  }
  try {
    const result = await fetchReadme(repo, store.snap.settings);
    if (seq !== readmeSeq) return;
    if (!result.ok) {
      set({ readmeLoading: false, readmeError: result.message });
      return;
    }
    cacheReadme(repo, { text: result.text, truncated: result.truncated, total: result.total });
    set({
      readmeLoading: false,
      readmeError: "",
      readmeText: result.text,
      readmeTruncated: result.truncated,
      readmeTotal: result.total,
    });
  } catch (error) {
    if (seq !== readmeSeq) return;
    set({ readmeLoading: false, readmeError: "读取 README 失败：" + messageOf(error) });
  }
}

/* ---------- 快照读写 ---------- */

async function readSnapshot(ctx, period, language) {
  try {
    const doc = await ctx.documentStorage.readText(historyPath(period, language));
    if (!doc) return null;
    const data = JSON.parse(doc.content);
    return Array.isArray(data && data.repos) ? data.repos : null;
  } catch {
    // 读失败 = 真的读不了（权限/目录失效），不要伪装成「没有历史」；
    // 但对比失败不该阻塞主流程，退化为首次使用。
    return null;
  }
}

/**
 * 写快照。同一路径的并发写会 CAS 冲突：快速切语言/时间档时两次写会读到同一个
 * version，后者被吞掉，导致快照停在旧数据、下次刷新把已上榜的重标成「新上榜」。
 * 这里按路径串行化，并在冲突后重读 version 重试一次。
 */
const snapshotLocks = new Map();

async function writeSnapshot(ctx, period, language, repos) {
  const rel = historyPath(period, language);
  const prev = snapshotLocks.get(rel) || Promise.resolve();
  const run = () => writeSnapshotOnce(ctx, rel, period, language, repos);
  // prev 失败也要继续：上一轮的写盘错误不该让这一轮静默不写。
  const next = prev.then(run, run);
  // 记进 Map 的必须是这一轮真正的「队尾」引用，否则 finally 里的 === 判断
  // 永远不成立（存 next.catch() 存的是另一个 Promise），锁表只增不减。
  const tail = next.catch(() => {});
  snapshotLocks.set(rel, tail);
  try {
    await next;
  } finally {
    // 只有自己还是队尾才删：后面已有新写入排队时，删了就会让它们并发。
    if (snapshotLocks.get(rel) === tail) snapshotLocks.delete(rel);
  }
}

async function writeSnapshotOnce(ctx, rel, period, language, repos) {
  const content = JSON.stringify({ savedAt: new Date().toISOString(), repos });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      let expected = null;
      const existing = await ctx.documentStorage.readText(rel);
      if (existing) expected = existing.version;
      // 内容没变就不覆盖：省一次写盘，也不必清理 .bak。
      if (existing) {
        try {
          const parsed = JSON.parse(existing.content);
          if (Array.isArray(parsed && parsed.repos) && snapshotSignature(parsed.repos) === snapshotSignature(repos)) {
            return;
          }
        } catch {
          /* 旧文件损坏：直接覆盖 */
        }
      }
      await ctx.documentStorage.writeTextAtomic(rel, content, expected);
      await cleanupBackups(ctx, rel);
      return;
    } catch (error) {
      // 只有 CAS 冲突值得重试；其它错误（权限、目录）重试也没用。
      if (attempt === 0 && /conflict/i.test(String(error && error.message))) continue;
      // 快照只是增强：写失败不该让用户看不到榜单。
      return;
    }
  }
}

async function cleanupBackups(ctx, rel) {
  try {
    const backup = rel + ".bak";
    const doc = await ctx.documentStorage.readText(backup);
    if (doc) await ctx.documentStorage.remove(backup, doc.version);
  } catch {
    /* 清理失败无害 */
  }
}

/**
 * 快照文件按 period+language 分槽，同一槽只有一份，所以不需要按天清理；
 * 这里只清宿主覆盖时留下的 .bak（宿主在覆盖前留备份，插件负责清理）。
 */
async function pruneHistory(ctx) {
  try {
    const files = await ctx.documentStorage.list(HISTORY_DIR);
    const backups = (Array.isArray(files) ? files : [])
      .map((f) => String(f).replace(/\\/g, "/"))
      .filter((f) => f.startsWith(HISTORY_DIR + "/") && f.endsWith(".bak"));
    for (const name of backups) {
      try {
        const doc = await ctx.documentStorage.readText(name);
        if (doc) await ctx.documentStorage.remove(name, doc.version);
      } catch {
        /* 单个清理失败不影响其他 */
      }
    }
  } catch {
    /* 目录不存在或 list 不支持前缀都很正常 */
  }
}

/* ---------- 加载 ---------- */

async function refresh(ctx, options) {
  const force = Boolean(options && options.force);
  const snap = store.snap;
  const settings = snap.settings;
  const view = snap.view;
  const period = view === "rising" ? RISING_PERIOD.key : view === "browse" ? "browse" : settings.period;
  const language = view === "trending" ? settings.language : "";
  // 搜索词只在「随便看看」里有意义；空串 = 换一批（伪随机档位 + 随机页）。
  // 可以从 options 传（搜索框刚提交，state 里的还是上一批），否则沿用当前生效的。
  const term =
    view === "browse"
      ? String(options && options.term !== undefined ? options.term : snap.discoverTerm || "").trim()
      : "";
  // 浏览视图没有「时间档」和「语言」，批次标识就是搜索词本身：
  // 同一个词重刷不该被早退挡掉，所以 key 必须把词算进去。
  const sourceKey = view === "browse" ? "browse:" + (term || "__random__") : view + ":" + period + ":" + language;

  // 同一份数据已经有内容且不是强制刷新：不重复打网络。
  // 注意「换一批」必须走 force——不 force 就等于按了没反应。
  if (!force && snap.loaded && snap.source === sourceKey) return;

  const seq = ++genSeq;

  // 榜单要换掉了。只打标记，不清表：清不清由用户选的 resumeMode 决定
  // （「总是续接」明确要求跨榜单也接着聊）。
  markDiscussSessionsStale();

  // 讨论的回执只服务于那一次点击：刷新是用户明确表示的「再来一次」，
  // 回执要让位给榜单本身的状态说明，失败的那条同理。
  // README 预览也随之作废：列表要换了，在飞的响应回来后不能往新列表里写旧正文。
  readmeSeq += 1;
  set({
    loading: true,
    httpError: "",
    errorKind: "",
    discussError: "",
    discussNotice: "",
    discussWorkspace: "",
    discussWarning: "",
    discussResumed: false,
    discussOpened: false,
    discussPromptName: "",
    readmeOpen: "",
    readmeLoading: false,
    readmeError: "",
    readmeText: "",
    readmeTruncated: false,
    readmeTotal: 0,
  });

  let result;
  try {
    if (view === "browse") {
      result = term ? await fetchRepoSearch(term, settings) : await fetchDiscover(settings);
    } else {
      result = view === "rising" ? await fetchRising(settings) : await fetchTrending(ctx, period, language);
    }
  } catch (error) {
    result = { ok: false, kind: "network", message: messageOf(error) };
  }

  // 代际校验：用户可能已经切了视图、或发起了新一轮。
  // 宿主桥没有 AbortSignal，晚到的响应只能靠这里丢弃。
  if (seq !== genSeq) return;

  if (!result.ok) {
    // 失败时优先保住用户正在看的内容：同一视图的旧数据 > 本地快照 > 空。
    // 「随便看看」没有本地快照（随机批次、搜索结果本就不该落盘）。
    const sameView = snap.source === sourceKey && snap.repos.length > 0;
    const cached = view === "trending" ? await readSnapshot(ctx, period, language) : null;
    if (seq !== genSeq) return;
    const fallback = sameView ? snap.repos : cached ? diffSnapshot(cached, null).repos : [];
    set({
      loading: false,
      loaded: true,
      errorKind: result.kind,
      httpError: result.message,
      source: sourceKey,
      repos: fallback,
      dropped: sameView ? snap.dropped : [],
      isFirstRun: sameView ? snap.isFirstRun : Boolean(cached),
      loadedAt: sameView ? snap.loadedAt : cached ? Date.now() : null,
      // 失败不覆盖上一批的档位说明：列表还在，说的还是同一批。
      discoverTerm: view === "browse" && sameView ? snap.discoverTerm : term,
      discoverBand: view === "browse" && sameView ? snap.discoverBand : "",
      discoverTotal: view === "browse" && sameView ? snap.discoverTotal : 0,
    });
    return;
  }

  if (view === "browse") {
    // 不落盘、不做历史对比：这批是随机抽的（或一次搜索结果），
    // 跟「上一次」没有任何可比的排名关系，标涨跌就是编数据。
    set({
      loading: false,
      loaded: true,
      errorKind: "",
      httpError: "",
      repos: result.repos.map((row, index) => ({ ...row, rank: null, rankDelta: null, isNew: false })),
      dropped: [],
      isFirstRun: false,
      source: sourceKey,
      loadedAt: Date.now(),
      discoverTerm: term,
      discoverBand: result.band ? bandLabel(result.band) : "",
      discoverTotal: Number.isFinite(result.total) ? result.total : result.repos.length,
    });
    return;
  }

  let previous = null;
  if (view !== "rising") {
    previous = await readSnapshot(ctx, period, language);
    if (seq !== genSeq) return;
  }

  const diff = diffSnapshot(result.repos, previous);
  set({
    loading: false,
    loaded: true,
    errorKind: "",
    httpError: "",
    repos: diff.repos,
    dropped: diff.dropped,
    isFirstRun: diff.isFirstRun,
    source: view + ":" + period + ":" + language,
    loadedAt: Date.now(),
    discoverTerm: "",
    discoverBand: "",
    discoverTotal: 0,
  });

  // 快照只对 Trending 有意义（新星库是滚动窗口，排名不可比）。
  if (view === "trending") await writeSnapshot(ctx, period, language, result.repos);
}

/* ---------- AI 解读 ---------- */

/**
 * 插件自己的数据目录（宿主隔离存储根，通常是 ~/.ccgui-next/plugin-data/<id>）。
 * 拿不到时返回空串，由调用方回退。
 */
async function pluginDataDir(ctx) {
  const cached = store.snap.storagePath;
  if (cached) return cached;
  const ds = ctx && ctx.documentStorage;
  if (!ds || typeof ds.getLocation !== "function") return "";
  try {
    const loc = await ds.getLocation();
    const path = String(loc && loc.path ? loc.path : "").replace(/[\\/]+$/, "");
    if (path) set({ storagePath: path });
    return path;
  } catch {
    return "";
  }
}

/**
 * 解读与「讨论」时引擎进程的 cwd。
 *
 * 顺序：用户显式选择 > 插件数据目录。
 *
 * 默认值不是可有可无的兜底：agent 跑一轮会在 ~/.claude/projects 留下会话记录，
 * cwd 就是这里传的值。挂在真实项目名下，「生成热点解读」这个动作本身会被那个
 * 项目的会话历史记成一次工作产出。收到插件目录后，这类会话归在
 * plugin-data/github-trending 下，谁产生的也一眼看得出。
 *
 * 没有第三层「侧栏第一个工作区」：留空就该是插件目录，不能悄悄跑到用户的
 * 真实项目里——那样「我什么都没选」和「我选了项目 A」的行为一模一样，没人能
 * 预料 cwd 到底在哪。宿主的 documentStorage 不可用时返回空串，由调用方报错
 * 让用户自己用「选择…」指定。
 */
async function resolveWorkspace(ctx, settings) {
  return pickWorkspace(settings, await pluginDataDir(ctx));
}

/** 用于比较的两个路径是否指向同一个目录：大小写、分隔符、尾部分隔符都不敏感。 */
function samePathKey(p) {
  return String(p || "")
    .trim()
    .replace(/[\\/]+$/, "")
    .replace(/\//g, "\\")
    .toLowerCase();
}

/** 侧栏分组名：宿主用目录名命名工作区，回执里照实说，用户才好去侧栏找。 */
function baseName(p) {
  const s = String(p || "").trim().replace(/[\\/]+$/, "");
  const i = Math.max(s.lastIndexOf("\\"), s.lastIndexOf("/"));
  return i >= 0 ? s.slice(i + 1) : s;
}

let workspaceRegistrations = new Map();

/**
 * 确保会话所在目录已经是宿主的侧栏工作区——「点了讨论，侧栏却没有会话」的根因修复。
 *
 * 宿主扫描会话目录时以工作区表为起点：`~/.claude/projects/<编码路径>/` 里写了
 * 多少 jsonl 都没用，只要对应目录不在侧栏工作区里，宿主就不会把它收进会话表，
 * 侧栏自然看不见（本机实测：所有已登记工作区的会话都在表里，plugin-data 下的
 * 会话一条都没有，但 jsonl 明明写得好好的）。
 *
 * 所以开会话前先登记工作目录。副作用是该目录会以目录名出现在侧栏工作区列表里，
 * 这恰好是「会话挂在哪个工作区下」的可见形式，用户随时可以在侧栏移除。
 *
 * 失败不阻断会话：宿主版本没有 workspaces API、权限没到位、或登记被拒时，仍照常
 * startRun，由调用方把「可能看不见」写进回执——按钮不能假死。
 *
 * 同一路径登记成功后就记住：不必每点一行都再查一遍列表；失败的不缓存，
 * 下次点击还会重试（偶发 IPC 失败不该让本页从此都看不见会话）。
 */
async function ensureWorkspaceRegistered(ctx, workspace) {
  const key = samePathKey(workspace);
  if (!key) return { visible: false, error: "" };
  const cached = workspaceRegistrations.get(key);
  if (cached) return cached;
  const remember = (result) => {
    if (result.visible) workspaceRegistrations.set(key, result);
    return result;
  };
  if (!ctx || !ctx.workspaces || typeof ctx.workspaces.add !== "function") {
    return { visible: false, error: "当前宿主不支持登记侧栏工作区，会话可能不会出现在侧栏" };
  }
  try {
    if (typeof ctx.workspaces.list === "function") {
      const rows = await withTimeout(ctx.workspaces.list(), WORKSPACE_REGISTER_TIMEOUT_MS, "工作区列表");
      const listed = (Array.isArray(rows) ? rows : []).some(
        (r) => r && samePathKey(r.path || r.workspacePath || r.dir) === key,
      );
      if (listed) return remember({ visible: true, error: "" });
    }
    await withTimeout(ctx.workspaces.add(workspace), WORKSPACE_REGISTER_TIMEOUT_MS, "登记工作区");
    // 新登记的工作区宿主还没扫过。补一次会话目录刷新：之前点过「讨论」、
    // jsonl 已经落盘但没进侧栏的会话能立刻找回来。startRun 建的新会话
    // 不依赖这次刷新（文档写明会立即出现在侧栏），所以这里不等待、失败也不报。
    if (ctx.sessions && typeof ctx.sessions.refresh === "function") {
      void Promise.resolve(ctx.sessions.refresh()).catch(() => {});
    }
    return remember({ visible: true, error: "" });
  } catch (error) {
    // 用原始 message 判权限：messageOf 会把 missing permission 归到网络那一套，
    // 这里的失败是 manifest 权限，不是网络授权。
    const raw = error && error.message ? String(error.message) : String(error || "");
    const hint = /host:workspace|permission|not declared/i.test(raw)
      ? "缺少登记工作区的权限，请重新安装插件（manifest 已声明 host:workspace）"
      : "登记侧栏工作区失败：" + messageOf(error);
    return remember({ visible: false, error: hint });
  }
}

/** 界面展示统一用本机分隔符；传给宿主与存储的仍是原始路径。 */
function displayPath(p) {
  const s = String(p || "").trim();
  if (!s) return "";
  return /^[A-Za-z]:[\\/]|^\\\\/.test(s) ? s.replace(/\//g, "\\") : s.replace(/\\/g, "/");
}

/**
 * 引擎目录。与工作志同一套：走 ctx.agent.catalog()，一次调用就同时拿到
 * 引擎、可用性、模型与 readOnly 标记。
 *
 * 不用 ctx.models：那是宿主模型目录接口，需要额外的 host:models 权限，
 * 且要分两次调（引擎一次、每个引擎的模型再一次），还没有 available 标记。
 */
let catalogLoading = false;

async function loadCatalog(ctx, options) {
  if (catalogLoading) return;
  const force = Boolean(options && options.force);
  if (!force && store.snap.catalogLoaded) return;
  catalogLoading = true;
  set({ modelsLoading: true, modelsError: "" });
  try {
    // 目录也按生成时真正会用的 cwd 去查，免得下拉里看到的引擎和实际跑的不是一套。
    const workspace = await resolveWorkspace(ctx, store.snap.settings);
    const list = await ctx.agent.catalog(workspace || undefined);
    const entries = (Array.isArray(list) ? list : []).filter(
      (e) => e && typeof e.engine === "string" && e.engine.trim() !== "",
    );
    set({ catalog: entries, catalogLoaded: true, modelsLoading: false });
  } catch (error) {
    // 「读不到引擎目录」和「没有可用引擎」是两回事，提示不能混。
    set({
      catalog: [],
      catalogLoaded: false,
      modelsLoading: false,
      modelsError: "读取引擎目录失败：" + messageOf(error),
    });
  } finally {
    catalogLoading = false;
  }
}

const ENGINE_LABELS = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  qoder: "Qoder",
  "qoder-cn": "Qoder (CN)",
  kimi: "Kimi CLI",
  grok: "Grok CLI",
  codebuddy: "CodeBuddy",
  minimax: "MiniMax",
  omp: "OMP",
  dsh: "DSH",
  agy: "AGY",
  pi: "Pi",
};

/** 宿主 catalog 的 id 是不可信输入：只认表里的自有属性。 */
function engineLabel(id) {
  const key = String(id || "").trim();
  if (!key) return "";
  const hit = Object.prototype.hasOwnProperty.call(ENGINE_LABELS, key)
    ? ENGINE_LABELS[key]
    : Object.prototype.hasOwnProperty.call(ENGINE_LABELS, key.toLowerCase())
      ? ENGINE_LABELS[key.toLowerCase()]
      : "";
  return hit || key;
}

/** 可用的排前面，组内按显示名排序（与工作志、CLI 安装检测插件一致）。 */
function sortCatalog(list) {
  return (Array.isArray(list) ? list.slice() : []).sort((a, b) => {
    const ai = a && a.available === false ? 1 : 0;
    const bi = b && b.available === false ? 1 : 0;
    if (ai !== bi) return ai - bi;
    return engineLabel(a && a.engine).localeCompare(engineLabel(b && b.engine), "en");
  });
}

/** 取选中引擎的目录条目；没显式选就返回第一个可用的。 */
function pickEntry(catalog, preferred) {
  const list = Array.isArray(catalog) ? catalog : [];
  const want = String(preferred || "").trim();
  if (want) return list.find((e) => e && e.engine === want) || null;
  return list.find((e) => e && e.available !== false) || null;
}

/**
 * 一轮解读的完整生命周期。把它收成一个对象而不是散在闭包里，是为了让
 * 「start 还在飞的时候用户点停止」也能被正确处理——那种时刻还没有 runId，
 * 只有会话对象知道这一轮已经作废。
 */
let activeDigest = null;

function newDigestSession(seq) {
  return {
    seq,
    runId: null,
    // start 还没 resolve 就被停止/切走：拿到 runId 后必须立刻 interrupt，
    // 否则宿主那侧的进程会跑到底、一直烧 token。
    cancelled: false,
    interrupted: false,
    settled: false,
    timer: null,
    off: null,
  };
}

/** 释放这一轮的事件订阅与定时器；幂等。 */
function releaseSession(session) {
  if (!session) return;
  session.settled = true;
  if (session.timer) {
    clearTimeout(session.timer);
    session.timer = null;
  }
  if (session.off) {
    try {
      session.off();
    } catch {
      /* 宿主可能已回收 */
    }
    session.off = null;
  }
  if (activeDigest === session) activeDigest = null;
}

/**
 * 打断这一轮在宿主侧的 run。
 *
 * 与 releaseSession 分开，是因为「停止」可能发生在 start 还没返回的时候：
 * 那一刻没有 runId 可打断，只能先记下 cancelled；等 start resolve 拿到 runId
 * 后再补这一刀。合并进幂等清理里就会被 settled 守卫挡掉，留下孤儿进程。
 *
 * 判据是「有没有真的起来一轮」（runId 是否存在），**不是** cancelled：超时、
 * 引擎报错同样是「插件放手了、宿主还在跑」，也必须打断。之前用 cancelled
 * 当闸门，导致 finish(error) 传了 interrupt 也被挡掉，120s 超时后宿主那侧
 * 继续烧 token 到自然结束。要不要打断由调用方决定（传不传 interruptRun），
 * 这里只保证不重复打断。
 */
function interruptSession(session, interruptRun) {
  if (!session || !session.runId || session.interrupted) return;
  if (typeof interruptRun !== "function") return;
  session.interrupted = true;
  try {
    void interruptRun(session.runId);
  } catch {
    /* 已结束 */
  }
}

function disposeSession(session, interruptRun) {
  releaseSession(session);
  interruptSession(session, interruptRun);
}

/**
 * 作废这一轮并打断宿主侧。
 *
 * 「先标记 cancelled、再打断」原本在停止/超时/卸载三处各写一遍，靠每个
 * 调用方记得两件事都做。收成一个动作后，漏掉任何一半都不可能发生。
 */
function cancelSession(session, ctx) {
  if (!session) return;
  session.cancelled = true;
  disposeSession(session, (runId) => ctx.agent.interrupt(runId));
}

/** 停止当前解读：无论它处于「准备中」「start 在飞」还是「流式中」。 */
function abortDigest(ctx) {
  digestSeq += 1;
  cancelSession(activeDigest, ctx);
  // 已经写出来的半截正文留着（用户可能还想看），但要标成「已停止」：
  // 否则它和一份正常写完的解读长得一模一样。
  set({ generating: false, digestStopped: Boolean(store.snap.digest) });
}

/* ---------- 单个仓库的讨论会话 ---------- */

/**
 * 和「生成解读」是两种东西，不能混用同一个 API：
 * - `agent.start` 的输出去向只有本插件，用户只能在面板里看完；
 * - `sessions.startRun` 会在侧栏起一个**宿主聊天会话**，用户能接着追问、能停、
 *   能我们之外的人接管。这正是「进项目里聊聊」需要的形态。
 *
 * 能力探测而不是硬用：`sessions` 是 0.3.18 才有的，宿主版本不达标时
 * `ctx.sessions` 不存在。这里必须给出可读文案，不能让按钮点了没反应。
 */
function supportsDiscuss(ctx) {
  const s = ctx && ctx.sessions;
  return Boolean(s && typeof s.startRun === "function");
}

let discussSeq = 0;

/**
 * 已经为哪些仓库开过会话：`仓库全名 -> { id, engine }`。
 *
 * 记成**跨榜单**的表而不是榜单内的：`resumeMode` 为 `always` 时用户明确要求
 * 「只要拿得到就接着聊」，那就不能因为换了一份榜单就把 id 扔掉。`session`
 * 模式靠 `discussSessionsStale` 这个标记来区分，而不是靠清空表。
 *
 * 这张表**要落盘**。只放内存里的话，插件重装 / 重新激活 / 宿主重启之后表就空了，
 * 用户看到的就是「每点一次都新开一条会话」——而侧栏里明明已经有四五条同一个
 * 仓库的会话。会话 ID 是宿主给的字符串，不含任何隐私内容，存进 settings 里
 * （`discussSessionIds`）比让它随着一次重装载入丢失更划算。
 *
 * **必须按引擎分开记**。会话 id 只在它所属的引擎下有意义；拿 claude 的 id 去
 * `selectSession("codex", ...)`，宿主要么拒绝、要么打开一条根本不是这次引擎的
 * 会话。所以一条记录的形状是
 *
 *   `{ id, engine, byEngine: { claude: "id-a", codex: "id-b" } }`
 *
 * `id` / `engine` 是「最近一次用的那条」，留作旧格式兼容与展示；真正查表走
 * `byEngine`。**同一个仓库在不同引擎下各有各的会话，互不覆盖**——早先只留一个
 * `{ id, engine }`，换引擎新开一轮就把另一个引擎的记录冲掉了，切回去又开新的。
 * 一个仓库下最多留 4 个引擎（现实中也就两三个），超出按插入序丢最旧的。
 *
 * sessionId 可能拿不到：`startRun` 文档写明引擎稍后才 announce，此时返回 null。
 * 那条路径**不记录**（不是记空串），再点时仍然新开——复用是加分项，拿不到 id
 * 时不能因此让按钮失败，也不该占着一个额度。
 *
 * 插入顺序即「最近用过」的顺序：`rememberDiscussSession` / `touchDiscussSession`
 * 每次都把该仓库挪到队尾，超限时从队首淘汰。上限见 DISCUSS_SESSION_LIMIT。
 */
let discussSessions = new Map();
/**
 * 自这张表上一次被写入以来，榜单是否已经换过（刷新 / 切视图 / 切时间档）。
 *
 * 用标记而不是清空表，是因为「总是续接」模式下换榜单不该丢掉会话。标记只影响
 * `session` 模式，见 shouldResume。
 *
 * 注意：**本次激活还没用过讨论时，刷新不算「换榜单」**。插件激活、页签首次
 * 加载都会走一遍 refresh，若那也算，`session` 模式就永远判定为「榜单已换」，
 * 落盘的会话 id 一次都用不上——用户看到的就是「不管设置里怎么选，每点一次都
 * 新开会话」。所以标记由 discussTouched 把着。
 */
let discussSessionsStale = false;
/** 本次激活内是否真的用讨论开过/打开过会话；没开过时 stale 语义没有意义。 */
let discussTouched = false;

/** 落盘上限：一个仓库一条记录。60 条 ≈ 每天讨论 5-10 个也能覆盖一周多。 */
const DISCUSS_SESSION_LIMIT = 60;

/** 一个仓库最多记几个引擎的会话。现实里宿主也就 claude / codex 两三个。 */
const DISCUSS_ENGINE_LIMIT = 4;

/**
 * 把落盘的一条值归一化成 `{ id, engine, byEngine }`；不是有效记录时返回 null。
 *
 * 兼容两代旧格式：
 * - `8ffb092`..`25faa4c`：裸字符串（没有 engine）；
 * - `25faa4c`.. 现在：`{ id, engine }`（一个仓库只留一个引擎的记录）。
 *
 * 两代都给不出 `byEngine`，就用 `id` / `engine` 补一条。`engine` 为空串表示
 * 「不知道属于哪个引擎」，这类记录**不再参与复用**——不知道该拿它去开哪个引擎
 * 的会话，拿去试反而可能打开错的会话。留着只是为了不让它被判成坏数据丢掉。
 */
function normaliseDiscussRow(value) {
  let id = "";
  let engine = "";
  const byEngine = {};
  if (typeof value === "string") {
    id = value.trim();
  } else if (value && typeof value === "object" && !Array.isArray(value)) {
    const raw = value.byEngine && typeof value.byEngine === "object" && !Array.isArray(value.byEngine)
      ? value.byEngine
      : {};
    for (const k of Object.keys(raw)) {
      const key = String(k).trim();
      const v = typeof raw[k] === "string" ? raw[k].trim() : "";
      if (key && v) byEngine[key] = v;
    }
    id = typeof value.id === "string" ? value.id.trim() : "";
    engine = typeof value.engine === "string" ? value.engine.trim() : "";
  } else {
    return null;
  }
  // 旧格式兜底：有 id 但没分槽时，engine 知道就归到那一槽。
  if (!id && engine) id = byEngine[engine] || "";
  if (id && engine && !byEngine[engine]) byEngine[engine] = id;
  if (!id && Object.keys(byEngine).length === 0) return null;
  return trimEngineSlots({ id, engine, byEngine });
}

/** 一个仓库的引擎分槽最多留 DISCUSS_ENGINE_LIMIT 个，按插入序丢最旧的。 */
function trimEngineSlots(row) {
  if (!row) return row;
  const keys = Object.keys(row.byEngine || {});
  if (keys.length <= DISCUSS_ENGINE_LIMIT) return row;
  const byEngine = {};
  for (const k of keys.slice(-DISCUSS_ENGINE_LIMIT)) byEngine[k] = row.byEngine[k];
  return { ...row, byEngine };
}

/**
 * 取某个仓库在某个引擎下的会话 id；没有就返回空串。
 *
 * 这是唯一的查表入口：别处一律走它，免得哪天有人漏改一处又退化成
 * 「拿别的引擎的 id 去开」。
 *
 * 例外：分槽全空的旧记录（`8ffb092` 起的裸字符串格式）不知道属于哪个引擎，
 * 但那多半就是用户一直在用的那个。照旧给它复用，成功打开时会被
 * `rememberDiscussSession` 顺手补上 engine，下次就进槽了。
 */
function sessionIdFor(row, engine) {
  if (!row || !engine) return "";
  const slots = row.byEngine || {};
  const hit = typeof slots[engine] === "string" ? slots[engine] : "";
  if (hit) return hit;
  const legacy = Object.keys(slots).length === 0 && !row.engine;
  return legacy && typeof row.id === "string" ? row.id : "";
}

/**
 * 按上限裁剪一张「仓库 → 记录」表。
 *
 * `Map` / 普通对象都保持插入顺序，这里两边都**按这个顺序**裁：淘汰的是最久
 * 没碰过的仓库。早先按 key 排序再 `slice(-N)`，留下的是字母序末尾的若干条，
 * 那是 bug——常点的 `rust-lang/rust` 会被裁掉，而某个从没再点过的 `zzz/zzz`
 * 会一直留着。
 */
function trimDiscussRows(rows) {
  const keys = Object.keys(rows);
  if (keys.length <= DISCUSS_SESSION_LIMIT) return rows;
  const out = {};
  for (const k of keys.slice(-DISCUSS_SESSION_LIMIT)) out[k] = rows[k];
  return out;
}

function normaliseDiscussSessions(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const valid = {};
  for (const k of Object.keys(raw)) {
    // 只认合法的 owner/name。空值也丢：它表示「开过但没拿到 id」，这跟
    // 「没有记录」在复用判断上完全等价（都要新开），占额度没有意义。
    if (!readmeRepoKey(k)) continue;
    const row = normaliseDiscussRow(raw[k]);
    if (row) valid[k] = row;
  }
  return trimDiscussRows(valid);
}

/**
 * 记一条会话 id（连同它属于哪个引擎）。
 *
 * **只写自己那一槽**，不碰别的引擎的记录：同一个仓库在 claude 与 codex 下各有
 * 一条会话，换引擎聊完再切回去，原来那条还得认得。
 *
 * 先 `delete` 再 `set`：`Map.set` 对已存在的 key 不会挪动位置，不这么做的话
 * 「最近用过」的仓库会一直停在队首，超限时被淘汰的反而是它。
 */
function rememberDiscussSession(repo, sessionId, engine) {
  if (!sessionId) return;
  const key = String(engine || "");
  const prev = discussSessions.get(repo) || { byEngine: {} };
  const byEngine = { ...(prev.byEngine || {}) };
  // 不知道该属于哪个引擎时不猜测：宁可只保留一个「最近一次」，也不随便塞槽。
  const merged = key ? { ...byEngine, [key]: sessionId } : byEngine;
  discussSessions.delete(repo);
  discussSessions.set(repo, {
    id: sessionId,
    engine: key,
    byEngine: trimEngineSlots({ byEngine: merged }).byEngine,
  });
  while (discussSessions.size > DISCUSS_SESSION_LIMIT) {
    const oldest = discussSessions.keys().next().value;
    discussSessions.delete(oldest);
  }
}

/**
 * 把某个仓库标记为「刚刚用过」——**命中已有会话时也必须调用**。
 *
 * 只在新建会话时记账是不够的：常点的仓库走的是「直接打开」那条路，从不经过
 * `rememberDiscussSession`，于是它永远停在队首。等下一份新会话进来，被淘汰的
 * 就是这个刚点过的仓库——用户下次再点它又变成新开一条，正是这个功能要解决的问题。
 *
 * @returns {boolean} 顺序是否真的变了（变了才需要写盘）
 */
function touchDiscussSession(repo) {
  if (!discussSessions.has(repo)) return false;
  // 已经在队尾就没有可挪的，省一次写盘。
  if (Array.from(discussSessions.keys()).pop() === repo) return false;
  const row = discussSessions.get(repo);
  discussSessions.delete(repo);
  discussSessions.set(repo, row);
  return true;
}

/**
 * 忘掉某个仓库在某个引擎下的会话 id（那条会话被删除/归档时）。
 *
 * 只删这一槽；全空了才删整条记录——否则下次 `normaliseDiscussRow` 会把它归一化
 * 成空壳，白白占一个额度。
 */
function forgetDiscussSession(repo, engine) {
  const row = discussSessions.get(repo);
  if (!row) return;
  const key = String(engine || "");
  const byEngine = { ...(row.byEngine || {}) };
  if (key) delete byEngine[key];
  const legacyStale = !key || row.engine === key;
  const keepLegacy = row.id && !legacyStale && Object.keys(byEngine).length === 0;
  if (Object.keys(byEngine).length === 0 && !keepLegacy) {
    discussSessions.delete(repo);
    return;
  }
  discussSessions.set(repo, {
    id: keepLegacy ? row.id : "",
    engine: keepLegacy ? row.engine : "",
    byEngine,
  });
}

/**
 * 激活后磁盘上的设置是否已经读回来了。
 *
 * 读盘是异步的（`activate` 里 fire-and-forget）。这之前 `store.snap.settings`
 * 还是 `DEFAULT_SETTINGS`，写盘会把磁盘上那份整个盖掉——包括 `discussSessionIds`
 * 和用户的提示词。所以所有写盘都要先等这一步。
 */
let settingsLoaded = Promise.resolve();
function whenSettingsLoaded() {
  return settingsLoaded;
}

/**
 * 把插件写进设置的一份补丁放到**当前** settings 上，然后落盘。
 *
 * 不能直接 `ctx.storage.set("settings", store.snap.settings)` 之外再传一份
 * 「渲染时抄下来的 form」：设置页里的 `form` 是它那一刻的快照，
 * `discussSessionIds` 这种**只在会话建立时**才变、设置页根本不编辑的字段，
 * 在快照里是旧值。用户开会话之后去改一下语言，保存时整份 form 回写，
 * 刚记下的 sessionId 就被这份旧快照覆盖成空——内存表与磁盘同时丢。
 * 这正是「点同一个仓库还是会开多个会话」的另一半原因。
 *
 * 所以所有写入都以 `store.snap.settings` 为底、只盖 patch 里的键。
 * @returns {Promise<boolean>} 是否落盘成功（失败不影响主流程，但调用方要能知道）
 */
function saveSettings(ctx, patch) {
  // 补丁先落到内存（store 的订阅者立刻要看到），写盘则等设置读回来之后再发，
  // 否则会用默认值把磁盘上的会话表与提示词盖掉。
  setSettings(patch || {});
  return whenSettingsLoaded().then(() =>
    Promise.resolve(ctx.storage.set("settings", store.snap.settings)).then(
      () => true,
      () => false,
    ),
  );
}

/** 把当前表写回设置。失败不报错：这只是省一次重复开会话，不影响主流程。 */
function persistDiscussSessions(ctx) {
  const rows = {};
  // 内存表已经裁过；这里再走一次是为了防手改/旧版本写进来的超大表。
  for (const [repo, row] of discussSessions) {
    if (!row) continue;
    const trimmed = trimEngineSlots(row);
    if (trimmed.id || Object.keys(trimmed.byEngine || {}).length > 0) rows[repo] = trimmed;
  }
  setSettings({ discussSessionIds: trimDiscussRows(rows) });
  return saveSettings(ctx);
}

/**
 * 会话表的落盘串行队列。
 *
 * 讨论这条路会在两个时刻记 id：`startRun` resolve 时（宿主当场给）和
 * `plugin-run` 回执时（引擎稍后才 announce）。两次几乎同时发生，并发写盘
 * 有可能后发的先到、把先记的 id 盖掉。排队执行，写盘顺序与记录顺序一致。
 */
let discussPersistChain = Promise.resolve();
function queuePersistDiscussSessions(ctx) {
  const run = () => persistDiscussSessions(ctx);
  discussPersistChain = discussPersistChain.then(run, run);
  return discussPersistChain;
}

/** 榜单换了一份。不是清空表——清不清由 resumeMode 决定。 */
function markDiscussSessionsStale() {
  // 本次激活内还没用过讨论：这份「换榜单」与上次开会话没有因果关系，
  // 不该因此把落盘的会话判成不可用。
  if (!discussTouched) return;
  discussSessionsStale = true;
}

/**
 * 尚未拿到 sessionId 的会话启动。
 *
 * SDK 写明 `startRun` 成功时可能返回 `sessionId: null`——引擎稍后才 announce，
 * 那一刻宿主经 `plugin-run://<pluginId>` 事件把 `{ runId, sessionId }` 回执过来。
 * 不接这个回执，id 永远拿不到：表永远是空的，用户点同一个仓库每一次都新开一条。
 *
 * 以 `runId` 为键（同一时刻可能有多轮），由回执里的 repo/engine 补记。
 * 条目有上限：回执可能永远不来（用户中途关了宿主），不能让表无限长。
 */
const PENDING_SESSION_LIMIT = 20;
/**
 * 等回执的最长时间。回执可能永远不来（宿主旧版本、用户在途中关了会话），
 * 超时后必须放手：一直挡着等于这个仓库的「讨论」按钮永久不可用。
 */
const PENDING_SESSION_TTL_MS = 90000;
/** runId → { repo, engine, at }：等回执的轮次。 */
const pendingSessionStarts = new Map();

function holdPendingSession(runId, repo, engine) {
  if (!runId || !repo) return;
  pendingSessionStarts.set(runId, { repo, engine: String(engine || ""), at: Date.now() });
  while (pendingSessionStarts.size > PENDING_SESSION_LIMIT) {
    const oldest = pendingSessionStarts.keys().next().value;
    pendingSessionStarts.delete(oldest);
  }
}

/**
 * 某个仓库在某个引擎下是否正有一条「建了但还拿不到 id」的会话。
 *
 * 这是回执到达前的空窗：`startRun` 已经 resolve（按钮回到可点），id 还在路上。
 * 这期间再点一次，表里查不到 id，就会又开一条——用户看到的就是「点两下两条」。
 * 所以空窗内直接拒绝，让用户等一两秒。超时的挂起项在这里惰性清掉。
 */
function pendingSessionFor(repo, engine) {
  const want = String(engine || "");
  const now = Date.now();
  for (const [runId, row] of pendingSessionStarts) {
    if (now - row.at > PENDING_SESSION_TTL_MS) {
      pendingSessionStarts.delete(runId);
      continue;
    }
    if (row.repo === repo && row.engine === want) return true;
  }
  return false;
}

function resetPendingSessions() {
  pendingSessionStarts.clear();
}

/**
 * 处理宿主对本插件 `startRun` 轮次的回执。
 *
 * 回执里带 `sessionId` 时立刻补记——这是「宿主当场没给、稍后才 announce」那条路
 * 唯一能拿到 id 的地方。拿到后 `persistDiscussSessions` 落盘，下次点击走
 * `selectSession` 直接打开，不再新开。
 *
 * `done` / `error` 都意味着这一轮已经不需要再等了，顺手清掉挂起项。
 */
function handlePluginRunEvent(ctx, event) {
  if (!event || typeof event !== "object") return;
  const runId = typeof event.runId === "string" ? event.runId : "";
  const pending = runId ? pendingSessionStarts.get(runId) : null;
  const sessionId = typeof event.sessionId === "string" ? event.sessionId.trim() : "";
  if (pending && sessionId) {
    rememberDiscussSession(pending.repo, sessionId, pending.engine);
    void queuePersistDiscussSessions(ctx);
  }
  if (runId && (event.kind === "done" || event.kind === "error")) pendingSessionStarts.delete(runId);
}

/**
 * 彻底清空（卸载 / 重新激活时用）。
 *
 * 注意：清的是**内存表**，磁盘上的那份要留着。重新激活后 settings 会把它读回来，
 * 那才是「同一个仓库只该有一条会话」的保证。
 */
function resetDiscussSessions() {
  discussSessions = new Map();
  discussSessionsStale = false;
  discussTouched = false;
  resetPendingSessions();
}

/**
 * 为一行榜单打开（或新建）讨论会话。
 *
 * 两条完全不同的路径，不能混：
 *
 * 1. **已经有这个仓库的会话** → `sessions.selectSession` 直接把侧栏切过去。
 *    这条路**不花 token**，用户看到的就是「接着上次聊」。这正是用户点第二次
 *    时期望的行为；用 `startRun` 带上 sessionId 虽然也能续上，但那会真的再跑
 *    一轮模型——为了「打开一个已有会话」花一次推理，没有道理。
 * 2. **没有会话** → `startRun` 新建一条，并把返回的 sessionId 落盘记住。
 *
 * 不走 activeDigest 那套「start 在飞时点停止」的状态机：会话一旦建起来就归
 * 宿主聊天托管，插件的责任只有「别开两轮」和「失败要说清楚」。
 */
async function discussRepo(ctx, row) {
  const snap = store.snap;
  if (!row || !row.repo) return;
  if (snap.discussing) return;
  if (!supportsDiscuss(ctx)) {
    set({ discussError: "当前 CC GUI 版本不支持从插件发起会话，请升级宿主" });
    return;
  }

  const seq = ++discussSeq;
  // 新的一轮先把上一条「已开会话」提示收掉：否则连续点两行，页面会同时说
  // 两个仓库都开了会话，而实际只留了最后那条。
  set({
    discussing: row.repo,
    discussError: "",
    discussNotice: "",
    discussWorkspace: "",
    discussWarning: "",
    discussResumed: false,
    discussOpened: false,
    discussPromptName: "",
  });
  const settings = snap.settings;
  const bailed = (message) => {
    if (seq === discussSeq) set({ discussing: "", discussError: message });
  };

  try {
    const workspace = await resolveWorkspace(ctx, settings);
    if (seq !== discussSeq) return;
    // 工作目录是会话的 cwd，拿不到就没法保证 agent 在哪读文件。
    if (!workspace) return bailed("读不到插件数据目录，请到设置里点「选择…」指定一个 AI 工作区");

    // 会话要出现在侧栏，前提是它挂在一个宿主已登记的工作区下。不登记就
    // startRun，jsonl 会照写、进程会照跑，但侧栏里一条都看不到——先登记再开会话。
    const registration = await ensureWorkspaceRegistered(ctx, workspace);
    if (seq !== discussSeq) return;

    // 引擎目录可能还没加载（用户直接从页签点进来看榜单）。
    if (!store.snap.catalogLoaded) {
      await loadCatalog(ctx);
      if (seq !== discussSeq) return;
    }
    if (store.snap.modelsError) return bailed(store.snap.modelsError);

    const entry = pickEntry(store.snap.catalog, settings.engine);
    if (!entry) return bailed("没有可用引擎，请先在设置里选择");
    if (entry.available === false) return bailed(engineLabel(entry.engine) + " 当前不可用，请换一个引擎");

    const models = (entry.models || []).filter((m) => m && typeof m.id === "string" && m.id.trim());
    const model = String(settings.model || "").trim() || (models[0] ? models[0].id : undefined);

    // 已经有这个仓库在本引擎下的会话：直接切过去，不跑模型。
    // 策略交给 shouldResume：never 时明确要求新开，其余情况优先复用。
    const known = discussSessions.get(row.repo);
    // 只认**本引擎**那一槽。别的引擎的 id 拿去 selectSession 要么被拒、要么
    // 打开一条根本不是这个引擎的会话；那条记录现在也不会被覆盖，切回去还在。
    const resumeId = sessionIdFor(known, entry.engine);
    const resumable = Boolean(resumeId);
    // 上一条会话刚建、id 还在路上（引擎稍后才 announce）。这时再开一条就是
    // 用户反馈的「点同一个仓库多出好几条」，所以空窗内直接挡住。
    // 「总是新开」是用户明确要的，不挡。
    if (
      !resumable &&
      normaliseResumeMode(settings.resumeMode) !== "never" &&
      pendingSessionFor(row.repo, entry.engine)
    ) {
      return bailed("上一次会话还在建立中，稍等一两秒再点（不会重复开会话）");
    }
    if (shouldResume(settings.resumeMode, discussSessionsStale, resumable) && typeof ctx.sessions.selectSession === "function") {
      try {
        await withTimeout(
          ctx.sessions.selectSession(entry.engine, resumeId, workspace),
          DISCUSS_TIMEOUT_MS,
          "会话打开",
        );
        if (seq !== discussSeq) return;
        // 打开成功也算「这份榜单认领过」：后面的点击继续走这条路。
        discussTouched = true;
        discussSessionsStale = false;
        // 命中即刷新位置，否则这个仓库会一直是「最久没用过的」，下一份新会话
        // 进来就被淘汰掉。顺序真的变了才写盘。
        if (touchDiscussSession(row.repo)) void queuePersistDiscussSessions(ctx);
        set({
          discussing: "",
          discussError: "",
          discussNotice: row.repo,
          discussWorkspace: registration.visible ? baseName(workspace) : "",
          discussWarning: registration.visible ? "" : registration.error,
          discussResumed: true,
          discussOpened: true,
          discussPromptName: "",
        });
        return;
      } catch (error) {
        // 打开失败（会话被归档/删除、宿主版本变了）不能把按钮卡死：
        // 落到下面新建一条，并把这个失效的 id 清掉。**只清本引擎那一槽**——
        // 别的引擎的会话还在，删整条记录会让切回去时又开新的。
        forgetDiscussSession(row.repo, entry.engine);
        void persistDiscussSessions(ctx);
      }
    }

    // 设置里可能维护了多份提示词，用选中的那份；没设置过就用内置模板。
    const chosen = pickPrompt(settings.prompts, settings.defaultPromptId);
    const prompt = buildDiscussPrompt({
      row,
      view: snap.view,
      period: snap.view === "rising" ? RISING_PERIOD.key : settings.period,
      language: snap.view === "trending" ? settings.language : "",
      // 「随便看看」的行没有名次/涨跌，来源得如实写成随机抽样或搜索结果，
      // 否则模型会以为这是一个有排名的榜单。
      scopeText: scopeTextOf(snap),
      template: chosen.text,
    });

    // 走到这里只有两种可能：没有本引擎可复用的会话，或者宿主不支持
    // selectSession。后者退回复用式 startRun（会真的再跑一轮），只为兼容旧宿主。
    // 别的引擎有记录也走这里——按当前引擎新开一条，那条记录原样留着。
    const fallbackResume =
      typeof ctx.sessions.selectSession === "function"
        ? ""
        : resumable
          ? resumeId
          : "";

    // 新会话不带 sessionId：宿主会建一个，侧栏立即可见。
    // 续接时传 sessionId 会切回那个会话并沿用它的模型/强度（文档明确覆盖会被忽略）。
    const started = await withTimeout(
      ctx.sessions.startRun({
        sessionId: fallbackResume || undefined,
        engine: entry.engine,
        model: model || undefined,
        prompt,
        workspacePath: workspace,
      }),
      DISCUSS_TIMEOUT_MS,
      "会话启动",
    );

    // 记住这一行的 sessionId 和它所属引擎，供下次点击时直接打开它。
    // `started.sessionId` 可能为 null——引擎稍后才 announce，回执走
    // `plugin-run://` 事件。这时先把 runId 挂起，等回执补记；否则 id 永远
    // 拿不到，同一个仓库点几次就开几条会话。
    const sessionId = started && typeof started.sessionId === "string" && started.sessionId ? started.sessionId : "";
    const startedRunId = started && typeof started.runId === "string" ? started.runId : "";
    if (sessionId) rememberDiscussSession(row.repo, sessionId, entry.engine);
    else holdPendingSession(startedRunId, row.repo, entry.engine);
    // 落盘：内存表熬不过重装/重新激活/宿主重启，而用户的观感是「每点一次
    // 就多一条会话」。写盘失败不影响这次点击，所以不 await 它的错误。
    void queuePersistDiscussSessions(ctx);
    // 这份榜单已经「认领」过，后面的点击不再算跨榜单。
    discussTouched = true;
    discussSessionsStale = false;

    // 不跳转这件事必须写在页面上。侧栏多一行对正在扫榜的人是很容易错过的，
    // 不给提示就会被理解成「按钮没反应」，进而连点，多开一轮真 token。
    if (seq === discussSeq)
      set({
        discussing: "",
        discussError: "",
        discussNotice: row.repo,
        discussWorkspace: registration.visible ? baseName(workspace) : "",
        discussWarning: registration.visible ? "" : registration.error,
        discussResumed: Boolean(fallbackResume),
        // 用哪份提示词要说出来：用户维护了好几份，回执不写名字就分不清刚才
        // 点的是哪一套要求。内置默认时不显示（那是没有选择的选择）。
        discussPromptName: chosen.id ? chosen.name : "",
      });
  } catch (error) {
    // 用原始 message 判权限，不要过 messageOf：那边把 "missing permission"
    // 一概当网络授权问题，会把「没装 host:session」误报成「重新安装插件」。
    const rawMessage = error && error.message ? String(error.message) : String(error || "");
    const hint = /host:session|permission|not declared/i.test(rawMessage)
      ? "缺少会话权限，请重新安装插件（manifest 已声明 host:session）"
      : /会话启动\s*timeout/i.test(rawMessage)
        ? "宿主没有及时建起会话（30 秒），可以直接再点一次"
        : messageOf(error);
    bailed("开会话失败：" + hint);
  }
}

/**
 * 起一轮解读，并在「带着旧 sessionId 被拒」时清掉 id 重开一次。
 *
 * 宿主对已删除/不属于当前工作区的 sessionId 是直接拒绝整轮，不会帮你新开。
 * 只重试一次、且只对带 id 的那次生效——没有 id 还失败说明是别的原因，
 * 重试只会把真实错误盖成 timeout。
 *
 * @returns {Promise<{ runId?: string, sessionId?: string }>}
 */
async function startDigestRun(ctx, entry, model, workspace, prompt, resumeId) {
  const once = (sessionId) =>
    ctx.agent.start({
      sessionId: sessionId || undefined,
      engine: entry.engine,
      model,
      workspacePath: workspace,
      prompt,
      // 宿主里 claude 不支持隔离只读，传 true 会被整轮拒绝（不是降级）。
      // 只有 catalog 明确声明支持的引擎（Pi、Codex 规划）才请求只读。
      readOnly: supportsReadOnly(entry),
    });

  if (!resumeId) return once("");
  try {
    return await once(resumeId);
  } catch (error) {
    // 清掉这条失效记录，下一轮才不会又拿着它去撞。写盘失败不影响本轮。
    persistSettings(ctx, { digestSessionId: "" }).catch(() => {});
    return await once("");
  }
}

async function generateDigest(ctx) {
  const snap = store.snap;
  if (snap.repos.length === 0) {
    set({ httpError: "先刷新出榜单再生成解读" });
    return;
  }
  if (snap.generating || activeDigest) return;

  const settings = snap.settings;
  const view = snap.view;
  const period =
    view === "rising" ? RISING_PERIOD.key : view === "browse" ? "browse" : settings.period;
  const seq = ++digestSeq;

  // 立刻置 generating：下面有两个 await，等到那时再置，双击就能开出两轮。
  set({
    generating: true,
    digest: "",
    digestStopped: false,
    httpError: "",
  });
  const session = newDigestSession(seq);
  activeDigest = session;

  const bailed = (message) => {
    if (activeDigest === session) activeDigest = null;
    session.settled = true;
    if (seq === digestSeq) set({ generating: false, httpError: message });
  };

  const built = buildDigestPrompt({
    view,
    period,
    language: view === "trending" ? settings.language : "",
    // 「随便看看」的榜单不是排行榜：不说清楚来源，模型会把随机抽样写成
    // 「今天在热什么」，那是在编结论。
    scopeText: scopeTextOf(store.snap),
    // 解读只看筛出来的行：屏幕上筛剩 3 个却解读 25 个，模型会写出用户看不见
    // 的结论。筛选说明一并带进 prompt，模型才不会把「这批」说成「全部」。
    filterNote: filterScopeNote(snap.keyword),
    repos: filterRows(snap.repos, snap.keyword),
    dropped: snap.dropped,
    isFirstRun: snap.isFirstRun,
  });
  set({ digestTruncated: built.truncated, digestIncluded: built.included, digestTotal: built.total });

  const workspace = await resolveWorkspace(ctx, settings);
  if (seq !== digestSeq || session.cancelled) return bailed("");
  if (!workspace) return bailed("读不到插件数据目录，请到设置里点「选择…」指定一个工作区");

  // 中央页签不会先打开设置页，引擎目录要在这里按需补一次。
  if (!store.snap.catalogLoaded) {
    await loadCatalog(ctx);
    if (seq !== digestSeq || session.cancelled) return bailed("");
  }
  if (store.snap.modelsError) return bailed(store.snap.modelsError);

  const entry = pickEntry(store.snap.catalog, settings.engine);
  if (!entry) return bailed("没有可用引擎，请先在设置里选择");
  if (entry.available === false) return bailed(engineLabel(entry.engine) + " 当前不可用，请换一个引擎");

  // 模型：用户选的优先，否则用该引擎的第一个；catalog 的 label 是显示名。
  const models = (entry.models || []).filter((m) => m && typeof m.id === "string" && m.id.trim());
  const model = String(settings.model || "").trim() || (models[0] ? models[0].id : undefined);
  const engine = entry.engine;

  let queued = [];
  let text = "";

  const finish = (error, value) => {
    if (session.settled) return;
    if (error) {
      // 超时/引擎报错时宿主那侧未必已经停：和「用户点停止」走同一条打断
      // 路径，否则 120s 后插件放手、宿主进程继续烧 token 到自然结束。
      cancelSession(session, ctx);
    } else {
      disposeSession(session, null);
    }
    if (seq !== digestSeq) return;
    if (error) {
      set({ generating: false, httpError: messageOf(error) });
      return;
    }
    set({ generating: false, digest: value, digestStopped: false });
  };

  const handleEvent = (event) => {
    if (session.settled) return;
    if (event.kind === "delta") {
      const piece =
        typeof event.data === "object" && event.data
          ? event.data.text || event.data.delta || event.data.content || ""
          : typeof event.data === "string"
            ? event.data
            : "";
      if (!piece) return;
      text += piece;
      if (seq === digestSeq) set({ digest: text });
      return;
    }
    if (event.kind === "done") {
      finish(null, text);
      return;
    }
    if (event.kind === "error") {
      const detail = (event.data && (event.data.message || event.data.error)) || "模型返回了错误";
      finish(new Error(String(detail)));
    }
  };

  // 订阅必须在 start 之前建立：宿主可能先推 delta，再 resolve runId。
  session.off = ctx.events.on("agent://" + PLUGIN_ID, (event) => {
    if (!event || typeof event !== "object" || session.settled) return;
    if (!session.runId) {
      queued.push(event);
      if (queued.length > 500) queued.shift();
      return;
    }
    if (event.runId !== session.runId) return;
    handleEvent(event);
  });

  session.timer = setTimeout(() => finish(new Error("生成超时")), AGENT_TIMEOUT_MS);

  try {
    // 解读固定复用同一条后台会话：每点一次就新开一条，侧栏（以及宿主的会话库）
    // 会被一堆「只读、写过一次就没人再看」的会话塞满。传 sessionId 即续接，
    // 上下文连续反而更好用——上次解读过的榜单这次还认得。
    //
    // 复用有两层兜底，缺一层就会把用户卡死：
    // 1. 没有 id（首轮/旧版本）→ 不传，宿主新开；
    // 2. **id 失效**（用户把那条会话删了 / 换了工作区）→ 宿主会直接拒绝整轮。
    //    这时必须清掉 id 再新开一次，否则之后**每一次**解读都失败，而界面上
    //    只有一句看不懂的报错。第二层只在「带 id 的那次」生效，不会掩盖真实错误。
    const started = await startDigestRun(ctx, entry, model, workspace, built.prompt, settings.digestSessionId);
    const runId = started && started.runId ? started.runId : null;
    session.runId = runId;
    // agent.start 可能回 sessionId（有的引擎只回 runId）。拿到就落盘，
    // 下次续接；拿不到说明宿主不给这条路径，那就保持现状，不硬凑。
    const startedSessionId =
      started && typeof started.sessionId === "string" && started.sessionId ? started.sessionId : "";
    if (startedSessionId && startedSessionId !== settings.digestSessionId) {
      persistSettings(ctx, { digestSessionId: startedSessionId }).catch(() => {});
    }
    // 用户在 start 期间点了停止 / 切了视图 / 卸载了插件：这一轮已经作废，
    // 但宿主的进程刚起来，必须当场打断。
    if (session.cancelled || seq !== digestSeq) {
      cancelSession(session, ctx);
      return;
    }

    const buffered = queued;
    queued = [];
    // 没有 runId 时退化为接收全部：本插件同一时刻只跑一轮解读，没有别的轮次可混淆。
    for (const event of buffered) {
      if (runId && event.runId !== runId) continue;
      handleEvent(event);
    }
  } catch (error) {
    finish(error);
  }
}

/* ---------- 渲染 ---------- */

function Dot({ color }) {
  const h = appCtx.react.createElement;
  return h("span", { className: "gt-dot", style: color ? { background: color } : undefined, "aria-hidden": "true" });
}

/** 增量单位跟着榜单时间档走，周榜不能写「今日」。 */
const GAIN_LABEL = { daily: "今日", weekly: "本周", monthly: "本月", rising: "star" };
function gainLabel(period) {
  return GAIN_LABEL[period] || "近期";
}

function movementLabel(row) {
  if (row.isNew) return "新上榜";
  const delta = row.rankDelta;
  if (!Number.isFinite(delta) || delta === 0) return "";
  return delta > 0 ? "↑" + delta : "↓" + Math.abs(delta);
}

function movementClass(row) {
  if (row.isNew) return " gt-move--new";
  const delta = row.rankDelta;
  if (!Number.isFinite(delta) || delta === 0) return "";
  return delta > 0 ? " gt-move--up" : " gt-move--down";
}

function RepoRow({ row, ctx, discussing, readme }) {
  const h = appCtx.react.createElement;
  const href = safeHref(row.url);
  const movement = movementLabel(row);
  // owner/name 可能缺失：掉榜行直接来自磁盘快照，只校验过 repo 是字符串。
  // 少一个字段就会渲染成 "undefined / undefined"，比不显示更糟。
  const repoName = String(row.repo || "");
  const slash = repoName.indexOf("/");
  const owner = row.owner || (slash > 0 ? repoName.slice(0, slash) : repoName);
  const name = row.name || (slash > 0 ? repoName.slice(slash + 1) : "");
  const busy = Boolean(discussing) && discussing === row.repo;
  // 一次只能开一个：别的行在开的时候按钮禁用，避免连点开出好几个真会话。
  const blocked = Boolean(discussing) && !busy;
  // readme 传的是整块快照，展开状态由 readmeOpen 决定——同一时刻只开一行。
  const readmeOpen = Boolean(readme) && readme.readmeOpen === repoName;
  // 搜索结果里精确命中的那一行标一下：`in:name` 是模糊匹配，搜 react 会先出
  // facebook/react-native，不标就得多扫几眼才知道「我要的那个在哪」。
  const exactHit =
    Boolean(readme) && readme.view === "browse" && readme.discoverTerm
      ? isExactNameMatch(row, readme.discoverTerm)
      : false;

  return h(
    "li",
    { className: "gt-row" },
    h(
      "div",
      { className: "gt-row-main" },
      h(
        "div",
        { className: "gt-row-title" },
        Number.isFinite(row.rank) ? h("span", { className: "gt-rank" }, row.rank) : null,
        href
          ? h(
              "a",
              { className: "gt-repo", href, target: "_blank", rel: "noreferrer noopener", title: row.repo },
              h("span", { className: "gt-repo-owner" }, owner + (name ? " /" : "")),
              name ? h("span", { className: "gt-sep" }, " ") : null,
              name || null,
            )
          : h("span", { className: "gt-repo" }, repoName),
        exactHit ? h("span", { className: "gt-hit", title: "仓库名与搜索词一致" }, "正中") : null,
        movement
          ? h("span", { className: "gt-move" + movementClass(row) }, movement)
          : null,
        // 放在标题行末尾：跟仓库名同一视觉层级，用户扫榜时顺手就能点。
        // 两个按钮共用一条 CSS（.gt-discuss）管淡入，一起浮现，不会一高一低。
        h(
          "button",
          {
            type: "button",
            className: "gt-btn gt-discuss gt-discuss--lead",
            onClick: () => void toggleReadme(ctx, row),
            // 不跟 discussing 联动：读 README 和开会话是两件互不冲突的事，
            // 唯一要防的是同一时刻开两个 README（那由 readmeOpen 单例保证）。
            "aria-expanded": readmeOpen ? "true" : "false",
            title: readmeOpen ? "收起 README" : "就地展开 README，不用跳浏览器",
            "aria-label": (readmeOpen ? "收起 " : "展开 ") + row.repo + " 的 README",
          },
          readmeOpen ? "收起 README" : "README",
        ),
        h(
          "button",
          {
            type: "button",
            className: "gt-btn gt-discuss" + (busy ? " gt-discuss--busy" : ""),
            onClick: () => void discussRepo(ctx, row),
            disabled: blocked || busy,
            title: "在 AI 工作区里开一个会话，分析这个项目",
            "aria-label": "就 " + row.repo + " 开会话",
          },
          busy ? "打开中…" : "讨论",
        ),
      ),
      row.description ? h("p", { className: "gt-desc" }, row.description) : null,
      h(
        "div",
        { className: "gt-meta" },
        row.language ? h("span", { className: "gt-lang" }, h(Dot, { color: row.languageColor }), row.language) : null,
        Number.isFinite(row.stars) ? h("span", { className: "gt-stat" }, "★ " + fmtNumber(row.stars)) : null,
        Number.isFinite(row.gain)
          ? h(
              "span",
              { className: "gt-gain" },
              "+" + fmtNumber(row.gain) + " " + gainLabel(row.gainPeriod),
            )
          : null,
        Number.isFinite(row.ageDays) && !(readme && readme.view === "browse")
          ? h("span", { className: "gt-stat" }, row.ageDays + " 天前创建")
          : null,
      ),
      readmeOpen ? h(ReadmePanel, { readme, href }) : null,
    ),
  );
}

/**
 * 行内 README 预览。
 *
 * 挂在行内（而不是浮层/新页签）是为了「扫到哪个看哪个」：浮层会盖住榜单，
 * 关掉之后又是滚回原处，来回两三次人就不看了。
 *
 * 正文一律走自写的 Markdown 子集渲染，不拼 HTML——README 是远端不可信内容。
 */
function ReadmePanel({ readme, href }) {
  const h = appCtx.react.createElement;
  const status = readme.readmeLoading
    ? h(
        "p",
        { className: "gt-readme-note" },
        h("span", { className: "gt-spinner", "aria-hidden": "true" }),
        "正在读 README…",
      )
    : readme.readmeError
      ? h("p", { className: "gt-readme-note gt-readme-note--error" }, readme.readmeError)
      : readme.readmeText
        ? h(
            "p",
            { className: "gt-readme-note" },
            readme.readmeTruncated
              ? "只显示前 " + readme.readmeText.length + " 字（共 " + readme.readmeTotal + " 字）"
              : "README 全文",
            href
              ? h(
                  "a",
                  { className: "gt-readme-more", href, target: "_blank", rel: "noreferrer noopener" },
                  "在 GitHub 上查看",
                )
              : null,
          )
        : null;

  return h(
    "section",
    { className: "gt-readme", "aria-busy": readme.readmeLoading ? "true" : "false" },
    status,
    readme.readmeText
      ? h("div", { className: "gt-readme-body" }, renderDigestMarkdown(readme.readmeText))
      : null,
  );
}

/**
 * 「随便看看」的搜索框 + 换一批。
 *
 * 输入框内容放组件局部 state，不写回 store：每敲一个字就换一批显然是错的，
 * 提交（回车/点「搜索」）才去 GitHub。清空输入框再提交 = 回到换一批。
 */
function DiscoverBar({ snap, ctx }) {
  const R = appCtx.react;
  const h = R.createElement;
  const textState = R.useState("");
  const text = textState[0];
  const setText = textState[1];
  // 搜索生效时输入框要显示那个词：否则清空后看不出「现在这批是搜出来的」。
  // 空串也必须同步——「换一批」后留着旧关键词，页面就在说谎。
  R.useEffect(() => {
    setText(snap.discoverTerm || "");
  }, [snap.discoverTerm]);

  const busy = snap.loading;
  const submit = (raw) => {
    const term = String(raw === undefined ? text : raw).trim();
    if (busy) return;
    // 提交时先清空列表再拉：换一批/换关键词时旧行留着会让人以为结果出来了。
    set({ repos: [], loaded: false, discoverTerm: term, discoverBand: "", discoverTotal: 0 });
    void refresh(ctx, { force: true, term });
  };
  // 空输入时「搜索」等于换一批，语义上是「取消搜索」，这也正是用户想要的。
  const onSearch = () => submit(text);
  const onRandom = () => {
    if (busy) return;
    set({ repos: [], loaded: false, discoverTerm: "", discoverBand: "", discoverTotal: 0 });
    void refresh(ctx, { force: true, term: "" });
  };

  return h(
    "div",
    { className: "gt-group gt-discover" },
    h(
      "form",
      {
        className: "gt-search",
        onSubmit: (event) => {
          if (event && typeof event.preventDefault === "function") event.preventDefault();
          onSearch();
        },
      },
      h("input", {
        type: "search",
        className: "gt-input gt-search-input",
        value: text,
        placeholder: "搜仓库名，回车去 GitHub 查",
        "aria-label": "搜索仓库名",
        maxLength: SEARCH_TERM_LIMIT,
        disabled: busy,
        onChange: (event) => setText(event && event.target ? String(event.target.value || "") : ""),
        // Esc 清空：输入框里最常见的「算了」，比逼用户逐个删字强。
        onKeyDown: (event) => {
          if (event && event.key === "Escape") setText("");
        },
      }),
      h(
        "button",
        {
          type: "submit",
          className: "gt-btn",
          disabled: busy,
          title: text.trim() ? "按仓库名到 GitHub 上搜索" : "没有关键词时等同于换一批",
        },
        "搜索",
      ),
    ),
    h(
      "button",
      {
        type: "button",
        className: "gt-btn",
        onClick: onRandom,
        disabled: busy,
        title: "重新随机抽一个 star 档位与页码",
      },
      "换一批",
    ),
  );
}

/**
 * 榜单内本地筛选。
 *
 * 只在已经加载的行里过滤，不发任何请求——这和「随便看看」的搜索框是两件事：
 * 那个是去 GitHub 查，这个是看手里这批里有没有。所以它放在状态行下面、
 * 紧挨着列表，而不是放进工具栏。
 *
 * 关键词直接存在 store 里（`snap.keyword`）：唯一数据源，输入框不会和生效的
 * 筛选条件说两套话。
 */
function FilterBar({ snap, total }) {
  const R = appCtx.react;
  const h = R.createElement;
  const shown = filterRows(snap.repos, snap.keyword).length;
  const filtering = isFiltering(snap.keyword, snap.repos);
  return h(
    "div",
    { className: "gt-filter" },
    h("input", {
      type: "search",
      className: "gt-input gt-filter-input",
      value: snap.keyword,
      placeholder: "在这批里筛：仓库名 / 描述 / 语言",
      "aria-label": "在本批榜单里筛选",
      maxLength: KEYWORD_LIMIT,
      spellCheck: false,
      onChange: (event) => {
        const value = normaliseKeyword(event && event.target ? event.target.value : "");
        set({ keyword: value });
      },
      // Esc 清空：和「随便看看」的搜索框保持同一个手势。
      onKeyDown: (event) => {
        if (event && event.key === "Escape") set({ keyword: "" });
      },
    }),
    filtering
      ? h(
          "span",
          { className: "gt-filter-count", role: "status" },
          "筛出 " + shown + " / " + total + " 个",
        )
      : h("span", { className: "gt-filter-count gt-filter-count--idle" }, "显示全部 " + total + " 个"),
    filtering
      ? h(
          "button",
          {
            type: "button",
            className: "gt-btn ghost gt-filter-clear",
            onClick: () => set({ keyword: "" }),
            title: "清空关键词，回到完整榜单",
          },
          "清除",
        )
      : null,
  );
}

/**
 * 「视图 / 时间档」的选择器。
 *
 * 宽屏下就是一个分段控件（segmented control）：选项**全部可见、单击切换**。
 * 视图切换是这个插件最高频的操作，收进下拉等于每次都多一次点击，而且
 * 「随便看看」「新星库」这类入口一旦藏起来，用户根本不知道还有别的视图。
 *
 * 窄屏才降级：时间档换成一个紧凑下拉（新星库与随便看看没有时间档，
 * 所以这一格在它们下面整个不出现），视图那组在任何宽度都保持原样。
 */
function Segmented(props) {
  const h = appCtx.react.createElement;
  return h(
    "div",
    {
      className: "gt-seg",
      role: "group",
      "aria-label": props.label,
    },
    (props.items || []).map((it) =>
      h(
        "button",
        {
          key: it.key,
          type: "button",
          className: "gt-seg-item" + (it.key === props.value ? " is-on" : ""),
          onClick: () => props.onChange(it.key),
          "aria-pressed": it.key === props.value ? "true" : "false",
        },
        it.label,
      ),
    ),
  );
}

/**
 * 「更多」菜单：窄屏下收走低频动作（复制 Markdown、设置）。
 *
 * 和 `Dropdown` 的区别是语义：这里是**执行一个动作**，不是「选一个值」。
 * 所以用 `role="menu"` / `role="menuitem"`，Enter 执行、Esc 关闭，
 * 不做「高亮项循环移动」——菜单项本来就少，方向键在这里没有收益。
 */
function OverflowMenu(props) {
  const R = appCtx.react;
  const h = R.createElement;
  const { open, setOpen, up, triggerRef, openPopover } = usePopover();
  const focusState = R.useState(-1);
  const focusIdx = focusState[0];
  const itemRefs = R.useRef([]);
  const items = Array.isArray(props.items) ? props.items.filter(Boolean) : [];
  const setFocusIndex = focusState[1];

  R.useEffect(() => {
    if (!open) return;
    const el = itemRefs.current[focusIdx];
    if (el && typeof el.focus === "function") el.focus();
  }, [open, focusIdx]);

  const openMenu = () => {
    if (!items.length) return;
    setFocusIndex(0);
    openPopover(Math.min(260, items.length * 36 + 8));
  };
  const run = (item) => {
    setOpen(false);
    if (item && typeof item.onSelect === "function") item.onSelect();
  };

  const move = (step) => {
    if (!items.length) return;
    setFocusIndex((focusIdx + step + items.length) % items.length);
  };

  const onKeyDown = (ev) => {
    // 和 Dropdown 同一套路：handler 挂容器，靠 className 认来源，
    // 触发器与容器不能各挂一个（同一事件会冒泡两遍）。
    const t = ev && ev.target;
    const onTrigger = Boolean(
      t && typeof t.className === "string" && t.className.split(/\s+/).includes("gt-more-trigger"),
    );
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      if (!open) openMenu();
      else move(ev.key === "ArrowDown" ? 1 : -1);
    } else if (ev.key === "Enter") {
      ev.preventDefault();
      if (open) run(items[focusIdx]);
      else openMenu();
    } else if (ev.key === " ") {
      if (onTrigger) {
        ev.preventDefault();
        if (open) run(items[focusIdx]);
        else openMenu();
      }
    } else if (ev.key === "Escape" && open) {
      ev.preventDefault();
      setOpen(false);
    } else if (ev.key === "Tab" && open) {
      // 遮罩是 fixed 全屏，不关掉会留下一层看不见的遮罩继续吞点击。
      setOpen(false);
    }
  };

  return h(
    "div",
    {
      className: "gt-more" + (open ? " is-open" : "") + (up ? " is-up" : ""),
      onKeyDown,
    },
    h(
      "button",
      {
        type: "button",
        className: "gt-more-trigger",
        ref: triggerRef,
        "aria-haspopup": "menu",
        "aria-expanded": open,
        "aria-label": props.label || "更多",
        title: props.label || "更多",
        onClick: () => (open ? setOpen(false) : openMenu()),
      },
      "⋮",
    ),
    open ? h("div", { className: "gt-more-scrim", onClick: () => setOpen(false) }) : null,
    open
      ? h(
          "div",
          { className: "gt-more-menu", role: "menu" },
          items.map((item, i) =>
            h(
              "button",
              {
                key: item.key || String(i),
                type: "button",
                ref: (el) => {
                  itemRefs.current[i] = el;
                },
                className: "gt-more-item" + (i === focusIdx ? " is-active" : ""),
                role: "menuitem",
                disabled: item.disabled,
                onClick: () => run(item),
                onMouseEnter: () => setFocusIndex(i),
              },
              item.label,
              item.hint ? h("span", { className: "gt-more-hint" }, item.hint) : null,
            ),
          ),
        )
      : null,
  );
}

function Toolbar({ snap, ctx }) {
  const h = appCtx.react.createElement;
  const R = appCtx.react;
  // 导出状态放在这一层而不是 status store：它只描述「刚才那次复制」，跟榜单
  // 数据无关，放进全局反而要在每个刷新点清一遍。
  const exportState = R.useState("");
  const exportStatus = exportState[0];
  const setExportStatus = exportState[1];
  const exportTimer = R.useRef(null);
  R.useEffect(() => () => {
    if (exportTimer.current) clearTimeout(exportTimer.current);
  }, []);
  const flashExport = (text) => {
    setExportStatus(text);
    if (exportTimer.current) clearTimeout(exportTimer.current);
    exportTimer.current = setTimeout(() => setExportStatus(""), 2000);
  };
  const exportMarkdown = () => {
    // 导出的是「你现在看到的这批」：筛选生效时只导出筛出来的行，
    // 并在标题里写明，否则粘出去像一份完整榜单。
    const markdown = buildBoardMarkdown({
      view: snap.view,
      period: snap.settings.period,
      language: snap.view === "trending" ? snap.settings.language : "",
      // 「随便看看」导出时得说清这批是怎么来的，否则粘出去像一份榜单。
      scopeText: scopeTextOf(snap),
      filterNote: filterScopeNote(snap.keyword),
      rows: filterRows(snap.repos, snap.keyword),
      dropped: snap.dropped,
      capturedAt: fmtTime(snap.loadedAt),
    });
    // 空榜单不该给出一个「已复制」，那等于让用户粘出一张空白表。
    if (!markdown) {
      flashExport("没有可导出的内容");
      return;
    }
    copyText(markdown).then(
      () => flashExport("已复制"),
      () => flashExport("复制失败"),
    );
  };
  const clearRows = () => ({
    digest: "",
    digestStopped: false,
    dropped: [],
    isFirstRun: true,
    repos: [],
    loaded: false,
    discussError: "",
    discussNotice: "",
    discussWorkspace: "",
    discussWarning: "",
    discussResumed: false,
    discussOpened: false,
    discussPromptName: "",
    readmeOpen: "",
    readmeLoading: false,
    readmeError: "",
    readmeText: "",
    readmeTruncated: false,
    readmeTotal: 0,
  });
  // 切视图/时间档会让榜单换掉，正在生成的解读说的是旧榜单，必须一并停掉，
  // 否则旧轮次的 delta 会继续写进新视图，而且宿主那侧还在烧 token。
  const onView = (view) => {
    if (view === snap.view) return;
    if (snap.generating) abortDigest(ctx);
    markDiscussSessionsStale();
    set({
      view,
      ...clearRows(),
      // 「随便看看」每次都从新的一批开始：保留上一个视图的搜索词只会让
      // 人以为搜索还生效着，其实列表已经是随机的了。
      discoverTerm: "",
      discoverBand: "",
      discoverTotal: 0,
      // 换视图后关键词没有意义：上一个视图筛的东西在这个视图里不存在。
      keyword: "",
    });
    void refresh(ctx, { force: true });
  };
  const onPeriod = (period) => {
    if (period === snap.settings.period) return;
    if (snap.generating) abortDigest(ctx);
    markDiscussSessionsStale();
    setSettings({ period });
    void persistSettings(ctx, { period });
    set(clearRows());
    void refresh(ctx, { force: true });
  };

  return h(
    "div",
    { className: "gt-toolbar" },
    // 视图切换永远平铺、永远单击可用：这是最高频的操作，也是「还有别的视图」
    // 的唯一入口。
    h(Segmented, {
      label: "数据视图",
      value: snap.view,
      onChange: onView,
      items: [
        { key: "trending", label: VIEW_LABEL.trending },
        { key: "rising", label: VIEW_LABEL.rising },
        { key: "browse", label: VIEW_LABEL.browse },
      ],
    }),
    // 时间档宽屏平铺、窄屏换成紧凑下拉。两份都渲染、由 @container 决定谁可见：
    // 组件拿不到容器宽度，用 CSS 切换比 js 宽度探测可靠。新星库/随便看看
    // 没有时间档，这一格整个不出现。
    snap.view === "trending"
      ? h(
          "div",
          { className: "gt-period" },
          h("span", { className: "gt-period-seg" }, h(Segmented, {
            label: "时间档",
            value: snap.settings.period,
            onChange: onPeriod,
            items: PERIODS,
          })),
          h("span", { className: "gt-period-dd" }, h(Dropdown, {
            items: PERIODS.map((p) => ({ value: p.key, label: p.label })),
            value: snap.settings.period,
            onChange: onPeriod,
            placeholder: "时间档",
          })),
        )
      : null,
    // 搜索与换一批只在「随便看看」里出现：它们换掉的是列表本身，
    // 放到别的视图里就会变成「刷新按钮的另一种写法」。
    snap.view === "browse" ? h(DiscoverBar, { snap, ctx }) : null,
    h(
      "div",
      { className: "gt-group gt-group--end" },
      snap.loadedAt ? h("span", { className: "gt-stamp" }, "更新于 " + fmtTime(snap.loadedAt)) : null,
      // 定宽：文案在「复制 Markdown / 已复制 / 复制失败」之间切，右侧按钮不能跟着挪。
      h(
        "button",
        {
          type: "button",
          className: "gt-btn gt-btn--export gt-when-wide",
          onClick: exportMarkdown,
          disabled: snap.loading || snap.repos.length === 0,
          title: "把当前榜单复制成 Markdown",
        },
        exportStatus || "复制 Markdown",
      ),
      h(
        "button",
        {
          type: "button",
          className: "gt-btn gt-btn--refresh" + (snap.loading ? " gt-btn--busy" : ""),
          onClick: () => void refresh(ctx, { force: true }),
          disabled: snap.loading,
          "aria-busy": snap.loading ? "true" : "false",
        },
        // 文案与宽度都不随状态变化，右侧按钮不会跟着挪
        snap.loading ? h("span", { className: "gt-spinner", "aria-hidden": "true" }) : null,
        snap.loading ? "刷新中…" : "刷新",
      ),
      h(
        "button",
        {
          type: "button",
          className: "gt-btn gt-btn--primary",
          onClick: () => (snap.generating ? abortDigest(ctx) : void generateDigest(ctx)),
          // 生成中不能跟着 loading 一起禁用：刷新一进来就把 loading 置真，而
          // 刷新并不中止解读——那样「停止生成」会变成一个点不动的按钮，
          // 用户只能等 20s 超时，看着 token 继续烧。
          disabled: snap.generating ? false : snap.loading || snap.repos.length === 0,
        },
        snap.generating ? "停止生成" : "生成解读",
      ),
      h("button", { type: "button", className: "gt-btn gt-when-wide", onClick: () => ctx.ui.openSettings() }, "设置"),
      // 窄屏才出现：收起「复制 Markdown / 设置」这两个低频动作（省 ~156px）。
      // 它们各自的按钮仍在 DOM 里，只是由 @container 隐藏——菜单项复用同一套
      // 处理函数，不会出现两种行为。
      h("span", { className: "gt-when-narrow" }, h(OverflowMenu, {
        label: "更多操作",
        items: [
          {
            key: "export",
            label: exportStatus || "复制 Markdown",
            disabled: snap.loading || snap.repos.length === 0,
            onSelect: exportMarkdown,
          },
          { key: "settings", label: "设置", onSelect: () => ctx.ui.openSettings() },
        ],
      })),
    ),
  );
}

/**
 * 状态行里「你现在在看什么」那句话。
 *
 * 三个视图的来源不同，涨跌标签也并非处处都有（「随便看看」的批次之间
 * 没有可比排名），所以每一段都要按视图决定在场与否——不能写一句通用文案
 * 就指望它对三种数据都成立。
 */
function scopeParts(snap) {
  if (snap.view === "browse") {
    const term = String(snap.discoverTerm || "").trim();
    const parts = [];
    if (term) {
      parts.push("GitHub 搜索「" + term + "」");
      if (Number.isFinite(snap.discoverTotal) && snap.discoverTotal > 0) {
        parts.push("共 " + fmtNumber(snap.discoverTotal) + " 个命中");
      }
    } else {
      parts.push("随机抽的一批热门仓库");
      if (snap.discoverBand) parts.push(snap.discoverBand);
    }
    parts.push("不是排行榜，没有名次与涨跌");
    return parts;
  }
  const parts = [
    snap.view === "rising" ? "近 7 天新建的高增长仓库" : "GitHub Trending · " + snap.settings.period,
  ];
  if (snap.view === "trending" && snap.settings.language) parts.push(snap.settings.language);
  if (snap.isFirstRun) parts.push("首次抓取，下次刷新可看到排名变化");
  // 没有变化时整榜都没有涨跌标签，不说明会让人以为标签没渲染出来
  if (!snap.isFirstRun && snap.repos.length > 0 && !hasRankChange(snap.repos)) parts.push("与上次相比排名无变化");
  return parts;
}

function StatusLine({ snap }) {
  const h = appCtx.react.createElement;
  if (snap.loading) {
    // 刷新时列表还在：只转圈 + 一句话，不抢走用户正在看的内容。
    // 首次加载没有列表：文案改成「首次抓取」的口吻。
    const first = snap.repos.length === 0;
    const what =
      snap.view === "browse"
        ? snap.discoverTerm
          ? "正在搜索仓库…"
          : "正在抽一批热门仓库…"
        : first
          ? "正在抓取 GitHub…"
          : "正在刷新榜单…";
    return h(
      "p",
      { className: "gt-notice gt-running", role: "status", "aria-live": "polite" },
      h("span", { className: "gt-spinner", "aria-hidden": "true" }),
      h("span", { className: "gt-running-text" }, what),
    );
  }
  // 讨论的回执讲的是「你刚才那一按的结果」，比榜单状态更该优先显示：
  // 先判回执，再判 httpError / loaded。否则上一次生成超时的红字会原样留着，
  // 把「开会话失败了，因为…」整个吞掉——用户看到的还是几分钟前的错误。
  if (snap.discussError || snap.discussNotice) {
    const base = snap.loaded
      ? h("p", { className: "gt-notice" }, scopeParts(snap).join(" · "))
      : null;
    return h(
      "div",
      { className: "gt-status-rows" },
      base,
      snap.discussError
        ? h("p", { className: "gt-notice gt-notice--error", role: "status" }, snap.discussError)
        : h(
            "p",
            { className: "gt-notice gt-notice--ok", role: "status" },
            h(
              "span",
              null,
              snap.discussOpened
                ? "已直接打开 " + snap.discussNotice + " 上次的会话（没有重跑模型）"
                : (snap.discussResumed ? "已在侧栏续接为 " : "已在侧栏为 ") +
                    snap.discussNotice +
                    " " +
                    (snap.discussResumed ? "的会话（接着上次的话题）" : "开了会话"),
            ),
            h(
              "span",
              { className: "gt-notice-hint" },
              // 说清会话挂在哪个分组下：侧栏工作区一多，光说「在侧栏」等于没说。
              (snap.discussWorkspace ? "分组「" + snap.discussWorkspace + "」· " : "") +
                (snap.discussOpened ? "侧栏已切到这个会话" : "本页不会自动跳转，点侧栏里那一行打开"),
            ),
            // 用户维护了好几份提示词，回执不说名字就分不清刚才用的是哪套要求。
            snap.discussPromptName
              ? h("span", { className: "gt-notice-hint" }, "提示词「" + snap.discussPromptName + "」")
              : null,
            // 会话真的建起来了，只是没挂进侧栏工作区：不能说成失败，更不能不说。
            snap.discussWarning ? h("span", { className: "gt-notice-hint" }, snap.discussWarning) : null,
          ),
      // 榜单自己的错误不能被回执顶掉：两件事并列说清楚，别二选一。
      snap.httpError
        ? h(
            "p",
            { className: "gt-notice gt-notice--error", role: "status" },
            h("span", null, snap.httpError),
            snap.repos.length > 0 ? h("span", { className: "gt-notice-hint" }, "（当前显示的是上次的结果）") : null,
          )
        : null,
    );
  }
  if (snap.httpError) {
    const cacheHint = snap.repos.length > 0;
    return h(
      "div",
      { className: "gt-notice gt-notice--error", role: "status" },
      h("span", null, snap.httpError),
      cacheHint ? h("span", { className: "gt-notice-hint" }, "（当前显示的是上次的结果）") : null,
    );
  }
  if (!snap.loaded) {
    return h(
      "p",
      { className: "gt-notice" },
      snap.view === "browse" ? "点「换一批」抽一批热门仓库，或直接搜仓库名。" : "点「刷新」拉取榜单。",
    );
  }
  // 回执和榜单说明并列，不互相顶替：回执说的是「你刚才那一按的结果」，
  // 榜单行说的是「你现在在看什么数据」，两件事都得在场。
  return h("p", { className: "gt-notice" }, scopeParts(snap).join(" · "));
}

/** 整榜是否有任何涨跌/新上榜。全为 false 时列表里不会出现任何变化标签。 */
function hasRankChange(repos) {
  const list = Array.isArray(repos) ? repos : [];
  return list.some((row) => row && (row.isNew || (Number.isFinite(row.rankDelta) && row.rankDelta !== 0)));
}

/** 骨架屏：条数与真实榜单接近，让加载完的落位不跳。 */
function SkeletonList() {
  const h = appCtx.react.createElement;
  // 6 行刚好铺满常见窗口高度，又不会撑出滚动条；
  // 骨架屏加载完就撤掉，行数与真实榜单不必一致。
  const rows = [];
  for (let i = 0; i < 6; i += 1) {
    rows.push(
      h(
        "li",
        { className: "gt-skel", "aria-hidden": "true" },
        h("span", { className: "gt-skel-badge" }),
        h(
          "span",
          { className: "gt-skel-body" },
          h("span", { className: "gt-skel-line gt-skel-line--title" }),
          h("span", { className: "gt-skel-line gt-skel-line--desc" }),
          h("span", { className: "gt-skel-line gt-skel-line--meta" }),
        ),
      ),
    );
  }
  return h("ul", { className: "gt-skel-list" }, rows);
}

/* ---------- 解读正文的 Markdown 渲染 ---------- */

/**
 * 把模型写出的 Markdown 渲染成元素。
 *
 * 解析与渲染都在 src/lib/markdown.mjs + markdown-view.mjs 里，与工作志
 * 插件共用一份——两边使用的是同一个模型，输出语法本来就该一致。
 * 全程不拼 HTML 字符串：模型输出属于不可信内容，只当文本处理。
 */
function renderDigestMarkdown(text) {
  const h = appCtx.react.createElement;
  return renderMarkdown(h, text, { prefix: "gt" });
}

function DigestPanel({ snap }) {
  const R = appCtx.react;
  const h = R.createElement;
  const bodyRef = R.useRef(null);
  const wasGenerating = R.useRef(false);
  const copyState = R.useState("");
  const copyStatus = copyState[0];
  const setCopyStatus = copyState[1];
  const copyTimer = R.useRef(null);

  // 解读面板在一个可滚动区域的底部：点「生成解读」后如果不滚过去，用户看到的
  // 是「什么都没发生」。只在「开始生成」这一刻滚，之后不抢用户正在看的位置。
  R.useEffect(() => {
    if (snap.generating && !wasGenerating.current) {
      wasGenerating.current = true;
      const el = bodyRef.current;
      if (el && typeof el.scrollIntoView === "function") {
        try {
          el.scrollIntoView({ block: "nearest", behavior: "smooth" });
        } catch {
          /* 老内核不支持参数对象：不滚也不影响阅读 */
        }
      }
    } else if (!snap.generating) {
      wasGenerating.current = false;
    }
  }, [snap.generating]);

  R.useEffect(() => () => {
    if (copyTimer.current) clearTimeout(copyTimer.current);
  }, []);

  if (!snap.generating && !snap.digest) return null;

  const note = snap.digestTruncated
    ? "事实过长，已截断（" + snap.digestIncluded + "/" + snap.digestTotal + "）"
    : "";
  const chars = snap.digest ? snap.digest.length : 0;

  const copy = () => {
    const text = snap.digest || "";
    if (!text) return;
    const done = () => {
      setCopyStatus("已复制");
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopyStatus(""), 2000);
    };
    const fail = () => setCopyStatus("复制失败");
    try {
      const clip = typeof navigator !== "undefined" ? navigator.clipboard : null;
      if (clip && typeof clip.writeText === "function") {
        clip.writeText(text).then(done, fail);
        return;
      }
    } catch {
      /* 落到下面 */
    }
    fail();
  };

  const status = snap.generating
    ? h(
        "span",
        { className: "gt-digest-run" },
        h("span", { className: "gt-spinner", "aria-hidden": "true" }),
        chars ? "生成中 · " + chars + " 字" : "生成中…",
      )
    : snap.digestStopped
      ? h("span", { className: "gt-digest-run gt-digest-stopped" }, "已停止，下面是写到这里的内容")
      : null;

  return h(
    "section",
    { className: "gt-digest", "aria-busy": snap.generating ? "true" : "false" },
    h(
      "header",
      { className: "gt-digest-head" },
      h("h3", null, "解读"),
      status,
      note ? h("span", { className: "gt-stamp" }, note) : null,
      snap.digest
        ? h(
            "button",
            {
              type: "button",
              className: "gt-btn gt-digest-copy",
              onClick: copy,
              disabled: snap.generating,
              title: "复制 Markdown 原文",
            },
            copyStatus || "复制",
          )
        : null,
    ),
    // aria-live 放在正文外层而不是 section 上：正文逐字追加时，读屏软件会
    // 把每个字都念一遍。这里只在「生成中/已完成」这类状态变化时播报。
    h(
      "div",
      { className: "gt-digest-body", ref: bodyRef },
      snap.digest
        ? renderDigestMarkdown(snap.digest)
        : h("p", { className: "gt-md-p gt-digest-wait" }, "正在整理今天的榜单…"),
    ),
    snap.digest && !snap.generating
      ? h("p", { className: "gt-notice", role: "status" }, "解读只在本机显示，未写入任何文件。")
      : null,
  );
}

function MainTab() {
  const h = appCtx.react.createElement;
  const ctx = appCtx;
  const snap = useSnap();
  // 列表、导出、解读共用这一份：三处看到的必须是同一批数据，
  // 否则「导出」出来的东西和屏幕上显示的不是一回事。
  const visible = filterRows(snap.repos, snap.keyword);

  appCtx.react.useEffect(() => {
    void refresh(ctx, { force: false });
    // 首次挂载自动拉一次；后续由用户动作触发。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return h(
    "div",
    { className: "gt-root" },
    h(
      "header",
      { className: "gt-head" },
      h(
        "div",
        { className: "gt-head-text" },
        h("h2", { className: "gt-title" }, "每日热点"),
        h("p", { className: "gt-sub" }, "GitHub Trending、新星库与「随便看看」，数据只在本机处理"),
      ),
    ),
    h(Toolbar, { snap, ctx }),
    h(StatusLine, { snap }),
    // 只在有行时出现：没有数据的时候，「筛什么」是个假问题。
    snap.repos.length > 0 ? h(FilterBar, { snap, total: snap.repos.length }) : null,
    h(
      "div",
      { className: "gt-scroll" },
      visible.length > 0
        ? h("ol", { className: "gt-list" }, visible.map((row) => h(RepoRow, { key: row.repo, row, ctx, discussing: snap.discussing, readme: snap })))
        : snap.loading
          ? h(SkeletonList, null)
          : snap.repos.length > 0
            ? h(
                "p",
                { className: "gt-empty" },
                "没有匹配「" + snap.keyword + "」的仓库。",
                h(
                  "button",
                  { type: "button", className: "gt-btn ghost gt-empty-clear", onClick: () => set({ keyword: "" }) },
                  "清空关键词",
                ),
              )
            : snap.loaded
              ? h(
                  "p",
                  { className: "gt-empty" },
                  snap.errorKind
                    ? "没有可显示的数据"
                    : snap.view === "browse"
                      ? snap.discoverTerm
                        ? "没搜到叫这个名字的仓库，换个词试试"
                        : "这一批没抽到仓库，点「换一批」再来"
                      : "榜单为空",
                )
              : null,
      snap.view === "trending" && snap.dropped.length > 0
        ? h(
            "section",
            { className: "gt-dropped" },
            h("h3", null, "掉榜（" + snap.dropped.length + "）"),
            h(
              "p",
              null,
              snap.dropped
                .slice(0, 12)
                .map((row) => row.repo)
                .join("、") + (snap.dropped.length > 12 ? " 等" : ""),
            ),
          )
        : null,
      h(DigestPanel, { snap }),
    ),
  );
}

/* ---------- 设置页 ---------- */

/**
 * 弹出层的公共骨架：开合状态、触发器 ref、靠近视口底部时向上弹。
 *
 * `Dropdown`（选一个值）与 `OverflowMenu`（执行一个动作）的键盘语义不同，
 * 但这三件事完全一样。抽出来是为了两处不会各错一处——「向上弹」这种逻辑
 * 复制一份就容易只改一边。
 */
function usePopover() {
  const R = appCtx.react;
  const openState = R.useState(false);
  const upState = R.useState(false);
  const triggerRef = R.useRef(null);
  const up = upState[0];
  const setUp = upState[1];

  /** 打开前估一下菜单高度：下方不够且上方更宽裕时向上弹，免得被视口裁掉。 */
  const openPopover = (estHeight) => {
    const el = triggerRef.current;
    let shouldUp = false;
    if (el && typeof el.getBoundingClientRect === "function" && typeof window !== "undefined") {
      const rect = el.getBoundingClientRect();
      const below = (window.innerHeight || 800) - rect.bottom;
      shouldUp = below < estHeight + 12 && rect.top > below;
    }
    setUp(shouldUp);
    openState[1](true);
  };

  return { open: openState[0], setOpen: openState[1], up, triggerRef, openPopover };
}

/**
 * 自绘下拉：原生 <select> 的展开层由系统绘制，不跟宿主的深浅色主题。
 * 键盘、方向键、Esc、点击外部关闭都对齐宿主习惯。
 */
function Dropdown(props) {
  const R = appCtx.react;
  const h = R.createElement;
  const { open, setOpen, up, triggerRef, openPopover } = usePopover();
  const focusState = R.useState(-1);
  const focusIdx = focusState[0];
  const setFocusIdx = focusState[1];
  const itemRefs = R.useRef([]);

  const items = Array.isArray(props.items) ? props.items : [];
  const value = props.value == null ? "" : String(props.value);
  const selectedIdx = items.findIndex((it) => String(it.value) === value);
  const selected = selectedIdx >= 0 ? items[selectedIdx] : null;
  const placeholder = props.placeholder || "请选择";

  R.useEffect(() => {
    if (!open) return;
    const el = itemRefs.current[focusIdx];
    if (el && typeof el.focus === "function") el.focus();
  }, [open, focusIdx]);

  const openMenu = () => {
    if (props.disabled || items.length === 0) return;
    let i = selectedIdx;
    if (i < 0) i = items.findIndex((it) => !it.disabled);
    setFocusIdx(i < 0 ? 0 : i);
    openPopover(Math.min(260, items.length * 32 + 8));
  };

  const choose = (item) => {
    if (!item || item.disabled) return;
    setOpen(false);
    if (String(item.value) !== value) props.onChange(item.value);
  };

  const move = (step) => {
    if (!items.length) return;
    let i = focusIdx;
    for (let n = 0; n < items.length; n += 1) {
      i = (i + step + items.length) % items.length;
      if (!items[i].disabled) break;
    }
    setFocusIdx(i);
  };

  /**
   * 键盘处理挂在**容器**上，不是 trigger 上。
   *
   * 菜单一打开，useEffect 会把焦点移到 option 上（option 带 tabIndex=-1），
   * 此后按键事件从 option 冒泡到容器。只挂在 trigger 上的话，打开之后方向键、
   * Enter 确认、Esc 关闭全部失灵——只剩鼠标能用。
   *
   * 容器与 trigger 不能各挂一个：同一事件会冒泡两遍，Enter 会触发两次
   * onChange。所以只有一个 handler，靠 `ev.target` 认来源。
   */
  const onKeyDown = (ev) => {
    if (props.disabled) return;
    // 按 className 认来源，不用 triggerRef.current：ref 在假宿主/替身里
    // 未必被赋值，一旦为 null 判断就会恒假，空格键静默失效。
    const t = ev && ev.target;
    const onTrigger = Boolean(
      t && typeof t.className === "string" && t.className.split(/\s+/).includes("gt-dd-trigger"),
    );
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      if (!open) openMenu();
      else move(ev.key === "ArrowDown" ? 1 : -1);
    } else if (ev.key === "Enter") {
      ev.preventDefault();
      if (open) choose(items[focusIdx]);
      else openMenu();
    } else if (ev.key === " ") {
      // 空格只在 trigger 上当「打开」：菜单项里按空格同理会冒泡到这里，
      // 但那是可滚动列表，别为了这个吃掉滚动键。
      if (onTrigger) {
        ev.preventDefault();
        if (open) choose(items[focusIdx]);
        else openMenu();
      }
    } else if (ev.key === "Escape" && open) {
      ev.preventDefault();
      setOpen(false);
    } else if (ev.key === "Tab" && open) {
      // 焦点会离开这个组件；scrim 是 fixed 全屏，不关掉会留下一层看不见的
      // 遮罩继续吞点击。
      setOpen(false);
    }
  };

  return h(
    "div",
    {
      className: "gt-dd" + (open ? " is-open" : "") + (up ? " is-up" : ""),
      onKeyDown,
    },
    h(
      "button",
      {
        type: "button",
        className: "gt-dd-trigger",
        ref: triggerRef,
        disabled: props.disabled,
        "aria-haspopup": "listbox",
        "aria-expanded": open,
        onClick: () => (open ? setOpen(false) : openMenu()),
      },
      h("span", { className: "gt-dd-value" + (selected ? "" : " is-empty") }, selected ? selected.label : placeholder),
      h("span", { className: "gt-dd-caret", "aria-hidden": "true" }),
    ),
    open ? h("div", { className: "gt-dd-scrim", onClick: () => setOpen(false) }) : null,
    open
      ? h(
          "div",
          { className: "gt-dd-menu", role: "listbox" },
          items.length
            ? items.map((item, i) =>
                h(
                  "div",
                  {
                    key: String(item.value) + ":" + i,
                    ref: (el) => {
                      itemRefs.current[i] = el;
                    },
                    className:
                      "gt-dd-item" +
                      (i === focusIdx ? " is-active" : "") +
                      (item.disabled ? " is-disabled" : ""),
                    role: "option",
                    "aria-selected": String(item.value) === value,
                    "aria-disabled": item.disabled ? true : undefined,
                    tabIndex: -1,
                    onClick: () => choose(item),
                    onMouseEnter: () => {
                      if (!item.disabled) setFocusIdx(i);
                    },
                  },
                  h("span", { className: "gt-dd-label" }, item.label),
                  h("span", { className: "gt-dd-check", "aria-hidden": "true" }, "✓"),
                ),
              )
            : h("div", { className: "gt-dd-empty" }, props.emptyText || "没有可选项"),
        )
      : null,
  );
}

function segField(label, control, hint) {
  const h = appCtx.react.createElement;
  return h(
    "div",
    { className: "gt-field" },
    h("label", null, label),
    control,
    hint ? h("span", { className: "gt-hint" }, hint) : null,
  );
}

/**
 * 占位符说明面板。
 *
 * 数据来自 prompt.mjs 的 DISCUSS_PLACEHOLDERS，与 fillTemplate 实际支持的 key
 * 是同一份清单——文档和实现不可能各说各话。
 */
function PlaceholderHelp() {
  const h = appCtx.react.createElement;
  return h(
    "div",
    { className: "gt-placeholders", id: "gt-placeholders" },
    h(
      "p",
      { className: "gt-note-line" },
      "这些标记会被这一行的真实数据替换。不认识的占位符不会被吞掉，会原样留在 prompt 里，方便自己发现拼错了。",
    ),
    h(
      "dl",
      { className: "gt-placeholder-list" },
      DISCUSS_PLACEHOLDERS.map((p) =>
        h(
          "div",
          { className: "gt-placeholder", key: p.token },
          h(
            "dt",
            { className: "gt-placeholder-head" },
            h("code", { className: "gt-placeholder-token" }, p.token),
            h("span", { className: "gt-placeholder-label" }, p.label),
            h("span", { className: "gt-placeholder-sample" }, p.sample),
          ),
          h("dd", { className: "gt-placeholder-detail" }, p.detail),
        ),
      ),
    ),
    h(
      "p",
      { className: "gt-note-line" },
      "没写 {{facts}} 时，插件会在正文末尾补一节「榜单事实（插件补充）」，所以只写自己关心的那几个占位符也行。",
    ),
  );
}

/**
 * 反馈区。独立组件而不是塞进 SettingsSection：它有自己的异步状态
 * （发信、查额度），混进设置页会让那个已经八百行的组件再长一截。
 *
 * 两个渠道共用同一个输入框：
 * - GitHub Issue：只是预填链接，不耗额度、不需要网络权限，永远可用。
 * - 中转发送：经 Worker 转发到邮箱，受每 IP 每天 30 条的共享额度限制。
 *   「共享」指四个插件同一个额度池，所以额度键里不能带插件名。
 */
function FeedbackSection() {
  const R = appCtx.react;
  const h = R.createElement;
  const ctx = appCtx;

  // 状态与提交逻辑在 src/lib/feedback-ui.mjs（四插件共用），这里只负责
  // 把它接到本插件的网络层与样式体系上。
  const form = useFeedbackForm(R, {
    repo: FEEDBACK_REPO,
    pluginName: "每日热点",
    pluginVersion: ctx.version,
    hostVersion: hostAppVersion(ctx),
    send: (text) => sendFeedback(ctx, text),
    quota: () => fetchQuota(ctx),
  });

  return form.render(h, {
    prefix: "gt",
    variant: "section",
    rows: 5,
    classes: {
      input: "gt-input",
      primaryBtn: "gt-btn gt-btn--primary",
      secondaryBtn: "gt-btn",
      hint: "gt-hint",
      note: "gt-note-line",
      linkBtn: "gt-link-btn",
      // 正文为空时 Issue 链接弱化成不可点的样子（判断由共用层统一做）。
      muted: "gt-btn--muted",
    },
  });
}

function SettingsSection() {
  const R = appCtx.react;
  const h = R.createElement;
  const ctx = appCtx;
  const snap = useSnap();

  const formState = R.useState(null);
  const form = formState[0] || snap.settings;
  const setForm = formState[1];
  // "" -> "saving" -> "saved"/"error"；改动即生效，不需要用户记得点保存。
  const saveState = R.useState("");
  const saveStatus = saveState[0];
  const setSaveStatus = saveState[1];
  const baseline = R.useRef("");
  const saveTimer = R.useRef(null);
  const ready = R.useRef(false);
  // 用户在本页改过哪些键。
  //
  // 保存时**只写这些键**，不整份 form 回写。`discussSessionIds` 只在开会话
  // 时由插件自己更新，设置页从来不编辑它；而 `form` 是本页渲染那一刻的快照。
  // 用户开会话之后回来改一下语言，整份 form 回写就会把刚记下的 sessionId
  // 覆盖成空——下次再点同一个仓库又开一条新的。磁盘与内存同时丢。
  const touchedKeys = R.useRef(null);

  const patch = (key, value) => {
    if (!touchedKeys.current) touchedKeys.current = new Set();
    touchedKeys.current.add(key);
    setForm((prev) => Object.assign({}, prev || snap.settings, { [key]: value }));
  };

  R.useEffect(() => {
    if (!snap.catalogLoaded) void loadCatalog(ctx);
    void pluginDataDir(ctx);
  }, []);

  const [flashMsg, setFlashMsg] = R.useState("");
  const flashTimer = R.useRef(null);
  const flash = (text) => {
    setFlashMsg(text);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlashMsg(""), 2600);
  };
  R.useEffect(() => () => {
    if (flashTimer.current) clearTimeout(flashTimer.current);
  }, []);

  // 路径只能来自宿主的系统文件夹选择器，不接受手填：手打的路径没有对应 grant，
  // 引擎跑起来会因为没授权而失败。
  async function chooseWorkspace() {
    if (!ctx.assets || typeof ctx.assets.grantDirectory !== "function") {
      flash("当前宿主不支持目录选择");
      return;
    }
    try {
      const grant = await ctx.assets.grantDirectory();
      const picked = grant && grant.path ? String(grant.path) : "";
      if (!picked) return;
      patch("workspacePath", picked);
      flash("已选择 " + displayPath(picked));
    } catch {
      /* 用户取消选择：按正常操作静默处理 */
    }
  }

  R.useEffect(() => {
    if (!form) return;
    const key = JSON.stringify(form);
    if (!ready.current) {
      ready.current = true;
      baseline.current = key;
      return;
    }
    if (key === baseline.current) return;
    setSaveStatus("saving");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void (async () => {
        // 只回写用户真正改过的键（见 touchedKeys 的注释）。
        const changes = {};
        const keys = touchedKeys.current || new Set();
        if (keys.size === 0) {
          // 这次「变化」不是用户改的（多半是磁盘设置异步读回来了）。
          // 基线要跟上，否则之后每次渲染都会再判一次「变了」、闪一次「已保存」。
          baseline.current = key;
          setSaveStatus("saved");
          return;
        }
        const latest = form || {};
        for (const k of keys) changes[k] = latest[k];
        const ok = await saveSettings(ctx, changes);
        if (ok) {
          baseline.current = key;
          setSaveStatus("saved");
        } else {
          setSaveStatus("error");
        }
      })();
    }, 500);
  }, [form]);

  R.useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    },
    [],
  );

  // 引擎选项来自 agent.catalog：不可用的保留在列表里但禁用，用户能看到
  // 「装了这个引擎但没配好」，而不是莫名其妙少一项。
  const engineItems = [{ value: "", label: "自动（第一个可用引擎）" }];
  for (const e of sortCatalog(snap.catalog)) {
    engineItems.push({
      value: e.engine,
      label: engineLabel(e.engine) + (e.available === false ? "（不可用）" : ""),
      disabled: e.available === false,
    });
  }
  if (snap.modelsLoading && snap.catalog.length === 0) {
    engineItems.push({ value: "", label: "读取引擎目录中…", disabled: true });
  }
  // 配置里已有、但这次目录没列出来的引擎：保留一项，避免下拉把它吃掉
  if (form.engine && !snap.catalog.some((e) => e.engine === form.engine)) {
    engineItems.push({ value: form.engine, label: engineLabel(form.engine) });
  }

  // 模型跟着所选引擎走；catalog 的 label 已是显示名。
  const entry = pickEntry(snap.catalog, form.engine);
  const entryModels = entry && Array.isArray(entry.models) ? entry.models : [];
  const modelItems = [{ value: "", label: "自动（该引擎的第一个模型）" }];
  for (const m of entryModels) {
    if (m && typeof m.id === "string" && m.id) {
      modelItems.push({ value: m.id, label: m.label || m.id });
    }
  }
  if (form.model && !entryModels.some((m) => m && m.id === form.model)) {
    modelItems.push({ value: form.model, label: form.model });
  }

  /** 模型一栏的说明文字：要能回答「现在实际会用哪个引擎」。 */
  const modelHint = () => {
    if (!entry) return "先选引擎，模型列表会跟着变。";
    const name = engineLabel(entry.engine);
    if (entry.available === false) return name + " 当前不可用，请在宿主的引擎配置里启用它。";
    if (!entryModels.length) return name + " 没有报告模型列表，留空即可。";
    const prefix = form.engine ? "" : "当前跟随「自动」选中的 " + name + "；";
    return prefix + "留空则用该引擎的第一个可用模型。";
  };

  /* ---- 讨论提示词 ---- */

  // 归一化是幂等的，且必须每次都过：磁盘上可能是手改过的数据。
  // 有名字但正文空的那份会保留在列表里——用户正在重写，不能当场消失。
  const prompts = normalisePrompts(form.prompts);
  // 「默认」标记必须落在真正会生效的那份上，否则界面说 A、实际用 B。
  // 空正文的条目会被 pickPrompt 跳过，这里也跟着跳过。内置模板的 id 是 "",
  // 所以 `defaultPromptId === ""` 天然表示「用内置」，不额外存一个标记位。
  const usable = prompts.filter((p) => p.text.trim() !== "");
  const defaultId = usable.some((p) => p.id === form.defaultPromptId) ? form.defaultPromptId : "";

  /** 写回列表。顺手修正默认值——默认指向一份刚被删掉的提示词时回落内置模板。 */
  const writePrompts = (next, nextDefault) => {
    // 有名字的空正文条目必须留住：用户全选删除正文是想重写，不是想删掉这一份。
    const list = normalisePrompts(next);
    const wanted = nextDefault === undefined ? form.defaultPromptId : nextDefault;
    // 空正文的不会生效（pickPrompt 跳过），默认值也不该指向它们。
    const usable = list.filter((p) => p.text.trim() !== "");
    // "" = 内置模板，它永远可选，所以回落目标就是它而不是「第一份」：
    // 用户删掉正在用的那份时，得到的是可预期的默认，而不是另一份自定义。
    const fixed = usable.some((p) => p.id === wanted) ? wanted : "";
    // 这两个键由提示词编辑器直接改，同样要登记进「用户改过」的集合，
    // 否则保存时会漏掉它们（见 touchedKeys）。
    if (!touchedKeys.current) touchedKeys.current = new Set();
    touchedKeys.current.add("prompts");
    touchedKeys.current.add("defaultPromptId");
    setForm((prev) => Object.assign({}, prev || snap.settings, { prompts: list, defaultPromptId: fixed }));
  };

  const addPrompt = () => {
    if (prompts.length >= PROMPT_COUNT_LIMIT) {
      flash("最多 " + PROMPT_COUNT_LIMIT + " 份，先删掉一份再添加");
      return;
    }
    // 新条目给内置模板当底稿：空白文本框等于让用户从零开始想，不如给一份能用的。
    // 名字用「提示词 N」而不是空串：空名字在列表里无法区分。
    const id = "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    const next = prompts.concat([{ id, name: "提示词 " + (prompts.length + 1), text: DEFAULT_DISCUSS_TEMPLATE }]);
    // 不自动抢默认：内置模板一开始就是默认，新加的那份要用户自己决定用不用。
    writePrompts(next, form.defaultPromptId);
  };

  const removePrompt = (id) => {
    writePrompts(prompts.filter((p) => p.id !== id), undefined);
  };

  /** 点某份提示词展开/收起它的编辑区。同一时刻只展开一份，设置页才不长。 */
  const openPromptState = R.useState("");
  const openPrompt = openPromptState[0];
  const setOpenPrompt = openPromptState[1];

  /**
   * 一份提示词的一行。
   *
   * `builtin` 的那份只读，而且**不渲染输入框**：一个 readOnly 的 textarea 看起来
   * 仍然像能改，点进去还可能出现光标。直接给只读的文本块，可编辑这件事就
   * 不会产生误会。想改就「新增提示词」——那份以内置模板为底稿，是可编辑的。
   */
  const promptRow = (item, builtin) => {
    const isDefault = builtin ? defaultId === "" : item.id === defaultId;
    const isOpen = openPrompt === (builtin ? "__builtin__" : item.id);
    const key = builtin ? "__builtin__" : item.id;
    return h(
      "div",
      { className: "gt-prompt", key },
      h(
        "div",
        { className: "gt-prompt-head" },
        h(
          "button",
          {
            type: "button",
            className: "gt-prompt-name",
            onClick: () => setOpenPrompt(isOpen ? "" : key),
            "aria-expanded": isOpen ? "true" : "false",
            "aria-label": (isOpen ? "收起 " : "展开 ") + item.name + " 的正文",
            title: builtin ? "查看内置模板（只读）" : "展开编辑正文",
          },
          h("span", { className: "gt-prompt-chevron", "aria-hidden": "true" }, isOpen ? "▾" : "▸"),
          h("span", { className: "gt-prompt-label" }, item.name),
          builtin ? h("span", { className: "gt-prompt-note" }, "只读") : null,
        ),
        // 默认那份用「已设为默认」的静态标记，而不是一个点下去没反应的按钮：
        // 几份提示词里哪份在生效，是这一节最重要的一条信息。
        isDefault
          ? h("span", { className: "gt-prompt-default" }, "默认")
          : h(
              "button",
              {
                type: "button",
                className: "gt-btn gt-path-pick",
                onClick: () => writePrompts(prompts, builtin ? "" : item.id),
                title: "点「讨论」时用这一份",
                "aria-label": "把 " + item.name + " 设为默认提示词",
              },
              "设为默认",
            ),
        // 内置那份没有删除按钮：不是禁用，而是根本不渲染——它不在用户数据里。
        builtin
          ? null
          : h(
              "button",
              {
                type: "button",
                className: "gt-btn ghost gt-path-pick",
                onClick: () => removePrompt(item.id),
                title: "删除这份提示词",
                "aria-label": "删除 " + item.name,
              },
              "删除",
            ),
      ),
      isOpen
        ? h(
            "div",
            { className: "gt-prompt-body" },
            builtin
              ? h("pre", { className: "gt-prompt-readonly" }, item.text)
              : h(
                  "div",
                  { className: "gt-path" },
                  h("input", {
                    className: "gt-input",
                    value: item.name,
                    maxLength: PROMPT_NAME_LIMIT,
                    placeholder: "名字，例如「评估可投入性」",
                    spellCheck: false,
                    "aria-label": "提示词名字",
                    onChange: (e) => {
                      const name = e.target.value.slice(0, PROMPT_NAME_LIMIT);
                      writePrompts(prompts.map((p) => (p.id === item.id ? Object.assign({}, p, { name }) : p)));
                    },
                  }),
                ),
            builtin
              ? null
              : h("textarea", {
                  className: "gt-input gt-prompt-text",
                  value: item.text,
                  rows: 14,
                  spellCheck: false,
                  "aria-label": item.name + " 的提示词正文",
                  onChange: (e) => {
                    // 超长只截断不报错：一边打字一边弹红字比截断更烦。
                    const text = e.target.value.slice(0, PROMPT_TEXT_LIMIT);
                    writePrompts(prompts.map((p) => (p.id === item.id ? Object.assign({}, p, { text }) : p)));
                  },
                }),
            builtin
              ? h("p", { className: "gt-hint" }, "内置模板只读，也删不掉。要以它为底稿改一份，点下面的「新增提示词」。")
              : h("p", { className: "gt-hint" }, "仓库数据由插件按占位符填进来，不用自己抄 star 数。可用占位符见「占位符」按钮。"),
          )
        : null,
    );
  };

  const promptRows = [
    promptRow(BUILTIN_PROMPT, true),
    ...prompts.map((item) => promptRow(item, false)),
    prompts.length === 0
      ? h(
          "p",
          { className: "gt-note-line" },
          "还没有自定义提示词。点「讨论」会用上面的内置模板；想换个角度分析，就新增一份。",
        )
      : null,
  ].filter(Boolean);

  // 占位符说明做成可开合的浮层：常驻一屏文字会把设置页撑长，而它是「写模板
  // 时才需要查」的东西。只有这里需要它，所以放在这一节里而不是设置页顶部。
  const showPlaceholdersState = R.useState(false);
  const showPlaceholders = showPlaceholdersState[0];
  const setShowPlaceholders = showPlaceholdersState[1];

  const promptEditor = h(
    "div",
    { className: "gt-prompts" },
    h(
      "p",
      { className: "gt-note-line" },
      "「讨论」每次只用其中一份（标「默认」的那份）。想换个角度分析时，存一份新的再切默认即可，不用来回改同一段话。",
    ),
    promptRows,
    h(
      "div",
      { className: "gt-prompts-actions" },
      h(
        "button",
        {
          type: "button",
          className: "gt-btn gt-path-pick",
          onClick: addPrompt,
          disabled: prompts.length >= PROMPT_COUNT_LIMIT,
          title: "以内置模板为底稿新建一份",
          "aria-label": "新增提示词",
        },
        "新增提示词",
      ),
      h(
        "button",
        {
          type: "button",
          className: "gt-btn gt-path-pick",
          onClick: () => setShowPlaceholders(!showPlaceholders),
          "aria-expanded": showPlaceholders ? "true" : "false",
          "aria-controls": "gt-placeholders",
          title: "查看可用的 {{占位符}} 及各自作用",
        },
        showPlaceholders ? "收起占位符" : "占位符",
      ),
      h("span", { className: "gt-prompt-count" }, prompts.length + " / " + PROMPT_COUNT_LIMIT),
      flashMsg ? h("span", { className: "gt-prompt-flash" }, flashMsg) : null,
    ),
    showPlaceholders ? h(PlaceholderHelp, null) : null,
  );

  // 工作区只读展示 + 文件夹选择按钮（与工作志同一套）：路径只能由系统选择器
  // 产生。手打的路径没有对应 grant，引擎跑起来会因为没授权而失败。
  // 没设置时显示插件数据目录的真实路径——只写「默认」等于没说 cwd 在哪。
  const ownDataDir = snap.storagePath || "";
  const workspaceShown = form.workspacePath
    ? displayPath(form.workspacePath)
    : ownDataDir
      ? displayPath(ownDataDir)
      : "";
  const workspaceValue = h(
    "span",
    {
      className:
        "gt-path-value" + (form.workspacePath ? "" : ownDataDir ? " is-default" : " is-empty"),
      title: form.workspacePath
        ? workspaceShown
        : ownDataDir
          ? "默认值，即插件数据目录：" + displayPath(ownDataDir)
          : "正在读取插件数据目录…",
    },
    workspaceShown || "插件数据目录（正在读取…）",
  );
  const workspaceControl = h(
    "div",
    { className: "gt-path gt-workspace-path" },
    workspaceValue,
    h(
      "button",
      {
        type: "button",
        className: "gt-btn gt-path-pick",
        title: "打开系统文件夹选择器",
        onClick: () => void chooseWorkspace(),
      },
      "选择…",
    ),
    // 空值本来就是「用默认」，没有可清除的东西时就不渲染
    form.workspacePath
      ? h(
          "button",
          {
            type: "button",
            className: "gt-btn ghost gt-path-pick",
            title: "清除并回到默认行为",
            onClick: () => patch("workspacePath", ""),
          },
          "默认",
        )
      : null,
  );

  const periodItems = PERIODS.map((p) => ({ value: p.key, label: p.label }));
  const starItems = [
    { value: 10, label: "10（很宽）" },
    { value: 50, label: "50（默认）" },
    { value: 200, label: "200" },
    { value: 500, label: "500" },
    { value: 1000, label: "1000（很严）" },
  ];

  const languageControl = h(
    "div",
    { className: "gt-path" },
    h("input", {
      className: "gt-input",
      value: form.language || "",
      placeholder: "留空 = 全部语言",
      spellCheck: false,
      onChange: (e) => patch("language", e.target.value.trim().toLowerCase()),
    }),
    form.language
      ? h(
          "button",
          {
            type: "button",
            className: "gt-btn ghost gt-path-pick",
            title: "回到全部语言",
            onClick: () => patch("language", ""),
          },
          "全部",
        )
      : null,
  );

  const tokenControl = h(
    "details",
    { className: "gt-disclosure" },
    h("summary", null, "限流了再加 Token（可选）"),
    h(
      "div",
      { className: "gt-disclosure-body" },
      h(
        "p",
        { className: "gt-hint" },
        "不填也能正常使用：搜索接口未认证 10 次/分钟，一般够每天刷新一两次；README 走 raw 域名，不占配额。Token 只存在本机，只发给 api.github.com。",
      ),
      h(
        "div",
        { className: "gt-path" },
        h("input", {
          className: "gt-input",
          type: "password",
          value: form.token || "",
          placeholder: "ghp_… / github_pat_…",
          spellCheck: false,
          onChange: (e) => patch("token", e.target.value.trim()),
        }),
        form.token
          ? h(
              "button",
              {
                type: "button",
                className: "gt-btn ghost gt-path-pick",
                onClick: () => patch("token", ""),
              },
              "清除",
            )
          : null,
      ),
    ),
  );

  const saveHint =
    saveStatus === "saving"
      ? "保存中…"
      : saveStatus === "saved"
        ? "已保存"
        : saveStatus === "error"
          ? "保存失败，请重试"
          : "改动会自动保存";

  return h(
    "div",
    { className: "gt-settings" },
    h("p", { className: "gt-settings-intro" }, "榜单与解读只在这台机器上处理；只有你主动点「发送反馈」时才会把那段文字发出去。"),

    h(
      "section",
      { className: "gt-section" },
      h(
        "div",
        { className: "gt-section-label" },
        h("h2", null, "显示"),
        h("p", null, "打开面板时看到的默认视图与时间档。"),
      ),
      h(
        "div",
        { className: "gt-section-panel" },
        segField(
          "默认时间档",
          h(Dropdown, { items: periodItems, value: form.period, onChange: (v) => patch("period", v) }),
          "Trending 榜按天 / 周 / 月统计，切换后立刻重新抓取。",
        ),
        segField(
          "语言筛选",
          languageControl,
          "对应 github.com/trending/<语言>，填英文语言名，例如 python、rust、typescript。",
        ),
        segField(
          "新星库 star 阈值",
          h(Dropdown, {
            items: starItems,
            value: form.minStars,
            onChange: (v) => patch("minStars", normaliseMinStars(v)),
          }),
          "「新星库」只看近 7 天创建、star 达到这个数的仓库。",
        ),
      ),
    ),

    h(
      "section",
      { className: "gt-section" },
      h(
        "div",
        { className: "gt-section-label" },
        h("h2", null, "中文解读"),
        h("p", null, "只有点「生成解读」时才调用模型，其余时间不耗 token。"),
      ),
      h(
        "div",
        { className: "gt-section-panel" },
        segField(
          "引擎",
          h(Dropdown, {
            items: engineItems,
            value: form.engine,
            onChange: (v) => {
              // 换引擎时模型要清空：旧引擎的 model id 对新引擎无意义
              patch("engine", v);
              patch("model", "");
            },
            disabled: snap.modelsLoading && snap.catalog.length === 0,
            emptyText: "宿主没有返回引擎",
          }),
          snap.modelsError
            ? snap.modelsError
            : "选项来自宿主当前可用的引擎；标「不可用」的是已安装但没配置好。",
        ),
        segField(
          "模型",
          h(Dropdown, {
            items: modelItems,
            value: form.model,
            onChange: (v) => patch("model", v),
            // 「自动」时按第一个可用引擎的模型列表给选项，用户仍能先挑模型。
            disabled: !entry || entry.available === false,
            emptyText: entry
              ? entry.available === false
                ? "该引擎当前不可用"
                : "该引擎未报告可用模型"
              : "先选引擎",
          }),
          modelHint(),
        ),
        segField(
          "AI 工作区",
          workspaceControl,
          "解读与「讨论」都会在这个目录下运行。"
            + "点榜单某行的「讨论」时，模型先在这里找同名仓库的本地副本，找不到再读远程。"
            + "默认落在插件数据目录，免得这些会话混进某个项目的会话历史。"
            + (flashMsg ? " " + flashMsg : ""),
        ),
      ),
    ),

    h(
      "section",
      { className: "gt-section" },
      h(
        "div",
        { className: "gt-section-label" },
        h("h2", null, "讨论提示词"),
        h("p", null, "点榜单某行的「讨论」时发给模型的那段话。可以存几份不同角度，选一份当默认。"),
      ),
      h(
        "div",
        { className: "gt-section-panel" },
        // 续接策略放在提示词之前：它决定「点一下会发生什么」，比提示词更早要回答。
        segField(
          "再点同一个仓库时",
          h(Dropdown, {
            items: RESUME_MODES.map((m) => ({ value: m.key, label: m.label })),
            value: form.resumeMode,
            onChange: (v) => patch("resumeMode", normaliseResumeMode(v)),
          }),
          resumeModeHint(form.resumeMode),
        ),
        promptEditor,
      ),
    ),

    h(
      "section",
      { className: "gt-section" },
      h(
        "div",
        { className: "gt-section-label" },
        h("h2", null, "网络"),
        h("p", null, "只访问 github.com、api.github.com 与 raw.githubusercontent.com。"),
      ),
      h(
        "div",
        { className: "gt-section-panel" },
        h(
          "p",
          { className: "gt-note-line" },
          "榜单来自 ",
          h("code", null, "github.com/trending"),
          " 的公开页面，不占 API 配额；新星库走 GitHub 搜索接口，未认证时 10 次/分钟。",
        ),
        tokenControl,
      ),
    ),

    h(FeedbackSection, null),

    h("p", { className: "gt-settings-foot" }, "版本 " + ctx.version + " · " + saveHint),
  );
}

/* ---------- CSS ---------- */

const CSS = `
/* 一套自足的 token：不依赖宿主变量名（各版本命名不保证稳定），
 * 也保证浅色/深色在任何宿主下都读得清。 */
.gt-root {
  --gt-text: #0a0a0a; --gt-muted: #6b6b6b;
  --gt-border: #e6e6e6; --gt-surface: #ffffff; --gt-raised: #f6f7f9;
  --gt-accent: #1d5fbf; --gt-positive: #2e7d32; --gt-negative: #c4242a;
  /* 骨架屏色块单独一档：raised 压在白色底上几乎看不见，会显得「没反应」 */
  --gt-skel: #e4e7ec;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  gap: 10px;
  padding: 16px 18px 0;
  color: var(--gt-text);
  container-type: inline-size;
}
.dark .gt-root {
  --gt-text: #f2f3f5; --gt-muted: #a3a7ad;
  --gt-border: #2a2d32; --gt-surface: #17191c; --gt-raised: #1d2024;
  --gt-skel: #2b2f35;
  --gt-accent: #5b9bf0; --gt-positive: #4fc27a; --gt-negative: #e5566f;
}
@media (prefers-color-scheme: dark) {
  .gt-root { --gt-text: #f2f3f5; --gt-muted: #a3a7ad; --gt-border: #2a2d32;
    --gt-surface: #17191c; --gt-raised: #1d2024; --gt-skel: #2b2f35;
    --gt-accent: #5b9bf0;
    --gt-positive: #4fc27a; --gt-negative: #e5566f; }
  .light .gt-root, html.light .gt-root {
    --gt-text: #0a0a0a; --gt-muted: #6b6b6b; --gt-border: #e6e6e6;
    --gt-surface: #ffffff; --gt-raised: #f6f7f9; --gt-skel: #e4e7ec;
    --gt-accent: #1d5fbf;
    --gt-positive: #2e7d32; --gt-negative: #c4242a;
  }
}
.gt-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.gt-title { margin: 0; font-size: 17px; font-weight: 600; letter-spacing: -0.01em; }
.gt-sub { margin: 2px 0 0; font-size: 12px; opacity: 0.62; }
.gt-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.gt-group { display: flex; align-items: center; gap: 4px; }
.gt-group--end { margin-left: auto; }

/* 分段控件：视觉上是一个选择器，但选项全部可见、单击切换。
 * 用一条外框 + 内部分格，而不是并排的独立按钮——否则看起来仍像 3 个按钮。 */
.gt-seg {
  display: inline-flex; align-items: center; padding: 2px; gap: 2px;
  border: 1px solid var(--gt-border); border-radius: 8px;
  background: var(--gt-surface);
}
.gt-seg-item {
  font: inherit; font-size: 12px; line-height: 1; padding: 5px 9px;
  border: 0; border-radius: 6px; background: transparent; color: var(--gt-muted);
  cursor: pointer; white-space: nowrap;
  transition: background-color 120ms ease, color 120ms ease;
}
.gt-seg-item:hover { background: var(--gt-raised); color: var(--gt-text); }
.gt-seg-item.is-on {
  background: var(--gt-raised); color: var(--gt-text); font-weight: 600;
}
.gt-seg-item:focus-visible { outline: 2px solid var(--gt-accent); outline-offset: -1px; }

/* 时间档的两份渲染：宽屏分段控件、窄屏紧凑下拉。
 * 组件拿不到容器宽度，所以两份都在 DOM 里，由 @container 决定谁可见；
 * 隐藏的那份不可聚焦，键盘不会 Tab 进看不见的控件。 */
.gt-period { display: inline-flex; align-items: center; gap: 4px; }
.gt-period-seg { display: inline-flex; }
.gt-period-dd { display: none; }
.gt-period-dd .gt-dd { width: auto; }
.gt-period-dd .gt-dd-trigger { height: 28px; padding: 0 8px; gap: 5px; font-size: 12px; }
/* 紧凑触发器的宽度只有 53px，而 .gt-dd-menu 是 left:0; right:0 ——
 * 菜单会跟着变成 53px，中文全部竖排。紧凑模式必须给菜单单独定宽。 */
.gt-period-dd .gt-dd-menu {
  left: 0; right: auto; min-width: 132px;
}

/* 低频动作的显隐：宽屏平铺，窄屏收进「更多」菜单。 */
.gt-when-narrow { display: none; }

.gt-btn {
  font: inherit;
  font-size: 12px;
  line-height: 1;
  padding: 6px 10px;
  border-radius: 7px;
  border: 1px solid var(--gt-border);
  background: transparent;
  color: inherit;
  cursor: pointer;
  white-space: nowrap;
  transition: background-color 120ms ease, border-color 120ms ease;
}
.gt-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
/* 「刷新 / 刷新中…」来回切时宽度不跳，右边的按钮不会跟着挪。
 * 转圈 12px + 间距 6px + 「刷新中…」实测 63px，加内边距 20 刚好 86px。 */
.gt-btn--refresh { min-width: 86px; }
/* 「导出 Markdown / 已复制 / 复制失败」来回切时宽度不跳。 */
.gt-btn--export { min-width: 104px; }
.gt-btn:hover { background: var(--gt-raised); }
.gt-btn--primary { border-color: var(--gt-accent); font-weight: 600; }
.gt-btn:disabled { opacity: 0.45; cursor: not-allowed; }
/* 抓取中按钮不能用 opacity:.45 冒充禁用：那样转圈也被一起淡掉了。
 * 底色压暗、光标改成等待，转圈保持不透明。放在 disabled 之后才盖得住。 */
.gt-btn--busy:disabled { opacity: 1; cursor: progress; background: var(--gt-raised); }
.gt-btn--busy .gt-spinner { border-color: var(--gt-border); border-top-color: var(--gt-accent); }
.gt-btn:focus-visible, .gt-input:focus-visible, .gt-repo:focus-visible {
  outline: 2px solid var(--gt-accent);
  outline-offset: 2px;
}

/* 「更多」菜单：结构和 Dropdown 同源，语义是「执行动作」不是「选值」。 */
.gt-more { position: relative; display: inline-flex; }
.gt-more-trigger {
  width: 28px; height: 28px; padding: 0; border-radius: 7px;
  display: flex; align-items: center; justify-content: center;
  font: inherit; font-size: 15px; line-height: 1;
  border: 1px solid var(--gt-border); background: transparent;
  color: inherit; cursor: pointer;
}
.gt-more-trigger:hover { background: var(--gt-raised); }
.gt-more-trigger:focus-visible { outline: 2px solid var(--gt-accent); outline-offset: 2px; }
.gt-more.is-open .gt-more-trigger { border-color: var(--gt-accent); }
.gt-more-scrim { position: fixed; inset: 0; z-index: 80; }
.gt-more-menu {
  position: absolute; right: 0; top: calc(100% + 6px); z-index: 81;
  min-width: 168px; max-height: 260px; overflow-y: auto; padding: 4px;
  display: flex; flex-direction: column; gap: 1px;
  background: var(--gt-surface); border: 1px solid var(--gt-border);
  border-radius: 8px; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.16);
}
.gt-more.is-up .gt-more-menu { top: auto; bottom: calc(100% + 6px); }
.gt-more-item {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  padding: 7px 9px; border: 0; border-radius: 5px;
  font: inherit; font-size: 13px; text-align: left;
  background: transparent; color: inherit; cursor: pointer; outline: none;
}
.gt-more-item.is-active { background: var(--gt-raised); }
.gt-more-item:disabled { opacity: 0.45; cursor: not-allowed; }
.gt-more-item:disabled.is-active { background: transparent; }
.gt-more-hint { font-size: 11px; color: var(--gt-muted); }
.gt-stamp { font-size: 11px; opacity: 0.55; white-space: nowrap; }
/* 「随便看看」的搜索框与换一批。输入框吃掉剩余宽度，但设上限：
 * 工具栏是 flex-wrap 的，输入框太宽会把右侧按钮挤到第二行。 */
.gt-discover { gap: 6px; flex-wrap: wrap; }
.gt-filter { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.gt-filter-input { width: 240px; min-width: 0; }
.gt-filter-input::-webkit-search-cancel-button { cursor: pointer; }
.gt-filter-count { font-size: 12px; color: var(--gt-muted); }
.gt-filter-count--idle { opacity: 0.6; }
.gt-filter-clear { flex: none; }
.gt-empty-clear { margin-left: 8px; }
.gt-search { display: flex; align-items: center; gap: 4px; }
.gt-input {
  font: inherit;
  font-size: 12px;
  line-height: 1;
  padding: 6px 9px;
  border-radius: 7px;
  border: 1px solid var(--gt-border);
  background: var(--gt-surface);
  color: inherit;
  transition: border-color 120ms ease;
}
.gt-input::placeholder { color: inherit; opacity: 0.45; }
.gt-input:disabled { opacity: 0.55; cursor: not-allowed; }
.gt-search-input { width: 180px; min-width: 0; }
.gt-search-input::-webkit-search-cancel-button { cursor: pointer; }
/* 精确命中标记：和涨跌标签同一视觉重量（小、带底色），但用强调色，
 * 不会被误读成「上升」。 */
.gt-hit {
  flex: none;
  font-size: 11px;
  line-height: 1;
  padding: 3px 6px;
  border-radius: 5px;
  border: 1px solid var(--gt-accent);
  color: var(--gt-accent);
}
.gt-notice { margin: 0; font-size: 12px; opacity: 0.7; }
/* 状态区可能同时有两件事要说（在看什么数据 + 刚才那一按的结果）。
 * 合成一列而不是二选一，两句话都短，叠起来还不到原来两行的钱。 */
.gt-status-rows { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.gt-notice--error { color: var(--gt-negative); opacity: 1; display: flex; gap: 6px; flex-wrap: wrap; }
/* 开会话成功：用正向色而不是中性灰。它是一条「你做了一件事，结果是好的」
 * 的回执，不是背景说明，灰掉就等于没说。 */
.gt-notice--ok { color: var(--gt-positive); opacity: 1; display: flex; gap: 6px; flex-wrap: wrap; }
.gt-notice-hint { opacity: 0.7; }
/* 抓取中：提示行里放一枚转圈，用户能确认进程还活着，而不是页面卡住了 */
.gt-notice.gt-running {
  display: flex; align-items: center; gap: 7px; flex-wrap: wrap;
  transition: opacity 120ms ease;
}
.gt-running-text { flex: none; }

@keyframes gt-spin { to { transform: rotate(360deg); } }
.gt-spinner {
  flex: none; display: inline-block; width: 12px; height: 12px; box-sizing: border-box;
  border: 2px solid var(--gt-border); border-top-color: var(--gt-accent);
  border-radius: 50%; animation: gt-spin 0.8s linear infinite;
}

/* 第一次加载没有旧数据可看：用骨架屏占住列表高度，
 * 避免「一行灰字 → 突然长出一整屏卡片」的跳动。 */
.gt-skel-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.gt-skel {
  position: relative; overflow: hidden;
  display: flex; gap: 12px; padding: 11px 14px; border-radius: 10px;
  background: var(--gt-surface); border: 1px solid var(--gt-border);
}
.gt-skel-badge { flex: none; width: 22px; height: 22px; border-radius: 6px; background: var(--gt-skel); }
.gt-skel-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 12px; }
.gt-skel-line { height: 11px; border-radius: 5px; background: var(--gt-skel); }
.gt-skel-line--title { width: 42%; height: 13px; }
.gt-skel-line--desc { width: 78%; }
.gt-skel-line--meta { width: 30%; }
/* 只有一道高光从左往右扫，色块本身不呼吸：比整块脉冲安静得多 */
.gt-skel::after {
  content: ""; position: absolute; inset: 0; pointer-events: none;
  background-image: linear-gradient(100deg, transparent 30%, rgba(255, 255, 255, 0.75) 50%, transparent 70%);
  background-size: 240% 100%; background-position: 140% 0;
  animation: gt-sweep 1.5s ease-in-out infinite;
}
.dark .gt-skel::after {
  background-image: linear-gradient(100deg, transparent 30%, rgba(255, 255, 255, 0.05) 50%, transparent 70%);
}
@keyframes gt-sweep { to { background-position: -140% 0; } }

/* 新榜单落位时轻轻淡入，替代“整块内容瞬间替换” */
@keyframes gt-fade-in { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: none; } }

@media (prefers-reduced-motion: reduce) {
  .gt-spinner { animation: none; }
  .gt-skel::after { animation: none; opacity: 0; }
  .gt-list { animation: none; }
  .gt-row, .gt-btn, .gt-discuss { transition: none; }
}
.gt-scroll { flex: 1; min-height: 0; overflow-y: auto; padding-bottom: 18px; }
.gt-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; animation: gt-fade-in 180ms ease; }
.gt-row {
  display: flex; gap: 12px; padding: 11px 14px; border-radius: 10px;
  background: var(--gt-surface); border: 1px solid var(--gt-border);
  transition: background-color 120ms ease, border-color 120ms ease;
}
.gt-row:hover { background: var(--gt-raised); border-color: var(--gt-accent); }
.gt-row-main { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 4px; }
.gt-row-title { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
/* 名次做成定宽徽章：一眼能看出这是榜单的第几条，也把标题行对齐成一条线 */
.gt-rank {
  flex: none; min-width: 22px; height: 22px; padding: 0 5px;
  display: inline-flex; align-items: center; justify-content: center;
  border-radius: 6px; border: 1px solid var(--gt-border);
  background: var(--gt-raised);
  font-size: 11px; font-weight: 600; color: var(--gt-muted);
  font-variant-numeric: tabular-nums;
}
.gt-repo { font-size: 13.5px; font-weight: 600; text-decoration: none; color: inherit; word-break: break-all; }
.gt-repo:hover { text-decoration: underline; }
.gt-repo-owner { font-weight: 400; color: var(--gt-muted); }
/* 讨论入口：平时压得很轻，不抢仓库名的注意力；悬停/聚焦时才浮起来。
 * 25 行各摆一个显眼按钮会让整个榜显得吵闹，而且误触是一轮真 token。 */
.gt-discuss {
  flex: none; padding: 2px 9px;
  font-size: 11px; border-radius: 6px; opacity: 0;
  transition: opacity 120ms ease;
}
/* 只有最左边那个按钮吃 auto 外边距：三个都写的话余量会被均分，
 * 悬停时按钮之间空出一大块、整行标题横向抖一下。 */
.gt-discuss--lead { margin-left: auto; }
.gt-row:hover .gt-discuss, .gt-row:focus-within .gt-discuss { opacity: 1; }
.gt-discuss:focus-visible { opacity: 1; }
.gt-discuss--busy { opacity: 1; }
.gt-sep { white-space: pre; }
.gt-move {
  flex: none; font-size: 10.5px; padding: 1px 6px; border-radius: 5px;
  background: var(--gt-raised); color: var(--gt-muted);
  font-variant-numeric: tabular-nums; white-space: nowrap;
}
/* 涨跌用颜色区分方向，箭头字形在窄体终端字体里常缺失，颜色更可靠 */
.gt-move--up { color: #2e7d32; background: rgba(46,160,67,0.12); }
.gt-move--down { color: #c4242a; background: rgba(196,36,42,0.1); }
.dark .gt-move--up { color: #4fc27a; }
.dark .gt-move--down { color: #e5566f; }
.gt-move--new { background: rgba(46,160,67,0.18); color: #2e7d32; font-weight: 600; }
.dark .gt-move--new { color: #4fc27a; }
.gt-desc { margin: 0; font-size: 12.5px; line-height: 1.55; color: var(--gt-muted); }
.gt-meta {
  display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
  font-size: 11.5px; color: var(--gt-muted);
}
.gt-lang { display: inline-flex; align-items: center; gap: 5px; }
.gt-dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; opacity: 0.8; display: inline-block; }
.gt-gain { font-variant-numeric: tabular-nums; }
.gt-stat { font-variant-numeric: tabular-nums; }
.gt-empty { font-size: 12.5px; opacity: 0.6; padding: 24px 4px; }
.gt-dropped { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--gt-border); }
.gt-dropped h3 { margin: 0 0 4px; font-size: 12px; font-weight: 600; opacity: 0.7; }
.gt-dropped p { margin: 0; font-size: 12px; opacity: 0.6; word-break: break-all; }
/* 解读面板：和榜单卡片同一套表面，再用一条强调色左边框区分「这是模型写的」 */
.gt-digest {
  margin-top: 14px; padding: 14px 16px; border-radius: 10px;
  background: var(--gt-surface); border: 1px solid var(--gt-border);
  border-left: 3px solid var(--gt-accent);
}
.gt-digest-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
/* 只管头部那个「解读」标题。写成 .gt-digest h3 会顺带压过正文里
 * .gt-md-h3 的字号（元素选择器比单个类更具体）。 */
.gt-digest-head > h3 { margin: 0; font-size: 13px; font-weight: 600; }
/* 生成中：转圈 + 已收字数。让用户确认进程活着，也知道还要等多久 */
.gt-digest-run {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 11.5px; color: var(--gt-muted); font-variant-numeric: tabular-nums;
}
.gt-digest-stopped { color: var(--gt-muted); font-weight: 600; }
.gt-digest-copy { margin-left: auto; padding: 3px 9px; font-size: 11.5px; }
.gt-digest-body { font-size: 13px; line-height: 1.7; word-break: break-word; }
.gt-digest-wait { color: var(--gt-muted); }
.gt-digest-body > *:first-child { margin-top: 0; }
.gt-digest-body > *:last-child { margin-bottom: 0; }
/* 行内 README：不用强调色左边框，它和「解读」是并列的两块内容，
 * 左边框会让整页变成两根竖线。 */
.gt-readme {
  margin-top: 10px; padding: 10px 12px; border-radius: 8px;
  background: var(--gt-raised); border: 1px solid var(--gt-border);
}
.gt-readme-note {
  margin: 0 0 8px; display: flex; align-items: center; gap: 8px;
  font-size: 11.5px; color: var(--gt-muted);
}
.gt-readme-note--error { color: var(--gt-negative); }
.gt-readme-more { margin-left: auto; color: var(--gt-accent); }
/* 正文限高：README 可以很长，展开一整份会把下面十几行榜单推到屏幕外。
 * 2000 字配这个高度刚好露出开头和结构，剩下的滚一下就够。 */
.gt-readme-body {
  max-height: 360px; overflow-y: auto;
  font-size: 12.5px; line-height: 1.65; word-break: break-word;
}
.gt-readme-body > *:first-child { margin-top: 0; }
.gt-readme-body > *:last-child { margin-bottom: 0; }
/* README 的一级标题和仓库名重复，而且比行标题还大，压到次要位置。 */
.gt-readme-body .gt-md-h1 { font-size: 14px; }

/* 解读正文里的 Markdown。只覆盖本插件自己的类名，不影响宿主样式。
 * 正文是 13px，标题梯度要拉到能一眼分节——模型最爱写三级标题，只比正文大
 * 1px 的话读起来和段落没区别。 */
.gt-md-p { margin: 0 0 10px; }
.gt-md-h1, .gt-md-h2, .gt-md-h3, .gt-md-h4, .gt-md-h5, .gt-md-h6 {
  margin: 18px 0 8px; font-weight: 600; line-height: 1.35;
}
.gt-md-h1 { font-size: 18px; }
.gt-md-h2 { font-size: 16.5px; }
.gt-md-h3 { font-size: 15px; }
.gt-md-h4 { font-size: 14px; }
.gt-md-h5, .gt-md-h6 { font-size: 13px; }
.gt-md-list { margin: 0 0 10px; padding-left: 20px; display: flex; flex-direction: column; gap: 4px; }
.gt-md-list .gt-md-list { margin: 4px 0 0; }
.gt-md-quote {
  margin: 0 0 10px; padding: 2px 0 2px 10px;
  border-left: 2px solid var(--gt-border); color: var(--gt-muted);
}
.gt-md-hr { margin: 14px 0; border: 0; border-top: 1px solid var(--gt-border); }
.gt-md-code {
  padding: 1px 5px; border-radius: 4px; background: var(--gt-raised);
  font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
  font-size: 12px;
}
.gt-md-pre {
  margin: 0 0 10px; padding: 10px 12px; border-radius: 8px;
  background: var(--gt-raised); border: 1px solid var(--gt-border);
  overflow-x: auto;
}
.gt-md-pre code {
  font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
  font-size: 12px; line-height: 1.6; white-space: pre;
}
/* 表格外壳负责横向滚动：解读面板在窄窗口里不能把整页撑宽 */
.gt-md-table-wrap {
  margin: 0 0 10px; overflow-x: auto;
  border: 1px solid var(--gt-border); border-radius: 8px;
}
/* 宽度 100% 让宽窗口铺满；min-width 是内容下限——窄窗口里宁可横向滚动，
 * 也不要把四列中文挤成一条条竖排。 */
.gt-md-table { width: 100%; min-width: 420px; border-collapse: collapse; font-size: 12.5px; line-height: 1.55; }
.gt-md-table th, .gt-md-table td {
  padding: 7px 10px; text-align: left; vertical-align: top;
  border-bottom: 1px solid var(--gt-border); word-break: break-word;
}
.gt-md-table th { background: var(--gt-raised); font-weight: 600; white-space: nowrap; }
.gt-md-table tbody tr:last-child td { border-bottom: 0; }
.gt-md-table tbody tr:nth-child(even) td { background: var(--gt-raised); }
.gt-digest-body a { color: var(--gt-accent); }
.gt-settings {
  --gt-control: #d4d4d4;
  --gt-text: #0a0a0a; --gt-muted: #6b6b6b; --gt-border: #e6e6e6;
  --gt-surface: #ffffff; --gt-raised: #f6f7f9; --gt-accent: #1d5fbf;
  max-width: 1080px; margin: 0 auto; display: flex; flex-direction: column;
  color: var(--gt-text); font-size: 14px; line-height: 1.6;
  container-type: inline-size;
}
.dark .gt-settings, .dark.gt-settings {
  --gt-text: #f2f3f5; --gt-muted: #a3a7ad; --gt-border: #2a2d32;
  --gt-surface: #17191c; --gt-raised: #1d2024; --gt-control: #3a3e44;
  --gt-accent: #5b9bf0;
}
@media (prefers-color-scheme: dark) {
  .gt-settings {
    --gt-text: #f2f3f5; --gt-muted: #a3a7ad; --gt-border: #2a2d32;
    --gt-surface: #17191c; --gt-raised: #1d2024; --gt-control: #3a3e44;
    --gt-accent: #5b9bf0;
  }
}
.gt-settings-intro { margin: 0 0 8px; font-size: 13px; color: var(--gt-muted); }
.gt-section {
  display: grid; grid-template-columns: 260px minmax(0, 1fr); gap: 32px;
  padding: 26px 0; border-top: 1px solid var(--gt-border);
}
.gt-section:first-of-type { border-top: 0; padding-top: 8px; }
.gt-section-label h2 { margin: 0; font-size: 16px; font-weight: 600; line-height: 1.4; }
.gt-section-label p { margin: 6px 0 0; font-size: 13px; line-height: 1.55; color: var(--gt-muted); }
.gt-section-panel {
  display: flex; flex-direction: column; gap: 18px;
  background: var(--gt-surface); border: 1px solid var(--gt-border);
  border-radius: 12px; padding: 18px;
}
.gt-field { display: flex; flex-direction: column; gap: 6px; }
.gt-field > label { font-size: 14px; font-weight: 500; }
.gt-field .gt-hint { font-size: 12px; line-height: 1.5; color: var(--gt-muted); }
.gt-settings .gt-input {
  width: 100%; height: 36px; box-sizing: border-box; font: inherit; font-size: 13px;
  padding: 0 12px; border-radius: 6px;
  border: 1px solid var(--gt-control); background: var(--gt-surface); color: var(--gt-text);
}
.gt-settings .gt-input::placeholder { color: var(--gt-muted); }
.gt-settings .gt-input:focus { outline: 2px solid var(--gt-accent); outline-offset: -1px; }
.gt-settings .gt-path { display: flex; align-items: center; gap: 8px; min-width: 0; }
.gt-settings .gt-btn {
  height: 36px; padding: 0 14px; font-size: 13px; border-radius: 6px;
  border: 1px solid var(--gt-control); background: var(--gt-surface); color: var(--gt-text);
}
.gt-settings .gt-btn:hover:not(:disabled) { background: var(--gt-raised); }
.gt-settings .gt-btn.ghost { border-color: transparent; background: transparent; color: var(--gt-muted); }
.gt-settings .gt-btn.ghost:hover:not(:disabled) { background: var(--gt-raised); color: var(--gt-text); }
.gt-settings .gt-path-pick { flex: none; }
/* 路径字段：只读展示 + 文件夹选择按钮，路径只能通过系统选择器产生 */
.gt-settings .gt-path-value {
  flex: 1 1 auto; min-width: 0; height: 36px; box-sizing: border-box;
  display: block; padding: 0 12px; line-height: 34px;
  border: 1px solid var(--gt-control); border-radius: 6px;
  background: var(--gt-raised); color: var(--gt-text); font-size: 13px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.gt-settings .gt-path-value.is-empty { color: var(--gt-muted); }

/* 讨论提示词：一份一行的折叠列表。默认那份只在收起时也一眼可见，
 * 因为「点讨论会用哪份」是这一节唯一不能猜的信息。 */
.gt-settings .gt-prompts { display: flex; flex-direction: column; gap: 10px; }
.gt-settings .gt-prompt {
  border: 1px solid var(--gt-control); border-radius: 8px; overflow: hidden;
}
.gt-settings .gt-prompt-head {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 10px; background: var(--gt-raised);
}
.gt-settings .gt-prompt-name {
  flex: 1 1 auto; min-width: 0; display: flex; align-items: center; gap: 6px;
  font: inherit; font-size: 13px; font-weight: 500; text-align: left;
  padding: 2px 0; border: 0; background: transparent; color: inherit; cursor: pointer;
}
.gt-settings .gt-prompt-name:hover { color: var(--gt-accent); }
.gt-settings .gt-prompt-chevron { flex: none; font-size: 10px; opacity: 0.7; }
.gt-settings .gt-prompt-label {
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
/* 内置那份只在名字后面挂一个灰字，不加边框/底色/左边线：它是列表里的第一行，
 * 位置已经说明了它是什么，再刷一层样式只会和这一节其他控件打架。 */
.gt-settings .gt-prompt-note { flex: none; font-size: 11px; color: var(--gt-muted); }
.gt-settings .gt-prompt-default {
  flex: none; padding: 2px 8px; border-radius: 5px; font-size: 11px; font-weight: 600;
  color: var(--gt-accent); background: transparent;
  border: 1px solid var(--gt-accent);
}
.gt-settings .gt-prompt-head .gt-btn { height: 26px; padding: 0 10px; font-size: 12px; }
.gt-settings .gt-prompt-body {
  display: flex; flex-direction: column; gap: 10px; padding: 12px;
  border-top: 1px solid var(--gt-control);
}
/* 正文是多行提示词：等宽字体比比例字体更容易看出缩进和条目结构。 */
.gt-settings .gt-prompt-text {
  height: auto; min-height: 200px; padding: 10px 12px; line-height: 1.6;
  resize: vertical; font-family: var(--gt-mono, ui-monospace, "Cascadia Code", Consolas, monospace);
  font-size: 12.5px;
}
/* 内置模板的只读正文：和 textarea 同样的字距与行长，但它是文字而不是控件。 */
.gt-settings .gt-prompt-readonly {
  margin: 0; max-height: 260px; overflow: auto; padding: 10px 12px;
  border: 1px solid var(--gt-border); border-radius: 6px; background: var(--gt-raised);
  font-family: var(--gt-mono, ui-monospace, "Cascadia Code", Consolas, monospace);
  font-size: 12.5px; line-height: 1.6; white-space: pre-wrap; word-break: break-word;
}
.gt-settings .gt-prompts-actions {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
}
.gt-settings .gt-prompt-count { font-size: 12px; color: var(--gt-muted); font-variant-numeric: tabular-nums; }
/* 占位符说明：按钮点开才出现，所以直接铺一列，不做折叠动画。 */
.gt-settings .gt-placeholders {
  display: flex; flex-direction: column; gap: 10px;
  padding: 14px; border: 1px solid var(--gt-border); border-radius: 8px;
}
.gt-settings .gt-placeholder-list {
  display: flex; flex-direction: column; gap: 10px; margin: 0;
}
.gt-settings .gt-placeholder { display: flex; flex-direction: column; gap: 2px; }
.gt-settings .gt-placeholder-head {
  display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap;
}
.gt-settings .gt-placeholder-token {
  font-family: var(--gt-mono, ui-monospace, "Cascadia Code", Consolas, monospace);
  font-size: 12.5px; color: var(--gt-accent);
}
.gt-settings .gt-placeholder-label { font-size: 13px; font-weight: 500; }
.gt-settings .gt-placeholder-sample {
  font-family: var(--gt-mono, ui-monospace, "Cascadia Code", Consolas, monospace);
  font-size: 11.5px; color: var(--gt-muted);
}
.gt-settings .gt-placeholder-detail { margin: 0; font-size: 12px; line-height: 1.5; color: var(--gt-muted); }
.gt-settings .gt-prompt-flash { font-size: 12px; color: var(--gt-muted); }
/* 没设置时显示的默认路径：虚框表示「这不是你选的，是插件自己的目录」 */
.gt-settings .gt-path-value.is-default {
  color: var(--gt-text); border-style: dashed; background: transparent;
}

/* 自绘下拉 */
.gt-dd { position: relative; width: 100%; }
.gt-dd-trigger {
  width: 100%; height: 36px; box-sizing: border-box; padding: 0 12px;
  display: flex; align-items: center; gap: 8px; cursor: pointer;
  font: inherit; font-size: 13px; text-align: left;
  border: 1px solid var(--gt-control); border-radius: 6px;
  background: var(--gt-surface); color: var(--gt-text);
}
.gt-dd-trigger:hover:not(:disabled) { border-color: var(--gt-muted); }
.gt-dd-trigger:focus-visible { outline: 2px solid var(--gt-accent); outline-offset: -1px; }
.gt-dd-trigger:disabled { opacity: 0.55; cursor: not-allowed; }
.gt-dd.is-open .gt-dd-trigger { border-color: var(--gt-accent); }
.gt-dd-value { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gt-dd-value.is-empty { color: var(--gt-muted); }
.gt-dd-caret {
  flex: none; width: 7px; height: 7px; margin-top: -4px;
  border-right: 1.5px solid var(--gt-muted); border-bottom: 1.5px solid var(--gt-muted);
  transform: rotate(45deg); transition: transform 120ms ease;
}
.gt-dd.is-open .gt-dd-caret { transform: rotate(-135deg); margin-top: 3px; }
.gt-dd-scrim { position: fixed; inset: 0; z-index: 80; }
.gt-dd-menu {
  position: absolute; left: 0; right: 0; top: calc(100% + 6px); z-index: 81;
  max-height: 260px; overflow-y: auto; padding: 4px;
  background: var(--gt-surface); border: 1px solid var(--gt-border);
  border-radius: 8px; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.16);
}
.gt-dd.is-up .gt-dd-menu { top: auto; bottom: calc(100% + 6px); }
.gt-dd-item {
  display: flex; align-items: center; gap: 8px; padding: 7px 9px;
  border-radius: 5px; font-size: 13px; cursor: pointer; outline: none;
}
.gt-dd-item.is-active { background: var(--gt-raised); }
.gt-dd-item.is-disabled { opacity: 0.45; cursor: default; }
.gt-dd-item.is-disabled.is-active { background: transparent; }
.gt-dd-label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gt-dd-check { flex: none; font-size: 12px; color: var(--gt-accent); opacity: 0; }
.gt-dd-item[aria-selected="true"] .gt-dd-check { opacity: 1; }
.gt-dd-empty { padding: 8px 10px; font-size: 12px; color: var(--gt-muted); }

/* 可折叠的次要项：Token 之类默认收起来 */
.gt-disclosure { border-top: 1px solid var(--gt-border); padding-top: 14px; }
.gt-disclosure:last-child { padding-bottom: 0; }
.gt-disclosure > summary {
  cursor: pointer; font-size: 13px; color: var(--gt-muted); list-style: none;
  display: flex; align-items: center; gap: 6px; padding: 2px 0;
}
.gt-disclosure > summary::-webkit-details-marker { display: none; }
.gt-disclosure > summary::before { content: "▸"; font-size: 10px; line-height: 1; }
.gt-disclosure[open] > summary::before { content: "▾"; }
.gt-disclosure > summary:hover { color: var(--gt-text); }
.gt-disclosure-body { display: flex; flex-direction: column; gap: 10px; margin-top: 12px; }
.gt-disclosure-body .gt-hint { margin: 0; font-size: 12px; line-height: 1.6; color: var(--gt-muted); }

/* 只放一段说明的卡片：别留出字段间距那么大的尾部空白 */
.gt-section-panel > .gt-note-line:last-child { margin-bottom: 0; }

.gt-note-line { margin: 0; font-size: 13px; line-height: 1.6; color: var(--gt-muted); }
.gt-note-line code {
  padding: 1px 5px; border-radius: 4px; font-size: 12px;
  background: var(--gt-raised); border: 1px solid var(--gt-border);
}
.gt-settings-foot { font-size: 12px; color: var(--gt-muted); margin: 16px 0 0; }

.gt-feedback-text {
  width: 100%; min-height: 96px; resize: vertical;
  font-family: inherit; font-size: 13px; line-height: 1.6;
}
/* ---- 反馈区 ---- */
.gt-feedback-row {
  display: flex; align-items: baseline; justify-content: space-between;
  gap: 12px; margin-top: 6px;
}
.gt-feedback-count { font-variant-numeric: tabular-nums; }
/* 额度用完时这句要能读懂，不要靠颜色区分——颜色在深浅色里不一致。 */
.gt-feedback-quota { text-align: right; }
/* 额度区的「重试」：长得像链接但仍是按钮，键盘可达。 */
.gt-link-btn {
  margin-left: 6px; padding: 0; border: 0; background: none;
  font: inherit; font-size: 12px; color: var(--gt-accent);
  text-decoration: underline; cursor: pointer;
}
.gt-link-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.gt-link-btn:focus-visible { outline: 2px solid var(--gt-accent); outline-offset: 2px; }
.gt-feedback-actions { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
/* <a> 当按钮用时没有 <button> 的默认盒模型，补上同样的外观。 */
.gt-feedback-issue {
  border: 1px solid var(--gt-border);
  background: var(--gt-surface);
  color: var(--gt-text);
  text-decoration: none;
  padding: 6px 12px;
  border-radius: 6px;
  font-size: 13px;
  line-height: 1.4;
}
.gt-feedback-issue:hover { background: var(--gt-raised); }
.gt-feedback-status { margin: 10px 0 0; font-size: 13px; }
.gt-feedback-status.is-ok { color: var(--gt-positive); font-weight: 500; }
.gt-feedback-status.is-bad { color: var(--gt-negative); }
/* 成功回执：按钮从「主操作」变成「已完成」——保留绿边而不是整块变绿，
 * 免得和「发送中」的忙碌态混淆；文字本身已改成「已发送」。 */
.gt-btn.gt-feedback-sent {
  border-color: var(--gt-positive);
  color: var(--gt-positive);
  background: transparent;
  /* 继承 :disabled 的 0.45 会把它又变灰，那就白改了。 */
  opacity: 1;
  cursor: default;
}

/* 工具栏分三档，断点来自实测的「装不下」宽度（内容宽 + 左右各 18px 内边距）：
 *
 *   ≥ 805  全平铺  视图 + 时间档 + 更新于 + 复制 + 刷新 + 生成 + 设置   (769)
 *   ≥ 677  收低频  视图 + 时间档 + 更新于 + 刷新 + 生成 + ⋮            (641)
 *   ≥ 595  换下拉  视图 + 下拉   + 更新于 + 刷新 + 生成 + ⋮            (559)
 *   < 595  再收时间戳                                                  (461)
 *
 * 断点之间留了 16px 余量：字体、缩放、不同平台的字宽都会让实测值偏一点，
 * 卡在正好贴边会在别人的机器上折行。 */
@container (max-width: 804px) {
  .gt-when-wide { display: none; }
  .gt-when-narrow { display: inline-flex; }
}
@container (max-width: 676px) {
  .gt-period-seg { display: none; }
  .gt-period-dd { display: inline-flex; }
}
@container (max-width: 594px) {
  .gt-stamp { display: none; }
}
@container (max-width: 720px) {
  .gt-section { grid-template-columns: minmax(0, 1fr); gap: 12px; padding: 20px 0; }
}
@container (max-width: 520px) {
  .gt-row { padding: 8px 6px; }
  /* 极窄档：461px 是这一行内容的最小宽度，再少几十像素就得收紧。
   * 收的是内边距和间距，不是隐藏按钮——刷新和生成解读在这里仍然是高频。 */
  .gt-toolbar { gap: 6px; }
  .gt-seg-item { padding: 5px 7px; }
  .gt-period-dd .gt-dd-trigger { padding: 0 6px; }
}
`;

/* ---------- 激活 ---------- */

export default function activate(ctx) {
  appCtx = ctx;
  const mySeq = ++activateSeq;
  // 重新激活时工作区表可能变了（用户在侧栏删过、或换了 AI 工作区），
  // 上次的「已登记」结论不能直接沿用。
  workspaceRegistrations = new Map();

  const cssDisposer = ctx.theme.injectCss(CSS);

  ctx.ui.registerCommand({
    key: "open",
    title: () => "热点：打开今日榜单",
    keywords: () => ["github", "trending", "热点", "榜单"],
    run: () => ctx.ui.openCenterTab("main"),
  });

  ctx.ui.registerCommand({
    key: "refresh",
    title: () => "热点：刷新榜单",
    keywords: () => ["github", "trending", "refresh", "刷新"],
    run: () => {
      ctx.ui.openCenterTab("main");
      void refresh(ctx, { force: true });
    },
  });

  const tabDisposer = ctx.ui.registerCenterTab({
    key: "main",
    title: () => "每日热点",
    icon: Icon,
    component: MainTab,
  });

  const sideDisposer = ctx.ui.registerSidebarNav({
    key: "main",
    label: () => "每日热点",
    icon: Icon,
    badge: () => {
      const snap = store.snap;
      if (!snap.loaded || snap.loading) return null;
      const fresh = snap.repos.filter((row) => row.isNew).length;
      return fresh > 0 ? String(fresh) : null;
    },
    onOpen: () => ctx.ui.openCenterTab("main"),
  });

  const settingsDisposer = ctx.ui.registerSettingsSection({
    key: "main",
    label: () => "每日热点",
    // 设置区标题栏的图标。不传的话宿主回落到插件的 artwork（docs/icon.png，
    // 带橙色底板），同一个插件在页签、侧栏是单色线条，到设置页变成彩色方块。
    // 这里和上面两处用同一个 `Icon`：`stroke="currentColor"`，跟随宿主文字色。
    icon: Icon,
    component: SettingsSection,
  });

  /**
   * 宿主对 `startRun` 轮次的回执。引擎稍后才 announce sessionId，那条路只有
   * 这个事件能拿到 id——不订阅的话「同一个仓库只开一条会话」永远不成立。
   */
  let runEventDisposer = null;
  if (ctx.events && typeof ctx.events.on === "function") {
    try {
      runEventDisposer = ctx.events.on("plugin-run://" + PLUGIN_ID, (event) => {
        if (mySeq !== activateSeq) return;
        handlePluginRunEvent(ctx, event);
      });
    } catch {
      /* 宿主不支持这个话题：退回「拿不到 id 就新开」，不影响主流程 */
    }
  }

  // 恢复设置与非敏感缓存；失败不影响激活。
  //
  // `settingsLoaded` 是一个**可等待**的信号：读盘完成（成功或失败）之前，
  // 任何 saveSettings 都必须等着，否则会拿 DEFAULT_SETTINGS 把磁盘上那份
  // 整个盖掉——会话表、提示词、token 都在里面。
  let markSettingsLoaded = () => {};
  settingsLoaded = new Promise((resolve) => {
    markSettingsLoaded = resolve;
  });
  void (async () => {
    try {
      const saved = await ctx.storage.get("settings");
      // 已卸载 / 已重新激活：这次读回来的值属于上一代，不能写进现在的 store。
      if (mySeq !== activateSeq) return;
      if (saved && typeof saved === "object") {
        const merged = Object.assign({}, DEFAULT_SETTINGS);
        for (const key of Object.keys(DEFAULT_SETTINGS)) {
          if (saved[key] !== undefined && saved[key] !== null) merged[key] = saved[key];
        }
        merged.minStars = normaliseMinStars(merged.minStars);
        merged.resumeMode = normaliseResumeMode(merged.resumeMode);
        // 提示词来自磁盘：可能是旧版本的空值、也可能是手改过的坏形状。
        // 归一化在这里做一次，后面所有读取点都不用再防。
        merged.prompts = normalisePrompts(merged.prompts);
        // 默认值只落在真正会生效的那份上（空正文会被 pickPrompt 跳过）。
        // 悬空或不存在时回落内置模板（id ""）——它不可删除，所以一定有东西可用。
        const usable = merged.prompts.filter((p) => p.text.trim() !== "");
        if (!usable.some((p) => p.id === merged.defaultPromptId)) merged.defaultPromptId = "";
        // 会话表从磁盘读回来：内存表在重装/重激活/宿主重启后是空的，只有这份
        // 落盘的映射能让「已经开过会话的仓库」继续走直接打开那条路。
        merged.discussSessionIds = normaliseDiscussSessions(merged.discussSessionIds);
        merged.digestSessionId =
          typeof merged.digestSessionId === "string" ? merged.digestSessionId.trim() : "";
        discussSessions = new Map(Object.entries(merged.discussSessionIds));
        set({ settings: merged });
      }
    } catch {
      /* 用默认设置 */
    } finally {
      // 无论成功失败都要放行：读失败时写盘会以默认值为底，这是既有行为，
      // 但绝不能让写盘永远挂住。
      markSettingsLoaded();
    }
    await pruneHistory(ctx);
  })();

  // 数据目录既是快照的落盘位置，也是解读默认的 cwd。早点读到，设置页才能
  // 把真实路径显示出来；读不到不影响刷新榜单，只影响解读能不能跑。
  void pluginDataDir(ctx);

  const dispose = () => {
    activateSeq += 1;
    genSeq += 1;
    digestSeq += 1;
    // 讨论也一起作废：卸载期间在飞的 startRun 回来后不能往 store 里写回执。
    discussSeq += 1;
    // 续接表跟着这次激活作废：重新安装/重新激活后 sessionId 未必还有效，
    // 拿旧 id 去续接会变成一个「刚开就报错」的按钮。
    resetDiscussSessions();
    // README 预览也作废：卸载后回来的 http 响应不能往 store 里写正文。
    readmeSeq += 1;
    // 会话内缓存跟着这次激活失效：重新安装/换工作区后，缓存里可能已经是旧内容。
    readmeCache.clear();
    cancelSession(activeDigest, ctx);
    try {
      if (runEventDisposer) runEventDisposer();
    } catch {
      /* 忽略 */
    }
    try {
      cssDisposer();
    } catch {
      /* 忽略 */
    }
    set({
      generating: false,
      loading: false,
      digest: "",
      digestStopped: false,
      repos: [],
      loaded: false,
      httpError: "",
      discussing: "",
      discussError: "",
      discussNotice: "",
      discussWorkspace: "",
      discussWarning: "",
      discussResumed: false,
      discussOpened: false,
      discussPromptName: "",
      readmeOpen: "",
      readmeLoading: false,
      readmeError: "",
      readmeText: "",
      readmeTruncated: false,
      readmeTotal: 0,
    });
  };

  return dispose;
}
