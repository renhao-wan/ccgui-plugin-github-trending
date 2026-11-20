// 宿主 catalog 条目到 agent.start 参数的映射。
//
// 这里最容易出错的是 readOnly：catalog 的 readOnly 是「这个引擎能不能做
// 隔离只读运行」，不是「这次调用想不想只读」。宿主对不支持的引擎是直接
// 拒绝整轮（实测 claude 会返回 "does not support isolated plugin read-only
// runs; only Pi and audited local Codex planning are supported"），不是静默
// 降级。所以只有字段明确为 true 才能请求，undefined 一律当作不支持。

/**
 * 该引擎能否接受隔离只读运行。
 * @param {{ readOnly?: unknown } | null | undefined} entry
 * @returns {boolean}
 */
export function supportsReadOnly(entry) {
  return Boolean(entry) && entry.readOnly === true;
}

/**
 * 决定引擎进程的 cwd。优先级：用户显式选择 > 插件数据目录。
 *
 * 默认值这层不是可有可无的兜底：agent 跑一轮会在 ~/.claude/projects 留下会话
 * 记录，cwd 就是这里传的值。挂在真实项目名下，「生成热点解读」这个动作本身
 * 会被那个项目的会话历史记成一次工作产出。
 *
 * 故意没有第三层「侧栏第一个工作区」：留空就该是插件目录，不能悄悄跑到用户的
 * 真实项目里——那样「什么都没选」和「选了项目 A」行为一样，没人能预料 cwd 在哪。
 *
 * @param {{ workspacePath?: unknown }} settings
 * @param {string} ownDir 插件数据目录（拿不到时为空串）
 * @returns {string} 空串表示两者都拿不到，由调用方报错
 */
export function pickWorkspace(settings, ownDir) {
  const configured = String((settings && settings.workspacePath) || "").trim();
  if (configured) return configured;
  return String(ownDir || "").trim();
}
