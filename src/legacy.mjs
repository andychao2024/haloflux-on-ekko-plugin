/**
 * 把插件快照映射成 docker 版 /stats 的结构，供原版 ai-link.js 直接渲染。
 * 字段名与原服务端保持一致；拿不到的历史统计用 null，让界面显示 “—”。
 */
const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null)
const sec = (ms, now = Date.now()) => (ms ? Math.max(0, Math.round((now - ms) / 1000)) : null)

export function buildLegacyStats(snap, host, version) {
  const now = Date.now()
  const usage = snap.usage || {}
  const today = usage.today || {}
  const totals = usage.totals || {}
  const rate = snap.rate || {}
  const agents = Array.isArray(snap.agents) ? snap.agents : []
  const streams = Array.isArray(snap.streams) ? snap.streams : []
  const plans = (snap.taskPlan && Array.isArray(snap.taskPlan.plans)) ? snap.taskPlan.plans : []
  const tools = Array.isArray(snap.tools) ? snap.tools : []
  const events = Array.isArray(snap.events) ? snap.events : []
  const topAgent = agents[0] || {}
  const topStream = streams[0] || {}
  const primary = plans[0] || null
  const running = plans.filter((p) => p.state === 'running')
  const active = agents.filter((a) => a.active)

  return {
    cpu: num(host.cpu),
    cpuCores: Array.isArray(host.cpuCores) ? host.cpuCores : [],
    cpuName: host.cpuName || 'CPU',
    ram: num(host.ram),
    ramDetail: host.ramDetail || null,
    gpu: null,
    disk: host.disk ? Object.assign({ available: true }, host.disk) : null,
    net: host.net || null,
    uptimeSec: num(host.uptimeSec),
    link: { source: 'studio-plugin' },
    server: {
      version,
      cores: Array.isArray(host.cpuCores) ? host.cpuCores.length : 0,
      source: 'ekko-studio-plugin'
    },
    ai: {
      source: 'ekko-studio',
      build: 'plugin',
      sessionId: topStream.sessionId || null,
      sessionTitle: topStream.title || topAgent.agent || null,
      agent: topAgent.agent || null,
      model: topAgent.model || topStream.model || null,
      provider: topAgent.provider || null,
      tokensPerSec: num(rate.tokensPerSec),
      outputTokensPerSec: num(rate.outputPerSec),
      cacheHitRate: num(rate.cacheHit),
      contextTokens: null,
      contextLimit: null,
      tokensTotal: num(totals.tokens),
      todayTokens: num(today.tokens),
      inputTokens: num(totals.input),
      outputTokens: num(totals.output),
      cacheReadTokens: num(totals.cacheRead),
      activeAgents: active.length,
      agents: agents.map((a) => ({
        agent: a.agent,
        profile: a.profile,
        sessions: a.sessions,
        openSessions: a.sessions,
        archivedSessions: 0,
        activeSessions: a.active ? a.sessions : 0,
        running: a.active ? 1 : 0,
        tokensTotal: a.tokens,
        messages: a.messages,
        toolCalls: num(snap.toolCount) || 0,
        model: a.model || null,
        title: null,
        lastActive: a.lastActive,
        active: !!a.active
      })),
      sessions: snap.sessions ? snap.sessions.total : null,
      toolCalls: num(snap.toolCount) || 0,
      messages: agents.reduce((n, a) => n + (a.messages || 0), 0),
      recentTools: tools.map((t) => ({
        agent: t.agent,
        name: t.name,
        arg: t.arg,
        state: t.state,
        at: t.at,
        ageSec: sec(t.at, now)
      })),
      recentCalls: null,
      currentSkill: snap.skills && snap.skills.current
        ? { name: snap.skills.current.name, agent: null, action: null, at: null, ageSec: null, active: false }
        : null,
      skills: (snap.skills && Array.isArray(snap.skills.top) ? snap.skills.top : []).map((s) => ({
        name: s.skill || s.name,
        count: s.total_count || s.count || 0,
        lastAt: null
      })),
      daily: (usage.daily || []).map((d) => ({ date: d.date, tokens: d.tokens, sessions: 0 })),
      streams: streams.map((s) => {
        const item = {
          agent: s.agent,
          profile: s.profile,
          text: s.text,
          kind: s.kind,
          state: s.state,
          working: s.working,
          pendingSec: null,
          ageSec: s.ageSec,
          sessionId: s.sessionId,
          title: s.title,
          ts: s.ts
        }
        // 可选字段不能是 undefined：SDK 会拒绝整份 JSON
        if (s.workKind) item.workKind = s.workKind
        if (typeof s.workSec === 'number') item.workSec = s.workSec
        return item
      }),
      pendingAgents: [],
      pendingSec: null,
      planActive: running.length > 0,
      planAgeSec: running[0] ? running[0].ageSec : null,
      taskPlan: primary ? {
        agent: primary.agent,
        title: primary.title,
        state: primary.state,
        sessionActive: primary.sessionActive,
        done: primary.done,
        total: primary.total,
        steps: primary.steps,
        ageSec: primary.ageSec,
        plans
      } : { plans },
      lastEvent: events[0] ? events[0].type : null,
      lastEventAgeSec: events[0] ? sec(events[0].at, now) : null,
      turns: null,
      steps: null,
      jobsRunning: null
    }
  }
}
