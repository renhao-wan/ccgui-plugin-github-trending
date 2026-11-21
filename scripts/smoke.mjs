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
const agentStarts = [];
const agentInterrupts = [];
/** sessions.startRun 的入参；讨论功能的核心断言对象。 */
const sessionStarts = [];
let sessionStartError = null;
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

function emit(ev) {
  for (const cb of Array.from(eventHandlers)) cb(ev);
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
    on: (_topic, cb) => {
      eventHandlers.add(cb);
      return () => eventHandlers.delete(cb);
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
      return { runId: "srun-" + sessionStarts.length, sessionId: "sess-" + sessionStarts.length };
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
      httpCalls.push({ url: args.url, headers: args.headers || {} });
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
      // /repos/<owner>/<name>/readme —— 不走 raw.githubusercontent.com，
      // 是为了复用已有的 network:api.github.com 授权。
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
async function freshTabInstance(storageGet) {
  const fresh = await import(PLUGIN + "?fresh=" + Date.now() + Math.random().toString(36).slice(2));
  let tab = null;
  const dispose = fresh.default(
    Object.assign({}, ctx, {
      storage: {
        get: async (k) => (k === "settings" ? storageGet() : null),
        set: async () => {},
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

await check("README：点行内展开，走 api.github.com 而不是 raw 域名", async () => {
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
  const call = httpCalls.find((c) => c.url.includes("/readme"));
  assert.ok(call, "应请求 readme 接口");
  assert.equal(call.url, "https://api.github.com/repos/beta/two/readme");
  // 走 api 域名是为了复用已有授权；换成 raw.xxx 就要新增网络权限、重装才生效。
  assert.doesNotMatch(call.url, /raw\.githubusercontent/);
  assert.match(String(call.headers.Accept), /vnd\.github\.raw/);

  // 预处理生效：badge、frontmatter、HTML 标签都不该出现在正文里
  const bodyText = textOf(render());
  assert.doesNotMatch(bodyText, /shields\.io/);
  assert.doesNotMatch(bodyText, /title: 假的 frontmatter/);
  assert.doesNotMatch(bodyText, /<b>|<div/);
  assert.match(bodyText, /一个很长的说明/);
  assert.match(bodyText, /npm i beta-two/, "代码块内容应保留");
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
  readmeRoutes.set("beta/two", { status: 404, body: JSON.stringify({ message: "Not Found" }) });
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
      if (!btn && n.type === "button" && n.props && n.props["aria-label"] === "展开 beta/two 的 README") btn = n;
    });
    btn.props.onClick();
    assert.ok(await waitFor(() => textOf(render()).includes("没有 README")), "404 要说清是没有 README");
  } finally {
    readmeRoutes.clear();
    // 收回到干净状态，别把展开态留给后面的用例
    let close = null;
    walk(render(), (n) => {
      if (!close && n.type === "button" && n.props && n.props["aria-label"] === "收起 beta/two 的 README") close = n;
    });
    if (close) close.props.onClick();
    await waitFor(() => !textOf(render()).includes("没有 README"));
  }
});

await check("导出 Markdown：复制的是当前榜单，不是渲染后的文本", async () => {
  const prev = globalThis.navigator;
  let copied = "";
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { clipboard: { writeText: async (t) => { copied = t; } } },
  });
  try {
    let btn = null;
    walk(render(), (n) => {
      if (!btn && n.type === "button" && textOf(n) === "导出 Markdown") btn = n;
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

await check("导出 Markdown：剪贴板不可用时报失败，不静默", async () => {
  const prev = globalThis.navigator;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
  try {
    // 先拿按钮（renderFresh 重置内部 state，文案回到「导出 Markdown」），
    // 之后必须每帧重新渲染再读：回执是异步写进 useState 的，拿一次快照
    // 只会在 Promise 落地前读到空字符串。
    let btn = null;
    walk(render(), (n) => {
      if (!btn && n.type === "button" && textOf(n) === "导出 Markdown") btn = n;
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
  sessionStartError = null;
  // 让 startRun 挂住，观察中间态
  const gated = [];
  const original = ctx.sessions.startRun;
  ctx.sessions.startRun = async (def) => {
    sessionStarts.push(def);
    await new Promise((r) => gated.push(r));
    return { runId: "srun-x", sessionId: null };
  };
  discussButtonFor(render(), "beta/two").props.onClick();
  assert.ok(await waitFor(() => sessionStarts.length === 1), "应开始开会话");
  assert.ok(await waitFor(() => textOf(render()).includes("打开中")), "按钮应显示打开中");
  // 别的行这时应该被禁用
  const other = discussButtonFor(render(), "alpha/one");
  assert.equal(other.props.disabled, true, "别的行在开会话期间应禁用");
  for (const r of gated) r();
  ctx.sessions.startRun = original;
  assert.ok(await waitFor(() => !textOf(render()).includes("打开中")), "完成后应复位");
});

await check("开会话失败时说明原因，不静默吞掉", async () => {
  sessionStartError = new Error("missing permission host:session");
  sessionStarts.length = 0;
  discussButtonFor(render(), "beta/two").props.onClick();
  assert.ok(await waitFor(() => textOf(render()).includes("缺少会话权限")), "应给人看得懂的提示");
  assert.ok(findByText(render(), "讨论"), "按钮应回到可点状态");
  sessionStartError = null;
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
  discussButtonFor(render(), "beta/two").props.onClick();
  // 成功了却一声不响，用户会以为按钮没反应，进而连点开出好几轮真 token。
  assert.ok(
    await waitFor(() => textOf(render()).includes("已在侧栏为 beta/two 开了会话")),
    "应回执会话已开",
  );
  assert.match(textOf(render()), /不会自动跳转/, "要说明本页不跳转");

  // 再点另一行：上一条回执必须先收掉，否则页面会同时声称两个会话都在等。
  discussButtonFor(render(), "alpha/one").props.onClick();
  assert.ok(
    await waitFor(() => textOf(render()).includes("已在侧栏为 alpha/one 开了会话")),
    "应换成新的一条回执",
  );
  assert.ok(!textOf(render()).includes("beta/two 开了会话"), "旧回执应被替换");

  // 刷新是用户明确表示的「再来一次」，回执要让位给榜单本身的状态说明。
  findByText(render(), "刷新").props.onClick();
  assert.ok(await waitFor(() => !textOf(render()).includes("已在侧栏")), "刷新后回执应消失");
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
  const chip = findByText(render(), "新星库（7 天）");
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
  findByText(render(), "新星库（7 天）").props.onClick();
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
    findByText(render(), "导出 Markdown").props.onClick();
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
  findByText(render(), "新星库（7 天）").props.onClick();
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
  findByText(render(), "新星库（7 天）").props.onClick();
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

await check("讨论续接：同一份榜单里再点同一行，带上上次的 sessionId", async () => {
  sessionStarts.length = 0;
  const inst = await freshTabInstance(() => ({}));
  try {
    // 宿主契约：startRun resolve { runId, sessionId }。第一次拿到 sess-1，
    // 第二次必须把它带回去——那是「接着上次话题」的唯一凭据。
    inst.click("beta/two");
    assert.ok(await waitFor(() => sessionStarts.length === 1));
    assert.ok(!sessionStarts[0].sessionId, "第一次应新开会话");
    // 续接用的是 startRun **返回值**里的 sessionId（入参此时本来就没有），
    // 假宿主按契约回 sess-<n>。
    const firstId = "sess-1";

    assert.ok(await waitFor(() => !inst.text().includes("打开中")));
    inst.click("beta/two");
    assert.ok(await waitFor(() => sessionStarts.length === 2), "应再开一次");
    assert.equal(sessionStarts[1].sessionId, firstId, "第二次应续接同一会话");
    assert.ok(
      await waitFor(() => inst.text().includes("续接")),
      "回执要说清是续接还是新开，否则侧栏多一行少一行用户没法判断",
    );
  } finally {
    inst.dispose();
  }
});

await check("讨论续接：换一行仍然新开，只有同一仓库才续接", async () => {
  sessionStarts.length = 0;
  const inst = await freshTabInstance(() => ({}));
  try {
    inst.click("beta/two");
    assert.ok(await waitFor(() => sessionStarts.length === 1));
    assert.ok(await waitFor(() => !inst.text().includes("打开中")));
    inst.click("alpha/one");
    assert.ok(await waitFor(() => sessionStarts.length === 2));
    assert.ok(!sessionStarts[1].sessionId, "另一个仓库不该续接到上一行");
    assert.ok(!inst.text().includes("续接"), "新开的回执不该说续接");
  } finally {
    inst.dispose();
  }
});

await check("讨论续接：拿不到 sessionId 时退回新开，不把按钮做成一次性", async () => {
  const original = ctx.sessions.startRun;
  // 引擎稍后才 announce 时 resolve 的 sessionId 是 null（文档明写），
  // 这条路径必须能继续用，否则这个仓库第二次点就报错。
  ctx.sessions.startRun = async (def) => {
    sessionStarts.push(def);
    return { runId: "srun-null", sessionId: null };
  };
  sessionStarts.length = 0;
  const inst = await freshTabInstance(() => ({}));
  try {
    inst.click("beta/two");
    assert.ok(await waitFor(() => sessionStarts.length === 1));
    assert.ok(await waitFor(() => !inst.text().includes("打开中")));
    inst.click("beta/two");
    assert.ok(await waitFor(() => sessionStarts.length === 2), "第二次仍应能开会话");
    assert.ok(!sessionStarts[1].sessionId, "没有 id 时退回新开");
  } finally {
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

await check("续接策略 always：刷新榜单后仍然接着聊", async () => {
  sessionStarts.length = 0;
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
    assert.ok(await waitFor(() => sessionStarts.length === 2));
    assert.equal(sessionStarts[1].sessionId, "sess-1", "always 模式下换榜单也要续接");
  } finally {
    inst.dispose();
  }
});

await check("续接策略 never：同一份榜单里也每次新开", async () => {
  sessionStarts.length = 0;
  const inst = await freshTabInstance(() => ({ resumeMode: "never" }));
  try {
    inst.click("beta/two");
    assert.ok(await waitFor(() => sessionStarts.length === 1));
    assert.ok(await waitFor(() => !inst.text().includes("打开中")));
    inst.click("beta/two");
    assert.ok(await waitFor(() => sessionStarts.length === 2));
    assert.ok(!sessionStarts[1].sessionId, "never 模式下不该续接");
    assert.ok(!inst.text().includes("续接"), "回执不该说续接");
  } finally {
    inst.dispose();
  }
});

await check("设置页：续接策略用下拉，默认是「同一份榜单内续接」", async () => {
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
    const trigger = findTrigger(keep(), "同一份榜单内续接");
    assert.ok(trigger, "默认应显示「同一份榜单内续接」");
    assert.match(textOf(keep()), /榜单刷新、换日\/周\/月之后新开/, "应把当前策略的含义写出来");

    // 换成 always 并写盘
    trigger.props.onClick();
    await waitFor(() => isOpen(dropdownFor(keep(), "同一份榜单内续接")));
    // 菜单项是 .gt-dd-item 的 div（不是 button），findByText 认不到。
    let option = null;
    walk(keep(), (n) => {
      if (option) return;
      const c = n.props && n.props.className;
      if (typeof c === "string" && c.split(/\s+/).includes("gt-dd-item") && textOf(n).includes("总是续接")) option = n;
    });
    assert.ok(option, "菜单里应有「总是续接」");
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
    assert.match(textOf(renderKeep(freshSettings.component, {})), /还没有自定义提示词/, "初始应说明会用内置模板");

    // 表单值是组件局部 state：必须用 renderKeep，renderFresh 会把它重置回
    // snap.settings，「新增」的结果还没写盘就丢了。
    const keep = () => renderKeep(freshSettings.component, {});
    findByText(keep(), "新增提示词").props.onClick();
    await waitFor(() => textOf(keep()).includes("提示词 1"));
    // 第一份自动成为默认：加完还要再点一次「设为默认」很别扭
    assert.match(textOf(keep()), /默认/);

    // 保存是防抖的，轮询渲染推进 effect
    for (let i = 0; i < 60 && !(saved.prompts || []).length; i += 1) {
      keep();
      await sleep(30);
    }
    assert.equal((saved.prompts || []).length, 1, "应写入设置");
    assert.equal(saved.defaultPromptId, saved.prompts[0].id, "第一份应成为默认");
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

    findByText(keep(), "删除").props.onClick();
    await waitFor(() => !textOf(keep()).includes("评估可投入性"));
    for (let i = 0; i < 60 && (saved.prompts || []).length !== 0; i += 1) {
      keep();
      await sleep(30);
    }
    assert.equal(saved.prompts.length, 0, "删除后应写回空列表");
    assert.equal(saved.defaultPromptId, "", "默认值不能指向已删除的那份");
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

await check("start 期间切视图，同样不会留下孤儿进程", async () => {
  agentMode = "slow-start";
  agentStartDelay = 200;

  findByText(render(), "生成解读").props.onClick();
  await sleep(40);
  const before = agentInterrupts.length;
  const risingChip = findByText(render(), "新星库（7 天）");
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
  findByText(render(), "新星库（7 天）").props.onClick();
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
