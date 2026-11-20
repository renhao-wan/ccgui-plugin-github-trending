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
const effectStores = new WeakMap();
let effectStore = new Map();
let stateIdx = 0;
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
  useRef: (init) => ({ current: init === undefined ? null : init }),
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
  effectStore = new Map();
  effectStores.set(comp, effectStore);
  stateIdx = 0;
  effectIdx = 0;
  pendingEffects.length = 0;
  const tree = expand(comp(props || {}));
  if (opts && opts.effects) flushEffects();
  else pendingEffects.length = 0;
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

/* ------------------------------------------------------------ 假宿主 */

const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "gt-smoke-"));
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
let agentMode = "stream"; // stream | error | silent
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
  workspaces: {
    list: async () => [{ path: os.tmpdir() }],
  },
  models: {
    listEngines: async () => [
      { id: "claude", name: "Claude", enabled: true },
      { id: "codex", name: "Codex", enabled: true },
      { id: "off", name: "Off", enabled: false },
    ],
    listEngineModels: async () => ({ models: [{ id: "m-one" }, { id: "m-two" }] }),
  },
  agent: {
    start: async (opts) => {
      agentStarts.push(opts);
      agentRunIdx += 1;
      const idx = agentRunIdx;
      const runId = "run-" + idx;
      if (agentMode === "silent") return { runId, sessionId: null };
      setTimeout(() => {
        if (agentMode === "error") {
          emit({ runId, kind: "error", data: { message: "模型炸了" } });
          return;
        }
        // 故意先推一个别的 run，验证按 runId 过滤
        emit({ runId: "stale-run", kind: "delta", data: "不该出现的内容" });
        emit({ runId, kind: "delta", data: "## 今天在热什么\n" });
        emit({ runId, kind: "delta", data: "- 测试解读正文\n" });
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

await check("生成解读：按 runId 过滤、流式写入", async () => {
  findByText(render(), "生成解读").props.onClick();
  assert.ok(await waitFor(() => textOf(render()).includes("测试解读正文")), "应写入解读");
  const text = textOf(render());
  assert.doesNotMatch(text, /不该出现的内容/, "别的 runId 的事件必须丢弃");
  assert.match(text, /今天在热什么/);
  assert.equal(agentStarts.length, 1);
  assert.equal(agentStarts[0].readOnly, true);
  assert.match(agentStarts[0].prompt, /GitHub Trending daily/);
  assert.ok(agentStarts[0].workspacePath, "应带工作区");
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

await check("切到新星库走 Search API 并渲染", async () => {
  const chip = findByText(render(), "新星库（7 天）");
  chip.props.onClick();
  assert.ok(await waitFor(() => textOf(render()).includes("fresh repo")), "应渲染新星库");
  const text = textOf(render());
  assert.match(text, /rising \/ star/);
  assert.match(text, /2 天前创建/);
  assert.ok(httpCalls.some((c) => c.url.startsWith("https://api.github.com/search/repositories")));
});

await check("限流时保留缓存并给出可读提示", async () => {
  // 回到 Trending，先确保有数据
  findByText(render(), "Trending").props.onClick();
  assert.ok(await waitFor(() => textOf(render()).includes("first fixture repo") || textOf(render()).includes("brand new repo")));
  const before = countByType(render(), "li");
  assert.ok(before > 0);

  searchPayload = { status: 403, body: JSON.stringify({ message: "API rate limit exceeded" }) };
  findByText(render(), "新星库（7 天）").props.onClick();
  assert.ok(await waitFor(() => textOf(render()).includes("限流")), "应提示限流");
});

await check("页面结构变化时给出明确提示而不是空榜单", async () => {
  trendingPayload = { status: 200, body: "<html><body>redesigned</body></html>" };
  findByText(render(), "Trending").props.onClick();
  assert.ok(await waitFor(() => textOf(render()).includes("页面结构可能已变化")), "应提示结构变化");
});

await check("设置页：引擎列表过滤未启用项，改动会持久化", async () => {
  renderFresh(settingsDef.component, {}, { effects: true });
  assert.ok(await waitFor(() => textOf(renderFresh(settingsDef.component)).includes("Claude")));

  const text = textOf(renderFresh(settingsDef.component));
  assert.match(text, /Claude/);
  assert.match(text, /Codex/);
  assert.doesNotMatch(text, /Off/, "未启用引擎不应出现");

  // 语言筛选在失焦时保存
  const inputs = [];
  walk(renderFresh(settingsDef.component), (n) => {
    if (n.type === "input" && n.props && n.props.placeholder && /python/.test(n.props.placeholder)) inputs.push(n);
  });
  assert.equal(inputs.length, 1, "应只有一个语言筛选输入框");
  inputs[0].props.onChange({ target: { value: "rust" } });
  inputs[0].props.onBlur({ target: { value: "rust" } });
  assert.ok(await waitFor(() => kv.has("settings")), "设置应已保存");
  assert.equal(kv.get("settings").language, "rust");
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

// 放在最后：重新 import 会覆盖模块级的 tabDef/settingsDef，破坏前面用例的装配。
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
} catch {
  /* 清理失败不影响结果 */
}
process.exit(failed === 0 ? 0 : 1);
