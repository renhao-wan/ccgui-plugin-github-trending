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
const AGENT_TIMEOUT_MS = 120000;
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

const DEFAULT_SETTINGS = {
  period: "daily",
  language: "",
  minStars: 50,
  engine: "",
  model: "",
  workspacePath: "",
  token: "",
};

const DEFAULT_STATE = {
  view: "trending",
  settings: { ...DEFAULT_SETTINGS },
  repos: [],
  dropped: [],
  isFirstRun: true,
  loadedAt: null,
  source: "",
  parseError: "",
  httpError: "",
  errorKind: "",
  loading: false,
  loaded: false,
  digest: "",
  digestTruncated: false,
  digestIncluded: 0,
  digestTotal: 0,
  generating: false,
  catalog: [],
  catalogLoaded: false,
  modelsLoading: false,
  modelsError: "",
  workspaces: [],
  workspacesLoaded: false,
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

function messageOf(error) {
  const raw = error && error.message ? String(error.message) : String(error || "");
  if (/network:|no declared network|missing permission|without declaring/i.test(raw)) {
    return "网络授权未生效，请重新安装插件";
  }
  if (/timed?\s*out|timeout/i.test(raw)) return "请求超时，请稍后重试";
  return raw || "请求失败";
}

async function httpGet(url, headers) {
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

async function fetchRising(settings) {
  const url =
    "https://api.github.com/search/repositories?q=" +
    encodeURIComponent(buildRisingQuery(settings.minStars, 7)) +
    "&sort=stars&order=desc&per_page=25";
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "ccgui-github-trending",
  };
  const token = String(settings.token || "").trim();
  if (token) headers.Authorization = "Bearer " + token;

  const res = await httpGet(url, headers);
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
      message: res.status >= 400 ? "GitHub 返回 HTTP " + res.status : "新星库结果为空，可调低 star 阈值",
    };
  }
  return { ok: true, repos: parsed.repos };
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
  const next = prev.then(
    () => writeSnapshotOnce(ctx, rel, period, language, repos),
    () => writeSnapshotOnce(ctx, rel, period, language, repos),
  );
  snapshotLocks.set(rel, next.catch(() => {}));
  try {
    await next;
  } finally {
    if (snapshotLocks.get(rel) === next || snapshotLocks.get(rel) === undefined) snapshotLocks.delete(rel);
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
  const period = view === "rising" ? RISING_PERIOD.key : settings.period;
  const language = view === "rising" ? "" : settings.language;

  // 同一视图已经有数据且不是强制刷新：不重复打网络。
  if (!force && snap.loaded && snap.source === view + ":" + period + ":" + language) return;

  const seq = ++genSeq;

  set({ loading: true, httpError: "", parseError: "", errorKind: "" });

  let result;
  try {
    result = view === "rising" ? await fetchRising(settings) : await fetchTrending(ctx, period, language);
  } catch (error) {
    result = { ok: false, kind: "network", message: messageOf(error) };
  }

  // 代际校验：用户可能已经切了视图、或发起了新一轮。
  // 宿主桥没有 AbortSignal，晚到的响应只能靠这里丢弃。
  if (seq !== genSeq) return;

  if (!result.ok) {
    const key = view + ":" + period + ":" + language;
    // 失败时优先保住用户正在看的内容：同一视图的旧数据 > 本地快照 > 空。
    const sameView = snap.source === key && snap.repos.length > 0;
    const cached = view === "rising" ? null : await readSnapshot(ctx, period, language);
    if (seq !== genSeq) return;
    const fallback = sameView ? snap.repos : cached ? diffSnapshot(cached, null).repos : [];
    set({
      loading: false,
      loaded: true,
      errorKind: result.kind,
      httpError: result.message,
      source: key,
      repos: fallback,
      dropped: sameView ? snap.dropped : [],
      isFirstRun: sameView ? snap.isFirstRun : Boolean(cached),
      loadedAt: sameView ? snap.loadedAt : cached ? Date.now() : null,
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
    parseError: "",
    repos: diff.repos,
    dropped: diff.dropped,
    isFirstRun: diff.isFirstRun,
    source: view + ":" + period + ":" + language,
    loadedAt: Date.now(),
  });

  // 快照只对 Trending 有意义（新星库是滚动窗口，排名不可比）。
  if (view !== "rising") await writeSnapshot(ctx, period, language, result.repos);
}

/* ---------- AI 解读 ---------- */

async function resolveWorkspace(ctx, settings) {
  const configured = String(settings.workspacePath || "").trim();
  if (configured) return configured;
  try {
    const rows = await ctx.workspaces.list();
    const first = (Array.isArray(rows) ? rows : []).find(
      (row) => row && typeof row.path === "string" && row.path.trim(),
    );
    if (first) return first.path;
  } catch {
    /* 没有工作区授权或列表为空都走下面的失败路径 */
  }
  return "";
}

/** 侧栏工作区列表：设置页直接选，避免让用户手打路径（手打的路径没有授权）。 */
async function loadWorkspaces(ctx) {
  if (store.snap.workspacesLoaded) return;
  try {
    const rows = await ctx.workspaces.list();
    const list = (Array.isArray(rows) ? rows : [])
      .filter((row) => row && typeof row.path === "string" && row.path.trim())
      .sort((a, b) => (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0));
    set({ workspaces: list, workspacesLoaded: true });
  } catch {
    // 宿主不支持或读取失败：设置页退化为「自动」，不阻塞其他设置。
    set({ workspaces: [], workspacesLoaded: true });
  }
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
    const workspace = String(store.snap.settings.workspacePath || "").trim();
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
 */
function interruptSession(session, interruptRun) {
  if (!session || !session.cancelled || !session.runId || session.interrupted) return;
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

/** 停止当前解读：无论它处于「准备中」「start 在飞」还是「流式中」。 */
function abortDigest(ctx) {
  digestSeq += 1;
  const session = activeDigest;
  if (session) session.cancelled = true;
  disposeSession(session, (runId) => ctx.agent.interrupt(runId));
  set({ generating: false });
}

/** 兼容旧调用名。 */
function stopDigest(ctx) {
  abortDigest(ctx);
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
  const period = view === "rising" ? RISING_PERIOD.key : settings.period;
  const seq = ++digestSeq;

  // 立刻置 generating：下面有两个 await，等到那时再置，双击就能开出两轮。
  set({
    generating: true,
    digest: "",
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
    language: view === "rising" ? "" : settings.language,
    repos: snap.repos,
    dropped: snap.dropped,
    isFirstRun: snap.isFirstRun,
  });
  set({ digestTruncated: built.truncated, digestIncluded: built.included, digestTotal: built.total });

  const workspace = await resolveWorkspace(ctx, settings);
  if (seq !== digestSeq || session.cancelled) return bailed("");
  if (!workspace) return bailed("还没有可用工作区：请先在设置里填写 agent 的工作区路径");

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
    disposeSession(session, null);
    if (seq !== digestSeq) return;
    if (error) {
      set({ generating: false, httpError: messageOf(error) });
      return;
    }
    set({ generating: false, digest: value });
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
    const started = await ctx.agent.start({
      engine,
      model,
      workspacePath: workspace,
      prompt: built.prompt,
      // 解读只读榜单，不需要写权限；catalog 说不行就不给。
      readOnly: entry.readOnly !== false,
    });
    const runId = started && started.runId ? started.runId : null;
    session.runId = runId;

    // 用户在 start 期间点了停止 / 切了视图 / 卸载了插件：这一轮已经作废，
    // 但宿主的进程刚起来，必须当场打断。
    if (session.cancelled || seq !== digestSeq) {
      session.cancelled = true;
      interruptSession(session, (id) => ctx.agent.interrupt(id));
      releaseSession(session);
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

function Chip(props) {
  const h = appCtx.react.createElement;
  return h(
    "button",
    {
      type: "button",
      className: "gt-chip" + (props.active ? " gt-chip--on" : ""),
      onClick: props.onClick,
      disabled: props.disabled,
      "aria-pressed": props.active ? "true" : "false",
    },
    props.children,
  );
}

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

function RepoRow({ row }) {
  const h = appCtx.react.createElement;
  const href = safeHref(row.url);
  const movement = movementLabel(row);

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
              h("span", { className: "gt-repo-owner" }, row.owner + " /"),
              h("span", { className: "gt-sep" }, " "),
              row.name,
            )
          : h("span", { className: "gt-repo" }, row.repo),
        movement
          ? h("span", { className: "gt-move" + movementClass(row) }, movement)
          : null,
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
        Number.isFinite(row.ageDays) ? h("span", { className: "gt-stat" }, row.ageDays + " 天前创建") : null,
      ),
    ),
  );
}

function Toolbar({ snap, ctx }) {
  const h = appCtx.react.createElement;
  // 切视图/时间档会让榜单换掉，正在生成的解读说的是旧榜单，必须一并停掉，
  // 否则旧轮次的 delta 会继续写进新视图，而且宿主那侧还在烧 token。
  const onView = (view) => {
    if (view === snap.view) return;
    if (snap.generating) stopDigest(ctx);
    set({ view, digest: "", dropped: [], isFirstRun: true, repos: [], loaded: false });
    void refresh(ctx, { force: true });
  };
  const onPeriod = (period) => {
    if (period === snap.settings.period) return;
    if (snap.generating) stopDigest(ctx);
    setSettings({ period });
    void persistSettings(ctx, { period });
    set({ loaded: false, repos: [], digest: "", dropped: [] });
    void refresh(ctx, { force: true });
  };

  return h(
    "div",
    { className: "gt-toolbar" },
    h(
      "div",
      { className: "gt-group", role: "group", "aria-label": "数据视图" },
      h(Chip, { active: snap.view === "trending", onClick: () => onView("trending") }, "Trending"),
      h(Chip, { active: snap.view === "rising", onClick: () => onView("rising") }, "新星库（7 天）"),
    ),
    snap.view === "trending"
      ? h(
          "div",
          { className: "gt-group", role: "group", "aria-label": "时间档" },
          PERIODS.map((p) =>
            h(Chip, { key: p.key, active: snap.settings.period === p.key, onClick: () => onPeriod(p.key) }, p.label),
          ),
        )
      : null,
    h(
      "div",
      { className: "gt-group gt-group--end" },
      snap.loadedAt ? h("span", { className: "gt-stamp" }, "更新于 " + fmtTime(snap.loadedAt)) : null,
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
          onClick: () => (snap.generating ? stopDigest(ctx) : void generateDigest(ctx)),
          disabled: snap.loading || snap.repos.length === 0,
        },
        snap.generating ? "停止生成" : "生成解读",
      ),
      h("button", { type: "button", className: "gt-btn", onClick: () => ctx.ui.openSettings() }, "设置"),
    ),
  );
}

function StatusLine({ snap }) {
  const h = appCtx.react.createElement;
  if (snap.loading) {
    // 刷新时列表还在：只转圈 + 一句话，不抢走用户正在看的内容。
    // 首次加载没有列表：文案改成「首次抓取」的口吻。
    const first = snap.repos.length === 0;
    return h(
      "p",
      { className: "gt-notice gt-running", role: "status", "aria-live": "polite" },
      h("span", { className: "gt-spinner", "aria-hidden": "true" }),
      h("span", { className: "gt-running-text" }, first ? "正在抓取 GitHub…" : "正在刷新榜单…"),
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
  if (!snap.loaded) return h("p", { className: "gt-notice" }, "点「刷新」拉取榜单。");
  return h(
    "p",
    { className: "gt-notice" },
    snap.view === "rising" ? "近 7 天新建的高增长仓库" : "GitHub Trending · " + snap.settings.period,
    snap.view === "trending" && snap.settings.language ? " · " + snap.settings.language : "",
    snap.isFirstRun ? " · 首次抓取，下次刷新可看到排名变化" : "",
    // 没有变化时整榜都没有涨跌标签，不说明会让人以为标签没渲染出来
    !snap.isFirstRun && snap.repos.length > 0 && !hasRankChange(snap.repos) ? " · 与上次相比排名无变化" : "",
  );
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

function DigestPanel({ snap }) {
  const h = appCtx.react.createElement;
  if (!snap.generating && !snap.digest) return null;
  const note = snap.digestTruncated
    ? "事实过长，已截断（" + snap.digestIncluded + "/" + snap.digestTotal + "）"
    : "";
  return h(
    "section",
    { className: "gt-digest", "aria-live": "polite" },
    h("header", { className: "gt-digest-head" }, h("h3", null, "解读"), note ? h("span", { className: "gt-stamp" }, note) : null),
    h("pre", { className: "gt-digest-body" }, snap.digest || "…"),
    snap.digest && !snap.generating ? h("p", { className: "gt-notice" }, "解读只在本机显示，未写入任何文件。") : null,
  );
}

function MainTab() {
  const h = appCtx.react.createElement;
  const ctx = appCtx;
  const snap = useSnap();

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
        h("p", { className: "gt-sub" }, "GitHub Trending 与新星库，数据只在本机处理"),
      ),
    ),
    h(Toolbar, { snap, ctx }),
    h(StatusLine, { snap }),
    h(
      "div",
      { className: "gt-scroll" },
      snap.repos.length > 0
        ? h("ol", { className: "gt-list" }, snap.repos.map((row) => h(RepoRow, { key: row.repo, row })))
        : snap.loading
          ? h(SkeletonList, null)
          : snap.loaded
            ? h("p", { className: "gt-empty" }, snap.errorKind ? "没有可显示的数据" : "榜单为空")
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
 * 自绘下拉：原生 <select> 的展开层由系统绘制，不跟宿主的深浅色主题。
 * 键盘、方向键、Esc、点击外部关闭都对齐宿主习惯。
 */
function Dropdown(props) {
  const R = appCtx.react;
  const h = R.createElement;
  const openState = R.useState(false);
  const open = openState[0];
  const setOpen = openState[1];
  const focusState = R.useState(-1);
  const focusIdx = focusState[0];
  const setFocusIdx = focusState[1];
  // 触发器下方空间不够时向上弹，避免菜单被视口底部裁掉
  const upState = R.useState(false);
  const up = upState[0];
  const setUp = upState[1];
  const triggerRef = R.useRef(null);
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
    const est = Math.min(260, items.length * 32 + 8);
    const el = triggerRef.current;
    if (el && typeof el.getBoundingClientRect === "function" && typeof window !== "undefined") {
      const rect = el.getBoundingClientRect();
      const below = (window.innerHeight || 800) - rect.bottom;
      setUp(below < est + 12 && rect.top > below);
    }
    setOpen(true);
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

  const onTriggerKeyDown = (ev) => {
    if (props.disabled) return;
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      if (!open) openMenu();
      else move(ev.key === "ArrowDown" ? 1 : -1);
    } else if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      if (open) choose(items[focusIdx]);
      else openMenu();
    } else if (ev.key === "Escape" && open) {
      ev.preventDefault();
      setOpen(false);
    }
  };

  return h(
    "div",
    { className: "gt-dd" + (open ? " is-open" : "") + (up ? " is-up" : "") },
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
        onKeyDown: onTriggerKeyDown,
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

  const patch = (key, value) => {
    setForm((prev) => Object.assign({}, prev || snap.settings, { [key]: value }));
  };

  R.useEffect(() => {
    if (!snap.catalogLoaded) void loadCatalog(ctx);
    void loadWorkspaces(ctx);
  }, []);

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
        const ok = await persistSettings(ctx, form);
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

  // 工作区直接选侧栏里已有的：手打的路径没有对应授权，后续会失败。
  const workspaceItems = [{ value: "", label: "自动（最近打开的工作区）" }];
  for (const row of snap.workspaces) {
    workspaceItems.push({ value: row.path, label: row.name || row.path });
  }
  if (form.workspacePath && !snap.workspaces.some((r) => r.path === form.workspacePath)) {
    workspaceItems.push({ value: form.workspacePath, label: form.workspacePath });
  }

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
        "不填也能正常使用：未认证时搜索接口 10 次/分钟，一般够每天刷新一两次。Token 只存在本机，只发给 api.github.com。",
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
    h("p", { className: "gt-settings-intro" }, "榜单与解读只在这台机器上处理，插件不上传任何内容。"),

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
          "解读用的工作区",
          h(Dropdown, {
            items: workspaceItems,
            value: form.workspacePath,
            onChange: (v) => patch("workspacePath", v),
            emptyText: "侧栏还没有工作区",
          }),
          "模型进程在这个工作区目录下运行。解读内容来自当前榜单，不读这里的文件。",
        ),
      ),
    ),

    h(
      "section",
      { className: "gt-section" },
      h(
        "div",
        { className: "gt-section-label" },
        h("h2", null, "网络"),
        h("p", null, "只访问 github.com 与 api.github.com。"),
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
.gt-chip, .gt-btn {
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
.gt-chip:hover, .gt-btn:hover { background: var(--gt-raised); }
.gt-chip--on {
  background: var(--gt-raised);
  border-color: var(--gt-accent);
  font-weight: 600;
}
.gt-btn--primary { border-color: var(--gt-accent); font-weight: 600; }
.gt-chip:disabled, .gt-btn:disabled { opacity: 0.45; cursor: not-allowed; }
/* 抓取中按钮不能用 opacity:.45 冒充禁用：那样转圈也被一起淡掉了。
 * 底色压暗、光标改成等待，转圈保持不透明。放在 disabled 之后才盖得住。 */
.gt-btn--busy:disabled { opacity: 1; cursor: progress; background: var(--gt-raised); }
.gt-btn--busy .gt-spinner { border-color: var(--gt-border); border-top-color: var(--gt-accent); }
.gt-chip:focus-visible, .gt-btn:focus-visible, .gt-input:focus-visible, .gt-repo:focus-visible {
  outline: 2px solid var(--gt-accent);
  outline-offset: 2px;
}
.gt-stamp { font-size: 11px; opacity: 0.55; white-space: nowrap; }
.gt-notice { margin: 0; font-size: 12px; opacity: 0.7; }
.gt-notice--error { color: var(--gt-negative); opacity: 1; display: flex; gap: 6px; flex-wrap: wrap; }
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
  .gt-row, .gt-chip, .gt-btn { transition: none; }
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
.gt-digest { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--gt-border); }
.gt-digest-head { display: flex; align-items: baseline; gap: 10px; }
.gt-digest h3 { margin: 0 0 6px; font-size: 13px; font-weight: 600; }
.gt-digest-body {
  margin: 0; white-space: pre-wrap; word-break: break-word;
  font: inherit; font-size: 13px; line-height: 1.7;
}
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

@container (max-width: 720px) {
  .gt-section { grid-template-columns: minmax(0, 1fr); gap: 12px; padding: 20px 0; }
}
@container (max-width: 520px) {
  .gt-group--end { margin-left: 0; width: 100%; }
  .gt-row { padding: 8px 6px; }
}
`;

/* ---------- 激活 ---------- */

export default function activate(ctx) {
  appCtx = ctx;
  const mySeq = ++activateSeq;

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
    icon: (props) =>
      ctx.react.createElement(
        "svg",
        Object.assign({}, THIN_ICON, props && props.className ? { className: props.className } : {}),
        ctx.react.createElement("path", { d: "M8 1.8v5.4l3.6 2.1" }),
        ctx.react.createElement("circle", { cx: 8, cy: 8, r: 6.2 }),
      ),
    component: MainTab,
  });

  const sideDisposer = ctx.ui.registerSidebarNav({
    key: "main",
    label: () => "每日热点",
    icon: (props) =>
      ctx.react.createElement(
        "svg",
        Object.assign({}, THIN_ICON, props && props.className ? { className: props.className } : {}),
        ctx.react.createElement("path", { d: "M8 1.8v5.4l3.6 2.1" }),
        ctx.react.createElement("circle", { cx: 8, cy: 8, r: 6.2 }),
      ),
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
    component: SettingsSection,
  });

  // 恢复设置与非敏感缓存；失败不影响激活。
  void (async () => {
    try {
      const saved = await ctx.storage.get("settings");
      if (mySeq !== activateSeq) return;
      if (saved && typeof saved === "object") {
        const merged = Object.assign({}, DEFAULT_SETTINGS);
        for (const key of Object.keys(DEFAULT_SETTINGS)) {
          if (saved[key] !== undefined && saved[key] !== null) merged[key] = saved[key];
        }
        merged.minStars = normaliseMinStars(merged.minStars);
        set({ settings: merged });
      }
    } catch {
      /* 用默认设置 */
    }
    await pruneHistory(ctx);
  })();

  const dispose = () => {
    activateSeq += 1;
    genSeq += 1;
    digestSeq += 1;
    const session = activeDigest;
    if (session) session.cancelled = true;
    disposeSession(session, (runId) => ctx.agent.interrupt(runId));
    try {
      cssDisposer();
    } catch {
      /* 忽略 */
    }
    set({
      generating: false,
      loading: false,
      digest: "",
      repos: [],
      loaded: false,
      httpError: "",
    });
  };

  return dispose;
}
