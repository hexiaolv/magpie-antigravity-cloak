// 本地单测：node test.mjs（模拟 magpie 中间件调用 onRequest）
//
// 所有 fixture 一律用 wr() 拼接构造纯净触发词——测试文件正文里
// 不允许出现未转义的敏感词，避免零宽字符污染让断言空转。
// 每个混淆断言都成对检查"混淆前不含 ZW、混淆后含 ZW"。
import { onRequest } from "./antigravity-cloak.middleware.js"

const ZW = "​"
// 纯净词构造：把源码里的词拆开拼接，保证测试文件里永远没有完整触发词
const W = {
  billing: "x-an" + "thropic-billing-header",
  cc: "C" + "laude Code",
  sdk: "C" + "laude Agent SDK",
  cli: "A" + "nthropic's official CLI",
  conv: "s" + "ystem-conventions",
  rfc: "R" + "FC 2119",
}

const assert = (cond, name) => {
  if (cond) console.log("✔ " + name)
  else { console.error("✘ " + name); process.exitCode = 1 }
}
// 混淆断言：混淆前的文本必须不含 ZW（fixture 纯净），混淆后必须在词首字符后插入 ZW
const cloaked = (before, after, w) => {
  assert(!before.includes(ZW), `fixture 纯净：${JSON.stringify(w)} 输入不含零宽`)
  assert(after.includes(w[0] + ZW + w.slice(1)), `被混淆：${JSON.stringify(w)}`)
}
const untouched = (after, w) =>
  assert(!after.includes(w[0] + ZW + w.slice(1)), `未被动过：${JSON.stringify(w)}`)

// 1. anthropic：system 为字符串
{
  const sys = `You are ${W.cc}, ${W.cli} for Claude.`
  const body = {
    model: "antigravity/gemini-3.8-flash",
    system: sys,
    messages: [{ role: "user", content: "hi" }],
  }
  const out = onRequest(body, { protocol: "anthropic", options: {} })
  cloaked(sys, out.system, W.cc)
  cloaked(sys, out.system, W.cli)
  assert(out.model === "antigravity/gemini-3.8-flash", "anthropic：model 不变")
}

// 2. anthropic：system 为块数组
{
  const t0 = `You are a Claude agent, built on ${W.sdk}.`
  const body = {
    model: "m",
    system: [
      { type: "text", text: t0 },
      { type: "text", text: "clean block" },
    ],
    messages: [],
  }
  const out = onRequest(body, { protocol: "anthropic", options: {} })
  cloaked(t0, out.system[0].text, W.sdk)
  assert(out.system[1].text === "clean block", "anthropic 块 system：干净块不动")
}

// 3. gemini：systemInstruction.parts
{
  const t = `Follow <${W.conv}> and ${W.rfc}.`
  const body = {
    systemInstruction: { parts: [{ text: t }] },
    contents: [],
  }
  const out = onRequest(body, { protocol: "gemini", options: {} })
  cloaked(t, out.systemInstruction.parts[0].text, W.conv)
  cloaked(t, out.systemInstruction.parts[0].text, W.rfc)
}

// 3b. 关键回归：billing 头标记（真实 429 的元凶）被混淆
{
  const t = W.billing + ": cc_version=1.2.3; cc_entrypoint=claude-desktop-3p;"
  const body = { system: [{ type: "text", text: t }], messages: [] }
  const out = onRequest(body, { protocol: "anthropic", options: {} })
  cloaked(t, out.system[0].text, W.billing)
}

// 4. chat：messages 里的 system
{
  const c = `You are ${W.cc}.`
  const body = {
    messages: [
      { role: "system", content: c },
      { role: "user", content: "user msg" },
    ],
  }
  const out = onRequest(body, { protocol: "chat", options: {} })
  cloaked(c, out.messages[0].content, W.cc)
}

// 5. deep 模式：用户消息、tools 描述、thinking 也被混淆
{
  const userMsg = `marker ${W.cc} here`
  const thinking = `sdk mention ${W.sdk}`
  const desc = `uses ${W.rfc}`
  const body = {
    model: "m",
    system: "clean",
    messages: [
      { role: "user", content: userMsg },
      { role: "assistant", content: [{ type: "thinking", thinking, signature: "sig123" }] },
    ],
    tools: [{ name: "t", description: desc, input_schema: { type: "object" } }],
  }
  const out = onRequest(body, { protocol: "anthropic", options: { deep: true } })
  cloaked(userMsg, out.messages[0].content, W.cc)
  cloaked(thinking, out.messages[1].content[0].thinking, W.sdk)
  assert(out.messages[1].content[0].signature === "sig123", "deep：signature 不动")
  cloaked(desc, out.tools[0].description, W.rfc)
  untouched(out.system, W.cc)
  assert(out.system === "clean", "deep：干净文本不动")
}

// 6. 默认模式：只混淆系统提示词，用户消息不动
{
  const sys = `You are ${W.cc}.`
  const userMsg = `${W.cc} in user`
  const body = {
    system: sys,
    messages: [{ role: "user", content: userMsg }],
  }
  const out = onRequest(body, { protocol: "anthropic", options: {} })
  cloaked(sys, out.system, W.cc)
  untouched(out.messages[0].content, W.cc)
}

// 6b. 默认模式：chat 协议下 messages 里的 system 消息也被混淆
{
  const sys = `You are ${W.cc}.`
  const userMsg = `${W.cc} in user`
  const body = {
    messages: [
      { role: "system", content: sys, other: "keep" },
      { role: "user", content: userMsg },
    ],
  }
  const out = onRequest(body, { protocol: "chat", options: {} })
  cloaked(sys, out.messages[0].content, W.cc)
  assert(out.messages[0].other === "keep", "默认：chat system 其他字段不动")
  untouched(out.messages[1].content, W.cc)
}

// 7. off 选项
{
  const sys = `You are ${W.cc}.`
  const body = { system: sys, messages: [] }
  const out = onRequest(body, { protocol: "anthropic", options: { off: true } })
  untouched(out.system, W.cc)
  assert(out.system === sys, "off=true：完全放行")
}

// 8. extraWords
{
  const sys = "hello my-secret-marker"
  const body = { system: sys, messages: [] }
  const out = onRequest(body, { protocol: "anthropic", options: { extraWords: ["my-secret-marker"] } })
  cloaked(sys, out.system, "my-secret-marker")
}

// 9. 还原等价 + 幂等：去零宽后与原文一致，跑两遍结果一致
{
  const orig = `You are ${W.cc}, ${W.cli}. ${W.billing}: v=1;`
  const once = onRequest({ system: orig, messages: [] }, { protocol: "anthropic", options: {} })
  const twice = onRequest(structuredClone(once), { protocol: "anthropic", options: {} })
  assert(once.system.replaceAll(ZW, "") === orig, "还原：去零宽空格后与原文一致")
  assert(twice.system === once.system, "幂等：跑两遍结果一致")
}

// 10. base64 大块不碰
{
  const b64 = "Q0xhdWRl" + "x".repeat(5000)
  const body = { system: "ok", messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", data: b64 } }] }] }
  const out = onRequest(body, { protocol: "anthropic", options: {} })
  assert(out.messages[0].content[0].source.data === b64, "base64 图片数据不动")
}

// 11. 词表含正则特殊字符也能安全匹配
{
  const sys = "use (a|b) [c] marker"
  const out = onRequest({ system: sys, messages: [] }, { protocol: "anthropic", options: { extraWords: ["(a|b) [c]"] } })
  // 期望结果 "("\u200B + a)"：插在 ( 后面
  assert(out.system.includes("(" + ZW + "a"), "正则特殊字符按字面匹配")
}

// 12. 重叠匹配不漏：短词在连续重复串里的每个出现都被混淆
{
  const sys = "aaaa"
  const out = onRequest({ system: sys, messages: [] }, { protocol: "anthropic", options: { extraWords: ["aa"] } })
  // "aa" 出现 2 次（重叠的第三个不计），每处首字符后插 ZW
  const count = (out.system.match(new RegExp(ZW, "g")) || []).length
  assert(count === 2, `重叠匹配不漏（插了 ${count} 处，应为 2）`)
}

// 13. modelFilter：字符串匹配与未匹配放行
{
  const sys = `You are ${W.cc}.`
  // 命中 antigravity
  const hit = onRequest(
    { model: "antigravity/gemini-3.7-flash", system: sys, messages: [] },
    { options: { modelFilter: "antigravity" } }
  )
  cloaked(sys, hit.system, W.cc)

  // 未命中 antigravity，直接放行
  const miss = onRequest(
    { model: "anthropic/claude-3-7-sonnet", system: sys, messages: [] },
    { options: { modelFilter: "antigravity" } }
  )
  untouched(miss.system, W.cc)
  assert(miss.system === sys, "modelFilter: 未命中时系统提示词保持原文")
}

// 14. modelFilter：支持正则模式字符串与数组
{
  const sys = `You are ${W.cc}.`
  // 数组与正则字符串支持
  const hit = onRequest(
    { model: "google-antigravity/model-v1", system: sys, messages: [] },
    { options: { modelFilter: ["/^google-antigravity\\//i", "custom-target"] } }
  )
  cloaked(sys, hit.system, W.cc)

  const miss = onRequest(
    { model: "openai/gpt-4o", system: sys, messages: [] },
    { options: { modelFilter: ["antigravity", "custom-target"] } }
  )
  untouched(miss.system, W.cc)
}

// 15. cloakChar 自定义混淆字符（如 ZWNJ ‌）
{
  const ZWNJ = "‌"
  const sys = `You are ${W.cc}.`
  const out = onRequest(
    { system: sys, messages: [] },
    { options: { cloakChar: ZWNJ } }
  )
  assert(!out.system.includes(ZW), "cloakChar: 不包含默认零宽空格")
  assert(out.system.includes(W.cc[0] + ZWNJ + W.cc.slice(1)), "cloakChar: 成功插入自定义 ZWNJ")
  assert(out.system.replaceAll(ZWNJ, "") === sys, "cloakChar: 去除自定义混淆字符可完整还原")
}

// 16. debug 选项：收集并在控制台输出统计
{
  const sys = `You are ${W.cc}, using ${W.sdk}.`
  let logOutput = ""
  const originalLog = console.log
  console.log = (msg) => { logOutput += msg + "\n" }
  try {
    onRequest(
      { model: "antigravity/test-model", system: sys, messages: [] },
      { options: { debug: true } }
    )
  } finally {
    console.log = originalLog
  }
  assert(logOutput.includes("[antigravity-cloak]"), "debug: 打印了插件前缀")
  assert(logOutput.includes('model: "antigravity/test-model"'), "debug: 打印了模型名称")
  assert(logOutput.includes("cloaked: 2 match(es)"), "debug: 准确统计混淆命中了 2 次")
}

console.log(process.exitCode ? "有失败" : "全部通过")
