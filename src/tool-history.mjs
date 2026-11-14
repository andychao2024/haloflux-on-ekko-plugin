/**
 * 从 Studio 会话历史中提取最近的工具调用。
 * assistant 消息的 tool_calls 提供名称与参数；tool 消息提供结果状态。
 * 状态口径与 docker 版一致：有结果是 done / error，没有结果且 30 分钟内是
 * running（面板显示青色），更早则是 idle（灰色）。
 * 只读、无副作用，方便单测。
 */
const RUNNING_WINDOW_MS = 30 * 60 * 1000
const ARG_KEYS = ['command', 'file_path', 'path', 'pattern', 'query', 'url',
  'prompt', 'description', 'session_id', 'sessionId', 'skill', 'tool', 'action', 'glob']

/** 与 docker 版一致：从工具参数对象里挑一个最有代表性的一行摘要。 */
function toolArg(input) {
  if (!input || typeof input !== 'object') return ''
  let v = null
  for (const key of ARG_KEYS) {
    const cand = input[key]
    if (typeof cand === 'string' && cand.trim()) { v = cand; break }
  }
  if (v === null) {
    for (const key of Object.keys(input)) {
      if (typeof input[key] === 'string' && input[key].trim()) { v = input[key]; break }
    }
  }
  if (v === null) return ''
  return String(v).replace(/\s+/g, ' ').trim().slice(0, 160)
}

function resultState(content) {
  // Studio 用 "Error: …" 前缀表示工具失败；不要被正文里的 error 字样误判
  return /^\s*error\b/i.test(String(content || '')) ? 'error' : 'done'
}

export function parseToolMessages(messages, limit = 8, now = Date.now()) {
  const entries = []
  const list = Array.isArray(messages) ? messages : []
  const results = new Map()   // tool_call_id -> done | error

  for (const message of list) {
    if (!message || message.role !== 'tool') continue
    if (message.tool_call_id) results.set(message.tool_call_id, resultState(message.content))
  }

  const fallbackState = (at) => {
    if (!at) return 'idle'
    return now - at < RUNNING_WINDOW_MS ? 'running' : 'idle'
  }

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
        let raw = fn.arguments
        if (typeof raw === 'string') {
          const text = raw.trim()
          if (text.startsWith('{') || text.startsWith('[')) {
            try { raw = JSON.parse(text) } catch (_) { /* 保留原始字符串 */ }
          }
        }
        const arg = typeof raw === 'string'
          ? raw.replace(/\s+/g, ' ').trim().slice(0, 160)
          : toolArg(raw)
        const id = call && call.id ? call.id : ''
        entries.push({
          at,
          name: String(fn.name),
          arg,
          state: (id && results.get(id)) || fallbackState(at),
          order: i
        })
      }
    } else if (message.role === 'tool' && message.tool_name) {
      if (message.tool_call_id && results.has(message.tool_call_id)) {
        // 已经有对应的 assistant 调用，不重复显示结果消息
        continue
      }
      entries.push({
        at,
        name: String(message.tool_name),
        arg: '',
        state: resultState(message.content),
        order: i
      })
    }
  }

  entries.sort((a, b) => (b.at || 0) - (a.at || 0) || b.order - a.order)
  return entries.slice(0, limit).map(({ at, name, arg, state }) => ({ at, name, arg, state }))
}
