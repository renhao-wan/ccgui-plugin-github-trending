# 每日热点 · CC GUI 插件

在 CC GUI 里每天看一眼 GitHub 上什么在热：**Trending 日/周/月榜** + **近 7 天新建的高增长仓库**，带新上榜、掉榜与排名变化；想随便逛逛时可以抽一批热门仓库，或按仓库名去 GitHub 搜。需要时再让模型写一段中文解读。

数据只在本机处理，不经过任何第三方服务。

## 功能

- **Trending 榜**：跟随 `github.com/trending` 的 日 / 周 / 月 三档，可按语言筛选
- **新星库**：近 7 天新建、star 达到阈值的仓库（GitHub Search API）
- **随便看看**：「换一批」从热门仓库里抽一批（随机 star 档位 + 随机页），或按**仓库名**去 GitHub 搜索。这批不是排行榜，没有名次与涨跌，页面和解读都会说明来源——这样「生成解读」写的是「这批里」而不是「今天」
- **变化对比**：与上一次成功快照相比，标出「新上榜 ↑ 降位 ↓」并列出掉榜
- **榜单内筛选**：在已加载的这批里按仓库名 / 描述 / 语言即时过滤，不发请求；复制 Markdown 与「生成解读」都只处理筛出来的行，标题和 prompt 会写明这是筛选后的子集
- **中文解读**：点「生成解读」才调用模型，读完可自己判断要不要看。多次生成**复用同一条后台会话**（id 落盘在设置里），不会每次都往宿主的会话库里新塞一条
- **单项目讨论**：榜单每一行悬停时出现「讨论」，在 AI 工作区里起一个宿主聊天会话，模型先找本地副本、找不到再只读远程公开页面（**明确禁止 `git clone`、禁止往工作区写文件**）；会话出现在侧栏，**本页不会自动跳转**（页面会给出回执，点侧栏那一行打开）。第一次开会话时会把 AI 工作目录登记成侧栏工作区（侧栏随之多出一个以目录名命名的分组），否则宿主的会话表不收这个目录的会话，侧栏里看不见。**同一个仓库再点「讨论」时直接打开那条已有会话，不重跑模型**——会话 id 落盘在设置里，插件重装/重新激活之后仍然认得
- **自定义讨论提示词**：设置里有一份**系统内置模板**（始终排在首位、标「系统」、不可删除），点「讨论」默认就用它。想换个角度分析时存一份新的，再点「设为默认」切过去；内置那份永远在，删掉自定义的会回落回它
- **续接策略可选**：同一个仓库再点一次「讨论」时怎么办，设置里三选一——同一份榜单内复用（默认，刷新/换榜后新开）、总是复用、总是新开。「复用」走的是宿主的 `selectSession`，**只是把侧栏切到那条会话，不花 token**
- **README 预览**：同一行的「README」就地展开前 2000 字（标题、列表、代码块照常渲染，代码块内的 `<T>`、`![alt](url)` 不会被当成 HTML/图片删掉），不用跳浏览器；只显示开头，想看全文点「在 GitHub 上查看」。优先读 `raw.githubusercontent.com`（**不占 API 配额**，限流期间照样能看），试过 `README.md` / `README.markdown` / `README.rst` 都没命中时，回落到 `api.github.com/repos/<owner>/<name>/readme`（认全部文件名变体，也能用 Token 读私有仓）。同一场会话里重复展开同一个仓库不再重走网络（只在内存里缓存，上限 30 条，不落盘、重新激活即清空）；失败结果不缓存，下次展开会重试
- **复制 Markdown**：工具栏一键把当前榜单复制成 Markdown（标题 + 时间 + 链接条目 + 掉榜清单），可以直接粘进周报、issue 或笔记
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
| `network:api.github.com` | 新星库 / 随便看看 / 仓库名搜索；README 在 raw 没命中时回落这里读取。可选 Token 只发给这个域名 |
| `network:raw.githubusercontent.com` | README 的主路径：**不占 API 配额**、不需要 Token，只请求公开文件 |
| `agent` | 「生成解读」时起一个只读的后台轮次；引擎清单来自宿主的 `agent.catalog()` |
| `assets:directory` | 设置页里用系统文件夹选择器指定 AI 工作区 |
| `host:session` | 「讨论」通过 `sessions.startRun` 起一个可在侧栏接管的聊天会话 |
| `host:workspace` | 开会话前把 AI 工作目录登记成侧栏工作区（宿主只收已登记工作区下的会话） |
| `ui:center-tab` / `ui:sidebar-entry` / `ui:settings-section` / `ui:command` | 界面入口 |
| `storage` / `plugin.storage` | 设置与历史快照 |
| `theme` / `events` | 注入样式、接收 agent 事件流 |

**没有** `exec:*`：不执行任何本机命令。

## 隐私边界

- 只访问 `github.com`、`api.github.com` 与 `raw.githubusercontent.com` 三个域名。
- 榜单与解读只在本机显示；解读不会自动写入任何文件。
- 历史快照存在插件数据目录（默认 `plugin-data/github-trending/history/`），随时可在插件详情页清空。
- 「生成解读」与「讨论」的模型进程默认都在插件数据目录下运行（设置页可改成别的目录），因此不会把这些记录混进某个真实项目的工作区历史。
- 「讨论」的会话归宿主管；插件自己不保存对话内容，会话历史按宿主的会话规则留存。为了让会话在侧栏可见，点「讨论」时会把 AI 工作目录登记为侧栏工作区——默认就是插件数据目录，不会碰你的项目；侧栏里会多出一个以该目录名命名的分组，不需要时可在侧栏移除（下次点讨论会重新登记）。
- GitHub Token 存在本机插件数据里，只作为 `Authorization` 头发给 `api.github.com`，**绝不发给 `raw.githubusercontent.com`**；不填也能用（搜索接口未认证 10 次/分钟，README 走 raw 不占配额）。

## 已知限制

- GitHub **没有** 官方的 trending API。本项目解析 `github.com/trending` 的 HTML，页面结构变化时会在界面上明确提示「页面结构可能已变化」，而不是显示空榜单。
- 首次抓取没有历史可对比，所以不会标「新上榜」；第二次刷新开始才有排名变化。
- 新星库与「随便看看」受 GitHub 搜索限流约束（未认证 10 次/分钟）；README 预览走核心接口，未认证 60 次/小时。遇到限流会提示，并保留上一次的结果。
- **「随便看看」的「随机」是伪随机**：GitHub Search 没有 random 排序，且任何查询最多只能翻到前 1000 条。所以每次是「随机 star 档位 × 随机页」，换几次可能撞上同一批；搜索只匹配仓库名（`in:name`），输入里的 `stars:`/`language:` 这类限定符会按字面量处理，不会被当成搜索语法。
- 「随便看看」不会落盘快照：随机批次与搜索结果之间没有可比的排名，切回来是一批新的。
- 解读有超时保护（默认 120 秒，开会话 30 秒）。超时会告诉用户原因，并**同时打断宿主侧进程**，不会在插件放手后继续消耗 token。
- 「讨论」用到 `host:session` 与 `host:workspace`：从旧版本升级后需要重新「从本地目录安装」一次，权限只在安装时生效。
- 续接只对**拿得到 sessionId** 的会话生效。宿主文档写明引擎可能稍后才 announce 会话 ID，那一刻返回 `null`——这种情况下同一行再点会新开一个会话，而不是报错，无论选了哪种续接策略。拿得到 id 时会存进设置（`discussSessionIds`），重装/重启后仍然认得；id 对应会话被删除时自动退回新开并清掉这条记录。**会话 id 按引擎分槽记录**：同一个仓库在 claude 和 codex 下各有一条，换引擎聊完再切回去，原来那条仍然认得。
- 「讨论」的 prompt 明确禁止 `git clone`：插件数据目录不是谁的项目，在那里克隆会留下几百 MB 用户永远不会清理的东西。想读完整代码，把侧栏那条会话移到自己的项目目录即可。
- 自定义提示词里写错占位符（比如 `{{ repoo }}`）不会被吞掉，会原样留在 prompt 里，方便自己发现。
- 解读质量取决于所选引擎与模型；插件只负责把榜单事实整理成清单，不替模型编造细节。

## 开发

```bash
npm run build     # 把 src/lib/*.mjs 内联进 main.js
npm test          # 纯函数单测（解析 / 搜索归一化 / 随机抽样与搜索词 / 本地筛选 / 对比 / prompt 预算与模板 / 复制 Markdown / README 预处理）
npm run smoke     # 假宿主冒烟：刷新 → 列表 → 解读 → 讨论 → 随便看看 → 停止 → 限流 → 卸载
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
src/lib/discover.mjs  # 随便看看：随机 star 档位/页、仓库名搜索词、精确命中
src/lib/filter.mjs    # 榜单内本地筛选：关键词收敛、多字段匹配、复制说明
src/lib/diff.mjs      # 快照对比：新上榜 / 掉榜 / 排名变化
src/lib/prompt.mjs    # 解读 prompt、讨论模板与占位符、提示词列表归一化
src/lib/report.mjs    # 榜单 → Markdown（工具栏「复制 Markdown」）
src/lib/readme.mjs    # README 去 badge/HTML、截断、base64 还原
src/lib/catalog.mjs   # 宿主引擎清单 → agent.start 参数（readOnly / 工作区）
scripts/build.mjs     # 内联构建（剥掉 export 前缀）
scripts/smoke.mjs     # 假宿主冒烟
scripts/validate-manifest.mjs
test/                 # node:test
```

`src/lib/*.mjs` 必须零 `import`、只做纯函数——单测直接 import 源文件，构建时正文被拼进 `main.js` 的同作用域。

## 许可

MIT
