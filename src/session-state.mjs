/**
 * 判断一个会话当前是否仍在工作。
 * 与 docker 版一致：最后一条消息是 user / tool，或者 assistant 带着尚未
 * 返回的 tool_calls，就说明这一轮还没结束。CodeBuddy 等外部 Agent 的
 * session.last_active 只在回合结束时更新，不能作为运行状态的依据。
 */
export function messagesWorking(messages) {
  const last = Array.isArray(messages) ? messages[messages.length - 1] : null
  if (!last) return false
  if (last.role === 'user' || last.role === 'tool') return true
  if (last.role === 'assistant' && last.tool_calls) {
    let calls = last.tool_calls
    if (typeof calls === 'string') {
      try { calls = JSON.parse(calls) } catch (_) { calls = null }
    }
    return Array.isArray(calls) && calls.length > 0
  }
  return false
}
