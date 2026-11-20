// 独立预览：把插件的设置页与主面板渲染到一个静态 HTML 里，用于肉眼核对样式。
// 不连网、不依赖 CC GUI；只是把真实组件与真实 CSS 跑起来。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const OUT = path.join(ROOT, ".preview", "index.html");

/* 收集 CSS：从产物里取回 injectCss 的实参 */
const bundle = fs.readFileSync(path.join(ROOT, "main.js"), "utf8");
const cssMatch = bundle.match(/const CSS = `([\s\S]*?)`;\n/);
if (!cssMatch) throw new Error("main.js 里找不到 CSS 常量");
const css = cssMatch[1];

let injected = { css: "", tab: null, settings: null, nav: null };
const eventListeners = new Map();

/* 极简 React 替身：把元素树序列化成 HTML 字符串 */
function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function render(node) {
  if (node == null || node === false) return "";
  if (typeof node === "string" || typeof node === "number") return esc(node);
  if (Array.isArray(node)) return node.map(render).join("");
  let { type, props, children } = node;
  props = props || {};
  children = children || [];
  if (typeof type === "function") {
    return render(type(Object.assign({}, props, { children })));
  }
  const kids = children.map(render).join("");
  if (type === "input") {
    return `<input class="${esc(props.className || "")}" value="${esc(props.value ?? "")}" placeholder="${esc(props.placeholder || "")}" ${props.type ? `type="${esc(props.type)}"` : ""} />`;
  }
  if (type === "details") {
    return `<details class="${esc(props.className || "")}" ${props.open ? "open" : ""}>${kids}</details>`;
  }
  const attrs = [];
  if (props.className) attrs.push(`class="${esc(props.className)}"`);
  if (props.title) attrs.push(`title="${esc(props.title)}"`);
  // style 对象要转成内联样式：语言色点靠它着色
  if (props.style && typeof props.style === "object") {
    const cssText = Object.entries(props.style)
      .map(([k, v]) => `${k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase())}:${v}`)
      .join(";");
    if (cssText) attrs.push(`style="${esc(cssText)}"`);
  }
  return `<${type}${attrs.length ? " " + attrs.join(" ") : ""}>${kids}</${type}>`;
}

const pendingEffects = [];
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (init) => [typeof init === "function" ? init() : init, () => {}],
  // 收集起来，渲染后统一跑：主面板靠它拉数据
  useEffect: (fn) => {
    pendingEffects.push(fn);
  },
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn(),
  useRef: (init) => ({ current: init === undefined ? null : init }),
  useSyncExternalStore: (_sub, getSnapshot) => getSnapshot(),
};

/** 把函数组件节点就地展开成元素节点，才能找到它们的 props.onClick。 */
function expand(node) {
  if (Array.isArray(node)) return node.map(expand);
  if (!node || typeof node !== "object") return node;
  if (typeof node.type === "function") {
    const props = Object.assign({}, node.props || {}, { children: node.children || [] });
    return expand(node.type(props));
  }
  return Object.assign({}, node, { children: (node.children || []).map(expand) });
}

/** 渲染并按 React 的时机跑 effect；返回元素树（还没序列化）。 */
async function renderTreeWithEffects(component) {
  // 先 expand 一遍：组件函数是在 expand 里被调用的，useEffect 也在此刻才
  // 被登记进来。先 splice 再 expand 会拿到上一次渲染残留的队列（首次为空），
  // 表现就是「第一屏永远没数据」。
  expand(fakeReact.createElement(component, {}));
  const effects = pendingEffects.splice(0);
  for (const fn of effects) fn();
  await new Promise((r) => setTimeout(r, 150));
  return expand(fakeReact.createElement(component, {}));
}

function renderWithEffects(component) {
  return renderTreeWithEffects(component).then(render);
}

/** 让 Trending 请求一直挂起，用来抓「正在抓取」这一刻的界面。 */
let holdTrending = false;

const now = Date.now();
const ctx = {
  react: fakeReact,
  pluginId: "github-trending",
  version: "0.1.0",
  host: { sdkVersion: "0.3.26", appVersion: "1.2.5", locale: "zh-CN", isWeb: false },
  theme: { injectCss: (s) => { injected.css = s; return () => {}; }, setTokens: () => () => {} },
  storage: { get: async () => null, set: async () => {}, delete: async () => {} },
  documentStorage: {
    // 宿主的隔离存储根。解读默认就跑在这个目录下，设置页也要显示它。
    getLocation: async () => ({ kind: "data", path: "C:/Users/you/.ccgui-next/plugin-data/github-trending" }),
    // 上次快照：只放 4 条，且刻意让「superpowers」「CLI-Anything」掉出、其余错位，
    // 好让预览里同时看到新上榜、上升、下跌三种标签。
    // 别只给 3 条——那样几乎整榜都是「新上榜」，看不出真实榜单里标签稀疏的样子。
    readText: async (rel) => {
      if (!/daily-all\.json$/.test(rel)) return null;
      const prev = [
        { repo: "obra/superpowers" },
        { repo: "jingyaogong/minimind" },
        { repo: "elementalsouls/Claude-BugHunter" },
        { repo: "HKUDS/CLI-Anything" },
        { repo: "old/dropped" },
      ];
      return { content: JSON.stringify({ savedAt: new Date(now - 86400000).toISOString(), repos: prev }), version: "1" };
    },
    writeTextAtomic: async () => ({ version: "1" }),
    remove: async () => {},
    list: async () => [],
  },
  ui: {
    registerCenterTab: (d) => { injected.tab = d; return () => {}; },
    registerSidebarNav: (d) => { injected.nav = d; return () => {}; },
    registerSettingsSection: (d) => { injected.settings = d; return () => {}; },
    registerCommand: () => () => {},
    openCenterTab: () => {},
    openSettings: () => {},
  },  events: {
    // 简单的订阅表：预览要手动推 agent 事件，才能看到「解读写到一半」和
    // 「写完的 Markdown」这两屏。
    on: (ch, fn) => {
      if (!eventListeners.has(ch)) eventListeners.set(ch, new Set());
      eventListeners.get(ch).add(fn);
      return () => eventListeners.get(ch).delete(fn);
    },
    emit: () => {},
  },
  // 路径只能来自系统文件夹选择器（和真实宿主一致）。预览里点「选择…」会
  // 直接拿到这个目录，用来肉眼看选中后的形态。
  assets: {
    grantDirectory: async () => ({
      grantId: "preview-grant",
      path: "D:/projects/school/compiler",
    }),
  },
  agent: {
    catalog: async () => [
      // readOnly 照实写：claude 在真实宿主里不支持隔离只读运行，全写 true
      // 会把这个差异藏起来，看不出「请求只读」和「引擎能不能只读」的区别。
      { engine: "claude", label: "Claude Code", available: true, readOnly: false, providers: [],
        models: [{ id: "claude-sonnet-5", label: "Sonnet 5" }, { id: "claude-opus-5", label: "Opus 5" }], efforts: ["low", "medium", "high"] },
      { engine: "codex", label: "Codex", available: true, readOnly: true, providers: [],
        models: [{ id: "gpt-5", label: "GPT-5" }], efforts: [] },
      { engine: "qoder", label: "Qoder", available: false, readOnly: true, providers: [], models: [], efforts: [] },
    ],
    start: async () => {
      // 正文由脚本按段推过来：先给一屏「写到一半」，再补齐成完整解读，
      // 这样预览里能同时核对加载态和排版。
      const runId = "preview-run";
      setTimeout(() => {
        for (const chunk of DIGEST_CHUNKS_HALF) emitAgent(runId, chunk);
      }, 30);
      return { runId, sessionId: null };
    },
    interrupt: async () => true,
  },
  // 讨论入口会调这个。预览里不需要真的跑聊天，只验证按钮存在与禁用态。
  sessions: {
    startRun: async () => ({ runId: "preview-srun", sessionId: "preview-sess" }),
    interruptRun: async () => {},
  },
  bridge: {
    invoke: async (_cmd, args) => {
      if (String(args.url).includes("/trending")) {
        if (holdTrending) await new Promise(() => {});
        return { status: 200, body: TRENDING_HTML() };
      }
      return { status: 200, body: JSON.stringify({ total_count: 0, items: [] }) };
    },
  },
};

/* ---------- 解读样本 ---------- */

/** 推 agent 事件；channel 就是 createDigest 订阅的那个。 */
function emitAgent(runId, text) {
  const set = eventListeners.get("agent://github-trending");
  if (!set) return;
  for (const fn of set) fn({ runId, kind: "delta", data: text });
}
function emitAgentDone(runId) {
  const set = eventListeners.get("agent://github-trending");
  if (!set) return;
  for (const fn of set) fn({ runId, kind: "done", data: null });
}

const DIGEST_CHUNKS_HALF = [
  "### 今天在热什么\n\n",
  "今天的热度集中在 **agent 工具链**：`skill`、`plugin` 这类让模型直接干活的形态占了前五里的一半。",
];

const DIGEST_CHUNKS_REST = [
  " Rust 侧的 `tokio` 生态之外，没有明显的新语言趋势。\n\n",
  "### 值得看的项目\n\n",
  "| 仓库 | 方向 | 解决什么问题 | 适合谁 |\n",
  "| --- | --- | --- | --- |\n",
  "| `obra/superpowers` | agent 技能框架 | 把开发方法论固化成可复用的技能包 | 已经在用 Claude Code 的人 |\n",
  "| `jingyaogong/minimind` | 小模型训练 | 两小时训出一个 64M 的 LLM，门槛极低 | 想动手学预训练的人 |\n",
  "| `cursor/plugins` | 编辑器插件规范 | 给 Cursor 定一套插件契约 | 做编辑器扩展的人 |\n",
  "| `HKUDS/CLI-Anything` | CLI 基建 | 让所有软件都能被 agent 当命令行调用 | 写自动化脚本的人 |\n",
  "\n### 一句话结论\n\n",
  "最值得点开的是 **`jingyaogong/minimind`** —— 它是今天唯一一个能让人在两小时内跑通全流程的项目。\n",
];

/** 和真实 trending 页面同构的样本，让预览走真实解析路径。 */function TRENDING_HTML() {
  const rows = [
    ["elementalsouls/Claude-BugHunter", "A Claude Code skill bundle for bug hunting and external red-team work — 82 skills, 15 slash commands.", "Python", "#3572A5", "12,721", "1,602", "1,349"],
    ["obra/superpowers", "An agentic skills framework & software development methodology that works.", "Shell", "#89e051", "322,190", "28,636", "2,028"],
    ["jingyaogong/minimind", "🧠 两小时从 0 训出你的 64M 大模型。Train your own 64M LLM from scratch in 2 hours.", "Python", "#3572A5", "67,010", "8,800", "238"],
    ["cursor/plugins", "Cursor plugin specification and official plugins", "TypeScript", "#3178c6", "4,210", "190", "384"],
    ["HKUDS/CLI-Anything", "\"CLI-Anything: Making ALL Software Agent-Native\" -- CLI-Hub", "Python", "#3572A5", "60,667", "5,504", "898"],
  ];
  return rows
    .map(
      ([repo, desc, lang, color, stars, forks, gain]) => `<article class="Box-row">
  <h2 class="h3 lh-condensed"><a href="/${repo}" class="Link"><span class="text-normal">
    ${repo.split("/")[0]} /</span> ${repo.split("/")[1]}</a></h2>
  <p class="col-9 color-fg-muted my-1 tmp-pr-4">${desc}</p>
  <div class="f6 color-fg-muted mt-2">
    <span class="tmp-mr-3 d-inline-block ml-0">
      <span class="repo-language-color" style="background-color: ${color}"></span>
      <span itemprop="programmingLanguage">${lang}</span>
    </span>
    <a href="/${repo}/stargazers" class="Link Link--muted"><svg><path d="M8 .25"></path></svg> ${stars}</a>
    <a href="/${repo}/forks" class="Link Link--muted"><svg><path d="M5 5"></path></svg> ${forks}</a>
    <span class="d-inline-block"><span>${gain} stars today</span></span>
  </div>
</article>`,
    )
    .join("\n");
}

const mod = await import(pathToFileURL(path.join(ROOT, "main.js")).href);
mod.default(ctx);

/* 让主面板真的跑一遍 effect（拉数据 → 解析 → 渲染状态），
 * 再把渲染结果序列化进静态页。 */
await new Promise((r) => setTimeout(r, 120));

/* 先渲染一次触发 effect（拉数据 → 解析 → 写 store），再渲染出结果。 */
fs.mkdirSync(path.dirname(OUT), { recursive: true });

const tabHtml = await renderWithEffects(injected.tab.component);
// 设置页的 effect 会拉引擎与工作区，同样需要跑一遍
const settingsHtml = await renderWithEffects(injected.settings.component);

/* 解读面板：点一次「生成解读」，先抓「写到一半」，再补齐抓「完整解读」。
 * 这两屏是这次改动的主要验证目标——以前整段塞 <pre>，表格和粗体全是原文。 */
const digestFlow = await (async () => {
  const findButton = (node, text) => {
    let hit = null;
    const walkTree = (n) => {
      if (hit || !n || typeof n !== "object") return;
      if (Array.isArray(n)) return n.forEach(walkTree);
      if (n.type === "button") {
        const flat = (x) => (typeof x === "string" ? x : Array.isArray(x) ? x.map(flat).join("") : x && x.children ? flat(x.children) : "");
        if (flat(n).includes(text)) {
          hit = n;
          return;
        }
      }
      (n.children || []).forEach(walkTree);
    };
    walkTree(node);
    return hit;
  };

  const tree0 = await renderTreeWithEffects(injected.tab.component);
  const btn = findButton(tree0, "生成解读");
  if (!btn) return { half: "", full: "" };
  btn.props.onClick();
  await new Promise((r) => setTimeout(r, 120)); // 等 half 那几段推完
  const half = render(await renderTreeWithEffects(injected.tab.component));

  for (const chunk of DIGEST_CHUNKS_REST) emitAgent("preview-run", chunk);
  emitAgentDone("preview-run");
  await new Promise((r) => setTimeout(r, 60));
  const full = render(await renderTreeWithEffects(injected.tab.component));
  return { half, full };
})();

/* 讨论成功回执：点一行「讨论」之后页面上会多一句「已在侧栏为 … 开了会话」。
 * 这一屏专门核对那句提示的层级——它必须读起来比榜单说明更「是你刚才做的事」，
 * 又不能在扫榜时抢掉仓库名的注意力。 */
const discussHtml = await (async () => {
  let discTab = null;
  const discMod = await import(pathToFileURL(path.join(ROOT, "main.js")).href + "?discuss=1");
  discMod.default(
    Object.assign({}, ctx, {
      ui: Object.assign({}, ctx.ui, {
        registerCenterTab: (d) => {
          discTab = d;
          return () => {};
        },
        registerSidebarNav: () => () => {},
        registerSettingsSection: () => () => {},
        registerCommand: () => () => {},
      }),
    }),
  );
  if (!discTab) return "";
  await new Promise((r) => setTimeout(r, 60));

  const findDiscuss = (node) => {
    let hit = null;
    const walkTree = (n) => {
      if (hit || !n || typeof n !== "object") return;
      if (Array.isArray(n)) return n.forEach(walkTree);
      const c = n.props && n.props.className;
      if (typeof c === "string" && c.split(/\s+/).includes("gt-discuss")) {
        hit = n;
        return;
      }
      (n.children || []).forEach(walkTree);
    };
    walkTree(node);
    return hit;
  };

  const btn = findDiscuss(await renderTreeWithEffects(discTab.component));
  if (!btn) return "";
  btn.props.onClick();
  await new Promise((r) => setTimeout(r, 120));
  return render(await renderTreeWithEffects(discTab.component));
})();

/* 抓取中的样子：另开一份模块实例（独立 store），让 Trending 请求一直挂起，
 * 这样就能抓到「第一次打开、还没数据」的那一屏。 */
holdTrending = true;
let loadingTab = null;
const loadingMod = await import(pathToFileURL(path.join(ROOT, "main.js")).href + "?loading=1");
const noopUi = {
  registerCenterTab: (d) => {
    loadingTab = d;
    return () => {};
  },
  registerSidebarNav: () => () => {},
  registerSettingsSection: () => () => {},
  registerCommand: () => () => {},
  openCenterTab: () => {},
  openSettings: () => {},
};
loadingMod.default(Object.assign({}, ctx, { ui: noopUi }));
await new Promise((r) => setTimeout(r, 60));
const loadingHtml = await renderWithEffects(loadingTab.component);
holdTrending = false;

/* 「首次抓取」：没有历史快照。这是最容易看错的一屏——
 * 一行标签都不该出现，但名次徽章必须在，否则整行只剩仓库名。 */
let firstTab = null;
const firstMod = await import(pathToFileURL(path.join(ROOT, "main.js")).href + "?first=1");
firstMod.default(
  Object.assign({}, ctx, {
    ui: Object.assign({}, noopUi, {
      registerCenterTab: (d) => {
        firstTab = d;
        return () => {};
      },
    }),
    // 没有历史：读快照一律返回 null（真机上就是第一次装插件的样子）
    documentStorage: Object.assign({}, ctx.documentStorage, { readText: async () => null }),
  }),
);
await new Promise((r) => setTimeout(r, 60));
const firstHtml = await renderWithEffects(firstTab.component);

/* 深色一份：骨架屏、转圈、涨跌色都必须在深色下确认过 */
const asDark = (s) => s.replace(/class="gt-root"/g, 'class="gt-root dark"');
const darkLoadingHtml = asDark(loadingHtml);
const darkTabHtml = asDark(tabHtml);

if (process.argv.includes("--dump")) {
  process.stdout.write(tabHtml + "\n");
}

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>每日热点 · 样式预览</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; background: #f7f8fa; font-family: -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif; }
  .frame { max-width: 1100px; margin: 0 auto; padding: 32px 40px 80px; }
  .frame > h1 { font-size: 15px; font-weight: 600; color: #6b6b6b; margin: 0 0 20px; }
  .frame > h2 { font-size: 13px; font-weight: 600; color: #8a8a8a; margin: 40px 0 12px; text-transform: uppercase; letter-spacing: .04em; }
  .tab-host { height: 720px; display: flex; border: 1px solid #e6e6e6; border-radius: 12px; overflow: hidden; background: #fff; }
  .tab-host > * { flex: 1; min-width: 0; }
  .tab-host.dark { background: #101214; border-color: #2a2d32; }
  .dark .tab-host { background: #101214; border-color: #2a2d32; }
  ${css}
</style>
</head>
<body>
<div class="frame">
  <h1>每日热点 · 样式预览（真实组件 + 真实 CSS）</h1>
  <h2>中心页签 · 首次抓取中</h2>
  <div class="tab-host" id="tab-loading"></div>
  <h2>中心页签 · 首次抓取（无历史快照）</h2>
  <div class="tab-host" id="tab-first"></div>
  <h2>中心页签 · 榜单</h2>
  <div class="tab-host" id="tab-host"></div>
  <h2>中心页签 · 首次抓取中（深色）</h2>
  <div class="tab-host dark" id="tab-loading-dark"></div>
  <h2>中心页签 · 榜单（深色）</h2>
  <div class="tab-host dark" id="tab-host-dark"></div>
  <h2>中心页签 · 点「讨论」后的回执</h2>
  <div class="tab-host" id="tab-discuss"></div>
  <h2>中心页签 · 点「讨论」后的回执（深色）</h2>
  <div class="tab-host dark" id="tab-discuss-dark"></div>
  <h2>解读 · 生成中（流式渲染 Markdown）</h2>
  <div class="tab-host" id="tab-digest-half"></div>
  <h2>解读 · 完成（表格 + 粗体 + 行内代码）</h2>
  <div class="tab-host" id="tab-digest-full"></div>
  <h2>解读 · 完成（深色）</h2>
  <div class="tab-host dark" id="tab-digest-full-dark"></div>
  <h2>设置页</h2>
  ${settingsHtml}
</div>
<script>
  // 主面板数据靠组件挂载后的 effect 拉取；预览里没有网络，直接把渲染结果塞进去。
  document.getElementById("tab-host").innerHTML = ${JSON.stringify(tabHtml)};
  document.getElementById("tab-loading").innerHTML = ${JSON.stringify(loadingHtml)};
  document.getElementById("tab-first").innerHTML = ${JSON.stringify(firstHtml)};
  document.getElementById("tab-host-dark").innerHTML = ${JSON.stringify(darkTabHtml)};
  document.getElementById("tab-discuss").innerHTML = ${JSON.stringify(discussHtml)};
  document.getElementById("tab-discuss-dark").innerHTML = ${JSON.stringify(asDark(discussHtml))};
  document.getElementById("tab-loading-dark").innerHTML = ${JSON.stringify(darkLoadingHtml)};
  document.getElementById("tab-digest-half").innerHTML = ${JSON.stringify(digestFlow.half)};
  document.getElementById("tab-digest-full").innerHTML = ${JSON.stringify(digestFlow.full)};
  document.getElementById("tab-digest-full-dark").innerHTML = ${JSON.stringify(asDark(digestFlow.full))};
  // 解读在列表下方：把这一屏内部的滚动区滚到底，截图里才看得到正文
  for (const id of ["tab-digest-half", "tab-digest-full", "tab-digest-full-dark"]) {
    const host = document.getElementById(id);
    const scroller = host && host.querySelector(".gt-scroll");
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }
</script>
</body>
</html>`;

fs.writeFileSync(OUT, html, "utf8");
process.stdout.write("preview -> " + OUT + " (" + Buffer.byteLength(html) + " bytes)\n");
