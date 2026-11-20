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
