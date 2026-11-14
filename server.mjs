import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { assertContracts, registerRpc } from './sdk/harness/contracts.mjs'
import { createStore } from './src/store.mjs'
import { createMetrics } from './src/metrics.mjs'
import { createConnections } from './src/conn.mjs'
import { buildLegacyStats } from './src/legacy.mjs'

const contract = assertContracts(JSON.parse(readFileSync(new URL('./contracts/plugin.json', import.meta.url), 'utf8')))
const VERSION = '0.4.0'

const SESSION_POLL_MS = 8000
const USAGE_POLL_MS = 30000
const SKILL_POLL_MS = 60000
const RATE_POLL_MS = 2000
const VIEWER_TTL_MS = 30000

const now = () => Date.now()
const round = (n, d = 1) => {
  const p = 10 ** d
  return Math.round(n * p) / p
}

/** @param {import('@ekko-studio/plugin-sdk').PluginContext} ctx */
export function apply(ctx) {
  const startedAt = now()
  const store = createStore()
  const metrics = createMetrics()
  const conns = createConnections({ host: ctx.host, store, log: ctx.log })
  const dumpDir = ctx.paths && ctx.paths.dataDir ? ctx.paths.dataDir : null
  let lastViewerAt = 0
  let usageBusy = false
  let rateBusy = false
  let lastRate = { total: 0, input: 0, output: 0, cacheRead: 0, at: 0 }
  const rateHistory = []
  const roleCache = new Map()

  let lastSnapshotDump = 0
  const writeDump = (name, value) => {
    if (!dumpDir) return
    if (name === 'snapshot.json' && now() - lastSnapshotDump < 5000) return
    if (name === 'snapshot.json') lastSnapshotDump = now()
    try { writeFileSync(join(dumpDir, name), JSON.stringify(value, null, 2)) } catch (_) { /* ignore */ }
  }

  async function pollSessions() {
    try {
      const listed = await ctx.host.sessions.list({ limit: 200 })
      const list = Array.isArray(listed && listed.sessions) ? listed.sessions : []
      store.upsertSessions(list)
      const t = Math.floor(now() / 1000)
      for (const s of list) {
        if (s.is_archived) continue
        if (t - (Number(s.last_active) || 0) < 300) conns.ensure(s.id)
      }
    } catch (error) {
      ctx.log.warn('sessions poll failed', String((error && error.message) || error))
    }
  }

  async function pollUsage() {
    if (usageBusy) return
    usageBusy = true
    try {
      const data = await ctx.host.request('/api/studio/usage/stats', { query: { days: 7 } })
      store.setUsage(data)
    } catch (error) {
      ctx.log.warn('usage poll failed', String((error && error.message) || error))
    } finally {
      usageBusy = false
    }
  }

  async function pollSkills() {
    try {
      const data = await ctx.host.request('/api/hermes/skills/usage/stats')
      const top = Array.isArray(data && data.top_skills) ? data.top_skills : []
      store.setSkills(top[0] ? { name: top[0].skill, count: top[0].total_count || top[0].count } : null, top)
    } catch (error) {
      ctx.log.warn('skills poll failed', String((error && error.message) || error))
    }
  }

  async function pollRate() {
    if (rateBusy) return
    const t = Math.floor(now() / 1000)
    const ids = []
    for (const s of store.sessions.values()) {
      if (s.archived) continue
      if (t - (s.lastActive || 0) < 600 || (store.streams.get(s.id) || {}).working) ids.push(s.id)
      if (ids.length >= 24) break
    }
    if (!ids.length) return
    rateBusy = true
    try {
      const data = await ctx.host.request('/api/studio/sessions/usage', { query: { ids: ids.join(',') } })
      let total = 0
      let input = 0
      let output = 0
      let cacheRead = 0
      for (const id of ids) {
        const row = data && data[id]
        if (!row) continue
        total += (row.input_tokens || 0) + (row.output_tokens || 0) + (row.cache_read_tokens || 0)
        input += row.input_tokens || 0
        output += row.output_tokens || 0
        cacheRead += row.cache_read_tokens || 0
      }
      const at = now()
      if (lastRate.at) {
        const dt = (at - lastRate.at) / 1000
        const dTotal = Math.max(0, total - lastRate.total)
        const dOutput = Math.max(0, output - lastRate.output)
        rateHistory.push({ at, total })
        while (rateHistory.length > 2 && at - rateHistory[0].at > 90000) rateHistory.shift()
        const span = (at - rateHistory[0].at) / 1000
        const gained = total - rateHistory[0].total
        const hit = input + cacheRead > 0 ? cacheRead / (input + cacheRead) : 0
        store.setRate({
          tokensPerSec: span > 1 ? round(Math.max(0, gained) / span, 1) : round(dTotal / dt, 1),
          outputPerSec: dt > 0.5 ? round(dOutput / dt, 1) : 0,
          cacheHit: round(hit * 100)
        })
      }
      lastRate = { total, input, output, cacheRead, at }
    } catch (error) {
      ctx.log.warn('rate poll failed', String((error && error.message) || error))
    } finally {
      rateBusy = false
    }
  }

  function viewerActive(ms = VIEWER_TTL_MS) {
    return now() - lastViewerAt < ms
  }

  const sessionTimer = setInterval(pollSessions, SESSION_POLL_MS)
  const usageTimer = setInterval(() => { if (viewerActive(SKILL_POLL_MS)) pollUsage() }, USAGE_POLL_MS)
  const skillTimer = setInterval(() => { if (viewerActive(SKILL_POLL_MS)) pollSkills() }, SKILL_POLL_MS)
  const rateTimer = setInterval(() => { if (viewerActive()) pollRate() }, RATE_POLL_MS)
  const metricTimer = setInterval(() => { if (viewerActive()) metrics.sample() }, 2000)
  const pruneTimer = setInterval(() => conns.prune(), 30000)

  ctx.lifecycle.add(() => {
    clearInterval(sessionTimer)
    clearInterval(usageTimer)
    clearInterval(skillTimer)
    clearInterval(rateTimer)
    clearInterval(metricTimer)
    clearInterval(pruneTimer)
    conns.closeAll()
  })

  ctx.events.on('chat.*', (event) => {
    try {
      const data = event && event.data ? event.data : {}
      const subject = typeof data.subject === 'string' ? JSON.parse(data.subject) : (data.subject || {})
      const sessionId = subject.session_id
      const type = String(event.type || '')
      const profile = (event.identity && event.identity.profile) || 'default'
      if (!sessionId) return
      conns.ensure(sessionId)
      if (type === 'chat.plan.updated' && data.task_plan) store.setPlan(sessionId, data.task_plan)
      if (type === 'chat.run.completed' || type === 'chat.run.failed' || type === 'chat.run.stopped') {
        store.setWorking(sessionId, false)
      }
      store.addEvent({ type: type.replace('chat.', ''), profile, agent: (store.streamFor(sessionId) || {}).agent, text: (data.summary && data.summary.status) || '' })
    } catch (_) { /* ignore */ }
  })

  pollSessions()
  metrics.sample()
  setTimeout(() => { if (viewerActive(SKILL_POLL_MS)) { pollUsage(); pollSkills() } }, 1500)

  // P1 自检：无人打开页面时也落一份快照，便于开发期核对（发布前移除）
  const selfDumpTimer = setTimeout(() => {
    try {
      const snap = store.snapshot(null)
      snap.host = metrics.state
      snap.server = { version: VERSION, connections: conns.size(), selfCheck: true }
      writeDump('snapshot-self.json', snap)
    } catch (_) { /* ignore */ }
  }, 6000)
  ctx.lifecycle.add(() => clearTimeout(selfDumpTimer))

  async function roleOf(run) {
    const uid = run.identity.userId
    const cached = roleCache.get(uid)
    if (cached && now() - cached.at < 60000) return cached.role
    let role = null
    try {
      const auth = await run.host.request('/api/auth/status')
      role = auth && auth.user && auth.user.role ? auth.user.role : null
    } catch (_) { /* ignore */ }
    roleCache.set(uid, { role, at: now() })
    return role
  }

  registerRpc(ctx, contract, 'snapshot', async (_input, run) => {
    lastViewerAt = now()
    const role = await roleOf(run)
    const profiles = role === 'super_admin' ? null : [run.identity.profile || 'default']
    const snap = store.snapshot(profiles)
    snap.server = {
      version: VERSION,
      startedAt,
      uptimeSec: Math.round((now() - startedAt) / 1000),
      connections: conns.size(),
      profiles: profiles || 'all'
    }
    snap.host = {
      cpu: metrics.state.cpu,
      cpuCores: metrics.state.cpuCores,
      cpuName: metrics.state.cpuName,
      ram: metrics.state.ram,
      ramDetail: metrics.state.ramDetail,
      disk: metrics.state.disk,
      net: metrics.state.net,
      uptimeSec: metrics.state.uptimeSec
    }
    if (viewerActive(15000) && now() - store.usage.fetchedAt > 60000) pollUsage()
    if (viewerActive(15000) && now() - store.skills.fetchedAt > 60000) pollSkills()
    if (!lastRate.at) pollRate()
    writeDump('snapshot.json', snap)
    return snap
  })

  registerRpc(ctx, contract, 'stats', async (_input, run) => {
    lastViewerAt = now()
    const role = await roleOf(run)
    const profiles = role === 'super_admin' ? null : [run.identity.profile || 'default']
    const snap = store.snapshot(profiles)
    if (viewerActive(15000) && now() - store.usage.fetchedAt > 60000) pollUsage()
    if (viewerActive(15000) && now() - store.skills.fetchedAt > 60000) pollSkills()
    if (!lastRate.at) pollRate()
    return buildLegacyStats(snap, metrics.state, VERSION)
  })

  registerRpc(ctx, contract, 'get-settings', async (_input, run) => {
    const saved = (await run.state.user.namespace('haloflux').get('settings')) || {}
    return { anim: saved.anim !== false, fps: saved.fps === 60 ? 60 : 30 }
  })

  registerRpc(ctx, contract, 'save-settings', async (input, run) => {
    await run.state.user.namespace('haloflux').set('settings', {
      anim: input.anim !== false,
      fps: input.fps === 60 ? 60 : 30
    })
    return { ok: true }
  })
}
