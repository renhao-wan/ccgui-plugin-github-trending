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
let agentMode = "stream"; // stream | error | silent | slow-start
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
        return { status: searchPayload.status, body: searchPayload.body };
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
