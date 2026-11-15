const MAX_TEXT = 4000
const MAX_TOOLS = 60
const MAX_EVENTS = 120
const ACTIVE_SEC = 180

const nowSec = () => Math.floor(Date.now() / 1000)
const clip = (text, max = MAX_TEXT) => {
  const s = String(text == null ? '' : text)
  return s.length > max ? s.slice(-max) : s
}
const keyOf = (profile, agent) => `${profile || 'default'}\u0000${agent || 'unknown'}`

export function createStore() {
  const sessions = new Map()
  const streams = new Map()      // sessionId -> stream
  const plans = new Map()        // sessionId -> plan
  const tools = []
  let toolCount = 0
  const events = []
  const usage = { today: null, daily: [], fetchedAt: 0, totals: null }
  const rate = { tokensPerSec: 0, outputPerSec: 0, cacheHit: 0, updatedAt: 0 }
  const skills = { current: null, top: [], fetchedAt: 0 }
  const sessionUsage = new Map()
  const contextLimits = new Map()
  const signals = new Map()   // sessionId -> 最近一次实时事件时间
  const toolHistory = new Map()  // sessionId -> { at, list } 历史工具调用（服务端回填）

  function upsertSessions(list) {
    const seen = new Set()
    for (const item of list) {
      if (!item || !item.id) continue
      seen.add(item.id)
      const prev = sessions.get(item.id) || {}
      sessions.set(item.id, {
        ...prev,
        id: item.id,
        profile: item.profile || prev.profile || 'default',
        agent: item.agent || prev.agent || 'unknown',
        model: item.model || prev.model || null,
        provider: item.provider || prev.provider || null,
        title: item.title || prev.title || '',
        source: item.source || prev.source || null,
        lastActive: Number(item.last_active) || prev.lastActive || 0,
        messageCount: Number(item.message_count) || 0,
        inputTokens: Number(item.input_tokens) || 0,
        outputTokens: Number(item.output_tokens) || 0,
        cacheRead: Number(item.cache_read_tokens) || 0,
        cacheWrite: Number(item.cache_write_tokens) || 0,
        toolCalls: Number(item.tool_call_count) || 0,
        archived: !!item.is_archived
      })
    }
    for (const id of [...sessions.keys()]) {
      if (!seen.has(id)) {
        // 会话列表分页/过滤时可能暂时缺失，不立即删除，只标记
        const s = sessions.get(id)
        if (s) s.stale = true
      }
    }
  }

  function streamFor(sessionId) {
    const s = sessions.get(sessionId)
    const profile = (s && s.profile) || 'default'
    const agent = (s && s.agent) || 'unknown'
    let st = streams.get(sessionId)
    if (!st) {
      st = {
        sessionId, profile, agent,
        reasoning: '', output: '', ts: 0, working: false,
        workKind: null, workStartedAt: 0, lastToolAt: 0, pendingSec: null,
        model: (s && s.model) || null, provider: (s && s.provider) || null
      }
      streams.set(sessionId, st)
    }
    if (s) {
      st.profile = s.profile
      st.agent = s.agent
      st.model = s.model || st.model
      st.provider = s.provider || st.provider
    }
    return st
  }

  function appendDelta(sessionId, kind, delta) {
    const st = streamFor(sessionId)
    const text = String(delta || '')
    if (!text) return
    if (kind === 'reasoning') st.reasoning = clip(st.reasoning + text)
    else st.output = clip(st.output + text)
    st.ts = Date.now()
  }

  function setWorking(sessionId, working, extra = {}) {
    const st = streamFor(sessionId)
    st.working = !!working
    if (working) {
      if (!st.workStartedAt) st.workStartedAt = Date.now()
      st.ts = Date.now()
    } else {
      st.workStartedAt = 0
      st.pendingSec = null
    }
    Object.assign(st, extra)
  }

  function noteTool(sessionId, tool) {
    const st = streamFor(sessionId)
    st.lastToolAt = Date.now()
    st.ts = Date.now()
    const entry = {
      at: Date.now(),
      profile: st.profile,
      agent: st.agent,
      sessionId,
      name: tool.name || 'tool',
      arg: clip(tool.arg || '', 80),
      state: tool.state || 'started',
      callId: tool.callId || ''
    }
    toolCount += 1
    tools.push(entry)
    while (tools.length > MAX_TOOLS) tools.shift()
    return entry
  }

  function finishTool(sessionId, callId, name, state) {
    for (let i = tools.length - 1; i >= 0; i--) {
      const tool = tools[i]
      if (tool.sessionId !== sessionId) continue
      const sameCall = callId && tool.callId && tool.callId === callId
      const sameName = !callId && tool.name === name && /running|started/.test(tool.state)
      if (sameCall || sameName) {
        tool.state = state
        return tool
      }
    }
    return null
  }

  function noteSignal(sessionId, at = Date.now()) {
    if (sessionId) signals.set(sessionId, at)
  }

  function motion(now = Date.now()) {
    let lastEventAt = 0
    for (const at of signals.values()) if (at > lastEventAt) lastEventAt = at
    for (const tool of tools) if (tool.at > lastEventAt) lastEventAt = tool.at
    for (const stream of streams.values()) if (stream.ts > lastEventAt) lastEventAt = stream.ts
    for (const plan of plans.values()) if (plan.ts > lastEventAt) lastEventAt = plan.ts
    let working = 0
    let pendingSec = null
    for (const stream of streams.values()) {
      if (!stream.working) continue
      working += 1
      const started = stream.workStartedAt || stream.ts || now
      const sec = Math.max(0, Math.round((now - started) / 1000))
      pendingSec = pendingSec === null ? sec : Math.max(pendingSec, sec)
    }
    return { lastEventAt, pendingSec, jobsRunning: working }
  }

  function setPlan(sessionId, plan) {
    const st = streamFor(sessionId)
    if (!plan || !Array.isArray(plan.plan)) return
    const steps = plan.plan.map((s) => ({
      id: s.id,
      step: clip(s.step || '', 120),
      status: s.status || 'pending'
    }))
    const done = steps.filter((s) => s.status === 'completed').length
    plans.set(sessionId, {
      sessionId,
      profile: st.profile,
      agent: st.agent,
      title: (sessions.get(sessionId) || {}).title || null,
      state: plan.execution_state || 'running',
      revision: plan.revision || 0,
      steps,
      done,
      total: steps.length,
      ts: plan.updated_at || Date.now()
    })
  }

  function addEvent(event) {
    const item = {
      at: event.at || Date.now(),
      type: event.type || 'event',
      profile: event.profile || 'default',
      agent: event.agent || null,
      text: clip(event.text || '', 160)
    }
    events.push(item)
    while (events.length > MAX_EVENTS) events.shift()
    return item
  }

  function setUsage(payload) {
    if (!payload || typeof payload !== 'object') return
    const daily = Array.isArray(payload.daily_usage) ? payload.daily_usage : []
    usage.daily = daily.slice(-7).map((d) => ({
      date: d.date,
      tokens: (d.input_tokens || 0) + (d.output_tokens || 0) +
        (d.cache_read_tokens || 0) + (d.cache_write_tokens || 0)
    }))
    const today = daily.length ? daily[daily.length - 1] : null
    usage.today = today ? {
      input: today.input_tokens || 0,
      output: today.output_tokens || 0,
      cacheRead: today.cache_read_tokens || 0,
      cacheWrite: today.cache_write_tokens || 0,
      tokens: (today.input_tokens || 0) + (today.output_tokens || 0) +
        (today.cache_read_tokens || 0) + (today.cache_write_tokens || 0),
      sessions: today.sessions || 0,
      apiCalls: payload.total_api_calls || 0
    } : null
    usage.totals = {
      input: payload.total_input_tokens || 0,
      output: payload.total_output_tokens || 0,
      cacheRead: payload.total_cache_read_tokens || 0,
      tokens: (payload.total_input_tokens || 0) + (payload.total_output_tokens || 0) +
        (payload.total_cache_read_tokens || 0) + (payload.total_cache_write_tokens || 0),
      sessions: payload.total_sessions || 0,
      apiCalls: payload.total_api_calls || 0
    }
    usage.fetchedAt = Date.now()
  }

  function backfillStream(sessionId, text, ts) {
    if (!text) return
    const st = streamFor(sessionId)
    if (st.reasoning) return
    st.reasoning = clip(text)
    st.ts = ts || st.ts
    st.backfilled = true
  }

  function setSessionUsage(id, row) {
    if (!id || !row) return
    sessionUsage.set(id, {
      input: Number(row.input_tokens) || 0,
      output: Number(row.output_tokens) || 0,
      cacheRead: Number(row.cache_read_tokens) || 0
    })
  }

  function setContextLimit(model, limit) {
    if (!model || !Number.isFinite(limit)) return
    contextLimits.set(model, Math.round(limit))
  }

  function setToolHistory(sessionId, list) {
    if (!sessionId) return
    toolHistory.set(sessionId, {
      at: Date.now(),
      list: Array.isArray(list) ? list.slice(0, 8) : []
    })
  }

  function setRate(next) {
    Object.assign(rate, next, { updatedAt: Date.now() })
  }

  function setSkills(current, top) {
    skills.current = current || null
    skills.top = Array.isArray(top) ? top.slice(0, 8) : []
    skills.fetchedAt = Date.now()
  }

  function visibleProfiles(profiles) {
    if (!profiles || !profiles.length) return null
    return new Set(profiles)
  }

  function snapshot(profiles, now = Date.now()) {
    const allow = visibleProfiles(profiles)
    const ok = (profile) => !allow || allow.has(profile || 'default')
    const t = Math.floor(now / 1000)

    const sess = [...sessions.values()].filter((s) => ok(s.profile))
    const activeSessions = sess.filter((s) => t - s.lastActive < ACTIVE_SEC || (streams.get(s.id) || {}).working)

    const byAgent = new Map()
    for (const s of sess) {
      const agg = byAgent.get(s.agent) || {
        agent: s.agent, profile: s.profile, sessions: 0, tokens: 0,
        messages: 0, toolCalls: 0, lastActive: 0, model: s.model || null,
        provider: s.provider || null, active: false
      }
      agg.sessions += 1
      agg.tokens += (s.inputTokens || 0) + (s.outputTokens || 0) + (s.cacheRead || 0) + (s.cacheWrite || 0)
      agg.messages += s.messageCount || 0
      agg.toolCalls += s.toolCalls || 0
      agg.lastActive = Math.max(agg.lastActive, s.lastActive || 0)
      agg.model = agg.model || s.model || null
      agg.provider = agg.provider || s.provider || null
      agg.active = agg.active || t - (s.lastActive || 0) < ACTIVE_SEC || !!((streams.get(s.id) || {}).working)
      byAgent.set(s.agent, agg)
    }
    const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tokens: 0, messages: 0, toolCalls: 0 }
    for (const s of sess) {
      totals.input += s.inputTokens || 0
      totals.output += s.outputTokens || 0
      totals.cacheRead += s.cacheRead || 0
      totals.cacheWrite += s.cacheWrite || 0
      totals.messages += s.messageCount || 0
      totals.toolCalls += s.toolCalls || 0
    }
    totals.tokens = totals.input + totals.output + totals.cacheRead + totals.cacheWrite

    const recentSessions = sess
      .filter((s) => s.lastActive)
      .sort((a, b) => (b.lastActive || 0) - (a.lastActive || 0))
      .slice(0, 6)
      .map((s) => ({ id: s.id, agent: s.agent, profile: s.profile, title: s.title || '', lastActive: s.lastActive || 0 }))

    let current = null
    for (const s of sess) {
      if (!s.lastActive) continue
      if (!current || s.lastActive > current.lastActive) {
        current = {
          id: s.id, title: s.title || '', agent: s.agent,
          model: s.model || null, provider: s.provider || null,
          lastActive: s.lastActive
        }
      }
    }

    let context = null
    if (current) {
      const row = sessionUsage.get(current.id)
      if (row) context = { tokens: row.input + row.cacheRead, limit: current.model ? (contextLimits.get(current.model) || null) : null }
      else if (current.model && contextLimits.get(current.model)) context = { tokens: null, limit: contextLimits.get(current.model) }
    }

    const activeList = sess
      .filter((s) => (s.lastActive && t - s.lastActive < 120))
      .sort((a, b) => (b.lastActive || 0) - (a.lastActive || 0))
      .slice(0, 8)
      .map((s) => ({ id: s.id, agent: s.agent, profile: s.profile, title: s.title || '', lastActive: s.lastActive || 0 }))

    const agents = [...byAgent.values()].sort((a, b) =>
      (b.active ? 1 : 0) - (a.active ? 1 : 0) || b.lastActive - a.lastActive)

    const streamList = []
    for (const st of streams.values()) {
      if (!ok(st.profile)) continue
      if (!st.reasoning && !st.output && !st.working) continue
      const meta = sessions.get(st.sessionId) || {}
      const ageSec = st.ts ? Math.max(0, Math.round((now - st.ts) / 1000)) : null
      const working = st.working
      const state = working ? 'live'
        : (meta.lastActive && t - meta.lastActive < ACTIVE_SEC) || (ageSec !== null && ageSec < ACTIVE_SEC)
          ? 'active' : 'idle'
      const pick = st.reasoning || st.output
      const item = {
        agent: st.agent,
        profile: st.profile,
        sessionId: st.sessionId,
        title: meta.title || '',
        text: clip(pick, 1200),
        kind: st.reasoning ? 'think' : 'text',
        state,
        working: working ? 1 : 0,
        ageSec,
        ts: st.ts || null
      }
      if (working) {
        item.workKind = st.lastToolAt && now - st.lastToolAt < 15000 ? 'tool' : 'model'
        if (st.workStartedAt) item.workSec = Math.round((now - st.workStartedAt) / 1000)
      }
      streamList.push(item)
    }
    streamList.sort((a, b) =>
      (b.working || 0) - (a.working || 0) ||
      (b.ts || 0) - (a.ts || 0))

    const planList = []
    for (const p of plans.values()) {
      if (!ok(p.profile)) continue
      const meta = sessions.get(p.sessionId) || {}
      const st = streams.get(p.sessionId) || {}
      const sessionActive = !!st.working || (meta.lastActive && t - meta.lastActive < ACTIVE_SEC)
      planList.push({
        agent: p.agent,
        profile: p.profile,
        sessionId: p.sessionId,
        title: p.title,
        state: p.state === 'running' && sessionActive ? 'running' : 'ended',
        sessionActive,
        done: p.done,
        total: p.total,
        steps: p.steps,
        ts: p.ts,
        ageSec: p.ts ? Math.max(0, Math.round((now - p.ts) / 1000)) : null
      })
    }
    planList.sort((a, b) =>
      (b.state === 'running' ? 1 : 0) - (a.state === 'running' ? 1 : 0) || (b.ts || 0) - (a.ts || 0))

    const backfillTools = []
    for (const [sid, rec] of toolHistory) {
      const meta = sessions.get(sid) || {}
      if (!ok(meta.profile)) continue
      for (const item of rec.list) backfillTools.push(item)
    }
    backfillTools.sort((a, b) => (b.at || 0) - (a.at || 0))

    return {
      at: now,
      totals,
      activeSessions: activeList,
      recentSessions,
      current,
      context,
      usage: {
        today: usage.today,
        totals: usage.totals,
        daily: usage.daily,
        fetchedAt: usage.fetchedAt
      },
      rate: { ...rate },
      sessions: { total: sess.length, active: activeSessions.length },
      agents,
      streams: streamList.slice(0, 10),
      taskPlan: { plans: planList.slice(0, 10) },
      toolCount,
      motion: motion(now),
      tools: tools.filter((x) => ok(x.profile)).slice(-20).reverse(),
      backfillTools: backfillTools.slice(0, 12),
      events: events.filter((x) => ok(x.profile)).slice(-30).reverse(),
      skills: { current: skills.current, top: skills.top }
    }
  }

  return {
    sessions, streams, plans, tools, events, usage, skills, rate,
    upsertSessions, streamFor, appendDelta, setWorking, noteTool, setPlan,
    addEvent, setUsage, setRate, setSkills, setSessionUsage, setContextLimit, setToolHistory,
    finishTool, noteSignal, motion,
    backfillStream, snapshot
  }
}
