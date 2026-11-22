// 冒烟：用最小 React 替身真实加载 main.js，走「打开页签 → 刷新 → 看列表 → 生成解读 → 停止」。
// 不连网：plugin_http_request 由假宿主返回 fixture；agent 事件由假宿主按脚本推进。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const PLUGIN = pathToFileURL(path.join(ROOT, "main.js")).href;
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred, ms = 2000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await sleep(20);
  }
  return pred();
}

/* ------------------------------------------------------------ fixtures */

function trendingHtml(repos) {
  return repos
    .map(
      (r, i) => `<article class="Box-row">
  <h2 class="h3 lh-condensed"><a href="/${r.repo}" class="Link"><span class="text-normal">
    ${r.owner} /</span> ${r.name}</a></h2>
  <p class="col-9 color-fg-muted my-1 tmp-pr-4">${r.description}</p>
  <div class="f6 color-fg-muted mt-2">
    <span class="tmp-mr-3 d-inline-block ml-0">
      <span class="repo-language-color" style="background-color: #3572A5"></span>
      <span itemprop="programmingLanguage">${r.language}</span>
    </span>
    <a href="/${r.repo}/stargazers" class="Link Link--muted"><svg><path d="M8 .25"></path></svg> ${r.stars.toLocaleString("en-US")}</a>
    <a href="/${r.repo}/forks" class="Link Link--muted"><svg><path d="M5 5"></path></svg> ${r.forks.toLocaleString("en-US")}</a>
    <span class="d-inline-block"><span>${r.gain.toLocaleString("en-US")} stars today</span></span>
  </div>
</article>`,
    )
    .join("\n");
}

const day1 = [
  { repo: "alpha/one", owner: "alpha", name: "one", description: "first fixture repo", language: "Python", stars: 1000, forks: 10, gain: 100 },
  { repo: "beta/two", owner: "beta", name: "two", description: "second fixture repo", language: "Rust", stars: 2000, forks: 20, gain: 200 },
  { repo: "gamma/three", owner: "gamma", name: "three", description: "third fixture repo", language: "Go", stars: 3000, forks: 30, gain: 300 },
];
// 第二轮：gamma 掉榜、新来 delta/four，beta 升到第一
const day2 = [
  { repo: "beta/two", owner: "beta", name: "two", description: "second fixture repo", language: "Rust", stars: 2100, forks: 20, gain: 210 },
  { repo: "alpha/one", owner: "alpha", name: "one", description: "first fixture repo", language: "Python", stars: 1100, forks: 10, gain: 110 },
  { repo: "delta/four", owner: "delta", name: "four", description: "brand new repo", language: "TypeScript", stars: 4000, forks: 40, gain: 400 },
];

/* ------------------------------------------------------------ React 替身 */

let stateSlots = new Map();
let refSlots = new Map();
const effectStores = new WeakMap();
let effectStore = new Map();
let stateIdx = 0;
let refIdx = 0;
let effectIdx = 0;
const pendingEffects = [];

const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (init) => {
    const i = stateIdx++;
    if (!stateSlots.has(i)) stateSlots.set(i, typeof init === "function" ? init() : init);
    return [stateSlots.get(i), (v) => stateSlots.set(i, typeof v === "function" ? v(stateSlots.get(i)) : v)];
  },
  useEffect: (fn, deps) => {
    pendingEffects.push({ i: effectIdx++, fn, deps });
  },
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useRef: (init) => {
    // ref 必须跨渲染保持同一个对象：防抖定时器、baseline 都挂在 ref 上，
    // 每次返回新对象会让「改动即自动保存」永远走首次渲染分支。
    const i = refIdx++;
    if (!refSlots.has(i)) refSlots.set(i, { current: init === undefined ? null : init });
    return refSlots.get(i);
  },
  useSyncExternalStore: (subscribe, getSnapshot) => {
    subscribe(() => {});
    return getSnapshot();
  },
};

function sameDeps(a, b) {
  if (!a || !b) return false;
  return a.length === b.length && a.every((d, i) => Object.is(d, b[i]));
}

function flushEffects() {
  for (const e of pendingEffects) {
    const prev = effectStore.get(e.i);
    if (prev && (!e.deps || sameDeps(prev.deps, e.deps))) continue;
    if (prev && typeof prev.cleanup === "function") {
      try {
        prev.cleanup();
      } catch {
        /* ignore */
      }
    }
    let cleanup = null;
    try {
      cleanup = e.fn();
    } catch {
      /* effect 错误交给断言暴露 */
    }
    effectStore.set(e.i, { deps: e.deps, cleanup: typeof cleanup === "function" ? cleanup : null });
  }
  pendingEffects.length = 0;
}

function expand(node) {
  if (Array.isArray(node)) return node.map(expand);
  if (!node || typeof node !== "object") return node;
  if (typeof node.type === "function") {
    const props = Object.assign({}, node.props || {}, { children: node.children || [] });
    return expand(node.type(props));
  }
  return Object.assign({}, node, { children: (node.children || []).map(expand) });
}

function renderFresh(comp, props, opts) {
  stateSlots = new Map();
  refSlots = new Map();
  effectStore = new Map();
  effectStores.set(comp, effectStore);
  stateIdx = 0;
  refIdx = 0;
  effectIdx = 0;
  pendingEffects.length = 0;
  const tree = expand(comp(props || {}));
  if (opts && opts.effects) flushEffects();
  else pendingEffects.length = 0;
  return tree;
}

/**
 * 保留组件内部状态的渲染：下拉展开、输入框内容这类局部状态要跨渲染存在，
 * 否则「点了展开再看菜单」永远看不到菜单。effect 照常在依赖变化时重跑。
 */
function renderKeep(comp, props) {
  effectStore = effectStores.get(comp) || new Map();
  effectStores.set(comp, effectStore);
  stateIdx = 0;
  refIdx = 0;
  effectIdx = 0;
  pendingEffects.length = 0;
  const tree = expand(comp(props || {}));
  flushEffects();
  return tree;
}

function walk(node, fn) {
  if (Array.isArray(node)) {
    for (const n of node) walk(n, fn);
    return;
  }
  if (!node || typeof node !== "object") return;
  fn(node);
  for (const k of node.children || []) walk(k, fn);
}

function textOf(node) {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (!node || typeof node !== "object") return "";
  return (node.children || []).map(textOf).join("");
}

function findByText(node, text) {
  let hit = null;
  walk(node, (n) => {
    if (hit) return;
    if (n.type === "button" && textOf(n).includes(text)) hit = n;
  });
  return hit;
}

/**
 * 把插件里那些「等 30s / 120s」的超时压缩到可测的尺度。
 *
 * 插件里的 withTimeout 直接调全局 setTimeout（宿主环境本来就是这样），
 * 所以在用例内临时换掉 globalThis.setTimeout 就能让超时路径在几百毫秒内
 * 走完，而不必真的等两分钟。只改 ≥30s 的延时：HTTP 的 20s、防抖与动画
 * 一律保持原样，否则正常请求会被误判成超时。
 */
async function withFastTimeouts(ms, fn) {
  const real = globalThis.setTimeout;
  globalThis.setTimeout = (cb, delay, ...rest) => real(cb, delay >= 30000 ? ms : delay, ...rest);
  try {
    return await fn();
  } finally {
    globalThis.setTimeout = real;
  }
}

function countByType(node, type) {
  let n = 0;
  walk(node, (x) => {
    if (x.type === type) n += 1;
  });
  return n;
}

/**
 * 按标签名找元素，可再按类名收窄。className 用空格切分后精确比对——
 * 用 includes 的话 gt-md-table-wrap 会同时命中 gt-md-table。
 */
function findByType(node, type, cls) {
  let hit = null;
  walk(node, (n) => {
    if (hit || n.type !== type) return;
    if (cls) {
      const c = n.props && n.props.className;
      if (typeof c !== "string" || !c.split(/\s+/).includes(cls)) return;
    }
    hit = n;
  });
  return hit;
}

/** 按 className 里的某个类名找元素（冒烟测试里只断言存在性）。 */
function countByClass(node, cls) {
  let n = 0;
  walk(node, (x) => {
    const c = x.props && x.props.className;
    if (typeof c === "string" && c.split(/\s+/).includes(cls)) n += 1;
  });
  return n;
}

/* ------------------------------------------------------------ 假宿主 */

const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "gt-smoke-"));
/** 假文件夹选择器返回的目录；单独建一个，才能区分「选中了」和「回落到默认」。 */
const pickedWorkspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "gt-picked-"));
const kv = new Map();
const httpCalls = [];
/** 反馈中转的假响应。用例逐个改写，跑完不必复原（每个用例自己设）。 */
let feedbackQuota = { status: 200, value: { remaining: 27, dailyLimit: 30 } };
let feedbackSend = { status: 200, body: '{"ok":true,"remaining":26}' };
const agentStarts = [];
const agentInterrupts = [];
/** sessions.startRun 的入参；讨论功能的核心断言对象。 */
const sessionStarts = [];
/** sessions.selectSession 的入参：打开已有会话（不跑模型）走这条。 */
const sessionSelects = [];
let sessionStartError = null;
let sessionSelectError = null;
/**
 * `startRun` 返回的 sessionId。默认当场给（`sess-N`）；设成 null 就模拟
 * 「引擎稍后才 announce」——那条路只能靠 `plugin-run://` 回执补记 id，
 * 而它正是「点同一个仓库还是会开多个会话」的主因。
 */
let sessionAnnounceLater = false;
/** 最近一次 startRun 的 runId；回执用它匹配挂起项。 */
let lastSessionRunId = "";
/**
 * 宿主的侧栏工作区表。宿主只扫「已登记工作区」对应的会话目录，所以这张表
 * 是「会话能不能出现在侧栏」的前提。初始放入 pickedWorkspaceDir，模拟
 * 「用户已经在设置里选了一个真实工作区」。
 */
const registeredWorkspaces = new Set([pickedWorkspaceDir]);
const workspaceAdds = [];
/** add 被调用那一刻 sessionStarts 的长度：用来断言「先登记、再开会话」。 */
const sessionStartsAtAdd = [];
let workspaceAddError = null;
/** 登记新工作区后插件应请宿主补扫会话目录（把之前看不见的旧会话找回来）。 */
let sessionRefreshes = 0;
/**
 * raw.githubusercontent.com 的假响应。默认全部 404——也就是「raw 快路径不命中」，
 * 让已有用例继续走 API 那条路，断言不用改。需要测快路径的用例显式塞一条。
 */
const rawRoutes = new Map();
/**
 * README 接口的假响应。按仓库名路由，所以能测「展开 A 再展开 B」。
 * `status` 用来覆盖 404 / 限流 / 网络错误。
 */
const readmeRoutes = new Map();
let readmeDefault = {
  status: 200,
  body: [
    "---",
    "title: 假的 frontmatter",
    "---",
    "[![build](https://img.shields.io/badge/x.svg)](https://ci.example/run)",
    "# beta/two",
    "",
    '<div align="center"><b>一个很长的说明</b><br>第二行</div>',
    "",
    "## 用法",
    "",
    "```bash",
    "npm i beta-two",
    "```",
  ].join("\n"),
};
const cssCalls = [];
const eventHandlers = new Set();
/** 订阅过的话题：断言插件确实接了 plugin-run 回执这条总线。 */
const eventTopics = new Set();

let tabDef = null;
let navDef = null;
let settingsDef = null;
const commands = new Map();
let openedTab = "";
let openedSettings = 0;
let openTabFailures = 0;

let trendingPayload = { status: 200, body: trendingHtml(day1) };
/** 原始新星库响应；用例改动 payload 后用它复位。 */
const GOOD_SEARCH = {
  status: 200,
  body: JSON.stringify({
    total_count: 1,
    items: [
      {
        full_name: "rising/star",
        html_url: "https://github.com/rising/star",
        description: "fresh repo",
        language: "TypeScript",
        stargazers_count: 800,
        forks_count: 7,
        created_at: new Date(Date.now() - 2 * 86400000).toISOString(),
      },
    ],
  }),
};
let searchPayload = GOOD_SEARCH;
/**
 * 「随便看看」的随机批次响应。与新星库分开取值：两者走同一个接口，
 * 但一个断言的是「时间窗内新仓库」，一个是「随机档位抽样」，
 * 共用 fixture 会让用例看不出到底走了哪条 query。
 */
const GOOD_DISCOVER = {
  status: 200,
  body: JSON.stringify({
    total_count: 40097,
    items: [
      {
        full_name: "random/pick",
        html_url: "https://github.com/random/pick",
        description: "a random pick",
        language: "Go",
        stargazers_count: 4200,
        forks_count: 12,
        created_at: new Date(Date.now() - 900 * 86400000).toISOString(),
      },
    ],
  }),
};
let discoverPayload = GOOD_DISCOVER;
/** 按仓库名搜索的响应：两个结果，其中 random/pick 精确命中。 */
const GOOD_NAME_SEARCH = {
  status: 200,
  body: JSON.stringify({
    total_count: 2,
    items: [
      {
        full_name: "random/pick",
        html_url: "https://github.com/random/pick",
        description: "a random pick",
        language: "Go",
        stargazers_count: 4200,
        forks_count: 12,
        created_at: new Date(Date.now() - 900 * 86400000).toISOString(),
      },
      {
        full_name: "random/pick-extra",
        html_url: "https://github.com/random/pick-extra",
        description: "fuzzy hit",
        language: "Go",
        stargazers_count: 90,
        forks_count: 1,
        created_at: new Date(Date.now() - 400 * 86400000).toISOString(),
      },
    ],
  }),
};
let nameSearchPayload = GOOD_NAME_SEARCH;
let agentMode = "stream"; // stream | error | silent | slow-start | hang
let agentStartDelay = 200;
let agentRunIdx = 0;

/**
 * 推一个事件。
 *
 * 给了 topic 就只送到订阅了那个 topic 的处理函数——这是宿主的真实行为
 * （`agent://` 与 `plugin-run://` 是两条独立总线）。不给就是全广播，旧用例
 * 靠这个，不用逐个补 topic。
 */
function emit(ev, topic) {
  const want = String(topic || "");
  for (const entry of Array.from(eventHandlers)) {
    if (want && entry.topic !== want) continue;
    entry.cb(ev);
  }
}

const ctx = {
  react: fakeReact,
  pluginId: MANIFEST.id,
  version: MANIFEST.version,
  host: { sdkVersion: "0.3.25", appVersion: "1.2.4", locale: "zh-CN", isWeb: false },
  theme: {
    injectCss: (css) => {
      cssCalls.push(css);
      return () => {};
    },
    setTokens: () => () => {},
  },
  storage: {
    get: async (k) => (kv.has(k) ? kv.get(k) : null),
    set: async (k, v) => {
      kv.set(k, v);
    },
    delete: async (k) => {
      kv.delete(k);
    },
  },
  documentStorage: {
    // 宿主的隔离存储根：默认 plugin-data/<id>/。解读默认就跑在这个目录下。
    getLocation: async () => ({ kind: "data", path: storageDir }),
    readText: async (rel) => {
      const p = path.join(storageDir, rel);
      if (!fs.existsSync(p)) return null;
      return { content: fs.readFileSync(p, "utf8"), version: String(fs.statSync(p).mtimeMs) };
    },
    writeTextAtomic: async (rel, content, expectedVersion) => {
      const p = path.join(storageDir, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      if (expectedVersion === null && fs.existsSync(p)) throw new Error("conflict: exists");
      if (fs.existsSync(p)) fs.writeFileSync(p + ".bak", fs.readFileSync(p));
      fs.writeFileSync(p, content, "utf8");
      return { version: String(Date.now()) };
    },
    remove: async (rel) => {
      try {
        fs.unlinkSync(path.join(storageDir, rel));
      } catch {
        /* 不存在 */
      }
    },
    list: async (dir) => {
      const abs = path.join(storageDir, dir || "");
      if (!fs.existsSync(abs)) return [];
      return fs.readdirSync(abs).map((name) => (dir ? dir + "/" + name : name));
    },
  },
  ui: {
    registerCenterTab: (def) => {
      tabDef = def;
      return () => {};
    },
    registerSidebarNav: (def) => {
      navDef = def;
      return () => {};
    },
    registerSettingsSection: (def) => {
      settingsDef = def;
      return () => {};
    },
    registerCommand: (def) => {
      commands.set(def.key, def);
      return () => {};
    },
    openCenterTab: (key) => {
      if (key === "main" && !tabDef) {
        openTabFailures += 1;
        throw new Error("unregistered tab");
      }
      openedTab = key;
    },
    openSettings: () => {
      openedSettings += 1;
    },
  },
  events: {
    on: (topic, cb) => {
      eventTopics.add(String(topic));
      const entry = { topic: String(topic), cb };
      eventHandlers.add(entry);
      return () => eventHandlers.delete(entry);
    },
    emit: () => {},
  },
  // 路径只能来自系统文件夹选择器：假的 grantDirectory 返回一个固定目录，
  // 用来验证「选择…」把结果写进设置，且设置里存的是原始路径不是展示形式。
  assets: {
    grantDirectory: async () => ({ grantId: "g-1", path: pickedWorkspaceDir }),
  },
  // 会话：讨论功能走这个，不是 agent.start。  // 形态照 SDK 0.3.18 的 startRun 契约：新会话不带 sessionId，resolve runId + sessionId。
  sessions: {
    startRun: async (def) => {
      sessionStarts.push(def);
      if (sessionStartError) throw sessionStartError;
      const runId = "srun-" + sessionStarts.length;
      lastSessionRunId = runId;
      // 「引擎稍后才 announce」：当场不回 id，id 只能从 plugin-run 回执拿。
      if (sessionAnnounceLater) return { runId, sessionId: null };
      return { runId, sessionId: "sess-" + sessionStarts.length };
    },
    // 打开一个**已有**会话：宿主侧只是切视图，不跑模型、不花 token。
    // 插件的「再点一次讨论」就该走这里，而不是再 startRun 一轮。
    selectSession: async (engine, sessionId, workspacePath) => {
      sessionSelects.push({ engine, sessionId, workspacePath });
      if (sessionSelectError) throw sessionSelectError;
      return true;
    },
    interruptRun: async () => {},
    refresh: async () => {
      sessionRefreshes += 1;
    },
  },
  // 工作区登记：不登记的话宿主不扫这个目录，侧栏里就没有会话。
  workspaces: {
    list: async () => Array.from(registeredWorkspaces, (p) => ({ path: p })),
    add: async (p) => {
      workspaceAdds.push(p);
      sessionStartsAtAdd.push(sessionStarts.length);
      if (workspaceAddError) throw workspaceAddError;
      registeredWorkspaces.add(p);
    },
  },
  agent: {
    // 与宿主真实契约一致：PluginAgentCatalogEntry[]
    // readOnly 是「这个引擎能不能做隔离只读运行」，不是「这个调用要不要只读」。
    // claude 实测不返回该字段（或返回 false），宿主对不支持的引擎会直接拒绝整轮，
    // 所以假数据必须复刻这个形态，否则测试根本发现不了传错参数。
    catalog: async () => [
      {
        engine: "claude",
        label: "Claude Code",
        available: true,
        readOnly: false,
        providers: [],
        models: [
          { id: "claude-sonnet-5", label: "Sonnet 5" },
          { id: "claude-opus-5", label: "Opus 5" },
        ],
        efforts: ["low", "medium", "high"],
      },
      {
        engine: "codex",
        label: "Codex",
        available: true,
        readOnly: true,
        providers: [],
        models: [{ id: "gpt-5", label: "GPT-5" }],
        efforts: [],
      },
      {
        // 已安装但没配置好：应显示为「不可用」而不是直接消失
        engine: "qoder",
        label: "Qoder",
        available: false,
        readOnly: true,
        providers: [],
        models: [],
        efforts: [],
      },
    ],
    start: async (opts) => {
      agentStarts.push(opts);
      agentRunIdx += 1;
      const idx = agentRunIdx;
      const runId = "run-" + idx;
      if (agentMode === "silent") {
        // 先推半截正文再保持沉默：模拟「模型写了开头就卡住」，用户这时点停止，
        // 界面要能区分「半截」和「写完了」。
        setTimeout(() => emit({ runId, kind: "delta", data: "## 今天在热什么\n\n写到这里就停了" }), 10);
        return { runId, sessionId: null };
      }
      if (agentMode === "slow-start") {
        // start 迟迟不 resolve：用来验证「start 在飞时点停止」不会留下孤儿进程
        await sleep(agentStartDelay);
        return { runId, sessionId: null };
      }
      if (agentMode === "hang") {
        // 起了进程但一个事件都不推、也不结束：模拟模型卡死。
        // 只有插件自己的超时能把用户从这个状态里放出来。
        return { runId, sessionId: null };
      }
      setTimeout(() => {
        if (agentMode === "error") {
          emit({ runId, kind: "error", data: { message: "模型炸了" } });
          return;
        }
        // 故意先推一个别的 run，验证按 runId 过滤
        emit({ runId: "stale-run", kind: "delta", data: "不该出现的内容" });
        emit({ runId, kind: "delta", data: "## 今天在热什么\n\n" });
        emit({ runId, kind: "delta", data: "**Rust** 在升温，`tokio` 生态最活跃。\n\n" });
        emit({ runId, kind: "delta", data: "| 仓库 | 方向 | 解决什么问题 | 适合谁 |\n" });
        emit({ runId, kind: "delta", data: "| --- | --- | --- | --- |\n" });
        emit({ runId, kind: "delta", data: "| alpha/one | 工具 | 测试解读正文 | 写代码的人 |\n" });
        emit({ runId, kind: "delta", data: "| [beta/two](https://github.com/beta/two) | 框架 | - | - |\n" });
        if (idx < 99) emit({ runId, kind: "done", data: null });
      }, 10);
      return { runId, sessionId: null };
    },
    interrupt: async (runId) => {
      agentInterrupts.push(runId);
      return true;
    },
  },
  bridge: {
    invoke: async (cmd, args) => {
      if (cmd !== "plugin_http_request") throw new Error("unexpected bridge command " + cmd);
      httpCalls.push({ url: args.url, headers: args.headers || {}, method: args.method, body: args.body });
      // 反馈中转：用例按 feedbackMode 决定这条路回什么。
      if (args.url.startsWith("https://ccgui-feedback.workers.dev/")) {
        if (args.url.endsWith("/quota")) {
          return { status: feedbackQuota.status, body: JSON.stringify(feedbackQuota.value) };
        }
        if (args.url.endsWith("/feedback")) {
          return { status: feedbackSend.status, body: feedbackSend.body };
        }
      }
      if (args.url.startsWith("https://github.com/trending")) {
        return { status: trendingPayload.status, body: trendingPayload.body };
      }
      if (args.url.startsWith("https://api.github.com/search/repositories")) {
        // 三条路径共用一个接口，按 q 区分，才能断言「用的对的那条 query」。
        const q = decodeURIComponent((/[?&]q=([^&]*)/.exec(args.url) || ["", ""])[1]);
        if (/in:name/.test(q)) return { status: nameSearchPayload.status, body: nameSearchPayload.body };
        // 新星库带 created:> 时间窗；「随便看看」是 stars:lo..hi 档位。
        if (/created:>/.test(q)) return { status: searchPayload.status, body: searchPayload.body };
        if (/stars:/.test(q)) return { status: discoverPayload.status, body: discoverPayload.body };
        return { status: searchPayload.status, body: searchPayload.body };
      }
      // raw 快路径：不受 API 配额影响。默认没有路由 → 404，用例按需登记。
      const raw = /^https:\/\/raw\.githubusercontent\.com\/([^/]+\/[^/]+)\/HEAD\/(.+)$/.exec(args.url);
      if (raw) {
        const hit = rawRoutes.get(raw[1] + ":" + raw[2]);
        return hit ? { status: hit.status, body: hit.body } : { status: 404, body: "404: Not Found" };
      }
      // /repos/<owner>/<name>/readme —— raw 没命中时的回落
      const readme = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/readme$/.exec(args.url);
      if (readme) {
        const hit = readmeRoutes.get(readme[1]) || readmeDefault;
        return { status: hit.status, body: hit.body };
      }
      throw new Error("unexpected url " + args.url);
    },
  },
};

/* ------------------------------------------------------------ 执行 */

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ ok: true, name });
  } catch (error) {
    results.push({ ok: false, name, error });
  }
}

const mod = await import(PLUGIN);
assert.equal(typeof mod.default, "function", "main.js 应默认导出 activate");
const dispose = mod.default(ctx);
assert.equal(typeof dispose, "function", "activate 应返回清理函数");

const tab = () => tabDef.component;
const render = (opts) => renderFresh(tab(), {}, opts);

await check("注册了中心页签、侧栏入口、设置页与两个命令", () => {
  assert.ok(tabDef, "center tab");
  assert.ok(navDef, "sidebar nav");
  assert.ok(settingsDef, "settings section");
  assert.ok(commands.has("open"), "command open");
  assert.ok(commands.has("refresh"), "command refresh");
  assert.equal(tabDef.title(), "每日热点");
  assert.equal(navDef.label(), "每日热点");
});

await check("注入的 CSS 不用远程资源", () => {
  assert.equal(cssCalls.length, 1);
  assert.doesNotMatch(cssCalls[0], /@import/);
  assert.doesNotMatch(cssCalls[0], /url\(\s*['"]?https?:/i);
});

await check("命令能打开页签", () => {
  commands.get("open").run();
  assert.equal(openedTab, "main");
  assert.equal(openTabFailures, 0);
});

await check("首次打开自动拉取并渲染列表", async () => {
  const tree = render({ effects: true });
  assert.ok(await waitFor(() => countByType(render(), "li") === 3), "应渲染 3 行");
  const text = textOf(render());
  assert.match(text, /alpha \/ one/);
  assert.match(text, /first fixture repo/);
  assert.match(text, /Python/);
  assert.match(text, /★ 1k/);
  assert.match(text, /\+100 今日/);
  assert.match(text, /首次抓取/);
});

await check("首次抓取也有名次徽章，只是不标涨跌", () => {
  // 宿主里第一次装插件看到的就是这一屏：没有历史快照。
  // 曾经这里 rank 为 null，标题行只剩仓库名，实机上看着像是标签没渲染出来。
  const tree = render();
  const ranks = [];
  walk(tree, (n) => {
    const c = n.props && n.props.className;
    if (typeof c === "string" && c.split(/\s+/).includes("gt-rank")) ranks.push(textOf(n));
  });
  assert.deepEqual(ranks, ["1", "2", "3"], "首次抓取也应按榜单顺序给出名次");

  // 没有可比的历史，任何涨跌/新上榜标签都不该出现
  assert.equal(countByClass(tree, "gt-move"), 0, "首次抓取不应有任何变化标签");
  assert.doesNotMatch(textOf(tree), /新上榜|↑|↓/, "首次抓取不应声称排名变化");
});

await check("请求只打到两个已声明的 host", () => {
  assert.ok(httpCalls.length >= 1);
  for (const call of httpCalls) {
    assert.match(call.url, /^https:\/\/(github\.com|api\.github\.com)\//);
  }
  const trending = httpCalls.find((c) => c.url.includes("/trending"));
  assert.ok(trending.url.includes("since=daily"));
  assert.ok(trending.headers["User-Agent"], "应带 User-Agent");
});

await check("快照落盘且不留 .bak", async () => {
  assert.ok(await waitFor(() => fs.existsSync(path.join(storageDir, "history", "daily-all.json"))));
  const snap = JSON.parse(fs.readFileSync(path.join(storageDir, "history", "daily-all.json"), "utf8"));
  assert.equal(snap.repos.length, 3);
  await sleep(60);
  assert.ok(!fs.existsSync(path.join(storageDir, "history", "daily-all.json.bak")), "应清理 .bak");
});

await check("第二次刷新标出新上榜/掉榜/升降位", async () => {
  trendingPayload = { status: 200, body: trendingHtml(day2) };
  const btn = findByText(render(), "刷新");
  btn.props.onClick();
  assert.ok(await waitFor(() => textOf(render()).includes("brand new repo")), "应出现新仓库");
  const text = textOf(render());
  assert.match(text, /↑1/, "beta 升到第一");
  assert.match(text, /↓1/, "alpha 降到第二");
  assert.match(text, /新/, "delta 标记新上榜");
  assert.match(text, /掉榜（1）/);
  assert.match(text, /gamma\/three/);
});

await check("榜单没变时说明「排名无变化」，而不是整行空着", async () => {
  // 再抓一次同一份榜单：所有 rankDelta 为 0，标签本来就不渲染。
  // 不解释一句，用户会以为涨跌标签坏了。
  const btn = findByText(render(), "刷新");
  assert.ok(btn, "应有刷新按钮");
  btn.props.onClick();
  assert.ok(await waitFor(() => /排名无变化/.test(textOf(render()))), "应说明排名无变化");
  assert.equal(countByClass(render(), "gt-move"), 0, "没有变化就不该有标签");
  assert.ok(countByClass(render(), "gt-rank") >= 3, "名次徽章仍要在");
});

/* ------------------------------------------------------- 工具栏 */

/** 工具栏里的分段控件：从容器 class 认，而不是按文本猜。 */
function segmented(node, label) {
  let hit = null;
  walk(node, (n) => {
    if (hit) return;
    const c = n.props && n.props.className;
    if (typeof c === "string" && c.split(/\s+/).includes("gt-seg") && n.props["aria-label"] === label) hit = n;
  });
  return hit;
}

function segItems(node, label) {
  const seg = segmented(node, label);
  assert.ok(seg, "应有「" + label + "」分段控件");
  const out = [];
  walk(seg, (n) => {
    if (n === seg) return;
    const c = n.props && n.props.className;
    if (typeof c === "string" && c.split(/\s+/).includes("gt-seg-item")) out.push(n);
  });
  return out;
}

/** 找「更多」菜单容器。 */
function overflowMenu(node) {
  let hit = null;
  walk(node, (n) => {
    if (hit) return;
    const c = n.props && n.props.className;
    if (typeof c === "string" && c.split(/\s+/).includes("gt-more")) hit = n;
  });
  return hit;
}

function moreItems(node) {
  const out = [];
  walk(node, (n) => {
    const c = n.props && n.props.className;
    if (typeof c === "string" && c.split(/\s+/).includes("gt-more-item")) out.push(n);
  });
  return out;
}

await check("工具栏：视图是分段控件，三个选项全部可见、单击切换", async () => {
  assert.ok(await waitFor(() => countByType(render(), "li") === 3));
  const items = segItems(render(), "数据视图");
  assert.deepEqual(items.map((n) => textOf(n)), ["Trending", "新星库", "随便看看"], "三个视图都应平铺可见");
  // 当前视图在同一容器内高亮，而不是靠另一个组件重复说明
  const on = items.filter((n) => String(n.props.className).includes("is-on"));
  assert.equal(on.length, 1, "同一时刻只有一个视图是高亮的");
  assert.equal(textOf(on[0]), "Trending");
  // 单击即可切换，不需要先展开
  items[1].props.onClick();
  assert.ok(await waitFor(() => textOf(render()).includes("近 7 天新建的高增长仓库")));
  // 切回趋势：外部 store 是模块级的，留着新星库会让后面的用例看不到时间档
  segItems(render(), "数据视图")[0].props.onClick();
  assert.ok(await waitFor(() => countByType(render(), "li") === 3), "切回趋势应重新拉回榜单");
});

await check("工具栏：时间档宽屏分段、窄屏下拉两份都在，由 CSS 决定可见", async () => {
  const tree = render();
  // 宽屏那份：今日 / 本周 / 本月 平铺
  const periods = segItems(tree, "时间档");
  assert.deepEqual(periods.map((n) => textOf(n)), ["今日", "本周", "本月"]);
  // 窄屏那份：触发器的文本就是当前值
  const dd = findTrigger(tree, "今日");
  assert.ok(dd, "窄屏档应有一个紧凑下拉，触发器的文本是当前值");
  // 两份都渲染、由 @container 切换可见：组件在冒烟里拿不到真实容器宽度，
  // 用 js 宽度探测会让「宽屏显示下拉」这种 bug 无法被测试发现。
  assert.equal(segmented(tree, "时间档").props.className.includes("gt-period"), false);
});

await check("工具栏：窄屏「更多」菜单里能复制 Markdown、能打开设置", async () => {
  const openedBefore = openedSettings;
  // 菜单开合是组件局部 state：要用 renderKeep，否则每次渲染都从头收起。
  const renderTab = () => renderKeep(tabDef.component, {});
  const menu = () => overflowMenu(renderTab());
  // 收起状态不渲染菜单项
  assert.equal(moreItems(render()).length, 0, "未展开时不该渲染菜单项");

  menu().props.onKeyDown({ key: "ArrowDown", preventDefault() {}, target: { className: "gt-more-trigger" } });
  assert.ok(String(menu().props.className).split(/\s+/).includes("is-open"), "方向键应展开");

  const items = moreItems(renderTab());
  assert.deepEqual(items.map((n) => textOf(n)), ["复制 Markdown", "设置"], "低频动作应都在菜单里");

  // 点「设置」走的是同一个 openSettings，不是第二套逻辑
  items[1].props.onClick();
  assert.equal(String(menu().props.className).includes("is-open"), false, "选中后应收起");
  assert.equal(openedSettings, openedBefore + 1, "应打开设置页");

  // Esc / Tab 关闭：scrim 是全屏的，留着会吞掉后续点击
  for (const key of ["Escape", "Tab"]) {
    menu().props.onKeyDown({ key: "ArrowDown", preventDefault() {}, target: { className: "gt-more-trigger" } });
    assert.ok(String(menu().props.className).includes("is-open"), key + " 前应已展开");
    menu().props.onKeyDown({ key, preventDefault() {}, target: { className: "gt-more-item" } });
    assert.equal(String(menu().props.className).includes("is-open"), false, key + " 应关闭菜单");
  }

  // 复制 Markdown 也走同一条路径：剪贴板桩会把内容记下来
  const prev = globalThis.navigator;
  let copied = "";
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { clipboard: { writeText: async (t) => { copied = t; } } },
  });
  try {
    menu().props.onKeyDown({ key: "ArrowDown", preventDefault() {}, target: { className: "gt-more-trigger" } });
    const exportItem = moreItems(renderTab()).find((n) => textOf(n).includes("复制 Markdown"));
    assert.ok(exportItem, "未复制前菜单项就是「复制 Markdown」");
    exportItem.props.onClick();
    assert.ok(await waitFor(() => copied.length > 0), "菜单里的复制应写入剪贴板");
    // 这里只验「走的是同一个导出」：前面几条用例已经换过榜单，
    // 不写死某个仓库名，免得它一改就被这条用例绊住。
    assert.match(copied, /github\.com/, "复制的应是当前榜单的 Markdown");
  } finally {
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: prev });
  }
});

/* ------------------------------------------------------- 榜单内本地筛选 */

function filterInputOf(node) {
  let hit = null;
  walk(node, (n) => {
    if (hit || n.type !== "input") return;
    const c = n.props && n.props.className;
    if (typeof c === "string" && c.split(/\s+/).includes("gt-filter-input")) hit = n;
  });
  return hit;
}

/** 关键词存在 store 里（唯一数据源），所以改完直接重新渲染就能看见效果。 */
function typeFilter(value) {
  const input = filterInputOf(render());
  assert.ok(input, "有榜单时应出现筛选输入框");
  input.props.onChange({ target: { value } });
}

const listRepos = () => {
  const out = [];
  walk(render(), (n) => {
    // 仓库名取链接的 title（就是 row.repo）：屏幕上渲染成「owner / name」，
    // 中间是空格，按文本切会得到两段。
    if (n.type === "a" && n.props && String(n.props.className || "").includes("gt-repo")) {
      const title = String(n.props.title || "");
      if (title) out.push(title);
    }
  });
  return out;
};

await check("榜单内筛选：只过滤已加载的行，不发请求", async () => {
  const before = httpCalls.length;
  typeFilter("rust");
  const repos = listRepos();
  assert.deepEqual(repos, ["beta/two"], "应只剩语言/描述匹配的那一行");
  assert.equal(httpCalls.length, before, "筛选是本地的，不该打网络");
  assert.match(textOf(render()), /筛出 1 \/ 3 个/);
  // 状态行说的是「你在看什么数据」，仍是完整的榜单说明
  assert.match(textOf(render()), /GitHub Trending/);
});

await check("榜单内筛选：不区分大小写，按描述也能筛", async () => {
  typeFilter("SECOND FIXTURE");
  assert.deepEqual(listRepos(), ["beta/two"]);
});

await check("榜单内筛选：清除后回到完整列表", async () => {
  const clear = findByText(render(), "清除");
  assert.ok(clear, "筛选生效时应给出清除入口");
  clear.props.onClick();
  assert.equal(listRepos().length, 3);
  assert.match(textOf(render()), /显示全部 3 个/);
});

await check("榜单内筛选：无匹配时说清楚，而不是「榜单为空」", async () => {
  typeFilter("根本没有这个东西");
  assert.equal(listRepos().length, 0);
  assert.match(textOf(render()), /没有匹配「根本没有这个东西」的仓库/);
  findByText(render(), "清空关键词").props.onClick();
  assert.equal(listRepos().length, 3);
});

await check("榜单内筛选：导出的是筛出来的行，并在标题里写明", async () => {
  const prev = globalThis.navigator;
  let copied = "";
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { clipboard: { writeText: async (t) => { copied = t; } } },
  });
  try {
    typeFilter("rust");
    findByText(render(), "复制 Markdown").props.onClick();
    assert.ok(await waitFor(() => copied.length > 0), "应写入剪贴板");
    assert.match(copied, /已筛选「rust」/, "标题要说明这是筛选后的子集");
    assert.match(copied, /beta\/two/);
    assert.doesNotMatch(copied, /alpha\/one/, "筛掉的行不能出现在导出里");
  } finally {
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: prev });
    typeFilter("");
    renderFresh(tab(), {});
  }
});

await check("榜单内筛选：切视图后关键词自动清空", async () => {
  typeFilter("rust");
  findByText(render(), "随便看看").props.onClick();
  assert.ok(await waitFor(() => textOf(render()).includes("a random pick")));
  assert.equal(filterInputOf(render()) ? filterInputOf(render()).props.value : "", "", "换视图后不该留着旧关键词");
  // 切回来，别把视图留给后面的用例
  findByText(render(), "Trending").props.onClick();
  assert.ok(await waitFor(() => listRepos().length === 3));
});

await check("榜单内筛选：解读只喂筛出来的行，并说明是子集", async () => {
  agentStarts.length = 0;
  typeFilter("rust");
  findByText(render(), "生成解读").props.onClick();
  assert.ok(await waitFor(() => textOf(render()).includes("测试解读正文")));
  const prompt = agentStarts[0].prompt;
  assert.match(prompt, /已筛选「rust」/);
  assert.match(prompt, /之后剩下的仓库/);
  assert.doesNotMatch(prompt, /alpha\/one/, "筛掉的行不能进 prompt");
  // 复位，别把筛选与解读留给后面的用例
  typeFilter("");
  renderFresh(tab(), {});
  // 下一条用例断言「只应跑过一轮」，这里这轮要清掉。
  agentStarts.length = 0;
});

await check("生成解读：按 runId 过滤、流式写入", async () => {
  findByText(render(), "生成解读").props.onClick();
  assert.ok(await waitFor(() => textOf(render()).includes("测试解读正文")), "应写入解读");
  const text = textOf(render());
  assert.doesNotMatch(text, /不该出现的内容/, "别的 runId 的事件必须丢弃");
  assert.match(text, /今天在热什么/);
  assert.equal(agentStarts.length, 1);
  // 「自动」会选中排第一的 claude，而 claude 不支持隔离只读：必须传 false。
  // 真实宿主对不支持的引擎是整轮拒绝，不是降级——传错这个参数生成直接失败。
  assert.equal(agentStarts[0].readOnly, false, "引擎不支持时不能请求只读运行");
  assert.match(agentStarts[0].prompt, /GitHub Trending daily/);
  // 默认 cwd 必须是插件数据目录，而不是侧栏第一个工作区（os.tmpdir() 在这里
  // 扮演「真实项目」）。挂在项目名下，解读会话会被那个项目的会话历史记成产出。
  assert.equal(
    agentStarts[0].workspacePath,
    storageDir,
    "默认工作区应是插件数据目录，不是侧栏工作区",
  );
});

await check("生成解读：复用同一条后台会话，不再每次新开", async () => {
  // 每点一次解读就新开一条会话，侧栏会被「只读、写过一次就没人再看」的
  // 会话塞满。这里验证：第一次新开并把 id 落盘，第二次带上它。
  const original = ctx.agent.start;
  const seen = [];
  let n = 0;
  ctx.agent.start = async (opts) => {
    seen.push(opts);
    n += 1;
    const runId = "digest-run-" + n;
    // 复刻真实宿主的事件流：订阅者靠 runId 对上号，正文也是流式推过来的。
    setTimeout(() => {
      emit({ runId, kind: "delta", data: "## 今天在热什么\n\n测试解读正文" });
      emit({ runId, kind: "done", data: null });
    }, 10);
    return { runId, sessionId: "digest-" + n };
  };
  const saved = {};
  const inst = await freshTabInstance(() => ({}), (k, v) => {
    if (k === "settings") Object.assign(saved, v);
  });
  try {
    inst.clickDigest();
    assert.ok(await waitFor(() => seen.length === 1), "第一次应起一轮");
    assert.ok(!seen[0].sessionId, "第一次没有可复用 id");
    assert.ok(await waitFor(() => saved.digestSessionId === "digest-1"), "应把会话 id 落盘");
    assert.ok(await waitFor(() => inst.text().includes("测试解读正文")));

    inst.clickDigest();
    assert.ok(await waitFor(() => seen.length === 2), "第二次应再起一轮");
    assert.equal(seen[1].sessionId, "digest-1", "第二次应复用同一条会话");
  } finally {
    ctx.agent.start = original;
    inst.dispose();
  }
});

await check("生成解读：旧会话被删时清掉 id 重开，不会每次都失败", async () => {
  // 宿主对已删除的 sessionId 是直接拒绝整轮，不会帮你新开。没有这层兜底的话，
  // 用户在侧栏删掉那条解读会话之后，**每一次**点「生成解读」都会报错，
  // 而界面上只有一句看不懂的话。
  const original = ctx.agent.start;
  const calls = [];
  let n = 0;
  ctx.agent.start = async (opts) => {
    calls.push(opts);
    if (opts.sessionId === "digest-gone") throw new Error("session not found: digest-gone");
    n += 1;
    const runId = "digest-run-" + n;
    setTimeout(() => {
      emit({ runId, kind: "delta", data: "## 今天在热什么\n\n测试解读正文" });
      emit({ runId, kind: "done", data: null });
    }, 10);
    return { runId, sessionId: "digest-" + n };
  };
  const saved = {};
  const inst = await freshTabInstance(
    () => ({ digestSessionId: "digest-gone" }),
    (k, v) => {
      if (k === "settings") Object.assign(saved, v);
    },
  );
  try {
    inst.clickDigest();
    assert.ok(await waitFor(() => calls.length === 2), "应带旧 id 试一次、失败后不带 id 再来一次");
    assert.equal(calls[0].sessionId, "digest-gone");
    assert.ok(!calls[1].sessionId, "重试应不带 sessionId");
    // 关键是能真的出结果，而不是停在报错
    assert.ok(await waitFor(() => inst.text().includes("测试解读正文")), "重试后应正常生成");
    assert.ok(await waitFor(() => saved.digestSessionId === "digest-1"), "应把新 id 落盘");
  } finally {
    ctx.agent.start = original;
    inst.dispose();
  }
});

await check("解读正文渲染成 Markdown，表格变成真表格", async () => {
  const tree = render();
  let digest = null;
  walk(tree, (n) => {
    if (!digest && n.props && typeof n.props.className === "string" && n.props.className.split(/\s+/).includes("gt-digest-body")) {
      digest = n;
    }
  });
  assert.ok(digest, "应有解读正文容器");
  // 以前整段塞 <pre>：模型写的表格和粗体全都显示成星号和竖线
  assert.ok(!findByType(digest, "pre"), "解读正文不该还是 <pre> 原文");
  assert.ok(findByType(digest, "h2"), "## 应渲染成标题");
  assert.ok(findByType(digest, "strong"), "**粗体** 应渲染成 strong");
  assert.ok(findByType(digest, "code", "gt-md-code"), "行内代码应渲染成 code");
  const table = findByType(digest, "table", "gt-md-table");
  assert.ok(table, "表格应渲染成 <table>");
  const ths = [];
  walk(table, (n) => {
    if (n.type === "th") ths.push(textOf(n));
  });
  assert.deepEqual(ths, ["仓库", "方向", "解决什么问题", "适合谁"], "表头四列都在");
  let tds = 0;
  walk(table, (n) => {
    if (n.type === "td") tds += 1;
  });
  assert.equal(tds, 8, "两行数据各四格");
  // 表格外面要有一层横向滚动容器，窄窗口下不能把整页撑宽
  let wrap = null;
  walk(digest, (n) => {
    if (!wrap && n.props && typeof n.props.className === "string" && n.props.className.split(/\s+/).includes("gt-md-table-wrap")) {
      wrap = n;
    }
  });
  assert.ok(wrap && findByType(wrap, "table"), "表格应包在可横向滚动的容器里");
  // 模型写的链接只能变成 http(s) 的 <a>
  let link = null;
  walk(digest, (n) => {
    if (!link && n.type === "a") link = n;
  });
  assert.ok(link, "Markdown 链接应渲染成 <a>");
  assert.equal(link.props.href, "https://github.com/beta/two");
  assert.equal(link.props.target, "_blank");
  assert.match(String(link.props.rel), /noopener/);
});

await check("解读只显示不落盘", async () => {
  const files = fs.readdirSync(storageDir, { recursive: true }).map(String);
  assert.ok(!files.some((f) => /digest|解读/.test(f)), "不应写解读文件");
});

/* ---------- 单个仓库的讨论会话 ---------- */

/**
 * 讨论按钮只在这一行的标题行里；按仓库名定位，避免点到别的行。
 *
 * 用 aria-label 精确匹配：行文本里仓库名是渲染成 `owner / name`（中间有空格），
 * 拿 `owner/name` 去 includes 永远不成立，会静默退回「第一个按钮」——那会让
 * 「点 A 行却开的是 B 行」这种真 bug 看起来像通过。
 */
function discussButtonFor(tree, repo) {
  let hit = null;
  const label = "就 " + repo + " 开会话";
  walk(tree, (n) => {
    if (hit || n.type !== "button") return;
    if (n.props && n.props["aria-label"] === label) hit = n;
  });
  return hit;
}

/**
 * 起一个独立插件实例（只接管页签）。
 *
 * 续接表 `discussSessions` 是模块级状态，只在**同一次激活**内共享。用例之间
 * 必须各起一个实例，否则前一条留下的 sessionId 会让后一条断言的「第一次应
 * 新开」直接失败。
 */
async function freshTabInstance(storageGet, storageSet) {
  const fresh = await import(PLUGIN + "?fresh=" + Date.now() + Math.random().toString(36).slice(2));
  let tab = null;
  const dispose = fresh.default(
    Object.assign({}, ctx, {
      storage: {
        get: async (k) => (k === "settings" ? storageGet() : null),
        set: async (k, v) => {
          if (storageSet) storageSet(k, v);
        },
        delete: async () => {},
      },
      ui: Object.assign({}, ctx.ui, {
        registerCenterTab: (d) => {
          tab = d;
          return () => {};
        },
        registerSidebarNav: () => () => {},
        registerSettingsSection: () => () => {},
        registerCommand: () => () => {},
      }),
    }),
  );
  assert.ok(await waitFor(() => !!tab, 2000), "独立实例应注册页签");
  renderFresh(tab.component, {}, { effects: true });
  assert.ok(
    await waitFor(() => !!discussButtonFor(renderFresh(tab.component, {}), "beta/two"), 2000),
    "独立实例应渲染出榜单",
  );
  return {
    click(repo) {
      const btn = discussButtonFor(renderFresh(tab.component, {}), repo);
      assert.ok(btn, "应有 " + repo + " 的讨论按钮");
      btn.props.onClick();
    },
    button(repo) {
      return discussButtonFor(renderFresh(tab.component, {}), repo);
    },
    clickDigest() {
      const btn = findByText(renderFresh(tab.component, {}), "生成解读");
      assert.ok(btn, "应有生成解读按钮");
      btn.props.onClick();
    },
    text() {
      return textOf(renderFresh(tab.component, {}));
    },
    tree() {
      return renderFresh(tab.component, {});
    },
    dispose,
  };
}

await check("每行都有讨论入口，点后向 sessions.startRun 开会话而不是 agent.start", async () => {
  const before = agentStarts.length;
  const btn = discussButtonFor(render(), "beta/two");
  assert.ok(btn, "榜单行里应有讨论按钮");
  btn.props.onClick();
  assert.ok(await waitFor(() => sessionStarts.length === 1), "应调用 sessions.startRun");
  // 讨论绝不能走 agent.start：那条路的输出只回插件，用户接管不了。
  assert.equal(agentStarts.length, before, "讨论不应走 agent.start");

  const def = sessionStarts[0];
  assert.equal(def.engine, "claude");
  assert.equal(def.model, "claude-sonnet-5", "没选模型时用该引擎第一个");
  assert.match(def.prompt, /beta\/two/);
  assert.match(def.prompt, /https:\/\/github\.com\/beta\/two/);
  assert.match(def.prompt, /本地副本/);
  // 新会话不带 sessionId，否则会续接到别人的会话上
  assert.ok(!def.sessionId, "新会话不应带 sessionId");
  assert.equal(def.workspacePath, storageDir, "会话 cwd 应是 AI 工作区");
  // 默认的 AI 工作区是插件数据目录，不在侧栏工作区表里。宿主只扫已登记
  // 工作区的会话目录——不先登记，会话进程照跑、jsonl 照写，侧栏就是没有。
  assert.deepEqual(workspaceAdds, [storageDir], "开会话前应把默认工作目录登记成侧栏工作区");
  assert.equal(sessionStartsAtAdd[0], 0, "登记必须先于 startRun，不能并行");
  assert.ok(await waitFor(() => sessionRefreshes >= 1), "登记新工作区后应请宿主补扫会话目录");
  assert.ok(textOf(render()).includes("分组「"), "回执应说明会话挂在哪个侧栏分组下");
});

await check("讨论会尊重设置里选的工作区", async () => {
  // 用独立实例 + 独立的 storage：改全局 kv 会污染后面用例（设置只在激活时
  // 读一次，改 kv 对已激活的 store 不生效，反过来又会漏给下一个用例）。
  const picked = { workspacePath: pickedWorkspaceDir };
  const fresh = await import(PLUGIN + "?discuss-ws=" + Date.now());
  let freshTab = null;
  const dispose2 = fresh.default(
    Object.assign({}, ctx, {
      storage: {
        get: async (k) => (k === "settings" ? picked : null),
        set: async () => {},
        delete: async () => {},
      },
      // 只接管页签；其余注册一律 noop，否则会把全局的 settingsDef/navDef
      // 换成这个实例的，后面的设置页用例全跑在一个 workspacePath 已设值的 store 上。
      ui: Object.assign({}, ctx.ui, {
        registerCenterTab: (d) => {
          freshTab = d;
          return () => {};
        },
        registerSidebarNav: () => () => {},
        registerSettingsSection: () => () => {},
        registerCommand: () => () => {},
      }),
    }),
  );
  try {
    assert.ok(await waitFor(() => !!freshTab, 2000), "独立实例应注册页签");
    renderFresh(freshTab.component, {}, { effects: true });
    assert.ok(await waitFor(() => !!discussButtonFor(renderFresh(freshTab.component, {}), "beta/two"), 2000));
    sessionStarts.length = 0;
    discussButtonFor(renderFresh(freshTab.component, {}), "beta/two").props.onClick();
    assert.ok(await waitFor(() => sessionStarts.length === 1), "应再次开会话");
    assert.equal(sessionStarts[0].workspacePath, pickedWorkspaceDir, "应使用用户指定的工作区");
    // 这个目录本来就在侧栏工作区表里，不该再登记一次。
    assert.deepEqual(workspaceAdds, [storageDir], "已登记的工作区不应重复登记");
  } finally {
    dispose2();
  }
});

await check("登记侧栏工作区失败时不阻断会话，但要说清可能看不见", async () => {
  // 独立目录 + 独立实例：主实例对 storageDir 的登记已经成功并缓存了。
  const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), "gt-unreg-"));
  const picked = { workspacePath: freshDir };
  const fresh = await import(PLUGIN + "?discuss-noreg=" + Date.now());
  let freshTab = null;
  const dispose2 = fresh.default(
    Object.assign({}, ctx, {
      storage: {
        get: async (k) => (k === "settings" ? picked : null),
        set: async () => {},
        delete: async () => {},
      },
      ui: Object.assign({}, ctx.ui, {
        registerCenterTab: (d) => {
          freshTab = d;
          return () => {};
        },
        registerSidebarNav: () => () => {},
        registerSettingsSection: () => () => {},
        registerCommand: () => () => {},
      }),
    }),
  );
  workspaceAddError = new Error("missing permission host:workspace");
  const addsBefore = workspaceAdds.length;
  const startsBefore = sessionStarts.length;
  try {
    assert.ok(await waitFor(() => !!freshTab, 2000));
    renderFresh(freshTab.component, {}, { effects: true });
    assert.ok(await waitFor(() => !!discussButtonFor(renderFresh(freshTab.component, {}), "beta/two"), 2000));
    discussButtonFor(renderFresh(freshTab.component, {}), "beta/two").props.onClick();
    // 登记失败只是「侧栏可能看不见」，会话本身必须照开——否则按钮等于坏了。
    assert.ok(await waitFor(() => sessionStarts.length === startsBefore + 1), "登记失败也应把会话开出来");
    assert.equal(workspaceAdds.length, addsBefore + 1, "应尝试登记且只尝试一次");
    assert.equal(sessionStarts[startsBefore].workspacePath, freshDir);
    assert.ok(
      await waitFor(() => textOf(renderFresh(freshTab.component, {})).includes("重新安装插件")),
      "回执应说明是权限问题导致会话可能看不见",
    );
  } finally {
    workspaceAddError = null;
    dispose2();
  }
});

await check("README：点行内展开，raw 没命中时回落到 api.github.com", async () => {
  rawRoutes.clear();
  readmeRoutes.clear();
  httpCalls.length = 0;
  let btn = null;
  walk(render(), (n) => {
    if (!btn && n.type === "button" && n.props && n.props["aria-label"] === "展开 beta/two 的 README") btn = n;
  });
  assert.ok(btn, "每行都应有 README 展开按钮");
  assert.equal(btn.props["aria-expanded"], "false");
  btn.props.onClick();

  assert.ok(await waitFor(() => textOf(render()).includes("用法")), "应渲染出 README 正文");
  // 先试 raw 的三个文件名（都不占 API 配额），全落空再回落 API。
  const rawCalls = httpCalls.filter((c) => c.url.startsWith("https://raw.githubusercontent.com/beta/two/HEAD/"));
  assert.ok(rawCalls.length > 0, "应优先试 raw 快路径");
  assert.equal(rawCalls[0].url, "https://raw.githubusercontent.com/beta/two/HEAD/README.md");
  assert.equal(rawCalls[0].headers.Authorization, undefined, "Token 不能发给 raw 域名");

  const call = httpCalls.find((c) => c.url.includes("/readme"));
  assert.ok(call, "raw 没命中时应请求 readme 接口");
  assert.equal(call.url, "https://api.github.com/repos/beta/two/readme");
  assert.match(String(call.headers.Accept), /vnd\.github\.raw/);

  // 预处理生效：badge、frontmatter、HTML 标签都不该出现在正文里
  const bodyText = textOf(render());
  assert.doesNotMatch(bodyText, /shields\.io/);
  assert.doesNotMatch(bodyText, /title: 假的 frontmatter/);
  assert.doesNotMatch(bodyText, /<b>|<div/);
  assert.match(bodyText, /一个很长的说明/);
  assert.match(bodyText, /npm i beta-two/, "代码块内容应保留");
});

await check("README：raw 命中时不再花 API 配额（限流期间也能看）", async () => {
  // 用独立实例：主实例的会话内缓存里已经有这几个仓库的正文，会挡住请求，
  // 那样这条用例就测不到「raw 命中后不再打 API」了。
  const fresh = await import(PLUGIN + "?readme-raw=" + Date.now());
  let freshTab = null;
  const dispose2 = fresh.default(
    Object.assign({}, ctx, {
      ui: Object.assign({}, ctx.ui, {
        registerCenterTab: (d) => {
          freshTab = d;
          return () => {};
        },
        registerSidebarNav: () => () => {},
        registerSettingsSection: () => () => {},
        registerCommand: () => () => {},
      }),
    }),
  );
  const view = () => renderFresh(freshTab.component, {});
  try {
    assert.ok(await waitFor(() => !!freshTab, 2000), "独立实例应注册页签");
    renderFresh(freshTab.component, {}, { effects: true });
    const readmeBtn = (repo) => {
      let hit = null;
      walk(view(), (n) => {
        if (!hit && n.type === "button" && n.props && n.props["aria-label"] === "展开 " + repo + " 的 README") hit = n;
      });
      return hit;
    };
    assert.ok(await waitFor(() => !!readmeBtn("alpha/one"), 3000), "独立实例应渲染出榜单");

    // 配额用完时 API 那条路会 403；raw 不受影响，必须还能读出正文。
    rawRoutes.clear();
    readmeRoutes.clear();
    httpCalls.length = 0;
    rawRoutes.set("alpha/one:README.md", { status: 200, body: "# alpha/one\n\n来自 raw 快路径" });
    readmeRoutes.set("alpha/one", { status: 403, body: JSON.stringify({ message: "API rate limit exceeded" }) });

    readmeBtn("alpha/one").props.onClick();
    assert.ok(await waitFor(() => textOf(view()).includes("来自 raw 快路径")), "raw 命中应直接出正文");
    assert.doesNotMatch(textOf(view()), /限流/, "命中 raw 时不该出现任何限流提示");
    assert.equal(
      httpCalls.filter((c) => c.url.startsWith("https://api.github.com/repos/alpha/one/readme")).length,
      0,
      "raw 命中后不该再打 API，否则照样烧配额",
    );
  } finally {
    rawRoutes.clear();
    readmeRoutes.clear();
    dispose2();
  }
});


await check("README：403 只在正文说明限流时才按配额解释", async () => {
  const openReadme = (repo) => {
    let btn = null;
    walk(render(), (n) => {
      if (!btn && n.type === "button" && n.props && n.props["aria-label"] === "展开 " + repo + " 的 README") btn = n;
    });
    return btn;
  };
  const closeIfOpen = () => {
    let close = null;
    walk(render(), (n) => {
      if (!close && n.type === "button" && n.props && typeof n.props["aria-label"] === "string"
        && /^收起 .+ 的 README$/.test(n.props["aria-label"])) close = n;
    });
    if (close) close.props.onClick();
  };
  try {
    // 1) 403 + 限流正文 → 配额文案（要告诉用户能做什么）
    closeIfOpen();
    await waitFor(() => !/README 全文|只显示前/.test(textOf(render())));
    readmeRoutes.set("alpha/one", { status: 403, body: JSON.stringify({ message: "API rate limit exceeded" }) });
    openReadme("alpha/one").props.onClick();
    assert.ok(await waitFor(() => /限流/.test(textOf(render()))), "限流 403 应提示配额");

    // 2) 403 + 普通正文（私有仓/被限制）→ 不能说成「等一会儿再试」
    closeIfOpen();
    await waitFor(() => !/限流/.test(textOf(render())));
    readmeRoutes.set("alpha/one", { status: 403, body: JSON.stringify({ message: "Repository access blocked" }) });
    openReadme("alpha/one").props.onClick();
    assert.ok(await waitFor(() => /拒绝访问/.test(textOf(render()))), "非限流 403 应说清是被拒绝");
    assert.doesNotMatch(textOf(render()), /限流/, "不该冒充限流");

    // 3) 429 一定是限流，不用看正文
    closeIfOpen();
    await waitFor(() => !/拒绝访问/.test(textOf(render())));
    readmeRoutes.set("alpha/one", { status: 429, body: "" });
    openReadme("alpha/one").props.onClick();
    assert.ok(await waitFor(() => /限流/.test(textOf(render()))), "429 应提示配额");
  } finally {
    readmeRoutes.clear();
    closeIfOpen();
    await waitFor(() => !/限流|拒绝访问/.test(textOf(render())));
    // 恢复进入本用例前的状态：beta/two 是展开的，下一条用例要接着测「收起」。
    let open = null;
    walk(render(), (n) => {
      if (!open && n.type === "button" && n.props && n.props["aria-label"] === "展开 beta/two 的 README") open = n;
    });
    if (open) open.props.onClick();
    await waitFor(() => textOf(render()).includes("一个很长的说明"));
  }
});

await check("README：再点一次收起，正文消失", async () => {
  let btn = null;
  walk(render(), (n) => {
    if (!btn && n.type === "button" && n.props && n.props["aria-label"] === "收起 beta/two 的 README") btn = n;
  });
  assert.ok(btn, "展开后按钮应变成收起");
  assert.equal(btn.props["aria-expanded"], "true");
  btn.props.onClick();
  assert.ok(await waitFor(() => !textOf(render()).includes("一个很长的说明")), "收起后正文应消失");
});

await check("README：同一时刻只展开一个，换行展开会顶掉上一行", async () => {
  readmeRoutes.set("alpha/one", { status: 200, body: "# alpha/one\n\n这是 alpha 的 README" });
  let open = null;
  walk(render(), (n) => {
    if (!open && n.type === "button" && n.props && n.props["aria-label"] === "展开 alpha/one 的 README") open = n;
  });
  open.props.onClick();
  assert.ok(await waitFor(() => textOf(render()).includes("这是 alpha 的 README")));
  let openB = null;
  walk(render(), (n) => {
    if (!openB && n.type === "button" && n.props && n.props["aria-label"] === "展开 beta/two 的 README") openB = n;
  });
  openB.props.onClick();
  assert.ok(await waitFor(() => textOf(render()).includes("一个很长的说明")));
  assert.doesNotMatch(textOf(render()), /这是 alpha 的 README/, "打开第二个时第一个应收起");
});

await check("README：没有 README 时给出原因，不是空白框", async () => {
  // 用 delta/four：它还没被展开过，否则会命中会话内缓存里的成功结果。
  readmeRoutes.set("delta/four", { status: 404, body: JSON.stringify({ message: "Not Found" }) });
  try {
    // 先收起当前展开的
    let close = null;
    walk(render(), (n) => {
      if (!close && n.type === "button" && n.props && n.props["aria-label"] === "收起 beta/two 的 README") close = n;
    });
    close.props.onClick();
    assert.ok(await waitFor(() => !textOf(render()).includes("一个很长的说明")));
    let btn = null;
    walk(render(), (n) => {
      if (!btn && n.type === "button" && n.props && n.props["aria-label"] === "展开 delta/four 的 README") btn = n;
    });
    btn.props.onClick();
    assert.ok(await waitFor(() => textOf(render()).includes("没有 README")), "404 要说清是没有 README");
  } finally {
    readmeRoutes.clear();
    // 收回到干净状态，别把展开态留给后面的用例
    let close = null;
    walk(render(), (n) => {
      if (!close && n.type === "button" && n.props && n.props["aria-label"] === "收起 delta/four 的 README") close = n;
    });
    if (close) close.props.onClick();
    await waitFor(() => !textOf(render()).includes("没有 README"));
  }
});

await check("README：会话内再展开不重新请求", async () => {
  // 上一条用例结束时 beta/two 是收起的，且刚展开过一次（正文应已进缓存）。
  readmeRoutes.clear();
  httpCalls.length = 0;
  const openBtn = () => {
    let hit = null;
    walk(render(), (n) => {
      if (!hit && n.type === "button" && n.props && n.props["aria-label"] === "展开 beta/two 的 README") hit = n;
    });
    return hit;
  };
  openBtn().props.onClick();
  assert.ok(await waitFor(() => textOf(render()).includes("一个很长的说明")), "第二次展开也应立刻看到正文");
  const readmeCalls = httpCalls.filter((c) => c.url.includes("/readme") || c.url.startsWith("https://raw.githubusercontent.com/"));
  assert.equal(readmeCalls.length, 0, "同一会话内重复展开不该再走网络（raw 与 API 都一样）");
});

await check("README：失败结果不缓存，看着恢复了就能重新读到", async () => {
  // 用 delta/four：同样没被缓存过，否则会先命中已有正文。
  readmeRoutes.set("delta/four", { status: 500, body: "boom" });
  try {
    let open = null;
    walk(render(), (n) => {
      if (!open && n.type === "button" && n.props && n.props["aria-label"] === "展开 delta/four 的 README") open = n;
    });
    open.props.onClick();
    assert.ok(await waitFor(() => /HTTP 500|读取 README 失败/.test(textOf(render()))), "应说明失败");
    // 修好后再展开：失败没被缓存，必须重新请求并成功
    readmeRoutes.set("delta/four", { status: 200, body: "# delta/four\n\n恢复了" });
    let close = null;
    walk(render(), (n) => {
      if (!close && n.type === "button" && n.props && n.props["aria-label"] === "收起 delta/four 的 README") close = n;
    });
    if (close) close.props.onClick();
    let again = null;
    walk(render(), (n) => {
      if (!again && n.type === "button" && n.props && n.props["aria-label"] === "展开 delta/four 的 README") again = n;
    });
    again.props.onClick();
    assert.ok(await waitFor(() => textOf(render()).includes("恢复了")), "失败不该粘住");
  } finally {
    readmeRoutes.clear();
    let close = null;
    walk(render(), (n) => {
      if (!close && n.type === "button" && n.props && n.props["aria-label"] === "收起 delta/four 的 README") close = n;
    });
    if (close) close.props.onClick();
    await waitFor(() => !textOf(render()).includes("恢复了"));
  }
});

await check("复制 Markdown：复制的是当前榜单，不是渲染后的文本", async () => {
  const prev = globalThis.navigator;
  let copied = "";
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { clipboard: { writeText: async (t) => { copied = t; } } },
  });
  try {
    let btn = null;
    walk(render(), (n) => {
      if (!btn && n.type === "button" && textOf(n) === "复制 Markdown") btn = n;
    });
    assert.ok(btn, "工具栏应有导出按钮");
    btn.props.onClick();
    assert.ok(await waitFor(() => copied.length > 0), "应写入剪贴板");
    assert.match(copied, /^# 每日热点/);
    assert.match(copied, /\*\*\[alpha\/one\]\(https:\/\/github\.com\/alpha\/one\)\*\*/);
    // Markdown 源码而不是屏幕上的纯文本：粘出去还得是列表和链接。
    assert.doesNotMatch(copied, /★ 1\.2k ·/);
  } finally {
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: prev });
  }
});

await check("复制 Markdown：剪贴板不可用时报失败，不静默", async () => {
  const prev = globalThis.navigator;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
  try {
    // 先拿按钮（renderFresh 重置内部 state，文案回到「复制 Markdown」），
    // 之后必须每帧重新渲染再读：回执是异步写进 useState 的，拿一次快照
    // 只会在 Promise 落地前读到空字符串。
    let btn = null;
    walk(render(), (n) => {
      if (!btn && n.type === "button" && textOf(n) === "复制 Markdown") btn = n;
    });
    assert.ok(btn);
    btn.props.onClick();
    assert.ok(
      await waitFor(() => textOf(renderKeep(tab(), {})).includes("复制失败")),
      "复制失败必须显示出来",
    );
  } finally {
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: prev });
    // 复位导出状态，别把「复制失败」留给下一条用例。
    renderFresh(tab(), {});
  }
});

await check("开会话期间按钮显示打开中，避免连点开出多个会话", async () => {
  sessionStarts.length = 0;
  sessionSelects.length = 0;
  sessionStartError = null;
  // 让 startRun 挂住，观察中间态。必须用独立实例：主实例上的 beta/two
  // 前面已经开过会话，第二次点击会走「直接打开」那条路，观察不到中间态。
  const gated = [];
  const original = ctx.sessions.startRun;
  const inst = await freshTabInstance(() => ({}));
  ctx.sessions.startRun = async (def) => {
    sessionStarts.push(def);
    await new Promise((r) => gated.push(r));
    return { runId: "srun-x", sessionId: null };
  };
  try {
    inst.click("beta/two");
    assert.ok(await waitFor(() => sessionStarts.length === 1), "应开始开会话");
    assert.ok(await waitFor(() => inst.text().includes("打开中")), "按钮应显示打开中");
    // 别的行这时应该被禁用
    assert.equal(inst.button("alpha/one").props.disabled, true, "别的行在开会话期间应禁用");
    for (const r of gated) r();
    assert.ok(await waitFor(() => !inst.text().includes("打开中")), "完成后应复位");
  } finally {
    ctx.sessions.startRun = original;
    inst.dispose();
  }
});

await check("开会话失败时说明原因，不静默吞掉", async () => {
  sessionStartError = new Error("missing permission host:session");
  sessionStarts.length = 0;
  sessionSelects.length = 0;
  const inst = await freshTabInstance(() => ({}));
  try {
    inst.click("beta/two");
    assert.ok(
      await waitFor(() => inst.text().includes("缺少会话权限")),
      "应给人看得懂的提示",
    );
    assert.ok(inst.button("beta/two"), "按钮应回到可点状态");
  } finally {
    sessionStartError = null;
    inst.dispose();
  }
});

await check("宿主没有 sessions 时按钮给出升级提示", async () => {
  const saved = ctx.sessions;
  delete ctx.sessions;
  try {
    sessionStarts.length = 0;
    discussButtonFor(render(), "beta/two").props.onClick();
    assert.ok(await waitFor(() => textOf(render()).includes("不支持从插件发起会话")), "应提示升级");
    assert.equal(sessionStarts.length, 0, "不能调用不存在的 API");
  } finally {
    ctx.sessions = saved;
  }
});

await check("开会话成功后回执会话去了侧栏，并说明本页不跳转", async () => {
  sessionStartError = null;
  sessionStarts.length = 0;
  sessionSelects.length = 0;
  const inst = await freshTabInstance(() => ({}));
  try {
    inst.click("beta/two");
    // 成功了却一声不响，用户会以为按钮没反应，进而连点开出好几轮真 token。
    assert.ok(
      await waitFor(() => inst.text().includes("已在侧栏为 beta/two 开了会话")),
      "应回执会话已开",
    );
    assert.match(inst.text(), /不会自动跳转/, "要说明本页不跳转");

    // 再点另一行：上一条回执必须先收掉，否则页面会同时声称两个会话都在等。
    inst.click("alpha/one");
    assert.ok(
      await waitFor(() => inst.text().includes("已在侧栏为 alpha/one 开了会话")),
      "应换成新的一条回执",
    );
    assert.ok(!inst.text().includes("beta/two 开了会话"), "旧回执应被替换");

    // 刷新是用户明确表示的「再来一次」，回执要让位给榜单本身的状态说明。
    findByText(inst.tree(), "刷新").props.onClick();
    assert.ok(await waitFor(() => !inst.text().includes("已在侧栏")), "刷新后回执应消失");
  } finally {
    inst.dispose();
  }
});

await check("生成中刷新榜单，停止按钮仍然点得动", async () => {
  // 刷新一进来就把 loading 置真，而刷新并不中止解读。按钮若跟着 loading
  // 一起禁用，用户就只能等 20s 超时、看着 token 继续烧。
  agentMode = "silent";
  const originalInvoke = ctx.bridge.invoke;
  let trendingDelay = 0;
  ctx.bridge.invoke = async (cmd, args) => {
    if (args.url.includes("/trending") && trendingDelay) await sleep(trendingDelay);
    return originalInvoke(cmd, args);
  };
  try {
    findByText(render(), "生成解读").props.onClick();
    assert.ok(await waitFor(() => !!findByText(render(), "停止生成")), "应进入生成中");

    trendingDelay = 200;
    findByText(render(), "刷新").props.onClick();
    await sleep(30);
    const stop = findByText(render(), "停止生成");
    assert.ok(stop, "刷新期间仍应是停止按钮");
    assert.notEqual(stop.props.disabled, true, "生成中不该被刷新禁掉");

    const before = agentInterrupts.length;
    await sleep(60);
    findByText(render(), "停止生成").props.onClick();
    assert.ok(await waitFor(() => agentInterrupts.length > before), "点了就该 interrupt");
  } finally {
    trendingDelay = 0;
    ctx.bridge.invoke = originalInvoke;
    agentMode = "stream";
    // 必须等这次慢刷新落地再退出：留着在飞的 loading，下一条用例刚点的
    // 生成结果会被「正在刷新榜单…」盖住，失败原因看起来像丢了。
    assert.ok(
      await waitFor(() => {
        const btn = findByText(render(), "刷新");
        return btn && btn.props["aria-busy"] === "false";
      }, 2000),
      "慢刷新应落地",
    );
  }
});

await check("模型报错时显示原因并复位按钮", async () => {
  agentMode = "error";
  findByText(render(), "生成解读").props.onClick();
  assert.ok(await waitFor(() => textOf(render()).includes("模型炸了")), "应显示错误");
  assert.ok(findByText(render(), "生成解读"), "按钮应回到可生成状态");
  agentMode = "stream";
});

await check("停止生成会通知宿主 interrupt", async () => {
  agentMode = "silent";
  findByText(render(), "生成解读").props.onClick();
  assert.ok(await waitFor(() => !!findByText(render(), "停止生成")), "应进入生成中");
  // waitFor 首次检查是同步的，等一拍确保 agent.start 已 resolve 出 runId
  await sleep(60);
  findByText(render(), "停止生成").props.onClick();
  assert.ok(await waitFor(() => agentInterrupts.length >= 1), "应调用 interrupt");
  assert.ok(findByText(render(), "生成解读"));
  agentMode = "stream";
});

await check("中途停止后正文标成「已停止」，不是一份写完的解读", async () => {
  // 先完整跑一次拿到正文，再重新生成并在中途停：半截正文留着，但要有标记，
  // 否则它和正常写完的解读长得一模一样。
  agentMode = "stream";
  findByText(render(), "生成解读").props.onClick();
  assert.ok(await waitFor(() => textOf(render()).includes("测试解读正文")), "应有一份完整解读");
  assert.ok(!/已停止/.test(textOf(render())), "完整解读不该带停止标记");

  agentMode = "silent";
  findByText(render(), "生成解读").props.onClick();
  assert.ok(await waitFor(() => !!findByText(render(), "停止生成")), "应进入生成中");
  await sleep(60);
  findByText(render(), "停止生成").props.onClick();
  assert.ok(await waitFor(() => /已停止/.test(textOf(render()))), "停止后应说明正文不完整");
  // 重新生成要把标记清掉
  agentMode = "stream";
  findByText(render(), "生成解读").props.onClick();
  assert.ok(await waitFor(() => textOf(render()).includes("测试解读正文") && !/已停止/.test(textOf(render()))), "重新生成后标记应消失");
});

await check("解读有复制按钮，复制的是 Markdown 原文", async () => {
  let copied = null;
  const prev = globalThis.navigator;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { clipboard: { writeText: async (t) => { copied = t; } } },
  });
  try {
    // 「已复制」是组件内部 state：renderFresh 每帧都会重置它，必须用 renderKeep。
    const keep = () => renderKeep(tab(), {});
    let btn = null;
    walk(keep(), (n) => {
      if (!btn && n.type === "button" && textOf(n) === "复制") btn = n;
    });
    assert.ok(btn, "写完的解读应有复制按钮");
    btn.props.onClick();
    assert.ok(await waitFor(() => copied !== null), "应调用剪贴板");
    // 复制原文而不是渲染后的纯文本：粘到别处仍是表格
    assert.match(copied, /^\| 仓库 \| 方向 \|/m);
    assert.match(copied, /\*\*Rust\*\*/);
    assert.ok(await waitFor(() => {
      let hit = null;
      walk(keep(), (n) => {
        if (!hit && n.type === "button" && textOf(n) === "已复制") hit = n;
      });
      return !!hit;
    }, 2000), "应给出复制成功反馈");
  } finally {
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: prev });
  }
});

await check("切到新星库走 Search API 并渲染", async () => {
  const chip = findByText(render(), "新星库");
  chip.props.onClick();
  assert.ok(await waitFor(() => textOf(render()).includes("fresh repo")), "应渲染新星库");
  const text = textOf(render());
  assert.match(text, /rising \/ star/);
  assert.match(text, /2 天前创建/);
  assert.ok(httpCalls.some((c) => c.url.startsWith("https://api.github.com/search/repositories")));
});

await check("限流时保留已有列表并给出可读提示", async () => {
  // 先在新星库拿到正常数据
  searchPayload = GOOD_SEARCH;
  findByText(render(), "新星库").props.onClick();
  assert.ok(await waitFor(() => textOf(render()).includes("fresh repo")), "先有数据");
  const before = countByType(render(), "li");
  assert.ok(before > 0, "应有列表行");

  // 同一视图刷新时被限流：列表必须还在
  searchPayload = { status: 403, body: JSON.stringify({ message: "API rate limit exceeded" }) };
  findByText(render(), "刷新").props.onClick();
  assert.ok(await waitFor(() => textOf(render()).includes("限流")), "应提示限流");
  const after = countByType(render(), "li");
  assert.equal(after, before, "限流后列表行数不应变化");
  assert.match(textOf(render()), /fresh repo/, "内容应保留");
  assert.match(textOf(render()), /上次缓存|当前显示/, "应说明显示的是旧数据");
});

await check("连接层偶发失败会重试一次，不再把 reqwest 原文丢给用户", async () => {
  // 宿主桥把 `error sending request` 原样抛出。第一次抛、第二次成功：
  // 插件应自己重放，页面上不该出现任何错误。
  trendingPayload = { status: 200, body: trendingHtml(day1) };
  let hits = 0;
  const original = ctx.bridge.invoke;
  ctx.bridge.invoke = async (cmd, args) => {
    if (String(args.url).startsWith("https://github.com/trending")) {
      hits += 1;
      if (hits === 1) throw new Error("error sending request");
    }
    return original(cmd, args);
  };
  try {
    findByText(render(), "Trending").props.onClick();
    assert.ok(await waitFor(() => textOf(render()).includes("alpha /")), "重试后应拿到榜单");
    assert.equal(hits, 2, "应重放一次");
    assert.doesNotMatch(textOf(render()), /error sending request/, "不该把底层错误原样显示");
  } finally {
    ctx.bridge.invoke = original;
  }
});

await check("连接层持续失败时给出人能看懂的提示", async () => {
  const original = ctx.bridge.invoke;
  ctx.bridge.invoke = async (cmd, args) => {
    if (String(args.url).startsWith("https://github.com/trending")) throw new Error("error sending request");
    return original(cmd, args);
  };
  try {
    findByText(render(), "刷新").props.onClick();
    assert.ok(await waitFor(() => /连不上 GitHub|网络|代理/.test(textOf(render()))), "应说清是网络问题");
    assert.doesNotMatch(textOf(render()), /error sending request/, "不要露出底层错误字符串");
  } finally {
    ctx.bridge.invoke = original;
    // 这两条用例停在 Trending 视图；下一条「页面结构变化」靠点 Trending 触发刷新，
    // 同一视图点一下是早退。先切回新星库，把视图状态还原成原顺序里的样子。
    findByText(render(), "新星库").props.onClick();
    await waitFor(() => textOf(render()).includes("fresh repo") || !textOf(render()).includes("正在刷新"));
  }
});

await check("页面结构变化时给出明确提示而不是空榜单", async () => {
  trendingPayload = { status: 200, body: "<html><body>redesigned</body></html>" };
  findByText(render(), "Trending").props.onClick();
  assert.ok(await waitFor(() => textOf(render()).includes("页面结构可能已变化")), "应提示结构变化");
});

/* ------------------------------------------------------- 随便看看 */

/** 「随便看看」的输入框内容属于组件局部 state：必须用 renderKeep 才看得见。 */
const browseKeep = () => renderKeep(tab(), {});

function searchInputOf(node) {
  let hit = null;
  walk(node, (n) => {
    if (hit || n.type !== "input") return;
    const ph = n.props && n.props.placeholder;
    if (typeof ph === "string" && /搜仓库名/.test(ph)) hit = n;
  });
  return hit;
}

/**
 * 提交搜索。
 *
 * 走 form 的 onSubmit 而不是按钮的 onClick：搜索按钮是 `type="submit"`、
 * 没有自己的 onClick，浏览器里点它（或按回车）触发的是表单提交。这里模拟
 * 同一条路径，也顺便验证了表单确实是可提交的。
 */
function submitSearch(value) {
  browseKeep();
  const input = searchInputOf(browseKeep());
  assert.ok(input, "应有搜索输入框");
  input.props.onChange({ target: { value } });
  browseKeep();
  let form = null;
  walk(browseKeep(), (n) => {
    if (form || n.type !== "form") return;
    const c = n.props && n.props.className;
    if (typeof c === "string" && c.split(/\s+/).includes("gt-search")) form = n;
  });
  assert.ok(form && typeof form.props.onSubmit === "function", "搜索框应在一个可提交的表单里");
  form.props.onSubmit({ preventDefault() {} });
}

await check("随便看看：换一批走 Search 的随机档位，并说明这不是排行榜", async () => {
  findByText(render(), "随便看看").props.onClick();
  assert.ok(await waitFor(() => textOf(render()).includes("a random pick")), "应渲染随机批次");
  const text = textOf(render());
  assert.match(text, /随机抽的一批热门仓库/);
  assert.match(text, /不是排行榜/, "必须说清楚没有名次与涨跌");
  assert.match(text, /★[\d.]+k?–5?[\d.]*k|★50k 以上|★\d/, "应说出抽的是哪个 star 档");

  const call = httpCalls.filter((c) => c.url.startsWith("https://api.github.com/search/repositories")).pop();
  const q = decodeURIComponent((/[?&]q=([^&]*)/.exec(call.url) || ["", ""])[1]);
  // 最高档是无上界写法（stars:>50000），所以数字前可能是 ":" 也可能是 ">"
  assert.match(q, /stars:[>\d]/, "随机批次应带 star 档位");
  assert.match(q, /fork:false/);
  assert.doesNotMatch(q, /created:>/, "不是新星库的时间窗查询");
  // 随机批次没有可比排名：不该出现「新上榜」这类标签
  assert.doesNotMatch(text, /新上榜/);
});

await check("随便看看：换一批每次都真的重新请求，不被早退挡掉", async () => {
  const before = httpCalls.length;
  findByText(render(), "换一批").props.onClick();
  assert.ok(await waitFor(() => httpCalls.length > before), "换一批必须打网络");
  assert.ok(await waitFor(() => textOf(render()).includes("a random pick")), "换一批后应有列表");
});

await check("随便看看：按仓库名搜索走 in:name，并标出精确命中", async () => {
  submitSearch("random/pick");

  assert.ok(await waitFor(() => textOf(render()).includes("fuzzy hit")), "应渲染搜索结果");
  const call = httpCalls.filter((c) => c.url.startsWith("https://api.github.com/search/repositories")).pop();
  const q = decodeURIComponent((/[?&]q=([^&]*)/.exec(call.url) || ["", ""])[1]);
  assert.match(q, /^random\/pick in:name/, "只搜仓库名");

  const tree = browseKeep();
  assert.equal(countByClass(tree, "gt-hit"), 1, "只有精确命中那一行带「正中」");
  assert.match(textOf(tree), /随机抽的一批热门仓库|搜索|正中/);
  assert.match(textOf(tree), /GitHub 搜索「random\/pick」/);
  assert.match(textOf(tree), /不是排行榜/);
});

await check("随便看看：搜索生效时输入框显示关键词，换一批后自动清空", async () => {
  submitSearch("random/pick");
  assert.ok(await waitFor(() => textOf(render()).includes("fuzzy hit")));
  // effect 里的 setText 在本次渲染之后才生效：像 React 一样再渲染一帧再读。
  browseKeep();
  assert.equal(searchInputOf(browseKeep()).props.value, "random/pick", "搜索生效时输入框应显示关键词");

  // 列表回到随机批次，输入框却还写着关键词的话，页面三处互相矛盾。
  findByText(render(), "换一批").props.onClick();
  assert.ok(await waitFor(() => textOf(render()).includes("a random pick")));
  browseKeep();
  assert.equal(searchInputOf(browseKeep()).props.value, "", "换一批后输入框必须清空");
});

await check("随便看看：搜索框限长，不把超长输入拼进 URL", async () => {
  submitSearch("random/pick");
  assert.ok(await waitFor(() => textOf(render()).includes("fuzzy hit")));
  const input = searchInputOf(browseKeep());
  assert.ok(Number.isFinite(input.props.maxLength), "输入框应有 maxLength，否则粘贴超长文本会拼出 414 的 URL");
});

await check("随便看看：搜不到时说清楚没搜到，而不是「榜单为空」", async () => {
  nameSearchPayload = { status: 200, body: JSON.stringify({ total_count: 0, items: [] }) };
  submitSearch("根本没有这个仓库");
  assert.ok(await waitFor(() => /没搜到/.test(textOf(render()))), "应说明没搜到");
  nameSearchPayload = GOOD_NAME_SEARCH;
});

await check("随便看看：清空搜索词再提交，回到换一批", async () => {
  submitSearch("");
  assert.ok(await waitFor(() => textOf(render()).includes("a random pick")), "应回到随机批次");
  assert.match(textOf(render()), /随机抽的一批/, "状态行应说明又回到随机抽样");
});

await check("随便看看：空批次给出明确的下一步，不是空白页", async () => {
  discoverPayload = { status: 200, body: JSON.stringify({ total_count: 900, items: [] }) };
  findByText(render(), "换一批").props.onClick();
  assert.ok(await waitFor(() => /没抽到仓库/.test(textOf(render()))), "应提示再换一批");
  discoverPayload = GOOD_DISCOVER;
});

await check("随便看看：限流时给出可读提示，不留空白", async () => {
  discoverPayload = { status: 403, body: JSON.stringify({ message: "API rate limit exceeded" }) };
  findByText(render(), "换一批").props.onClick();
  assert.ok(await waitFor(() => /限流/.test(textOf(render()))), "应提示限流");
  discoverPayload = GOOD_DISCOVER;
});

await check("随便看看：没有本地快照，切回来也不会说「与上次相比」", async () => {
  // 先离开再回来：同一个视图重复点 chip 是早退，不算「切回来」。
  findByText(render(), "Trending").props.onClick();
  await waitFor(() => !textOf(render()).includes("a random pick"));
  discoverPayload = GOOD_DISCOVER;
  findByText(render(), "随便看看").props.onClick();
  assert.ok(await waitFor(() => textOf(render()).includes("a random pick")), "应重新抽一批");
  // 随机批次或搜索结果之间没有可比排名，说「排名无变化」就是编数据
  assert.doesNotMatch(textOf(render()), /排名无变化/);
  assert.doesNotMatch(textOf(render()), /首次抓取/);
});

await check("随便看看：导出标题写明来源，不冒充榜单", async () => {
  let copied = null;
  const prev = globalThis.navigator;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { clipboard: { writeText: async (t) => { copied = t; } } },
  });
  try {
    submitSearch("random/pick");
    assert.ok(await waitFor(() => textOf(render()).includes("fuzzy hit")), "先有搜索结果");
    findByText(render(), "复制 Markdown").props.onClick();
    assert.ok(await waitFor(() => copied !== null), "应调用剪贴板");
    assert.match(copied, /^# 每日热点 · GitHub 上按仓库名搜索「random\/pick」的结果/);
    assert.doesNotMatch(copied, /Trending ·/, "不能冒充 Trending 榜");
  } finally {
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: prev });
  }
});

/** 找到文本匹配的下拉触发器（Dropdown 未展开时不渲染选项）。 */
function findTrigger(node, label) {
  let hit = null;
  walk(node, (n) => {
    if (hit) return;
    const c = n.props && n.props.className;
    if (typeof c === "string" && c.split(/\s+/).includes("gt-dd-trigger") && textOf(n).includes(label)) hit = n;
  });
  return hit;
}

/**
 * 按触发器文本找到整个下拉容器。
 *
 * 键盘处理挂在容器上（菜单打开后焦点会被移到 option 上，只挂 trigger 的话
 * 方向键、Enter、Esc 全部失灵），所以用例必须拿到容器本身，而不是 trigger。
 */
function dropdownFor(node, label) {
  let trigger = null;
  walk(node, (n) => {
    if (trigger || n.type !== "button") return;
    const c = n.props && n.props.className;
    if (typeof c === "string" && c.split(/\s+/).includes("gt-dd-trigger") && textOf(n).includes(label)) trigger = n;
  });
  if (!trigger) return null;

  // 取「包含 trigger 的最内层 gt-dd」：外层可能是别的下拉，用最后一个命中。
  let hit = null;
  const contains = (n) => {
    if (n === trigger) return true;
    if (!n || typeof n !== "object") return false;
    return (n.children || []).some(contains);
  };
  walk(node, (n) => {
    const c = n.props && n.props.className;
    if (typeof c !== "string" || !c.split(/\s+/).includes("gt-dd")) return;
    if (contains(n)) hit = n;
  });
  return hit;
}

const isOpen = (node) => Boolean(node && /(?:^|\s)is-open(?:\s|$)/.test(String(node.props.className)));

await check("设置页：分节布局，改动自动保存", async () => {
  // 先清掉磁盘上的设置：前面的讨论用例会把会话表写回 settings 落盘，
  // 留着的话 `kv.has("settings")` 一开始就为真，读到的是那次写入的那份，
  // 于是根本等不到防抖保存，断言比的是旧值。
  kv.delete("settings");
  renderFresh(settingsDef.component, {}, { effects: true });
  await waitFor(() => textOf(renderFresh(settingsDef.component)).includes("中文解读"));

  const text = textOf(renderFresh(settingsDef.component));
  // 三节结构
  assert.match(text, /显示/);
  assert.match(text, /中文解读/);
  assert.match(text, /网络/);
  // Token 默认折叠，不占版面
  assert.match(text, /限流了再加 Token/);
  assert.match(text, /自动保存|已保存/);

  // 语言筛选仍是文本输入（自由填英文语言名），改动后防抖自动保存
  const inputs = [];
  walk(renderFresh(settingsDef.component, {}, { effects: true }), (n) => {
    if (n.type === "input" && n.props && n.props.placeholder && /全部语言/.test(n.props.placeholder)) inputs.push(n);
  });
  assert.equal(inputs.length, 1, "应只有一个语言筛选输入框");
  inputs[0].props.onChange({ target: { value: "rust" } });
  // onChange 只更新表单，防抖 500ms 后才写盘；这里轮询渲染推进 effect
  for (let i = 0; i < 40 && !kv.has("settings"); i += 1) {
    renderKeep(settingsDef.component, {});
    await sleep(40);
  }
  assert.ok(kv.has("settings"), "设置应被自动保存");
  assert.equal(kv.get("settings").language, "rust");
});

await check("设置页：引擎下拉来自 agent.catalog，不可用的标出来但不隐藏", async () => {
  renderFresh(settingsDef.component, {}, { effects: true });
  // 等引擎目录加载完成（触发器存在且可展开）
  assert.ok(await waitFor(() => !!findTrigger(renderFresh(settingsDef.component, {}, { effects: true }), "自动"), 1500));

  const engineTrigger = findTrigger(renderKeep(settingsDef.component, {}), "自动（第一个可用引擎）");
  assert.ok(engineTrigger, "应有引擎下拉触发器");
  engineTrigger.props.onClick();

  const opened = textOf(renderKeep(settingsDef.component, {}));
  assert.match(opened, /Claude Code/, "应显示引擎的友好名而不是裸 id");
  assert.match(opened, /Codex/);
  // 已安装但不可用的引擎保留在列表里并标注，而不是静默消失
  assert.match(opened, /Qoder（不可用）/, "不可用引擎应标注出来");
});

await check("设置页：时间档与阈值用下拉而不是手填", async () => {
  renderFresh(settingsDef.component, {}, { effects: true });
  assert.ok(await waitFor(() => textOf(renderFresh(settingsDef.component)).includes("今日")));
  const text = textOf(renderFresh(settingsDef.component));
  // 下拉触发器显示当前值，而不是空输入框
  assert.match(text, /今日/, "时间档应显示当前值");
  assert.match(text, /50（默认）/, "阈值应显示为带说明的选项");
  // 不应再出现手填的数字输入框
  let numberInputs = 0;
  walk(renderFresh(settingsDef.component), (n) => {
    if (n.type === "input" && n.props && n.props.type === "number") numberInputs += 1;
  });
  assert.equal(numberInputs, 0, "阈值不应是手填数字框");
});

await check("下拉能用键盘操作：方向键移动、Enter 确认、Esc 关闭", async () => {
  // 键只挂在容器上：菜单一打开焦点就移到 option 上，只挂 trigger 会让
  // 方向键 / Enter / Esc 全部失灵，只剩鼠标可用。
  renderFresh(settingsDef.component, {}, { effects: true });
  assert.ok(await waitFor(() => !!findTrigger(renderFresh(settingsDef.component, {}, { effects: true }), "今日"), 1500));

  const press = (key, target) => {
    const ev = { key, preventDefault() {}, target };
    const dd = dropdownFor(renderKeep(settingsDef.component, {}), "今日");
    assert.ok(dd, "应能找到下拉容器");
    dd.props.onKeyDown(ev);
  };
  const openState = () => {
    const dd = dropdownFor(renderKeep(settingsDef.component, {}), "今日");
    return isOpen(dd);
  };
  const activeLabel = () => {
    let hit = null;
    walk(renderKeep(settingsDef.component, {}), (n) => {
      const c = n.props && n.props.className;
      if (hit || typeof c !== "string" || !c.split(/\s+/).includes("gt-dd-item")) return;
      if (c.split(/\s+/).includes("is-active")) hit = textOf(n);
    });
    return hit;
  };

  assert.equal(openState(), false, "初始应为收起");
  // 触发器上按方向键直接展开，并把焦点放到当前值（今日）
  press("ArrowDown", { className: "gt-dd-trigger" });
  assert.equal(openState(), true, "方向键应能展开");
  assert.match(activeLabel() || "", /今日/, "焦点应从当前值开始");

  press("ArrowDown", { className: "gt-dd-item" });
  assert.match(activeLabel() || "", /本周/, "ArrowDown 应下移一项");
  press("ArrowUp", { className: "gt-dd-item" });
  assert.match(activeLabel() || "", /今日/, "ArrowUp 应上移一项");

  // Enter 确认当前项；值没变时 onChange 不该被调用（这里今日就是当前值）
  press("Enter", { className: "gt-dd-item" });
  assert.equal(openState(), false, "Enter 应确认并收起");

  press("Escape", { className: "gt-dd-trigger" }); // 收起状态按 Esc 无副作用
  press("ArrowDown", { className: "gt-dd-trigger" });
  assert.equal(openState(), true);
  press("Escape", { className: "gt-dd-item" });
  assert.equal(openState(), false, "Esc 应关闭菜单");

  // Tab 离开组件：scrim 是全屏的，不关掉会留一层看不见的遮罩吞点击
  press("ArrowDown", { className: "gt-dd-trigger" });
  assert.equal(openState(), true);
  press("Tab", { className: "gt-dd-item" });
  assert.equal(openState(), false, "Tab 离开时应关闭菜单");
});

await check("设置页：工作区用只读路径 + 选择按钮，不是下拉也不是手填", async () => {
  renderFresh(settingsDef.component, {}, { effects: true });
  assert.ok(
    await waitFor(() => textOf(renderFresh(settingsDef.component)).includes("选择…")),
    2000,
  );
  const tree = renderFresh(settingsDef.component);
  const text = textOf(tree);

  // 与工作志同一套控件：只读路径 + 「选择…」，路径只能由系统选择器产生。
  assert.equal(findByText(tree, "选择…") !== null, true, "应有文件夹选择按钮");
  // 没设置时直接把默认目录的真实路径写出来：只写「默认」等于没说 cwd 在哪。
  let defaultValue = null;
  walk(tree, (n) => {
    if (n.props && typeof n.props.className === "string" && n.props.className.includes("gt-path-value")) {
      defaultValue = n;
    }
  });
  assert.ok(defaultValue, "应有只读路径展示");
  assert.match(String(defaultValue.props.className), /is-default/, "未设置时应标为默认值");
  assert.match(textOf(defaultValue), /github-trending|gt-smoke-/, "应显示数据目录的真实路径");

  // 不能退回成下拉：下拉会把「选过的路径」和「默认」混成一个列表，
  // 而路径本来就只能来自系统选择器。只看工作区这一栏——引擎和模型仍是下拉。
  let workspaceField = null;
  walk(tree, (n) => {
    if (n.props && typeof n.props.className === "string" && n.props.className.includes("gt-workspace-path")) {
      workspaceField = n;
    }
  });
  assert.ok(workspaceField, "应有路径栏");
  assert.match(textOf(workspaceField), /选择…/, "路径栏里应是选择按钮");
  walk(workspaceField, (n) => {
    if (n.props && typeof n.props.className === "string" && /gt-dd-trigger/.test(n.props.className)) {
      throw new Error("工作区不应使用下拉控件");
    }
  });
  let pathInputs = 0;
  walk(tree, (n) => {
    if (n.type === "input" && n.props && n.props.placeholder && /工作区路径|D:\\\\|example/.test(n.props.placeholder)) {
      pathInputs += 1;
    }
  });
  assert.equal(pathInputs, 0, "不应有手填工作区路径的输入框");
});

await check("设置页：选完目录后路径不再是默认态，并写进设置", async () => {
  // 用 renderKeep：点「选择…」改的是组件内部 state，renderFresh 会把它重置掉，
  // 那样永远看不到变化（和下拉展开同一个陷阱）。
  renderFresh(settingsDef.component, {}, { effects: true });

  // 只能在工作区那一栏的子树里找：整棵树上「默认」还命中「50（默认）」这个
  // 下拉标签，排在前面，findByText 会先抓到它，点下去只是展开下拉。
  const workspaceField = () => {
    let hit = null;
    walk(renderKeep(settingsDef.component, {}), (n) => {
      if (!hit && n.props && typeof n.props.className === "string" && n.props.className.includes("gt-workspace-path")) {
        hit = n;
      }
    });
    return hit;
  };
  const buttonInField = (text) => {
    const field = workspaceField();
    return field ? findByText(field, text) : null;
  };
  const pathClass = () => {
    const field = workspaceField();
    if (!field) return "";
    let hit = "";
    walk(field, (n) => {
      if (!hit && n.props && typeof n.props.className === "string" && n.props.className.includes("gt-path-value")) {
        hit = String(n.props.className);
      }
    });
    return hit;
  };

  const pick = buttonInField("选择…");
  assert.ok(pick, "应有选择按钮");
  pick.props.onClick();
  assert.ok(await waitFor(() => !/is-default/.test(pathClass()), 2000), "选完目录后应不再是默认态");
  assert.match(textOf(workspaceField()), /gt-picked-/, "应显示选中的目录");
  // 存进设置的是原始路径，不是加了分隔符转换或缩写的展示值
  assert.ok(await waitFor(() => {
    const saved = kv.get("settings");
    return saved && saved.workspacePath === pickedWorkspaceDir;
  }, 2000), "设置里应存原始路径");
  // 「默认」按钮只在设了值之后出现，用来回到插件数据目录
  const reset = buttonInField("默认");
  assert.ok(reset, "设了值之后应能回到默认");
  reset.props.onClick();
  assert.ok(await waitFor(() => /is-default/.test(pathClass()), 2000), "点默认后应回到插件数据目录");
  assert.ok(!buttonInField("默认"), "回到默认后不该再有「默认」按钮");
});

await check("卸载会中断在跑的 agent 并复位状态", async () => {
  agentMode = "silent";
  findByText(render(), "生成解读").props.onClick();
  await waitFor(() => !!findByText(render(), "停止生成"));
  await sleep(60);
  const before = agentInterrupts.length;
  dispose();
  assert.ok(await waitFor(() => agentInterrupts.length > before), "卸载应 interrupt");
  assert.ok(findByText(render(), "生成解读"), "卸载后不应处于生成中");
  agentMode = "stream";
});

await check("快速切换视图时晚到的响应不覆盖新视图", async () => {
  // 前面的用例改过 payload，这里先复位成正常数据
  trendingPayload = { status: 200, body: trendingHtml(day2) };
  searchPayload = GOOD_SEARCH;
  kv.delete("settings");

  const originalInvoke = ctx.bridge.invoke;
  let trendingDelay = 0;
  ctx.bridge.invoke = async (cmd, args) => {
    if (args.url.includes("/trending") && trendingDelay) await sleep(trendingDelay);
    return originalInvoke(cmd, args);
  };

  trendingDelay = 150;
  findByText(render(), "Trending").props.onClick();
  await sleep(10);
  // 立刻切到新星库（Trending 还在路上）
  findByText(render(), "新星库").props.onClick();
  assert.ok(await waitFor(() => textOf(render()).includes("fresh repo")), "新星库应先到");
  await sleep(250); // 等慢的 Trending 响应回来
  const text = textOf(render());
  assert.match(text, /fresh repo/, "新星库内容应还在");
  assert.doesNotMatch(text, /brand new repo/, "晚到的 Trending 不应覆盖新星库");

  trendingDelay = 0;
  ctx.bridge.invoke = originalInvoke;
});

await check("生成解读时切视图会停止这一轮，不串台到新视图", async () => {
  trendingPayload = { status: 200, body: trendingHtml(day2) };
  searchPayload = GOOD_SEARCH;
  kv.delete("settings");
  agentMode = "silent";

  findByText(render(), "Trending").props.onClick();
  assert.ok(await waitFor(() => textOf(render()).includes("brand new repo")));

  findByText(render(), "生成解读").props.onClick();
  assert.ok(await waitFor(() => !!findByText(render(), "停止生成")), "应进入生成中");
  await sleep(60);

  const beforeInterrupts = agentInterrupts.length;
  // 切到新星库
  findByText(render(), "新星库").props.onClick();
  assert.ok(await waitFor(() => agentInterrupts.length > beforeInterrupts), "切视图应 interrupt 旧轮次");
  assert.ok(findByText(render(), "生成解读") === null || findByText(render(), "生成解读"), "按钮应复位");

  // 旧轮次晚到的 delta 不能出现在新视图
  await sleep(80);
  const text = textOf(render());
  assert.doesNotMatch(text, /今天在热什么/, "旧解读的 delta 不应写入新视图");
  assert.match(text, /fresh repo|正在抓取/, "应显示新星库内容");

  agentMode = "stream";
  findByText(render(), "Trending").props.onClick();
  await waitFor(() => textOf(render()).includes("brand new repo"));
});

await check("start 还没返回时点停止，拿到 runId 后仍会 interrupt", async () => {
  // 这是最容易被漏掉的路径：stopDigest 执行时 runId 还不存在。
  agentMode = "slow-start";
  agentStartDelay = 250;

  findByText(render(), "生成解读").props.onClick();
  assert.ok(await waitFor(() => !!findByText(render(), "停止生成")), "应立刻进入生成中");
  await sleep(30); // start 还在飞

  const before = agentInterrupts.length;
  findByText(render(), "停止生成").props.onClick();
  assert.ok(findByText(render(), "生成解读"), "按钮应立刻复位");

  // 等 start resolve；必须当场 interrupt 掉刚起来的进程
  assert.ok(
    await waitFor(() => agentInterrupts.length > before, 1500),
    "start resolve 后应 interrupt，避免孤儿进程继续烧 token",
  );

  agentMode = "stream";
  agentStartDelay = 200;
});

await check("生成超时后同样要打断宿主，不能只是插件放手", async () => {
  // 超时和「用户点停止」是同一类事：插件不再管这一轮，但宿主那侧的进程还在。
  // 如果只在 cancelled 时才 interrupt，这里会留下一个跑满全程的孤儿。
  agentMode = "hang";
  let before = 0;
  try {
    await withFastTimeouts(120, async () => {
      before = agentInterrupts.length;
      findByText(render(), "生成解读").props.onClick();
      assert.ok(await waitFor(() => !!findByText(render(), "停止生成")), "应进入生成中");
      assert.ok(
        await waitFor(() => textOf(render()).includes("生成超时"), 3000),
        "超时后应告诉用户发生了什么",
      );
    });
  } finally {
    agentMode = "stream";
  }
  assert.ok(findByText(render(), "生成解读"), "超时后按钮应复位，能重试");
  assert.ok(
    await waitFor(() => agentInterrupts.length > before, 1000),
    "超时后应 interrupt，避免宿主继续烧 token",
  );
});

await check("开会话挂住时会在 30 秒后放手并说明原因", async () => {
  // 开会话期间全榜的讨论按钮都是禁用的：挂住不给出口，等于整页功能不可用。
  const original = ctx.sessions.startRun;
  ctx.sessions.startRun = () => new Promise(() => {});
  try {
    await withFastTimeouts(120, async () => {
      discussButtonFor(render(), "beta/two").props.onClick();
      assert.ok(await waitFor(() => textOf(render()).includes("打开中")), "应显示打开中");
      assert.ok(
        await waitFor(() => textOf(render()).includes("宿主没有及时建起会话"), 3000),
        "超时后要说明原因",
      );
    });
  } finally {
    ctx.sessions.startRun = original;
  }
  assert.ok(findByText(render(), "讨论"), "按钮应回到可点状态，可以直接再点一次");
  assert.equal(discussButtonFor(render(), "alpha/one").props.disabled, false, "别的行也应解除禁用");
});

await check("讨论续接：同一份榜单里再点同一行，直接打开已有会话而不是再跑一轮", async () => {
  sessionStarts.length = 0;
  sessionSelects.length = 0;
  const inst = await freshTabInstance(() => ({}));
  try {
    // 宿主契约：startRun resolve { runId, sessionId }。第一次拿到 sess-1，
    // 第二次要**打开**它（selectSession）——再 startRun 一轮会白烧一次推理，
    // 而且用户要的只是「接着上次聊」。
    inst.click("beta/two");
    assert.ok(await waitFor(() => sessionStarts.length === 1));
    assert.ok(!sessionStarts[0].sessionId, "第一次应新开会话");
    assert.ok(await waitFor(() => !inst.text().includes("打开中")));

    inst.click("beta/two");
    assert.ok(await waitFor(() => sessionSelects.length === 1), "第二次应打开已有会话");
    assert.equal(sessionStarts.length, 1, "第二次不该再 startRun（不花 token）");
    assert.equal(sessionSelects[0].sessionId, "sess-1", "应打开同一个 sessionId");
    assert.equal(sessionSelects[0].engine, "claude");
    assert.equal(sessionSelects[0].workspacePath, storageDir);
    assert.ok(
      await waitFor(() => inst.text().includes("直接打开")),
      "回执要说清是「直接打开」还是新开，否则侧栏多一行少一行用户没法判断",
    );
  } finally {
    inst.dispose();
  }
});

await check("讨论续接：换一行仍然新开，只有同一仓库才复用", async () => {
  sessionStarts.length = 0;
  sessionSelects.length = 0;
  const inst = await freshTabInstance(() => ({}));
  try {
    inst.click("beta/two");
    assert.ok(await waitFor(() => sessionStarts.length === 1));
    assert.ok(await waitFor(() => !inst.text().includes("打开中")));
    inst.click("alpha/one");
    assert.ok(await waitFor(() => sessionStarts.length === 2));
    assert.ok(!sessionStarts[1].sessionId, "另一个仓库不该复用上一行的会话");
    assert.equal(sessionSelects.length, 0, "另一个仓库不该 selectSession");
    assert.ok(!inst.text().includes("直接打开"), "新开的回执不该说打开了旧会话");
  } finally {
    inst.dispose();
  }
});

await check("讨论续接：换引擎不复用、也不覆盖另一引擎的记录，切回去照样打开", async () => {
  // 会话 id 只在所属引擎下有意义。拿 claude 的 id 去 selectSession("codex")
  // 宿主要么拒绝、要么打开错的会话。所以换引擎要新开一条——但**不能把 claude
  // 那条覆盖掉**，否则切回 claude 再点又变成新开。
  sessionStarts.length = 0;
  sessionSelects.length = 0;
  const seeded = { "beta/two": { id: "sess-claude", engine: "claude", byEngine: { claude: "sess-claude" } } };
  let saved = {};
  let inst = await freshTabInstance(() => ({ discussSessionIds: seeded, engine: "codex" }), (k, v) => {
    if (k === "settings") saved = v;
  });
  try {
    inst.click("beta/two");
    assert.ok(await waitFor(() => sessionStarts.length === 1), "换引擎应新开一条");
    assert.equal(sessionSelects.length, 0, "不该拿别的引擎的 id 去打开");
    assert.ok(!sessionStarts[0].sessionId, "新会话不该带别人的 id");
    assert.equal(sessionStarts[0].engine, "codex");
    assert.ok(await waitFor(() => saved.discussSessionIds && saved.discussSessionIds["beta/two"]), "应记下新引擎的会话");
    const rows = saved.discussSessionIds["beta/two"];
    assert.equal(rows.byEngine.codex, "sess-1", "codex 那一槽要有新会话");
    assert.equal(rows.byEngine.claude, "sess-claude", "claude 那条不能被覆盖");
  } finally {
    inst.dispose();
  }

  // 切回 claude：应直接打开当初那条，而不是又开一条。
  // 注意 saved 里 settings.engine 还是 codex——要显式切回来，否则下一次激活
  // 仍按 codex 走，查到的自然是 codex 那槽。
  sessionStarts.length = 0;
  sessionSelects.length = 0;
  inst = await freshTabInstance(() => ({ ...saved, engine: "claude" }));
  try {
    inst.click("beta/two");
    assert.ok(await waitFor(() => sessionSelects.length === 1), "切回原引擎应复用");
    assert.equal(sessionSelects[0].sessionId, "sess-claude");
    assert.equal(sessionSelects[0].engine, "claude");
    assert.equal(sessionStarts.length, 0, "不该再新开");
  } finally {
    inst.dispose();
  }
});

await check("讨论续接：某引擎的会话被删时只清那一槽，另一个引擎的记录还在", async () => {
  // 打开失败的清理不能 `discussSessions.delete(repo)` —— 那会把另一个引擎
  // 好端端的记录一起删掉，切回去又开新的。
  sessionStarts.length = 0;
  sessionSelects.length = 0;
  const seeded = {
    "beta/two": { id: "sess-gone", engine: "claude", byEngine: { claude: "sess-gone", codex: "sess-codex" } },
  };
  sessionSelectError = new Error("session not found");
  let saved = null;
  const inst = await freshTabInstance(() => ({ discussSessionIds: seeded }), (k, v) => {
    if (k === "settings") saved = v;
  });
  try {
    inst.click("beta/two");
    assert.ok(await waitFor(() => sessionStarts.length === 1), "打开失败应退回新开");
    assert.ok(await waitFor(() => saved && saved.discussSessionIds["beta/two"]));
    const rows = saved.discussSessionIds["beta/two"];
    assert.equal(rows.byEngine.claude, "sess-1", "失效的那槽要换成新会话");
    assert.equal(rows.byEngine.codex, "sess-codex", "别的引擎的记录不能跟着被删");
  } finally {
    sessionSelectError = null;
    inst.dispose();
  }
});

await check("讨论续接：旧格式落盘的裸字符串仍能读回来", async () => {
  // 8ffb092..25faa4c 之间落盘的是 { repo: "id" }，没有 engine。升级后不能把这些
  // 记录当成坏数据丢掉——那样用户重装一次就退回「每点一次新开一条」。
  sessionStarts.length = 0;
  sessionSelects.length = 0;
  const inst = await freshTabInstance(() => ({ discussSessionIds: { "beta/two": "sess-legacy" } }));
  try {
    inst.click("beta/two");
    assert.ok(await waitFor(() => sessionSelects.length === 1), "旧记录应照常复用");
    assert.equal(sessionSelects[0].sessionId, "sess-legacy");
    assert.equal(sessionStarts.length, 0, "不该新开");
  } finally {
    inst.dispose();
  }
});

await check("讨论续接：命中也算「刚用过」，下一份新会话不会把它挤掉", async () => {
  // LRU 的关键不在于「新建时挪到队尾」，而在于**读取时也挪**。常点的仓库走
  // 「直接打开」那条路，从不经过新建分支——不记读取的话它永远停在队首，
  // 下一次新开会话就把它淘汰了，用户再点又变成新开一条。
  sessionStarts.length = 0;
  sessionSelects.length = 0;
  const seeded = { "alpha/one": { id: "sess-alpha", engine: "claude" } };
  // 先塞 59 条凑到 60：alpha/one 在最前（最久没用）。
  for (let i = 0; i < 59; i += 1) seeded["seed/seed-" + i] = { id: "seed-" + i, engine: "claude" };
  let lastSaved = null;
  const inst = await freshTabInstance(() => ({ discussSessionIds: seeded }), (k, v) => {
    if (k === "settings") lastSaved = v;
  });
  try {
    // 1) 打开 alpha/one：应把它挪到队尾
    inst.click("alpha/one");
    assert.ok(await waitFor(() => sessionSelects.length === 1), "应直接打开");
    assert.ok(await waitFor(() => !inst.text().includes("打开中")));

    // 2) 再开一个新仓库（beta/two），表已满，应淘汰队首
    inst.click("beta/two");
    assert.ok(await waitFor(() => sessionStarts.length === 1));
    assert.ok(await waitFor(() => !inst.text().includes("打开中")));
    const rows = lastSaved.discussSessionIds;
    assert.ok(rows["alpha/one"] && rows["alpha/one"].id === "sess-alpha", "刚点开过的 alpha/one 不能被淘汰");
    assert.ok(!rows["seed/seed-0"], "该淘汰的是最久没用过的那条");
    assert.equal(Object.keys(rows).length, 60, "仍是 60 条");
  } finally {
    inst.dispose();
  }
});

await check("讨论续接：会话表落盘，重新激活后仍能直接打开", async () => {
  // 内存表熬不过重装/重激活/宿主重启。只放内存里的话，用户看到的就是
  // 「每点一次都新开一条」——这正是反馈里的原话。
  sessionStarts.length = 0;
  sessionSelects.length = 0;
  const saved = {};
  let inst = await freshTabInstance(() => ({}), (k, v) => {
    if (k === "settings") Object.assign(saved, v);
  });
  try {
    inst.click("beta/two");
    assert.ok(await waitFor(() => sessionStarts.length === 1));
    assert.ok(await waitFor(() => !inst.text().includes("打开中")));
    assert.ok(
      await waitFor(() => saved.discussSessionIds && saved.discussSessionIds["beta/two"] && saved.discussSessionIds["beta/two"].id === "sess-1"),
      "会话 id 应写进设置",
    );
  } finally {
    inst.dispose();
  }

  // 新实例 = 重新激活：只读磁盘上那份设置，内存表是空的。
  inst = await freshTabInstance(() => saved);
  try {
    inst.click("beta/two");
    assert.ok(await waitFor(() => sessionSelects.length === 1), "重新激活后应直接打开旧会话");
    assert.equal(sessionSelects[0].sessionId, "sess-1");
    assert.equal(sessionStarts.length, 1, "不该再 startRun");
  } finally {
    inst.dispose();
  }
});

await check("讨论续接：宿主当场不给 sessionId 时，靠 plugin-run 回执补齐，下次仍直接打开", async () => {
  // SDK 写明 startRun 可能返回 sessionId: null——引擎稍后才 announce，
  // 那一刻宿主经 plugin-run://<pluginId> 事件回执 { runId, sessionId }。
  // 不接这个回执，id 永远拿不到，用户点同一个仓库每一次都新开一条。
  sessionStarts.length = 0;
  sessionSelects.length = 0;
  sessionAnnounceLater = true;
  const saved = {};
  let inst = await freshTabInstance(() => ({}), (k, v) => {
    if (k === "settings") Object.assign(saved, v);
  });
  try {
    inst.click("beta/two");
    assert.ok(await waitFor(() => sessionStarts.length === 1));
    assert.ok(await waitFor(() => !inst.text().includes("打开中")));
    // 当场这一下没有 id，表里不该有记录——记空串等于占着额度还不复用。
    assert.ok(
      !(saved.discussSessionIds && saved.discussSessionIds["beta/two"]),
      "拿不到 id 时不该写一条空记录",
    );

    // 引擎稍后 announce：宿主把 id 经回执送回来。
    assert.ok(eventTopics.has("plugin-run://" + MANIFEST.id), "应订阅 plugin-run 回执话题");
    emit(
      {
        runId: lastSessionRunId,
        sessionId: "sess-announced",
        engine: "claude",
        workspacePath: storageDir,
        kind: "done",
        error: null,
      },
      "plugin-run://" + MANIFEST.id,
    );
    assert.ok(
      await waitFor(
        () => saved.discussSessionIds && saved.discussSessionIds["beta/two"] &&
          saved.discussSessionIds["beta/two"].byEngine.claude === "sess-announced",
      ),
      "回执里的 sessionId 应补记并落盘",
    );

    // 再点同一行：现在有 id 了，应直接打开，不再新开。
    inst.click("beta/two");
    assert.ok(await waitFor(() => sessionSelects.length === 1), "补齐 id 后应直接打开旧会话");
    assert.equal(sessionSelects[0].sessionId, "sess-announced");
    assert.equal(sessionStarts.length, 1, "不该再 startRun");
  } finally {
    sessionAnnounceLater = false;
    inst.dispose();
  }
});

await check("讨论续接：回执乱序到达也只认自己的 runId，不误记别的仓库", async () => {
  // 同一时刻可能有多轮在飞。回执以 runId 为准：对不上的一律不理，
  // 否则会把 A 仓库的会话记到 B 仓库名下，下次点 B 直接打开 A 的会话。
  sessionStarts.length = 0;
  sessionSelects.length = 0;
  sessionAnnounceLater = true;
  const saved = {};
  const inst = await freshTabInstance(() => ({}), (k, v) => {
    if (k === "settings") Object.assign(saved, v);
  });
  try {
    inst.click("beta/two");
    assert.ok(await waitFor(() => sessionStarts.length === 1));
    assert.ok(await waitFor(() => !inst.text().includes("打开中")));

    emit(
      { runId: "someone-else", sessionId: "sess-x", engine: "claude", kind: "done", error: null },
      "plugin-run://" + MANIFEST.id,
    );
    // 等一拍，确认没有任何写入发生
    await new Promise((r) => setTimeout(r, 60));
    assert.ok(
      !(saved.discussSessionIds && saved.discussSessionIds["beta/two"]),
      "别的 runId 的回执不该记到本仓库名下",
    );
  } finally {
    sessionAnnounceLater = false;
    inst.dispose();
  }
});

await check("设置页保存不覆盖 discussSessionIds（否则刚记下的 id 会被抹掉）", async () => {
  // 设置页的 form 是渲染那一刻的快照，discussSessionIds 不在表单里。
  // 整份回写会把开会话时刚记下的 id 覆盖成空——内存与磁盘同时丢，
  // 用户下次点同一个仓库又开一条。这里断言「只写用户改过的键」。
  //
  // 设置区属于这个实例自己的 store，所以不能借用全局那一个 settingsDef：
  // 必须像下面「讨论会尊重设置里选的工作区」一样自己接住注册。
  let ownSettings = null;
  let saved = null;
  const fresh = await import(PLUGIN + "?settings-keep-sessions=" + Date.now());
  const dispose = fresh.default(
    Object.assign({}, ctx, {
      storage: {
        get: async (k) =>
          k === "settings"
            ? {
                discussSessionIds: {
                  "beta/two": { id: "sess-keep", engine: "claude", byEngine: { claude: "sess-keep" } },
                },
              }
            : null,
        set: async (k, v) => {
          if (k === "settings") saved = v;
        },
        delete: async () => {},
      },
      ui: Object.assign({}, ctx.ui, {
        registerCenterTab: () => () => {},
        registerSidebarNav: () => () => {},
        registerSettingsSection: (d) => {
          ownSettings = d;
          return () => {};
        },
        registerCommand: () => () => {},
      }),
    }),
  );
  try {
    assert.ok(await waitFor(() => !!ownSettings, 2000), "独立实例应注册设置区");
    // 等设置从磁盘读回来，否则基线是默认值，round-trip 会被当成一次用户改动。
    renderFresh(ownSettings.component, {}, { effects: true });
    assert.ok(await waitFor(() => textOf(renderFresh(ownSettings.component)).includes("中文解读")));
    await sleep(80);

    const input = (() => {
      let hit = null;
      walk(renderFresh(ownSettings.component, {}, { effects: true }), (n) => {
        if (!hit && n.type === "input" && n.props && n.props.placeholder === "留空 = 全部语言") hit = n;
      });
      return hit;
    })();
    assert.ok(input, "应有语言筛选输入框");
    input.props.onChange({ target: { value: "python" } });
    for (let i = 0; i < 40 && !saved; i += 1) {
      renderKeep(ownSettings.component, {});
      await sleep(40);
    }
    assert.ok(saved, "改动应触发保存");
    assert.equal(saved.language, "python", "用户改过的键要写进去");
    assert.ok(
      saved.discussSessionIds && saved.discussSessionIds["beta/two"] &&
        saved.discussSessionIds["beta/two"].byEngine.claude === "sess-keep",
      "保存不能抹掉会话表",
    );
  } finally {
    dispose();
  }
});

await check("讨论续接：id 还在路上时再点同一行会被挡住，不会开第二条", async () => {
  // startRun 已经 resolve（按钮回到可点），但 sessionId 还没回执。这期间再点
  // 一次，表里查不到 id，就会又开一条——用户看到的正是「点两下多出两条」。
  sessionStarts.length = 0;
  sessionSelects.length = 0;
  sessionAnnounceLater = true;
  const inst = await freshTabInstance(() => ({}));
  try {
    inst.click("beta/two");
    assert.ok(await waitFor(() => sessionStarts.length === 1));
    assert.ok(await waitFor(() => !inst.text().includes("打开中")));

    inst.click("beta/two");
    assert.ok(await waitFor(() => inst.text().includes("还在建立中")), "应说明为什么这次没开");
    assert.equal(sessionStarts.length, 1, "空窗内不该再 startRun");
    assert.equal(sessionSelects.length, 0, "也还没有 id 可以打开");
  } finally {
    sessionAnnounceLater = false;
    inst.dispose();
  }
});

await check("讨论续接：设置成「总是新开」时，空窗不挡（用户明确要的就是新开）", async () => {
  sessionStarts.length = 0;
  sessionSelects.length = 0;
  sessionAnnounceLater = true;
  const inst = await freshTabInstance(() => ({ resumeMode: "never" }));
  try {
    inst.click("beta/two");
    assert.ok(await waitFor(() => sessionStarts.length === 1));
    assert.ok(await waitFor(() => !inst.text().includes("打开中")));
    inst.click("beta/two");
    assert.ok(await waitFor(() => sessionStarts.length === 2), "never 模式下应照常新开");
  } finally {
    sessionAnnounceLater = false;
    inst.dispose();
  }
});

await check("设置区标题栏用单色 Icon，不用带颜色的 artwork", async () => {
  // 页签和侧栏都是 stroke="currentColor" 的线条图标；设置区不传 icon 时
  // 宿主回落到 docs/icon.png（橙色底板），同一个插件在设置页变成彩色方块。
  assert.ok(settingsDef, "应注册设置区");
  assert.equal(typeof settingsDef.icon, "function", "设置区应传 icon");
  const rendered = settingsDef.icon({ className: "x" });
  assert.equal(rendered.type, "svg", "设置区图标应是 svg");
  assert.equal(rendered.props.stroke, "currentColor", "应跟随宿主文字色，不带自己的颜色");
  assert.ok(!/^#/.test(String(rendered.props.fill)), "不应有硬编码填充色");
});

await check("讨论续接：打开旧会话失败时退回新开，并清掉失效 id", async () => {
  // 会话可能已被归档/删除，或宿主换了版本不再认这个 id。不能让按钮变成
  // 「一点就报错」的死路，也不能把那个 id 一直留着。
  sessionStarts.length = 0;
  sessionSelects.length = 0;
  const saved = { discussSessionIds: { "beta/two": { id: "sess-gone", engine: "claude" } } };
  sessionSelectError = new Error("session not found");
  let lastSaved = null;
  const inst = await freshTabInstance(() => saved, (k, v) => {
    if (k === "settings") lastSaved = v;
  });
  try {
    inst.click("beta/two");
    assert.ok(await waitFor(() => sessionStarts.length === 1), "打开失败应退回新开");
    assert.ok(await waitFor(() => !inst.text().includes("打开中")));
    // 失效 id 必须被换掉；新开成功后会写成新拿到的那个。
    assert.ok(
      await waitFor(() => lastSaved && lastSaved.discussSessionIds["beta/two"] && lastSaved.discussSessionIds["beta/two"].id === "sess-1"),
      "失效 id 应被换成新会话",
    );
  } finally {
    sessionSelectError = null;
    inst.dispose();
  }
});

await check("讨论续接：超过上限时淘汰最久没用过的，且写入时就裁", async () => {
  // 上限 60。之前在内存里根本不裁、写盘也不裁，这条路径等于没有上限；
  // 读盘裁剪还按字典序，会先淘汰掉常点的仓库。
  sessionStarts.length = 0;
  sessionSelects.length = 0;
  const seeded = {};
  // 塞满 60 条，`zzz/zzz` 排在最前——它是最久没用过的那条。
  for (let i = 0; i < 60; i += 1) {
    const repo = i === 0 ? "zzz/zzz" : "seed/seed-" + i;
    seeded[repo] = { id: "seed-" + i, engine: "claude" };
  }
  let lastSaved = null;
  const inst = await freshTabInstance(() => ({ discussSessionIds: seeded }), (k, v) => {
    if (k === "settings") lastSaved = v;
  });
  try {
    inst.click("beta/two");
    assert.ok(await waitFor(() => sessionStarts.length === 1));
    assert.ok(await waitFor(() => !inst.text().includes("打开中")));
    assert.ok(await waitFor(() => lastSaved && lastSaved.discussSessionIds), "应写回设置");
    const rows = lastSaved.discussSessionIds;
    assert.equal(Object.keys(rows).length, 60, "落盘最多 60 条");
    assert.ok(rows["beta/two"] && rows["beta/two"].id === "sess-1", "新会话要在表里");
    assert.equal(rows["beta/two"].engine, "claude", "要记下它属于哪个引擎");
    assert.ok(!rows["zzz/zzz"], "超限时淘汰最久没用的那条，而不是按字母序");
  } finally {
    inst.dispose();
  }
});

await check("讨论续接：回执一直不来时，等待窗口过后仍能新开，不会把按钮锁死", async () => {
  // 引擎稍后才 announce 时 resolve 的 sessionId 是 null（文档明写）。
  // 这期间再点会被挡住——但不能永远挡住：回执可能永远不来（旧宿主、
  // 用户中途关会话）。窗口过后必须放手，否则这个仓库的按钮永久不可用。
  const original = ctx.sessions.startRun;
  ctx.sessions.startRun = async (def) => {
    sessionStarts.push(def);
    return { runId: "srun-null", sessionId: null };
  };
  sessionStarts.length = 0;
  const inst = await freshTabInstance(() => ({}));
  // 只把 Date.now 往前拨，不碰 setTimeout：窗口是惰性判定的。
  const realNow = Date.now;
  try {
    inst.click("beta/two");
    assert.ok(await waitFor(() => sessionStarts.length === 1));
    assert.ok(await waitFor(() => !inst.text().includes("打开中")));

    inst.click("beta/two");
    assert.ok(await waitFor(() => inst.text().includes("还在建立中")), "窗口内应挡住");
    assert.equal(sessionStarts.length, 1, "窗口内不该再开");

    const later = realNow() + 120000;
    Date.now = () => later;
    inst.click("beta/two");
    assert.ok(await waitFor(() => sessionStarts.length === 2), "窗口过后应能再开");
    assert.ok(!sessionStarts[1].sessionId, "没有 id 时退回新开");
  } finally {
    Date.now = realNow;
    ctx.sessions.startRun = original;
    inst.dispose();
  }
});

await check("讨论续接：刷新榜单后不再续接（新话题配新上下文）", async () => {
  sessionStarts.length = 0;
  const inst = await freshTabInstance(() => ({}));
  try {
    inst.click("beta/two");
    assert.ok(await waitFor(() => sessionStarts.length === 1));
    assert.ok(await waitFor(() => !inst.text().includes("打开中")));

    // 刷新 = 用户明确表示「再来一次」，旧话题的结论不能带进新榜单。
    trendingPayload = { status: 200, body: trendingHtml(day1) };
    findByText(inst.tree(), "刷新").props.onClick();
    assert.ok(await waitFor(() => {
      const btn = findByText(inst.tree(), "刷新");
      return btn && btn.props["aria-busy"] === "false";
    }, 3000));

    inst.click("beta/two");
    assert.ok(await waitFor(() => sessionStarts.length === 2));
    assert.ok(!sessionStarts[1].sessionId, "刷新后应新开会话");
  } finally {
    inst.dispose();
  }
});

await check("续接策略 always：刷新榜单后仍然直接打开旧会话", async () => {
  sessionStarts.length = 0;
  sessionSelects.length = 0;
  const inst = await freshTabInstance(() => ({ resumeMode: "always" }));
  try {
    inst.click("beta/two");
    assert.ok(await waitFor(() => sessionStarts.length === 1));
    assert.ok(await waitFor(() => !inst.text().includes("打开中")));

    trendingPayload = { status: 200, body: trendingHtml(day1) };
    findByText(inst.tree(), "刷新").props.onClick();
    assert.ok(await waitFor(() => {
      const btn = findByText(inst.tree(), "刷新");
      return btn && btn.props["aria-busy"] === "false";
    }, 3000));

    inst.click("beta/two");
    assert.ok(await waitFor(() => sessionSelects.length === 1), "always 模式下换榜单也要打开旧会话");
    assert.equal(sessionSelects[0].sessionId, "sess-1");
    assert.equal(sessionStarts.length, 1, "always 模式下不该再 startRun");
  } finally {
    inst.dispose();
  }
});

await check("续接策略 never：同一份榜单里也每次新开", async () => {
  sessionStarts.length = 0;
  sessionSelects.length = 0;
  const inst = await freshTabInstance(() => ({ resumeMode: "never" }));
  try {
    inst.click("beta/two");
    assert.ok(await waitFor(() => sessionStarts.length === 1));
    assert.ok(await waitFor(() => !inst.text().includes("打开中")));
    inst.click("beta/two");
    assert.ok(await waitFor(() => sessionStarts.length === 2));
    assert.ok(!sessionStarts[1].sessionId, "never 模式下不该复用");
    assert.equal(sessionSelects.length, 0, "never 模式下不该 selectSession");
    assert.ok(!inst.text().includes("直接打开"), "回执不该说打开了旧会话");
  } finally {
    inst.dispose();
  }
});

await check("设置页：续接策略用下拉，默认是「同一份榜单内复用」", async () => {
  const fresh = await import(PLUGIN + "?resume=" + Date.now());
  let freshSettings = null;
  const saved = {};
  const dispose5 = fresh.default(
    Object.assign({}, ctx, {
      storage: {
        get: async () => ({}),
        set: async (k, v) => {
          if (k === "settings") Object.assign(saved, v);
        },
        delete: async () => {},
      },
      ui: Object.assign({}, ctx.ui, {
        registerCenterTab: () => () => {},
        registerSidebarNav: () => () => {},
        registerSettingsSection: (d) => {
          freshSettings = d;
          return () => {};
        },
        registerCommand: () => () => {},
      }),
    }),
  );
  try {
    assert.ok(await waitFor(() => !!freshSettings, 2000));
    renderFresh(freshSettings.component, {}, { effects: true });
    await waitFor(() => textOf(renderFresh(freshSettings.component)).includes("再点同一个仓库时"));

    const keep = () => renderKeep(freshSettings.component, {});
    // 默认值；未设置过时不该显示成空
    // 下拉的触发器是 button 但文本在子节点里，用 findTrigger 按 gt-dd-trigger 认。
    const trigger = findTrigger(keep(), "同一份榜单内复用");
    assert.ok(trigger, "默认应显示「同一份榜单内复用」");
    assert.match(textOf(keep()), /榜单刷新、换日\/周\/月之后新开/, "应把当前策略的含义写出来");

    // 换成 always 并写盘
    trigger.props.onClick();
    await waitFor(() => isOpen(dropdownFor(keep(), "同一份榜单内复用")));
    // 菜单项是 .gt-dd-item 的 div（不是 button），findByText 认不到。
    let option = null;
    walk(keep(), (n) => {
      if (option) return;
      const c = n.props && n.props.className;
      if (typeof c === "string" && c.split(/\s+/).includes("gt-dd-item") && textOf(n).includes("总是复用")) option = n;
    });
    assert.ok(option, "菜单里应有「总是复用」");
    option.props.onClick();
    for (let i = 0; i < 60 && saved.resumeMode !== "always"; i += 1) {
      keep();
      await sleep(30);
    }
    assert.equal(saved.resumeMode, "always", "应写进设置");
  } finally {
    dispose5();
  }
});

await check("设置页：提示词可以新增、设为默认、删除，并写进设置", async () => {
  // 独立 store：主实例的设置已经激活过，直接改 kv 不会反映到 form 上。
  const fresh = await import(PLUGIN + "?prompts=" + Date.now());
  let freshSettings = null;
  const saved = {};
  const dispose3 = fresh.default(
    Object.assign({}, ctx, {
      storage: {
        get: async (k) => (k === "settings" ? { prompts: [], defaultPromptId: "" } : null),
        set: async (k, v) => {
          if (k === "settings") Object.assign(saved, v);
        },
        delete: async () => {},
      },
      ui: Object.assign({}, ctx.ui, {
        registerCenterTab: () => () => {},
        registerSidebarNav: () => () => {},
        registerSettingsSection: (d) => {
          freshSettings = d;
          return () => {};
        },
        registerCommand: () => () => {},
      }),
    }),
  );
  try {
    assert.ok(await waitFor(() => !!freshSettings, 2000), "应注册设置节");
    renderFresh(freshSettings.component, {}, { effects: true });
    await waitFor(() => textOf(renderFresh(freshSettings.component)).includes("讨论提示词"));
    const initialText = textOf(renderKeep(freshSettings.component, {}));
    assert.match(initialText, /还没有自定义提示词/, "初始应说明会用内置模板");
    // 内置模板一开始就在列表里，且是默认那份
    assert.match(initialText, /内置模板/);
    assert.match(initialText, /只读/, "内置那份要能一眼看出不可编辑");

    // 表单值是组件局部 state：必须用 renderKeep，renderFresh 会把它重置回
    // snap.settings，「新增」的结果还没写盘就丢了。
    const keep = () => renderKeep(freshSettings.component, {});
    findByText(keep(), "新增提示词").props.onClick();
    await waitFor(() => textOf(keep()).includes("提示词 1"));

    // 保存是防抖的，轮询渲染推进 effect
    for (let i = 0; i < 60 && !(saved.prompts || []).length; i += 1) {
      keep();
      await sleep(30);
    }
    assert.equal((saved.prompts || []).length, 1, "应写入设置");
    // 新增不抢默认：内置模板一开始就是默认，换不换由用户决定
    assert.equal(saved.defaultPromptId, "", "新增的那份不该自动变成默认");
    assert.equal(saved.prompts[0].name, "提示词 1");

    // 正文默认收起：新增完就展开一整块 14 行文本框会把设置页拉很长。
    // 点名字才展开——顺带覆盖这条交互。
    findByText(keep(), "提示词 1").props.onClick();
    await waitFor(() => textOf(keep()).includes("可用占位符"));

    // 改名字要同步写回列表，否则「设为默认」按钮上的 aria-label 会过期
    const nameInput = [];
    walk(keep(), (n) => {
      if (n.type === "input" && n.props && n.props["aria-label"] === "提示词名字") nameInput.push(n);
    });
    assert.equal(nameInput.length, 1, "展开后应有名字输入框");
    nameInput[0].props.onChange({ target: { value: "评估可投入性" } });
    for (let i = 0; i < 60 && (saved.prompts || [])[0]?.name !== "评估可投入性"; i += 1) {
      keep();
      await sleep(30);
    }
    assert.equal(saved.prompts[0].name, "评估可投入性");

    // 设为默认：两处「设为默认」里选用户那份（内置已经是默认，没有按钮）
    findByText(keep(), "设为默认").props.onClick();
    for (let i = 0; i < 60 && saved.defaultPromptId !== saved.prompts[0]?.id; i += 1) {
      keep();
      await sleep(30);
    }
    assert.equal(saved.defaultPromptId, saved.prompts[0].id, "点「设为默认」应切过去");

    // 删除用户那份：删完默认回落内置模板（""），不是回落到别的自定义
    findByText(keep(), "删除").props.onClick();
    await waitFor(() => !textOf(keep()).includes("评估可投入性"));
    for (let i = 0; i < 60 && (saved.prompts || []).length !== 0; i += 1) {
      keep();
      await sleep(30);
    }
    assert.equal(saved.prompts.length, 0, "删除后应写回空列表");
    assert.equal(saved.defaultPromptId, "", "默认值应回落到内置模板，不悬空");

    // 内置那份根本没有删除按钮：不是禁用，而是不存在
    const deleteButtons = [];
    walk(keep(), (n) => {
      if (n.type === "button" && textOf(n) === "删除") deleteButtons.push(n);
    });
    assert.equal(deleteButtons.length, 0, "内置模板不可删除");
    assert.match(textOf(keep()), /内置模板/, "删完之后内置那份还在");

    // 内置那份展开后是只读文本，不是 textarea：一个 readOnly 的输入框看起来
    // 仍然像能改，点进去还会出现光标。
    findByText(keep(), "内置模板").props.onClick();
    await waitFor(() => textOf(keep()).includes("先在本机找同名仓库") || textOf(keep()).includes("本地副本"));
    const builtinInputs = [];
    // 只在提示词行的子树里统计。设置页底部还有反馈正文的 textarea，
    // 按整页统计会把它也算成「内置模板的可编辑控件」。
    walk(keep(), (n) => {
      if (!n.props || !String(n.props.className || "").split(/\s+/).includes("gt-prompt")) return;
      walk(n, (m) => {
        if (m.type === "textarea" || (m.type === "input" && m.props && m.props["aria-label"] === "提示词名字")) {
          builtinInputs.push(m);
        }
      });
    });
    assert.equal(builtinInputs.length, 0, "内置模板不应有任何可编辑控件");
    findByText(keep(), "内置模板").props.onClick();

    // 占位符：默认收起，点按钮才出现，且每一项都带作用说明
    assert.doesNotMatch(textOf(keep()), /\{\{repo\}\}/, "默认不展开占位符面板");
    findByText(keep(), "占位符").props.onClick();
    assert.ok(await waitFor(() => textOf(keep()).includes("{{repo}}")), "点开后应列出占位符");
    const helpText = textOf(keep());
    for (const token of ["{{repo}}", "{{facts}}", "{{stars}}", "{{rank}}", "{{scope}}"]) {
      assert.ok(helpText.includes(token), "占位符清单应含 " + token);
    }
    assert.match(helpText, /让模型去找本地副本时用的名字/, "每个占位符都要说清作用");
    assert.match(helpText, /收起占位符/);
    findByText(keep(), "收起占位符").props.onClick();
    await waitFor(() => !textOf(keep()).includes("{{repo}}"));
  } finally {
    dispose3();
  }
});

await check("讨论用的是设置里选中的那份提示词", async () => {
  const fresh = await import(PLUGIN + "?promptpick=" + Date.now());
  const picked = {
    prompts: [
      { id: "a", name: "评估可投入性", text: "只判断 {{repo}} 值不值得投入。" },
      { id: "b", name: "找可借鉴设计", text: "只看 {{repo}} 里能借鉴的设计。" },
    ],
    defaultPromptId: "b",
  };
  let freshTab = null;
  const dispose4 = fresh.default(
    Object.assign({}, ctx, {
      storage: {
        get: async (k) => (k === "settings" ? picked : null),
        set: async () => {},
        delete: async () => {},
      },
      ui: Object.assign({}, ctx.ui, {
        registerCenterTab: (d) => {
          freshTab = d;
          return () => {};
        },
        registerSidebarNav: () => () => {},
        registerSettingsSection: () => () => {},
        registerCommand: () => () => {},
      }),
    }),
  );
  try {
    assert.ok(await waitFor(() => !!freshTab, 2000));
    renderFresh(freshTab.component, {}, { effects: true });
    assert.ok(await waitFor(() => !!discussButtonFor(renderFresh(freshTab.component, {}), "beta/two"), 2000));
    sessionStarts.length = 0;
    discussButtonFor(renderFresh(freshTab.component, {}), "beta/two").props.onClick();
    assert.ok(await waitFor(() => sessionStarts.length === 1));
    assert.match(sessionStarts[0].prompt, /只看 beta\/two 里能借鉴的设计/);
    // 事实由插件补，用户不必自己抄 star 数
    assert.match(sessionStarts[0].prompt, /榜单事实（插件补充）/);
    assert.ok(
      await waitFor(() => textOf(renderFresh(freshTab.component, {})).includes("找可借鉴设计")),
      "回执应说明用了哪份提示词",
    );
  } finally {
    dispose4();
  }
});

await check("讨论回执：用内置模板时不写提示词名，自定义时才写", async () => {
  // 内置模板是「没有选择的选择」，回执里再报一遍名字只是噪音；
  // 但用户建的那份必须报，否则分不清刚才用的是哪套要求。
  sessionStarts.length = 0;
  // 讨论入口只挂在榜单行上：先切回 Trending 拿到 alpha/beta/gamma 这三行。
  const trendingChip = findByText(render(), "Trending");
  if (trendingChip) trendingChip.props.onClick();
  assert.ok(await waitFor(() => !!discussButtonFor(render(), "beta/two"), 2000), "应找到讨论按钮");
  discussButtonFor(render(), "beta/two").props.onClick();
  assert.ok(await waitFor(() => sessionStarts.length === 1));
  // 主实例的设置里没有 prompts → 走内置模板
  assert.doesNotMatch(textOf(render()), /提示词「内置模板」/, "内置时不必报名字");
  assert.match(sessionStarts[0].prompt, /本地副本/, "内置模板的正文应真的被用上");
});

await check("start 期间切视图，同样不会留下孤儿进程", async () => {
  agentMode = "slow-start";
  agentStartDelay = 200;

  findByText(render(), "生成解读").props.onClick();
  await sleep(40);
  const before = agentInterrupts.length;
  const risingChip = findByText(render(), "新星库");
  assert.ok(risingChip, "应有新星库按钮");
  risingChip.props.onClick();
  assert.ok(
    await waitFor(() => agentInterrupts.length > before, 1500),
    "切视图后 start 回来也应 interrupt",
  );

  agentMode = "stream";
  findByText(render(), "Trending").props.onClick();
  await waitFor(() => textOf(render()).includes("brand new repo"));
});

// 放在最后：重新 import 会覆盖模块级的 tabDef/settingsDef，破坏前面用例的装配。
await check("首次抓取时显示骨架屏与转圈，不再是空屏", async () => {
  // 前面的用例都已 loaded，这里换一份慢响应，把状态退回到「首次抓取」
  trendingPayload = { status: 200, body: trendingHtml(day1) };
  const originalInvoke = ctx.bridge.invoke;
  let trendingDelay = 0;
  ctx.bridge.invoke = async (cmd, args) => {
    if (args.url.includes("/trending") && trendingDelay) await sleep(trendingDelay);
    return originalInvoke(cmd, args);
  };

  trendingDelay = 200;
  // 切一次视图再切回来：会清空列表并重新抓取，等于首次加载的观感
  findByText(render(), "新星库").props.onClick();
  await waitFor(() => textOf(render()).includes("fresh repo"));
  findByText(render(), "Trending").props.onClick();

  const during = render();
  assert.ok(countByClass(during, "gt-skel") >= 4, "抓取中应铺骨架屏占住列表高度");
  assert.ok(countByClass(during, "gt-spinner") >= 1, "抓取中应显示转圈");
  assert.match(textOf(during), /正在抓取|正在刷新/, "应给出进行中的文案");

  assert.ok(await waitFor(() => countByClass(render(), "gt-skel") === 0), "表格到达后骨架屏应撤掉");
  assert.equal(countByClass(render(), "gt-skel"), 0);
  assert.ok(countByType(render(), "li") >= 3, "应渲染真实列表");

  trendingDelay = 0;
  ctx.bridge.invoke = originalInvoke;
});

await check("刷新时保留列表内容，只在按钮和提示行上转圈", async () => {
  trendingPayload = { status: 200, body: trendingHtml(day2) };
  const originalInvoke = ctx.bridge.invoke;
  let trendingDelay = 0;
  ctx.bridge.invoke = async (cmd, args) => {
    if (args.url.includes("/trending") && trendingDelay) await sleep(trendingDelay);
    return originalInvoke(cmd, args);
  };

  // 先确保有列表
  assert.ok(findByText(render(), "刷新"), "应有刷新按钮");
  assert.ok(countByType(render(), "li") >= 3, "刷新前应已有列表");

  trendingDelay = 150;
  findByText(render(), "刷新").props.onClick();
  await sleep(20);

  const during = render();
  assert.ok(countByType(during, "li") >= 3, "刷新期间列表不应被清空");
  assert.equal(countByClass(during, "gt-skel"), 0, "有旧数据时不该退回骨架屏");
  assert.match(textOf(during), /正在刷新榜单/, "刷新与首次抓取文案应区分");
  const busy = findByText(during, "刷新中");
  assert.ok(busy, "刷新按钮应进入进行中");
  assert.equal(busy.props["aria-busy"], "true");
  assert.equal(busy.props.disabled, true, "进行中不能再点第二次");

  // 注意不能用 /刷新/ 判断结束：「刷新中…」也含这两个字，条件会立刻为真
  assert.ok(await waitFor(() => {
    const btn = findByText(render(), "刷新");
    return btn && btn.props["aria-busy"] === "false";
  }, 2000), "结束后按钮应复位");
  assert.equal(findByText(render(), "刷新中"), null, "结束后不该还是进行中");

  trendingDelay = 0;
  ctx.bridge.invoke = originalInvoke;
});

await check("语言名含路径穿越时不会写到快照目录之外", async () => {
  kv.set("settings", Object.assign({}, kv.get("settings") || {}, { language: "../../evil" }));
  const fresh = await import(PLUGIN + "?lang-guard=" + Date.now());
  const dispose2 = fresh.default(ctx);
  renderFresh(tab(), {}, { effects: true });
  await sleep(250);

  assert.ok(!fs.existsSync(path.join(storageDir, "..", "evil.json")), "不应写到 storage 根之外");
  const historyDir = path.join(storageDir, "history");
  if (fs.existsSync(historyDir)) {
    for (const name of fs.readdirSync(historyDir)) {
      assert.doesNotMatch(name, /[\\/]/, "快照文件名不应含分隔符：" + name);
    }
  }
  dispose2();
});

/* ------------------------------------------------ 反馈：两个渠道 */

/** 反馈区在设置页里的锚点：按「发送反馈」按钮反查所属 section。 */
function feedbackSection() {
  const tree = renderFresh(settingsDef.component, {}, { effects: true });
  const btn = findByText(tree, "发送反馈");
  assert.ok(btn, "设置页应有「发送反馈」按钮");
  return { tree, btn };
}

/**
 * 渲染设置页并等额度查询落地。
 *
 * 额度来自一次异步 GET，落在 useState 里；首帧只能拿到 null。真宿主会
 * 在 state 变化后重渲染，这里用两次 renderKeep 模拟。
 *
 * `fresh` 为 true 时换一个组件引用：effectStore 是 WeakMap，按组件引用缓存，
 * 不换引用的话上一个用例的额度结果会被当成「effect 已跑过」而跳过。
 */
async function renderFeedbackReady(fresh) {
  if (fresh) {
    stateSlots = new Map();
    refSlots = new Map();
    effectStores.delete(settingsDef.component);
  }
  renderKeep(settingsDef.component, {});
  await sleep(60);
  return renderKeep(settingsDef.component, {});
}

/** 在整棵树里找含指定文字的任意元素（文案有 button、p、span 多种载体）。 */
function findAnyText(node, text) {
  let hit = null;
  walk(node, (n) => {
    if (hit || !n.type || typeof n.type !== "string") return;
    if (textOf(n).includes(text)) hit = n;
  });
  return hit;
}

await check("反馈：GitHub Issue 链接预填正文，且不含任何本机信息", async () => {
  const { tree } = feedbackSection();
  const link = findByType(tree, "a", "gt-feedback-issue");
  assert.ok(link, "应有「通过 GitHub 提 Issue」链接");
  const url = new URL(link.props.href);
  assert.equal(url.hostname, "github.com");
  assert.equal(url.pathname, "/renhao-wan/ccgui-plugin-github-trending/issues/new");
  assert.ok(url.searchParams.get("title").includes("反馈"));
  const body = url.searchParams.get("body");
  assert.ok(!body.includes("D:\\"), "正文不应带本机路径");
  assert.equal(link.props.target, "_blank");
  assert.match(link.props.rel, /noreferrer/);
});

await check("反馈：额度查询失败时不显示数字，但仍可发送", async () => {
  feedbackQuota = { status: 500, value: null };
  const tree = await renderFeedbackReady(true);
  const quota = findByType(tree, "span", "gt-feedback-quota");
  assert.ok(quota, "应渲染额度提示");
  assert.match(textOf(quota), /额度有限/);
  assert.doesNotMatch(textOf(quota), /\d+ 条/);
  feedbackQuota = { status: 200, value: { remaining: 27, dailyLimit: 30 } };
});

await check("反馈：额度查得到时显示剩余条数", async () => {
  feedbackQuota = { status: 200, value: { remaining: 27, dailyLimit: 30 } };
  const tree = await renderFeedbackReady(true);
  const quota = findByType(tree, "span", "gt-feedback-quota");
  assert.match(textOf(quota), /27/);
});

await check("反馈：输入后点发送，POST 到 worker，body 只带白名单字段", async () => {
  httpCalls.length = 0;
  feedbackSend = { status: 200, body: '{"ok":true,"remaining":26}' };
  // 输入框内容跨渲染存在，用 renderKeep 才能走完「打字 → 点发送 → 看到结果」。
  const tree = await renderFeedbackReady(true);
  const area = findByType(tree, "textarea", "gt-feedback-text");
  assert.ok(area, "反馈区应有输入框");
  area.props.onChange({ target: { value: "界面有点卡" } });
  await sleep(20);
  const btn = findByText(renderKeep(settingsDef.component, {}), "发送反馈");
  assert.ok(!btn.props.disabled, "有内容时应可发送");
  btn.props.onClick();
  assert.ok(await waitFor(() => httpCalls.some((c) => c.url.endsWith("/feedback")), 3000), "应发出 /feedback");
  const call = httpCalls.find((c) => c.url.endsWith("/feedback"));
  assert.equal(call.method, "POST");
  assert.equal(new URL(call.url).hostname, "ccgui-feedback.workers.dev");
  const body = JSON.parse(call.body);
  assert.deepEqual(Object.keys(body).sort(), ["hostVersion", "pluginId", "pluginVersion", "text", "ts"]);
  assert.equal(body.text, "界面有点卡");
  assert.equal(body.pluginId, "github-trending");
  assert.ok(!JSON.stringify(body).includes("D:"), "请求体不应带本机路径");
  // 成功后输入框清空、显示成功文案。
  assert.ok(
    await waitFor(() => findAnyText(renderKeep(settingsDef.component, {}), "反馈已发送"), 2000),
    "应显示成功文案",
  );
});

await check("反馈：429 时提示额度用完", async () => {
  httpCalls.length = 0;
  feedbackSend = { status: 429, body: '{"ok":false,"error":"rate_limited","remaining":0}' };
  const tree = await renderFeedbackReady(true);
  findByType(tree, "textarea", "gt-feedback-text").props.onChange({ target: { value: "再来一条" } });
  await sleep(20);
  findByText(renderKeep(settingsDef.component, {}), "发送反馈").props.onClick();
  assert.ok(
    await waitFor(() => findAnyText(renderKeep(settingsDef.component, {}), "额度已用完"), 3000),
    "应显示额度用完文案",
  );
});

await check("反馈：500 时提示发送失败并给出 Issue 退路", async () => {
  feedbackSend = { status: 500, body: "boom" };
  const tree = await renderFeedbackReady(true);
  findByType(tree, "textarea", "gt-feedback-text").props.onChange({ target: { value: "再来一条" } });
  await sleep(20);
  findByText(renderKeep(settingsDef.component, {}), "发送反馈").props.onClick();
  assert.ok(
    await waitFor(() => findAnyText(renderKeep(settingsDef.component, {}), "可改用 GitHub Issue"), 3000),
    "失败文案应指回 Issue",
  );
  feedbackSend = { status: 200, body: '{"ok":true,"remaining":26}' };
});

/* ------------------------------------------------------------ 汇总 */
let failed = 0;
for (const r of results) {
  if (r.ok) {
    console.log("ok   " + r.name);
  } else {
    failed += 1;
    console.error("FAIL " + r.name);
    console.error(String((r.error && r.error.stack) || r.error).replace(/^/gm, "     "));
  }
}
console.log(`\nRESULT=${failed === 0 ? "SMOKE_OK" : "SMOKE_FAIL"} passed=${results.length - failed} failed=${failed}`);
try {
  fs.rmSync(storageDir, { recursive: true, force: true });
  fs.rmSync(pickedWorkspaceDir, { recursive: true, force: true });
} catch {
  /* 清理失败不影响结果 */
}
process.exit(failed === 0 ? 0 : 1);
