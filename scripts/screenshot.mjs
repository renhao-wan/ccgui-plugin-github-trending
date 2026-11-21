// README / 市场详情页的产品图：真实组件 + 真实 CSS + 真实 GitHub 数据，交给 headless Chrome 截图。
// 仅开发用，不进发布包（manifest 只挂 main.js）。换一屏：SHOT_README=owner/name node scripts/screenshot.mjs
//
// 本机到 github.com 的网页请求可能不通（api.github.com 与 raw 正常）。那时榜单正文喂一份
// 与真实 trending 页面同构的 HTML，README 预览仍走 raw.githubusercontent.com 真读。
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
// 中间产物不落仓库：.gitignore 里已经有 .tmp/
const TMP = path.join(ROOT, ".tmp");
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
const PLUGIN = pathToFileURL(path.join(ROOT, "main.js")).href;
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const kebab = (s) => s.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());

/* ------------------------------------------------------------ React 替身 */

let effects = [];

const R = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (init) => [typeof init === "function" ? init() : init, () => {}],
  useEffect: (fn) => effects.push(fn),
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn(),
  useRef: (init) => ({ current: init === undefined ? null : init }),
  useSyncExternalStore: (_sub, get) => get(),
};

function expand(node) {
  if (Array.isArray(node)) return node.map(expand);
  if (!node || typeof node !== "object") return node;
  if (typeof node.type === "function") {
    return expand(node.type(Object.assign({}, node.props || {}, { children: node.children || [] })));
  }
  return Object.assign({}, node, { children: (node.children || []).map(expand) });
}

async function renderTree(component) {
  expand(R.createElement(component, {}));
  const pending = effects.splice(0);
  for (const fn of pending) {
    try {
      await fn();
    } catch {
      /* 预览里允许失败 */
    }
  }
  return expand(R.createElement(component, {}));
}

function textOf(node) {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (!node || typeof node !== "object") return "";
  return (node.children || []).map(textOf).join("");
}

function find(node, pred) {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = find(n, pred);
      if (hit) return hit;
    }
    return null;
  }
  if (pred(node)) return node;
  return find(node.children || [], pred);
}
const byText = (node, text) => find(node, (n) => n.type === "button" && textOf(n).includes(text));
const byClass = (node, cls) =>
  find(node, (n) => {
    const c = n.props && n.props.className;
    return typeof c === "string" && c.split(/\s+/).includes(cls);
  });

/* ------------------------------------------------------------ HTML 化 */

const VOID = new Set(["input", "br", "hr", "img", "meta", "link"]);

function toHtml(node) {
  if (node == null || node === true || node === false) return "";
  if (Array.isArray(node)) return node.map(toHtml).join("");
  if (typeof node === "string" || typeof node === "number") return esc(node);
  const { type } = node;
  const props = node.props || {};
  const children = node.children || [];
  if (typeof type === "function") return toHtml(expand(node));
  const attrs = [];
  for (const [k, v] of Object.entries(props)) {
    if (k === "children" || k === "key" || k === "ref" || k === "value" || k.startsWith("on")) continue;
    if (k === "className") attrs.push('class="' + esc(v) + '"');
    else if (k === "style" && v && typeof v === "object") {
      attrs.push('style="' + Object.entries(v).map(([a, b]) => kebab(a) + ":" + b).join(";") + '"');
    } else if (k === "spellCheck" || k === "aria-busy") continue;
    else if (typeof v === "boolean") {
      if (v) attrs.push(k);
    } else if (v != null) attrs.push(k + '="' + esc(v) + '"');
  }
  if (type === "input")
    return "<input" + (attrs.length ? " " + attrs.join(" ") : "") + " />";
  if (VOID.has(type)) return "<" + type + (attrs.length ? " " + attrs.join(" ") : "") + ">";
  return "<" + type + (attrs.length ? " " + attrs.join(" ") : "") + ">" + children.map(toHtml).join("") + "</" + type + ">";
}

/* ------------------------------------------------------------ 假宿主 */

const storageData = new Map();
const snapshotFiles = new Map();
const eventHandlers = new Map();

const DEMO_PREVIOUS = [
  "obra/superpowers",
  "firecrawl/firecrawl",
  "elementalsouls/Claude-BugHunter",
  "jingyaogong/minimind",
  "nginx/nginx",
  "old/dropped",
  "HKUDS/CLI-Anything",
];
snapshotFiles.set(
  "history/daily-all.json",
  JSON.stringify({
    savedAt: new Date(Date.now() - 86400000).toISOString(),
    repos: DEMO_PREVIOUS.map((repo) => ({ repo })),
  }),
);

/* 本机到 github.com 的网页请求不通（api.github.com 与 raw 正常）。所以榜单正文
 * 用一份**与真实 trending 页面同构**的 HTML 喂进去——数据来自上一次成功抓取
 * （2026-11-22 02:40），走的是插件自己的解析器，不是手拼 DOM。
 * README 预览仍然是当场从 raw.githubusercontent.com 真读的。 */
const TRENDING_HTML = (() => {
  const rows = [
    ["elementalsouls/Claude-BugHunter", "A Claude Code skill bundle for bug hunting and external red-team work - 82 skills, 15 slash commands, 681 disclosed-report patterns curated across 24 core vulnerability classes, plus enterprise identity + infrastructure attack matrices.", "Python", "#3572A5", "15,662", "1,802", "1,794"],
    ["obra/superpowers", "An agentic skills framework & software development methodology that works.", "Shell", "#89e051", "323,562", "28,703", "884"],
    ["HKUDS/CLI-Anything", "\"CLI-Anything: Making ALL Software Agent-Native\" -- CLI-Hub: https://clianything.cc/", "Python", "#3572A5", "61,935", "5,609", "767"],
    ["jingyaogong/minimind", "🧠 两小时从 0 训出你的 64M 大模型。Train your own 64M LLM from scratch in 2 hours.", "Python", "#3572A5", "68,075", "8,899", "488"],
    ["cursor/plugins", "Cursor plugin specification and official plugins", "TypeScript", "#3178c6", "18,047", "1,969", "261"],
  ];
  return rows
    .map(([repo, desc, lang, color, stars, forks, gain]) => {
      const [owner, name] = repo.split("/");
      return `<article class="Box-row">
  <h2 class="h3 lh-condensed"><a href="/${repo}" class="Link"><span class="text-normal">${owner} /</span> ${name}</a></h2>
  <p class="col-9 color-fg-muted my-1 tmp-pr-4">${desc}</p>
  <div class="f6 color-fg-muted mt-2">
    <span class="tmp-mr-3 d-inline-block ml-0"><span class="repo-language-color" style="background-color: ${color}"></span>
    <span itemprop="programmingLanguage">${lang}</span></span>
    <a href="/${repo}/stargazers" class="Link Link--muted">${stars}</a>
    <a href="/${repo}/forks" class="Link Link--muted">${forks}</a>
    <span class="d-inline-block"><span>${gain} stars today</span></span>
  </div>
</article>`;
    })
    .join("\n");
})();
const isTrending = (url) => /^https:\/\/github\.com\/trending/.test(String(url));

const ctx = {
  react: R,
  pluginId: MANIFEST.id,
  version: MANIFEST.version,
  host: { sdkVersion: "0.3.26", appVersion: "1.2.5", locale: "zh-CN", isWeb: false },
  theme: { injectCss: () => () => {}, setTokens: () => () => {} },
  storage: {
    get: async (k) => (storageData.has(k) ? storageData.get(k) : null),
    set: async (k, v) => void storageData.set(k, v),
    delete: async (k) => void storageData.delete(k),
  },
  documentStorage: {
    getLocation: async () => ({ kind: "data", path: "C:/Users/demo/.ccgui-next/plugin-data/github-trending" }),
    readText: async (rel) => {
      const key = String(rel).replace(/\\/g, "/");
      return snapshotFiles.has(key) ? { content: snapshotFiles.get(key), version: "1" } : null;
    },
    writeTextAtomic: async (rel, content) => {
      snapshotFiles.set(String(rel).replace(/\\/g, "/"), content);
      return { version: String(Date.now()) };
    },
    remove: async () => {},
    list: async () => [],
    selectLocation: async () => ({ kind: "data", path: "C:/Users/demo/.ccgui-next/plugin-data/github-trending" }),
  },
  ui: {
    registerCenterTab: (d) => {
      settings.tab = d;
      return () => {};
    },
    registerSidebarNav: () => () => {},
    registerSettingsSection: () => () => {},
    registerCommand: () => () => {},
    openCenterTab: () => {},
    openSettings: () => {},
  },
  events: {
    on: (topic, cb) => {
      if (!eventHandlers.has(topic)) eventHandlers.set(topic, new Set());
      eventHandlers.get(topic).add(cb);
      return () => eventHandlers.get(topic).delete(cb);
    },
    emit: () => {},
  },
  assets: { grantDirectory: async () => ({ grantId: "shot", path: "C:/Users/demo/.ccgui-next/plugin-data/github-trending" }) },
  agent: {
    catalog: async () => [
      {
        engine: "claude",
        label: "Claude Code",
        available: true,
        readOnly: false,
        providers: [],
        models: [{ id: "claude-sonnet-5", label: "Sonnet 5" }],
        efforts: ["low", "medium", "high"],
      },
    ],
    start: async () => ({ runId: "shot-run", sessionId: null }),
    interrupt: async () => true,
  },
  sessions: { startRun: async () => ({ runId: "shot-srun", sessionId: null }), interruptRun: async () => {} },
  bridge: {
    // 榜单用同构样本（github.com 本机连不通），README 走真实 raw 请求。
    invoke: async (cmd, args) => {
      if (cmd !== "plugin_http_request") throw new Error("unexpected " + cmd);
      if (isTrending(args.url)) return { status: 200, body: TRENDING_HTML };
      const t0 = Date.now();
      try {
        const res = await fetch(args.url, { headers: args.headers || {} });
        const body = await res.text();
        console.log("[http]", res.status, body.length, "bytes", Date.now() - t0 + "ms", String(args.url).slice(0, 60));
        return { status: res.status, body };
      } catch (error) {
        console.log("[http] FAILED", Date.now() - t0 + "ms", String(args.url).slice(0, 60), String(error && error.message));
        throw error;
      }
    },
  },
};
const settings = {};

/* ------------------------------------------------------------ 渲染 */

const mod = await import(PLUGIN + "?shot=" + Date.now());
mod.default(ctx);
await sleep(50);
if (!settings.tab) throw new Error("没有登记中心页签");

// 首次挂载会自己拉一次榜单；给它网络时间。GitHub 有时要十几秒。
let tree = await renderTree(settings.tab.component);
let ready = false;
for (let i = 0; i < 240; i += 1) {
  await sleep(500);
  tree = await renderTree(settings.tab.component);
  const flat = textOf(tree);
  if (i % 10 === 0) console.log("waiting…", i / 2 + "s", flat.slice(-60));
  if (flat.includes("★")) {
    ready = true;
    break;
  }
  // 失败也要立刻报出来，否则只会看到「一直转圈」
  const err = flat.match(/连不上 GitHub[^。]*。|GitHub (?:返回|拒绝)[^。]*。/);
  if (err) throw new Error("抓取失败：" + err[0]);
}
if (!ready) throw new Error("等了 120s 榜单还没出来");
await sleep(300);
tree = await renderTree(settings.tab.component);

// 展开一行的 README：README 预览是「不用跳浏览器」那一段的活证据。
// 用 aria-label 定位，不受行序影响。`SHOT_README=<owner/name>` 可换一行。
const WANT_README = process.env.SHOT_README || "obra/superpowers";
const readmeBtn = find(
  tree,
  (n) => n.type === "button" && String((n.props && (n.props["aria-label"] || n.props.title)) || "").includes(WANT_README) && /README/.test(String((n.props && n.props["aria-label"]) || "")),
);
if (!readmeBtn) throw new Error("找不到 " + WANT_README + " 的 README 按钮");
await readmeBtn.props.onClick();
for (let i = 0; i < 25; i += 1) {
  await sleep(200);
  tree = await renderTree(settings.tab.component);
  const panel = byClass(tree, "gt-readme");
  if (panel && !/正在读 README/.test(textOf(panel))) break;
}

// 生成解读：走真实事件通道，先推几段再 done。
const digestBtn = byText(tree, "生成解读");
if (!digestBtn) throw new Error("找不到生成解读按钮");
digestBtn.props.onClick();
await sleep(200);

const CHUNKS = [
  "### 今天在热什么\n\n",
  "榜单头部集中在一件事上：**让 agent 真的能干活的工具链**。`skills`、`plugin`、`CLI` 这类给模型铺路的项目占了前五里的四个。\n\n",
  "### 值得看的项目\n\n",
  "| 仓库 | 方向 | 解决什么问题 |\n",
  "| --- | --- | --- |\n",
  "| `obra/superpowers` | agent 技能框架 | 把一套开发方法论固化成技能包，让模型按流程走 |\n",
  "| `elementalsouls/Claude-BugHunter` | 安全审计技能集 | 82 个技能 + 15 个命令，覆盖 24 类漏洞的披露报告模式 |\n",
  "| `HKUDS/CLI-Anything` | CLI 基建 | 把任意软件包装成 agent 能直接调用的命令 |\n",
  "| `cursor/plugins` | 编辑器插件规范 | 给 Cursor 定义一套可复用的插件契约 |\n",
  "\n### 一句话结论\n\n",
  "如果只想点开一个，选 **`obra/superpowers`**：它不是在教模型写代码，而是在教模型怎么按流程做事。\n",
];
for (const txt of CHUNKS) {
  for (const cb of eventHandlers.get("agent://" + MANIFEST.id) || []) cb({ runId: "shot-run", kind: "delta", data: txt });
  await sleep(10);
}
for (const cb of eventHandlers.get("agent://" + MANIFEST.id) || []) cb({ runId: "shot-run", kind: "done", data: null });
await sleep(300);
tree = await renderTree(settings.tab.component);

/* ------------------------------------------------------------ 输出页面 */

let html = toHtml(tree);

/* 只留前几行：完整榜单十几行会把图拉到 2900px 高，缩到 README 宽度后字小得看不清。
 * 保留「名次 + 涨跌 + 新上榜 + 掉榜 + 解读」这几样能说明功能的东西就够了。 */
const KEEP_ROWS = 5;
function keepRows(src, n) {
  const OPEN = '<li class="gt-row">';
  let pos = 0;
  let kept = 0;
  let end = -1;
  for (;;) {
    const i = src.indexOf(OPEN, pos);
    if (i < 0) break;
    // 行内 README 的 Markdown 也可能渲染出 <li>，按标签配对找真正的那一行结束
    let depth = 0;
    let p = i;
    let close = -1;
    for (;;) {
      const nextOpen = src.indexOf("<li", p);
      const nextClose = src.indexOf("</li>", p);
      if (nextClose < 0) break;
      if (nextOpen >= 0 && nextOpen < nextClose) {
        depth += 1;
        p = nextOpen + 3;
      } else {
        depth -= 1;
        p = nextClose + 5;
        if (depth === 0) {
          close = p;
          break;
        }
      }
    }
    if (close < 0) break;
    kept += 1;
    pos = close;
    if (kept === n) {
      end = close;
      break;
    }
  }
  if (end < 0) return src;
  const tail = src.indexOf("</ol>", end);
  return src.slice(0, end) + (tail >= 0 ? src.slice(tail) : "");
}
html = keepRows(html, KEEP_ROWS);
html = html.replace(/显示全部 \d+ 个/, "显示全部 " + KEEP_ROWS + " 个");

// 悬停才浮现的「README / 讨论」：只把展开了 README 的那一行点亮。
const markAt = html.indexOf('class="gt-readme"');
const liAt = markAt >= 0 ? html.lastIndexOf('<li class="gt-row">', markAt) : -1;
if (liAt >= 0) html = html.slice(0, liAt) + '<li class="gt-row is-shot-hover">' + html.slice(liAt + '<li class="gt-row">'.length);

const css = /const CSS = `([\s\S]*?)`;/.exec(fs.readFileSync(path.join(ROOT, "main.js"), "utf8"))[1];

const page = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<style>
html,body{margin:0;padding:0;background:#f4f5f7;}
body{font-family:-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",system-ui,sans-serif;}
.frame{width:1240px;margin:0 auto;padding:28px 30px 34px;box-sizing:border-box;background:#f4f5f7;}
.window{background:#fff;border:1px solid #e3e6ea;border-radius:12px;overflow:hidden;box-shadow:0 18px 44px rgba(16,24,40,.10),0 2px 6px rgba(16,24,40,.05);}
.window-bar{display:flex;align-items:center;gap:8px;height:38px;padding:0 14px;border-bottom:1px solid #eceff2;background:#fbfcfd;}
.window-bar i{width:10px;height:10px;border-radius:50%;background:#ddE2e8;display:block;}
.window-bar span{margin-left:10px;font-size:12px;color:#8a919a;}
.viewport{padding:20px 26px 22px;background:#fff;}
.viewport .gt-root{height:auto;}
.viewport .gt-scroll{overflow:visible;}
.is-shot-hover .gt-discuss{opacity:1;}
.is-shot-hover{background:var(--gt-raised);border-color:var(--gt-accent);}
${css}
</style></head><body>
<div class="frame"><div class="window">
  <div class="window-bar"><i></i><i></i><i></i><span>CC GUI — 每日热点</span></div>
  <div class="viewport">${html}</div>
</div></div>
<div id="measure" style="display:none">0</div>
<script>
  addEventListener("load", () => {
    const f = document.querySelector(".frame");
    document.getElementById("measure").textContent = Math.ceil(f.getBoundingClientRect().height + 1);
  });
</script>
</body></html>`;

const htmlFile = path.join(TMP, "readme-shot.html");
fs.mkdirSync(TMP, { recursive: true });
fs.writeFileSync(htmlFile, page, "utf8");
console.log("html:", page.length, "bytes");

const dom = execFileSync(
  CHROME,
  ["--headless=new", "--disable-gpu", "--allow-file-access-from-files", "--window-size=1240,900", "--virtual-time-budget=3000", "--dump-dom", pathToFileURL(htmlFile).href],
  { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 120000 },
);
const measured = Number((/<div id="measure"[^>]*>(\d+)<\/div>/.exec(dom) || [])[1] || 0);
const pageH = measured > 200 ? measured : 1600;
console.log("page height:", measured, "→ window 1240x" + pageH);

fs.mkdirSync(path.join(ROOT, "docs"), { recursive: true });
const outPng = path.join(ROOT, "docs", "screenshot.png");
execFileSync(
  CHROME,
  [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--force-device-scale-factor=2",
    "--window-size=1240," + pageH,
    "--virtual-time-budget=3000",
    "--screenshot=" + outPng,
    pathToFileURL(htmlFile).href,
  ],
  { stdio: "inherit", timeout: 120000 },
);
console.log("png:", outPng, fs.statSync(outPng).size, "bytes");
