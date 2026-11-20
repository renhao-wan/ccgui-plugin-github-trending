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

/** 渲染并按 React 的时机跑 effect；返回序列化后的元素树。 */
async function renderWithEffects(component) {
  const tree = render(fakeReact.createElement(component, {}));
  const effects = pendingEffects.splice(0);
  for (const fn of effects) fn();
  await new Promise((r) => setTimeout(r, 150));
  return render(fakeReact.createElement(component, {}));
}

const now = Date.now();
const ctx = {
  react: fakeReact,
  pluginId: "github-trending",
  version: "0.1.0",
  host: { sdkVersion: "0.3.26", appVersion: "1.2.5", locale: "zh-CN", isWeb: false },
  theme: { injectCss: (s) => { injected.css = s; return () => {}; }, setTokens: () => () => {} },
  storage: { get: async () => null, set: async () => {}, delete: async () => {} },
  documentStorage: {
    // 给一份「上次快照」，让排名变化与新上榜在预览里能看出来
    readText: async (rel) => {
      if (!/daily-all\.json$/.test(rel)) return null;
      const prev = [
        { repo: "jingyaogong/minimind" },
        { repo: "elementalsouls/Claude-BugHunter" },
        { repo: "HKUDS/CLI-Anything" },
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
  },  events: { on: () => () => {}, emit: () => {} },
  workspaces: {
    list: async () => [
      { id: "1", path: "D:/projects/claudecode-plugings/cc-wrapped", name: "cc-wrapped", lastOpenedAt: now },
      { id: "2", path: "D:/projects/claudecode-plugings/ccgui-plugin-worklog", name: "ccgui-plugin-worklog", lastOpenedAt: now - 1000 },
      { id: "3", path: "D:/projects/school/compiler", name: "compiler", lastOpenedAt: now - 5000 },
    ],
  },
  models: {
    listEngines: async () => [
      { id: "claude", name: "Claude", enabled: true },
      { id: "codex", name: "Codex", enabled: true },
      { id: "qoder", name: "Qoder", enabled: true },
    ],
    listEngineModels: async () => ({ models: [{ id: "claude-sonnet-5" }, { id: "claude-opus-5" }] }),
  },
  agent: { start: async () => ({ runId: "preview", sessionId: null }), interrupt: async () => true },
  bridge: {
    invoke: async (_cmd, args) => {
      if (String(args.url).includes("/trending")) return { status: 200, body: TRENDING_HTML() };
      return { status: 200, body: JSON.stringify({ total_count: 0, items: [] }) };
    },
  },
};

/** 和真实 trending 页面同构的样本，让预览走真实解析路径。 */
function TRENDING_HTML() {
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
  ${css}
</style>
</head>
<body>
<div class="frame">
  <h1>每日热点 · 样式预览（真实组件 + 真实 CSS）</h1>
  <h2>中心页签 · 榜单</h2>
  <div class="tab-host" id="tab-host"></div>
  <h2>设置页</h2>
  ${settingsHtml}
</div>
<script>
  // 主面板数据靠组件挂载后的 effect 拉取；预览里没有网络，直接把渲染结果塞进去。
  document.getElementById("tab-host").innerHTML = ${JSON.stringify(tabHtml)};
</script>
</body>
</html>`;

fs.writeFileSync(OUT, html, "utf8");
process.stdout.write("preview -> " + OUT + " (" + Buffer.byteLength(html) + " bytes)\n");
