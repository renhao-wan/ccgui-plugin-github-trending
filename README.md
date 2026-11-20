# 每日热点 · CC GUI 插件

在 CC GUI 里每天看一眼 GitHub 上什么在热：**Trending 日/周/月榜** + **近 7 天新建的高增长仓库**，带新上榜、掉榜与排名变化；需要时再让模型写一段中文解读。

数据只在本机处理，不经过任何第三方服务。

## 功能

- **Trending 榜**：跟随 `github.com/trending` 的 日 / 周 / 月 三档，可按语言筛选
- **新星库**：近 7 天新建、star 达到阈值的仓库（GitHub Search API）
- **变化对比**：与上一次成功快照相比，标出「新上榜 ↑ 降位 ↓」并列出掉榜
- **中文解读**：点「生成解读」才调用模型，读完可自己判断要不要看
- **不打扰**：侧栏徽标只在有新上榜时显示数字；不会后台自动跑

## 安装

1. CC GUI 侧边栏 →「插件」→「从本地目录安装」
2. 选中本目录（含 `manifest.json` 的那一层）
3. 侧栏出现「每日热点」，或命令面板搜「热点」

改动代码后重新走一次「从本地目录安装」即可热重载，不需要重启应用。

## 权限与用途

| 权限 | 用途 |
|---|---|
| `network:github.com` | 抓 `github.com/trending` 公开页面（不占 API 配额） |
| `network:api.github.com` | 新星库搜索；可选 Token 只发给这个域名 |
| `agent` | 「生成解读」时起一个只读的后台轮次 |
| `host:workspace` | 解析默认工作区（agent 进程的工作目录） |
| `host:models` | 设置页的引擎 / 模型下拉 |
| `ui:center-tab` / `ui:sidebar-entry` / `ui:settings-section` / `ui:command` | 界面入口 |
| `storage` / `plugin.storage` | 设置与历史快照 |
| `theme` / `events` | 注入样式、接收 agent 事件流 |

**没有** `exec:*`：不执行任何本机命令。

## 隐私边界

- 只访问 `github.com` 与 `api.github.com` 两个域名。
- 榜单与解读只在本机显示；解读不会自动写入任何文件。
- 历史快照存在插件数据目录（默认 `plugin-data/github-trending/history/`），随时可在插件详情页清空。
- GitHub Token 存在本机插件数据里，只作为 `Authorization` 头发给 `api.github.com`；不填也能用（未认证时搜索接口 10 次/分钟）。

## 已知限制

- GitHub **没有** 官方的 trending API。本项目解析 `github.com/trending` 的 HTML，页面结构变化时会在界面上明确提示「页面结构可能已变化」，而不是显示空榜单。
- 首次抓取没有历史可对比，所以不会标「新上榜」；第二次刷新开始才有排名变化。
- 新星库受 GitHub 搜索限流约束（未认证 10 次/分钟）。遇到限流会提示，并保留上一次的结果。
- 解读质量取决于所选引擎与模型；插件只负责把榜单事实整理成清单，不替模型编造细节。

## 开发

```bash
npm run build     # 把 src/lib/*.mjs 内联进 main.js
npm test          # 纯函数单测（解析 / 搜索归一化 / 对比 / prompt 预算）
npm run smoke     # 假宿主冒烟：刷新 → 列表 → 解读 → 停止 → 限流 → 卸载
npm run validate  # manifest、权限 ↔ 调用、禁用写法、产物自检
npm run check     # 上面四步全跑
npm run icon      # 重新生成 docs/icon.png
```

### 目录

```
manifest.json
main.js               # 构建产物，唯一入口（不要手改）
src/main.head.js      # UI、调度、存储、agent
src/lib/parse.mjs     # Trending HTML → 结构化仓库
src/lib/rising.mjs    # Search API → 结构化仓库
src/lib/diff.mjs      # 快照对比：新上榜 / 掉榜 / 排名变化
src/lib/prompt.mjs    # 解读 prompt 与事实预算
scripts/build.mjs     # 内联构建（剥掉 export 前缀）
scripts/smoke.mjs     # 假宿主冒烟
scripts/validate-manifest.mjs
test/                 # node:test
```

`src/lib/*.mjs` 必须零 `import`、只做纯函数——单测直接 import 源文件，构建时正文被拼进 `main.js` 的同作用域。

## 许可

MIT
