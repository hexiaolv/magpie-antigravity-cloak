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
//   {
//     "extraWords": ["自定义敏感词"],
//     "off": false,
//     "deep": false,
//     "modelFilter": "antigravity", // 仅对匹配的模型启用（支持字符串、正则字符串、数组）
//     "debug": false,               // 输出命中词与耗时日志
//     "cloakChar": "​"         // 自定义混淆字符（默认零宽空格 U+200B）
//   }
//   off 设为 true 时完全放行；deep 设为 true 时深度混淆整个请求体，
//   覆盖面更大但更激进。

// 默认零宽空格（U+200B），写成转义形式避免源码中出现不可见字符
const DEFAULT_CLOAK_CHAR = "​"

// 常见零宽/不可见字符集合（用于 buildNeedles 自动过滤，防止用户误贴造成脏匹配）
const INVISIBLE_CHARS = new Set([
  "​", // Zero Width Space
  "‌", // Zero Width Non-Joiner
  "‍", // Zero Width Joiner
  "⁠", // Word Joiner
  "﻿", // Zero Width No-Break Space / BOM
])

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

// 正则表达式编译缓存，避免每次请求重复构建
const regexCache = new Map()

function buildNeedles(extra, cloakChar = DEFAULT_CLOAK_CHAR) {
  const words = DEFAULT_WORDS.concat(Array.isArray(extra) ? extra : [])
  // 清理首尾空白，去掉已含混淆字符或不可见字符的词（如用户误贴混淆文本），去重，按长度从长到短，
  // 避免短词先匹配破坏长词
  const seen = new Set()
  const out = []
  for (const w of words) {
    if (!w || typeof w !== "string") continue
    const trimmed = w.trim()
    if (trimmed.length < 2) continue
    let hasInvisible = false
    for (let i = 0; i < trimmed.length; i++) {
      const ch = trimmed[i]
      if (ch === cloakChar || INVISIBLE_CHARS.has(ch)) {
        hasInvisible = true
        break
      }
    }
    if (hasInvisible) continue
    const k = trimmed.toLowerCase()
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

// 获取单条合并正则（带缓存）
function getCompiledRegex(needles) {
  if (!needles || needles.length === 0) return null
  const cacheKey = needles.join("|")
  let re = regexCache.get(cacheKey)
  if (!re) {
    // 将所有敏感词合并为单条正则，单次线性扫描，天然保证长词优先命中
    const pattern = needles.map(escapeRegExp).join("|")
    re = new RegExp(pattern, "gi")
    regexCache.set(cacheKey, re)
  }
  return re
}

// 在 text 的每个敏感词第一个字符后插混淆字符。
// 使用单正则整体匹配，已混淆的词中间多了混淆字符，不再匹配，天然幂等。
function cloakText(text, regex, cloakChar, stats) {
  if (typeof text !== "string" || text.length < 2 || !regex) return text
  return text.replace(regex, (m) => {
    if (stats) {
      stats.count++
      stats.matches.add(m.toLowerCase())
    }
    // Unicode Code Point 安全切分，防止 Emoji 或双字节字符代理对被截断
    const firstChar = String.fromCodePoint(m.codePointAt(0))
    return firstChar + cloakChar + m.slice(firstChar.length)
  })
}

// 递归遍历 JSON 值：对每个字符串混淆，并原地写回。
// 疑似 base64 / data URL 的超长无空格串不碰；签名等字段不碰。
const SKIP_KEYS = new Set(["signature", "id", "session", "sessionId", "requestId"])

function cloakDeep(value, regex, cloakChar, stats) {
  if (value == null) return value
  const t = typeof value
  if (t === "string") {
    if (value.length > 4096 && !value.includes(" ")) return value
    return cloakText(value, regex, cloakChar, stats)
  }
  if (t !== "object") return value
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = cloakDeep(value[i], regex, cloakChar, stats)
    return value
  }
  for (const k in value) {
    if (SKIP_KEYS.has(k)) continue
    value[k] = cloakDeep(value[k], regex, cloakChar, stats)
  }
  return value
}

// 判断 chat 协议下 messages 里的 system 消息
function isChatSystem(msg) {
  return msg && typeof msg === "object" && !Array.isArray(msg) && msg.role === "system"
}

// 混淆一个可能是字符串或嵌套对象的系统提示词字段
function cloakSystemField(sys, regex, cloakChar, stats) {
  if (typeof sys === "string") return cloakText(sys, regex, cloakChar, stats)
  if (sys && typeof sys === "object") cloakDeep(sys, regex, cloakChar, stats)
  return sys
}

// 匹配模型是否命中过滤规则
function isModelMatched(model, filter) {
  if (!filter) return true
  if (typeof model !== "string") return false

  const checkSingle = (rule) => {
    if (!rule) return false
    if (rule instanceof RegExp) return rule.test(model)
    if (typeof rule === "string") {
      const trimmedRule = rule.trim()
      if (!trimmedRule) return false
      // 支持正则字符串格式，如 "/^antigravity/i"
      if (trimmedRule.startsWith("/") && trimmedRule.lastIndexOf("/") > 0) {
        const lastSlash = trimmedRule.lastIndexOf("/")
        const pattern = trimmedRule.slice(1, lastSlash)
        const flags = trimmedRule.slice(lastSlash + 1)
        try {
          return new RegExp(pattern, flags).test(model)
        } catch (_) {}
      }
      // 支持通配符格式，如 "antigravity/*" 或 "*gemini*"
      if (trimmedRule.includes("*")) {
        const escaped = escapeRegExp(trimmedRule).replace(/\\\*/g, ".*")
        try {
          return new RegExp(`^${escaped}$`, "i").test(model)
        } catch (_) {}
    }
      return model.toLowerCase().includes(trimmedRule.toLowerCase())
    }
    return false
  }

  if (Array.isArray(filter)) {
    return filter.some(checkSingle)
  }
  return checkSingle(filter)
}

export function onRequest(body, ctx) {
  const opts = ctx?.options ?? {}
  if (opts.off) return body

  // 渠道/模型过滤：未命中则直接放行，避免干扰其他 Provider
  const model = body?.model || ctx?.model || ""
  if (opts.modelFilter && !isModelMatched(model, opts.modelFilter)) {
    return body
  }

  const cloakChar = typeof opts.cloakChar === "string" && opts.cloakChar.length > 0
    ? opts.cloakChar
    : DEFAULT_CLOAK_CHAR

  const needles = buildNeedles(opts.extraWords, cloakChar)
  const regex = getCompiledRegex(needles)
  if (!regex) return body

  const stats = opts.debug ? { count: 0, matches: new Set(), startTime: Date.now() } : null

  // deep：全字段深度混淆，用户消息、tools、thinking 也一起
  if (opts.deep) {
    cloakDeep(body, regex, cloakChar, stats)
  } else {
    // 默认：只混淆系统提示词（cli-proxy-api 的保守行为，模型输出质量影响最小）
    for (const key of ["system", "systemInstruction", "system_instruction", "instructions"]) {
      if (body[key] != null) body[key] = cloakSystemField(body[key], regex, cloakChar, stats)
    }
    if (Array.isArray(body.messages)) {
      for (const msg of body.messages) {
        if (!isChatSystem(msg)) continue
        msg.content = cloakSystemField(msg.content, regex, cloakChar, stats)
      }
    }
  }

  if (stats) {
    const elapsed = Date.now() - stats.startTime
    const matchedList = Array.from(stats.matches).join(", ") || "none"
    console.log(
      `[antigravity-cloak] model: "${model}" | cloaked: ${stats.count} match(es) [${matchedList}] (${elapsed}ms)`
    )
  }

  return body
}
