const IDLE_CLOSE_MS = 5 * 60 * 1000

export function createConnections({ host, store, log, max = 8 }) {
  const handles = new Map()   // sessionId -> { handle, lastEvent, working }

  function toolArg(event) {
    if (typeof event.preview === 'string' && event.preview) return event.preview
    if (typeof event.arguments === 'string') return event.arguments
    if (event.arguments && typeof event.arguments === 'object') {
      try { return JSON.stringify(event.arguments) } catch (_) { return '' }
    }
    return ''
  }

  async function ensure(sessionId) {
    if (!sessionId || handles.has(sessionId)) return
    if (handles.size >= max) return
    try {
      const meta = store.sessions.get(sessionId) || {}
      const entry = { handle: null, lastEvent: Date.now(), working: false }
      handles.set(sessionId, entry)
      entry.handle = await host.sessions.connect(sessionId, (event) => {
        entry.lastEvent = Date.now()
        try { onEvent(sessionId, meta, event, entry) } catch (error) {
          log.warn('session event failed', String((error && error.message) || error))
        }
      })
    } catch (error) {
      handles.delete(sessionId)
      log.warn('session connect failed', { sessionId, error: String((error && error.message) || error) })
    }
  }

  function onEvent(sessionId, meta, event, entry) {
    const name = String((event && event.event) || '')
    const agent = (store.streamFor(sessionId) || {}).agent || meta.agent
    const profile = (store.streamFor(sessionId) || {}).profile || meta.profile
    if (name === 'reasoning.delta' || name === 'thinking.delta' || name === 'interim.delta') {
      store.appendDelta(sessionId, 'reasoning', event.delta)
      store.setWorking(sessionId, true)
      entry.working = true
      return
    }
    if (name === 'message.delta') {
      store.appendDelta(sessionId, 'output', event.delta)
      store.setWorking(sessionId, true)
      entry.working = true
      return
    }
    if (name === 'tool.started') {
      store.noteTool(sessionId, { name: event.name || event.tool, arg: toolArg(event), state: 'started' })
      store.setWorking(sessionId, true)
      store.addEvent({ type: 'tool', profile, agent, text: (event.name || 'tool') + ' ' + toolArg(event).slice(0, 60) })
      entry.working = true
      return
    }
    if (name === 'tool.completed' || name === 'tool.failed') {
      store.noteTool(sessionId, { name: event.name || event.tool, arg: toolArg(event), state: name === 'tool.failed' ? 'failed' : 'done' })
      return
    }
    if (name === 'run.started' || name === 'run.updated' || name === 'run.queued') {
      store.setWorking(sessionId, true)
      entry.working = true
      return
    }
    if (name === 'run.completed' || name === 'run.failed' || name === 'run.stopped') {
      store.setWorking(sessionId, false)
      store.addEvent({ type: 'run', profile, agent, text: name.replace('run.', '') })
      entry.working = false
      return
    }
    if (name === 'plan.updated') {
      store.setPlan(sessionId, event.task_plan || event.plan)
      return
    }
    if (name === 'resumed') {
      const working = !!event.isWorking
      store.setWorking(sessionId, working, {
        model: event.model || undefined,
        provider: event.provider || undefined
      })
      entry.working = working
      const plans = Array.isArray(event.taskPlans) ? event.taskPlans : []
      if (plans[0]) store.setPlan(sessionId, plans[0])
      return
    }
    if (name === 'approval.requested' || name === 'clarify.requested' || name === 'clarification.requested') {
      store.addEvent({ type: 'wait', profile, agent, text: name })
    }
  }

  async function close(sessionId) {
    const entry = handles.get(sessionId)
    if (!entry) return
    handles.delete(sessionId)
    try { if (entry.handle && entry.handle.close) await entry.handle.close() } catch (_) { /* ignore */ }
  }

  function prune(now = Date.now()) {
    for (const [id, entry] of handles) {
      if (now - entry.lastEvent > IDLE_CLOSE_MS) close(id)
    }
  }

  async function closeAll() {
    await Promise.all([...handles.keys()].map(close))
  }

  return { ensure, close, prune, closeAll, size: () => handles.size }
}
