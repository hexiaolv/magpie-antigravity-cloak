// antigravity-cloak：Antigravity 429 问题中间件
//
// 根因（实测定位，比 issue #666 的结论更进一步）：
//   Antigravity 上游按请求文本里的特定指纹字符串拦截，并统一伪装成
//   "429 Resource has been exhausted"，实际并不是额度用完了。
//   实测确认的触发词有两类：
//   1. 计费头标记：Claude Code 会往 system 里塞一行
//      "x-anthropic-billing-header" 开头的计费信息（含 cc_version 等），
//      上游按这个字符串拦截。curl 手工构造的探测没有这行，
//      这是之前修复一直失败、排查一直"复现不出来"的原因。
//   2. 身份字样："Claude Code" / "Claude Agent SDK" 等
//      （issue #666 确认，cli-proxy-api PR #6280 的默认指纹）。
//
// 做法（参考 cli-proxy-api PR #6280）：
//   在敏感词第一个字符后插入零宽空格。人眼看不出差别，
//   模型也基本不受影响，但上游的关键字匹配就失效了。
//   默认只混淆系统提示词（system / systemInstruction / instructions，
//   以及 chat 协议下 messages 里 role === "system" 的消息）；
//   deep 选项会混淆整个请求体（用户消息、tools、thinking 也一起）。
//
// 安装：magpie plugin add /Users/heguanghai/Code/magpie-antigravity-cloak
//   （短名不识别，options 操作也要用完整路径）
//
// 可选配置（magpie plugin options <完整路径> '<json>'）：
//   { "extraWords": ["自定义敏感词"], "off": true, "deep": true }
//   off 设为 true 时完全放行；deep 设为 true 时深度混淆整个请求体，
//   覆盖面更大但更激进。

// 零宽空格写成转义形式，避免源码里出现肉眼不可见的字符（词表请保持纯 ASCII）
const ZERO_WIDTH = "​"

// 默认敏感词，全部纯 ASCII。不要把零宽字符写进词表，会被 buildNeedles 过滤掉。
// 大小写不敏感。
const DEFAULT_WORDS = [
  "x-anthropic-billing-header",
  "Claude Agent SDK",
  "Claude Code",
  "Anthropic's official CLI",
  "system-conventions",
  "system_conventions",
  "system-directive",
  "system_directive",
  "RFC 2119",
]

function buildNeedles(extra) {
  const words = DEFAULT_WORDS.concat(Array.isArray(extra) ? extra : [])
  // 去掉已含零宽空格的（用户误贴混淆文本），去重，按长度从长到短，
  // 避免短词先匹配破坏长词
  const seen = new Set()
  const out = []
  for (const w of words) {
    if (!w || typeof w !== "string" || w.length < 2 || w.includes(ZERO_WIDTH)) continue
    const k = w.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(k)
  }
  out.sort((a, b) => b.length - a.length)
  return out
}

// 词表是纯文本不是正则，先转义特殊字符
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// 在 text 的每个敏感词第一个字符后插零宽空格。
// 每个词用正则整体替换一遍：已混淆的词中间多了零宽空格，
// 不再匹配，天然幂等。
function cloakText(text, needles) {
  if (typeof text !== "string" || text.length < 2) return text
  for (const needle of needles) {
    const re = new RegExp(escapeRegExp(needle), "gi")
    text = text.replace(re, (m) => m[0] + ZERO_WIDTH + m.slice(1))
  }
  return text
}

// 递归遍历 JSON 值：对每个字符串混淆，并原地写回。
// 疑似 base64 / data URL 的超长无空格串不碰；签名等字段不碰。
const SKIP_KEYS = new Set(["signature", "id", "session", "sessionId", "requestId"])

function cloakDeep(value, needles) {
  if (value == null) return value
  const t = typeof value
  if (t === "string") {
    if (value.length > 4096 && !value.includes(" ")) return value
    return cloakText(value, needles)
  }
  if (t !== "object") return value
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = cloakDeep(value[i], needles)
    return value
  }
  for (const k in value) {
    if (SKIP_KEYS.has(k)) continue
    value[k] = cloakDeep(value[k], needles)
  }
  return value
}

// 判断 chat 协议下 messages 里的 system 消息
function isChatSystem(msg) {
  return msg && typeof msg === "object" && !Array.isArray(msg) && msg.role === "system"
}

// 混淆一个可能是字符串或嵌套对象的系统提示词字段
function cloakSystemField(sys, needles) {
  if (typeof sys === "string") return cloakText(sys, needles)
  if (sys && typeof sys === "object") cloakDeep(sys, needles)
  return sys
}

export function onRequest(body, ctx) {
  const opts = ctx.options ?? {}
  if (opts.off) return body

  const needles = buildNeedles(opts.extraWords)

  // deep：全字段深度混淆，用户消息、tools、thinking 也一起
  if (opts.deep) return cloakDeep(body, needles)

  // 默认：只混淆系统提示词（cli-proxy-api 的保守行为，模型输出质量影响最小）
  for (const key of ["system", "systemInstruction", "instructions"]) {
    if (body[key] != null) body[key] = cloakSystemField(body[key], needles)
  }
  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (!isChatSystem(msg)) continue
      msg.content = cloakSystemField(msg.content, needles)
    }
  }
  return body
}
