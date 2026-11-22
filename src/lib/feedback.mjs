/**
 * 反馈渠道的纯函数层：正文归一化、Issue 链接拼装、请求体收敛、响应文案。
 *
 * 全部离线可测。网络与 UI 在 main.head.js 里，这一层只回答「发什么」和
 * 「回什么」，方便把隐私边界钉死在测试里：请求体只允许五个字段。
 */

/** 正文上限。再长就不是一条反馈，而是一篇文档了。 */
export const TEXT_LIMIT = 1000;

/**
 * 收敛用户输入：控制字符折叠成空格、合并连续空白、限长。
 * 保留大小写、中文与 emoji——反馈要原样送到人眼前。
 *
 * @param {unknown} raw
 * @returns {string}
 */
export function normaliseFeedbackText(raw) {
  return String(raw === undefined || raw === null ? "" : raw)
    .replace(/[\u0000-\u001f\u007f�]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, TEXT_LIMIT)
    .trim();
}

/**
 * GitHub 新建 Issue 的预填链接。
 *
 * 用预填而不是直接调 API：API 要 PAT，PAT 写进插件源码等于公开。预填链接
 * 只依赖用户浏览器里已有的登录态，插件一行网络代码都不用写。
 *
 * @param {{repo: string, pluginName: string, text: string, pluginVersion: string, hostVersion: string}} o
 * @returns {string}
 */
export function buildIssueUrl(o) {
  const text = normaliseFeedbackText(o.text);
  const body = [
    text || "_（请在这里描述问题或建议）_",
    "",
    "---",
    "插件：" + String(o.pluginName || "") + " " + String(o.pluginVersion || ""),
    "CC GUI：" + String(o.hostVersion || ""),
  ].join("\n");
  const q = new URLSearchParams({
    title: "[反馈] " + String(o.pluginName || ""),
    body,
  });
  return "https://github.com/" + String(o.repo || "") + "/issues/new?" + q.toString();
}

/** 请求体允许的字段。白名单而非黑名单：漏传字段比误传路径好。 */
const PAYLOAD_FIELDS = ["text", "pluginId", "pluginVersion", "hostVersion", "ts"];

/**
 * 组装发往中转的请求体，只保留白名单字段。
 *
 * @param {object} o
 * @returns {{text: string, pluginId: string, pluginVersion: string, hostVersion: string, ts: number}}
 */
export function buildFeedbackPayload(o) {
  const src = {
    text: normaliseFeedbackText(o.text),
    pluginId: String(o.pluginId || ""),
    pluginVersion: String(o.pluginVersion || ""),
    hostVersion: String(o.hostVersion || ""),
    ts: Number(o.now) || Date.now(),
  };
  const out = {};
  for (const k of PAYLOAD_FIELDS) out[k] = src[k];
  return out;
}

function parseJson(body) {
  if (typeof body !== "string" || !body) return null;
  try {
    const v = JSON.parse(body);
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

/**
 * 把一次中转响应翻译成界面文案。
 *
 * @param {{status?: number, body?: string, error?: Error}} r
 * @returns {{ok: boolean, kind: string, message: string, remaining: number|null}}
 */
export function describeFeedbackResult(r) {
  if (r && r.error) {
    const raw = String(r.error.message || r.error);
    if (/timed?\s*out|timeout/i.test(raw)) {
      return { ok: false, kind: "timeout", message: "发送超时，可改用 GitHub Issue 反馈", remaining: null };
    }
    if (/network:|permission|授权/i.test(raw)) {
      return { ok: false, kind: "denied", message: "网络权限未生效，请重新安装插件", remaining: null };
    }
    return { ok: false, kind: "network", message: "连不上反馈服务，可改用 GitHub Issue 反馈", remaining: null };
  }

  const status = Number(r && r.status) || 0;
  const data = parseJson(r && r.body);
  const remaining = data && Number.isFinite(Number(data.remaining)) ? Number(data.remaining) : null;

  if (status >= 200 && status < 300) {
    return { ok: true, kind: "sent", message: "反馈已发送，谢谢", remaining };
  }
  if (status === 429) {
    return { ok: false, kind: "rate_limited", message: "今天的反馈额度已用完，明天再来", remaining: 0 };
  }
  if (status === 400 || status === 413) {
    return { ok: false, kind: "invalid", message: "反馈内容不合要求，请缩短后重试", remaining };
  }
  return { ok: false, kind: "http", message: "发送失败（HTTP " + status + "），可改用 GitHub Issue 反馈", remaining };
}

/**
 * 额度提示文案。查不到额度时也要给一句话，不能空着。
 *
 * @param {{remaining: number, dailyLimit: number}|null} quota
 * @returns {{remaining: number|null, message: string}}
 */
export function describeQuota(quota) {
  if (!quota || !Number.isFinite(Number(quota.remaining))) {
    return { remaining: null, message: "额度有限，请勿刷屏" };
  }
  const remaining = Math.max(0, Number(quota.remaining));
  if (remaining === 0) {
    return { remaining: 0, message: "今天的反馈额度已用完，明天再来" };
  }
  return { remaining, message: "今天还可发 " + remaining + " 条反馈" };
}
