import { parseLiveEvent } from './live-signals.mjs'

const LIVE_TTL_MS = 10 * 60 * 1000      // 没有结束事件时，实时 slot 最长续命时间
const IDLE_CLOSE_MS = 15 * 60 * 1000    // 长时间没有事件才断开，避免频繁重连
const DROP_GRACE_MS = 60 * 1000         // 会话离开最近列表后保留 60 秒，避免轮换时抖动
const RETRY_MS = 60 * 1000              // 连接失败后至少 60 秒再试，避免每秒重试

/**
 * 插件后端的实时会话连接。
 *
 * 壁纸服务没有页面端的 iframe，不能直接使用 ClientContext 的
 * sessions.connect。这里用插件生命周期里的 ctx.host.sessions.connect，
 * 把当前回合的思考增量、工具调用和计划写进共享 store；/stats 仍然
 * 复用同一个 store，所以壁纸页不需要打开插件页也能看到实时内容。
 */
export function createConnections({ host, store, log, max = 4, now = Date.now }) {
  const handles = new Map()   // sessionId -> entry
  const failed = new Map()    // sessionId -> 最近一次连接失败时间
  let lastEvent = null

  function metaOf(sessionId) {
    const meta = store.sessions.get(sessionId) || {}
    return {
      agent: meta.agent || 'unknown',
      profile: meta.profile || 'default',
      title: meta.title || ''
    }
  }

  function mark(entry, working, at) {
    const stream = store.streamFor(entry.sessionId)
    entry.working = !!working
    entry.ts = at
    if (stream.agent) entry.agent = stream.agent
    if (stream.profile) entry.profile = stream.profile
    if (!entry.title) entry.title = (store.sessions.get(entry.sessionId) || {}).title || ''
  }

  function onEvent(sessionId, entry, event) {
    // 会话句柄可能已经被 sync() 关闭；迟到的回调不能再写 store。
    if (handles.get(sessionId) !== entry) return
    const parsed = parseLiveEvent(event)
    if (!parsed) return
    const at = now()
    entry.lastEvent = at
    entry.ts = at
    // 新回合的实时事件优先于上一回合的历史回填文本。
    if (parsed.kind === 'delta' || parsed.kind === 'tool' || parsed.kind === 'plan' ||
      (parsed.kind === 'run' && parsed.working) ||
      (parsed.kind === 'resume' && parsed.working)) {
      store.markLive(sessionId)
    }

    if (parsed.kind === 'delta') {
      if (parsed.text) store.appendDelta(sessionId, parsed.channel, parsed.text)
      store.setWorking(sessionId, true)
      mark(entry, true, at)
      store.noteSignal(sessionId, at)
      lastEvent = { type: parsed.channel === 'reasoning' ? 'think' : 'message', at }
      return
    }

    if (parsed.kind === 'tool') {
      if (parsed.state === 'running') {
        store.noteTool(sessionId, {
          name: parsed.name, arg: parsed.arg, state: 'running', callId: parsed.callId
        })
        store.addEvent({
          type: 'tool/call', profile: entry.profile, agent: entry.agent,
          text: parsed.name, at
        })
      } else {
        const hit = store.finishTool(sessionId, parsed.callId, parsed.name, parsed.state)
        // 没收到 started 的事件才补一条，避免每次完成都重复显示一条工具。
        if (!hit) {
          store.noteTool(sessionId, {
            name: parsed.name, arg: parsed.arg, state: parsed.state, callId: parsed.callId
          })
        }
      }
      store.setWorking(sessionId, true)
      mark(entry, true, at)
      store.noteSignal(sessionId, at)
      lastEvent = { type: 'tool', at }
      return
    }

    if (parsed.kind === 'run') {
      store.setWorking(sessionId, parsed.working)
      mark(entry, parsed.working, at)
      store.noteSignal(sessionId, at)
      if (!parsed.working) {
        store.addEvent({
          type: 'job/settled', profile: entry.profile, agent: entry.agent,
          text: '完成', at
        })
      }
      lastEvent = { type: parsed.working ? 'run' : 'done', at }
      return
    }

    if (parsed.kind === 'plan') {
      store.setPlan(sessionId, parsed.plan)
      store.noteSignal(sessionId, at)
      lastEvent = { type: 'plan', at }
      return
    }

    if (parsed.kind === 'resume') {
      store.setWorking(sessionId, parsed.working)
      mark(entry, parsed.working, at)
      for (const plan of parsed.plans) store.setPlan(sessionId, plan)
      store.noteSignal(sessionId, at)
    }
  }

  async function ensure(sessionId) {
    if (!sessionId || handles.has(sessionId)) return
    if (handles.size >= max) return
    const retryAt = failed.get(sessionId) || 0
    if (retryAt && now() - retryAt < RETRY_MS) return

    const meta = metaOf(sessionId)
    const entry = {
      sessionId,
      handle: null,
      connecting: true,
      working: false,
      ts: now(),
      lastEvent: now(),
      agent: meta.agent,
      profile: meta.profile,
      title: meta.title
    }
    handles.set(sessionId, entry)
    try {
      entry.handle = await host.sessions.connect(sessionId, (event) => {
        try {
          onEvent(sessionId, entry, event)
        } catch (error) {
          log.warn('session event failed', {
            sessionId, error: String((error && error.message) || error)
          })
        }
      })
      failed.delete(sessionId)
    } catch (error) {
      handles.delete(sessionId)
      failed.set(sessionId, now())
      log.warn('session connect failed', {
        sessionId, error: String((error && error.message) || error)
      })
    } finally {
      entry.connecting = false
    }
  }

  /**
   * 只保持最近 max 个会话的连接。壁纸每次 /stats 都会调用；重复调用只
   * 建立缺失的连接，不会重复订阅。
   */
  function sync(targets) {
    const ids = (Array.isArray(targets) ? targets : [])
      .map((item) => item && item.id)
      .filter(Boolean)
      .slice(0, max)
    const keep = new Set(ids)
    for (const id of ids) void ensure(id)

    const t = now()
    for (const [id, entry] of [...handles]) {
      if (keep.has(id)) continue
      if (t - entry.lastEvent > DROP_GRACE_MS) void close(id)
    }
    for (const [id, at] of [...failed]) {
      if (t - at > RETRY_MS) failed.delete(id)
    }
    for (const [id, entry] of [...handles]) {
      if (entry.connecting) continue
      if (t - entry.lastEvent > IDLE_CLOSE_MS) void close(id)
    }
  }

  /** 当前实时 slot，供 buildStats 计算激活 Agent 和动效信号。 */
  function slots() {
    const t = now()
    const list = []
    for (const [sessionId, entry] of handles) {
      const recent = t - entry.ts <= LIVE_TTL_MS
      list.push({
        sessionId,
        agent: entry.agent,
        profile: entry.profile,
        title: entry.title,
        working: !!entry.working && recent,
        ts: entry.ts
      })
    }
    return list
  }

  async function close(sessionId) {
    const entry = handles.get(sessionId)
    if (!entry) return
    handles.delete(sessionId)
    try {
      if (entry.handle && entry.handle.close) await entry.handle.close()
    } catch (_) { /* ignore */ }
  }

  async function closeAll() {
    await Promise.all([...handles.keys()].map(close))
  }

  return {
    ensure,
    sync,
    slots,
    close,
    closeAll,
    lastEvent: () => lastEvent,
    size: () => handles.size,
    failed: (sessionId) => !!(failed.get(sessionId) && now() - failed.get(sessionId) < RETRY_MS)
  }
}
