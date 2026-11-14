/**
 * 从 Studio 会话历史中提取最近的工具调用。
 * assistant 消息的 tool_calls 提供名称与参数；tool 消息在没有对应调用时兜底。
 * 只读、无副作用，方便单测。
 */
const clip = (text, max) => {
  const s = String(text == null ? '' : text)
  return s.length > max ? s.slice(0, max) : s
}

export function parseToolMessages(messages, limit = 8) {
  const entries = []
  const byCallId = new Map()
  const list = Array.isArray(messages) ? messages : []
  for (let i = 0; i < list.length; i++) {
    const message = list[i]
    if (!message) continue
    const at = Number(message.timestamp) * 1000 || 0
    if (message.role === 'assistant' && message.tool_calls) {
      let calls = message.tool_calls
      if (typeof calls === 'string') {
        try { calls = JSON.parse(calls) } catch (_) { calls = null }
      }
      if (!Array.isArray(calls)) continue
      for (const call of calls) {
        const fn = call && call.function ? call.function : call
        if (!fn || !fn.name) continue
        let arg = fn.arguments
        if (arg && typeof arg === 'object') {
          try { arg = JSON.stringify(arg) } catch (_) { arg = '' }
        }
        const entry = { at, name: String(fn.name), arg: clip(arg || '', 80), order: i }
        entries.push(entry)
        if (call && call.id) byCallId.set(call.id, entry)
      }
    } else if (message.role === 'tool' && message.tool_name) {
      const hit = message.tool_call_id ? byCallId.get(message.tool_call_id) : null
      if (hit) {
        if (!hit.at) hit.at = at
        continue
      }
      entries.push({ at, name: String(message.tool_name), arg: '', order: i })
    }
  }
  entries.sort((a, b) => (b.at || 0) - (a.at || 0) || b.order - a.order)
  return entries.slice(0, limit).map(({ at, name, arg }) => ({ at, name, arg }))
}
