/**
 * 把 Studio 会话实时事件转换成 store 能直接消费的动作。
 * 与 client 端的 onLiveEvent 保持同一套字段口径，纯函数便于单测。
 */
import { toolArg } from './tool-history.mjs'

export function parseLiveEvent(event) {
  if (!event || typeof event !== 'object') return null
  const name = String(event.event || '')
  if (!name) return null

  if (name === 'reasoning.delta' || name === 'thinking.delta' || name === 'interim.delta') {
    return { kind: 'delta', channel: 'reasoning', text: String(event.delta || '') }
  }
  if (name === 'message.delta') {
    return { kind: 'delta', channel: 'text', text: String(event.delta || '') }
  }
  if (name === 'tool.started' || name === 'tool.completed' || name === 'tool.failed') {
    const toolName = event.tool_name || event.name || event.tool || 'tool'
    const raw = event.args !== undefined ? event.args
      : (event.arguments !== undefined ? event.arguments
        : (event.input !== undefined ? event.input : event.preview))
    const arg = typeof raw === 'string' ? raw : (raw && typeof raw === 'object' ? toolArg(raw) : '')
    return {
      kind: 'tool',
      state: name === 'tool.started' ? 'running' : (name === 'tool.failed' ? 'error' : 'done'),
      name: String(toolName),
      arg: String(arg || '').slice(0, 160),
      callId: String(event.tool_call_id || event.callId || event.id || '')
    }
  }
  if (name === 'run.started' || name === 'run.updated' || name === 'run.queued') {
    return { kind: 'run', working: true }
  }
  if (name === 'run.completed' || name === 'run.failed' || name === 'run.stopped') {
    return { kind: 'run', working: false }
  }
  if (name === 'plan.updated') {
    const plan = event.task_plan || event.plan || null
    return plan ? { kind: 'plan', plan } : null
  }
  if (name === 'resumed') {
    return {
      kind: 'resume',
      working: !!(event.isWorking !== undefined ? event.isWorking : event.working),
      plans: Array.isArray(event.taskPlans) ? event.taskPlans
        : (Array.isArray(event.task_plans) ? event.task_plans : [])
    }
  }
  return null
}
