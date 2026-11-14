import { readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { assertContracts, registerRpc } from './sdk/harness/contracts.mjs'
import { createStore } from './src/store.mjs'
import { createMetrics } from './src/metrics.mjs'
import { createConnections } from './src/conn.mjs'
import { buildLegacyStats } from './src/legacy.mjs'

const contract = assertContracts(JSON.parse(readFileSync(new URL('./contracts/plugin.json', import.meta.url), 'utf8')))
const VERSION = '0.6.6'

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
  let lastUsageTry = 0
  let lastSkillTry = 0
  let lastRateTry = 0
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

  async function pollUsage(run) {
    if (usageBusy || !run || now() - lastUsageTry < 15000) return
    usageBusy = true
    lastUsageTry = now()
    try {
      const data = await run.host.request('/api/studio/usage/stats', { query: { days: 7 } })
      store.setUsage(data)
    } catch (error) {
      ctx.log.warn('usage poll failed: ' + String((error && error.message) || error))
    } finally {
      usageBusy = false
    }
  }

  async function pollSkills(run) {
    if (!run || now() - lastSkillTry < 15000) return
    lastSkillTry = now()
    try {
      const data = await run.host.request('/api/hermes/skills/usage/stats')
      const top = Array.isArray(data && data.top_skills) ? data.top_skills : []
      store.setSkills(top[0] ? { name: top[0].skill, count: top[0].total_count || top[0].count } : null, top)
    } catch (error) {
      ctx.log.warn('skills poll failed: ' + String((error && error.message) || error))
    }
  }

  const prevUsage = new Map()   // sessionId -> { tok, out }
  const rateDeltas = []         // { at, tok, out } 最近 90 秒
  let lastRateAt = 0

  async function pollRate(run) {
    if (rateBusy || !run || now() - lastRateTry < 2500) return
    lastRateTry = now()
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
      const data = await run.host.request('/api/studio/sessions/usage', { query: { ids: ids.join(',') } })
      let tokDelta = 0
      let outDelta = 0
      let input = 0
      let cacheRead = 0
      for (const id of ids) {
        const row = data && data[id]
        if (!row) continue
        const tok = (row.input_tokens || 0) + (row.output_tokens || 0) + (row.cache_read_tokens || 0)
        const out = (row.output_tokens || 0)
        const prev = prevUsage.get(id)
        // 只按“同一会话的累计增量”计数；会话进出统计集合不会造成总量跳变
        if (prev) {
          tokDelta += Math.max(0, tok - prev.tok)
          outDelta += Math.max(0, out - prev.out)
        }
        prevUsage.set(id, { tok, out })
        input += row.input_tokens || 0
        cacheRead += row.cache_read_tokens || 0
      }
      const at = now()
      rateDeltas.push({ at, tok: tokDelta, out: outDelta })
      while (rateDeltas.length > 2 && at - rateDeltas[0].at > 90000) rateDeltas.shift()
      let tokSum = 0
      let outSum = 0
      for (const item of rateDeltas) { tokSum += item.tok; outSum += item.out }
      // 90 秒窗口；窗口不满时按实际跨度折算，避免开头数值虚高
      const span = Math.max(5, Math.min(90, (at - rateDeltas[0].at) / 1000))
      const hit = input + cacheRead > 0 ? cacheRead / (input + cacheRead) : 0
      store.setRate({
        tokensPerSec: round(tokSum / span, 1),
        outputPerSec: round(outSum / span, 1),
        cacheHit: round(hit * 100)
      })
      lastRateAt = at
    } catch (error) {
      ctx.log.warn('rate poll failed: ' + String((error && error.message) || error))
    } finally {
      rateBusy = false
    }
  }

  function viewerActive(ms = VIEWER_TTL_MS) {
    return now() - lastViewerAt < ms
  }

  const sessionTimer = setInterval(pollSessions, SESSION_POLL_MS)
  const metricTimer = setInterval(() => { if (viewerActive()) metrics.sample() }, 2000)
  const pruneTimer = setInterval(() => conns.prune(), 30000)

  ctx.lifecycle.add(() => {
    clearInterval(sessionTimer)
    clearInterval(metricTimer)
    clearInterval(pruneTimer)
    conns.closeAll()
  })

  pollSessions()
  metrics.sample()

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
    if (now() - store.usage.fetchedAt > 60000) pollUsage(run)
    if (now() - store.skills.fetchedAt > 60000) pollSkills(run)
    if (now() - lastRateAt > 2500) pollRate(run)
    writeDump('snapshot.json', snap)
    return snap
  })

  registerRpc(ctx, contract, 'stats', async (_input, run) => {
    lastViewerAt = now()
    const role = await roleOf(run)
    const profiles = role === 'super_admin' ? null : [run.identity.profile || 'default']
    if (now() - store.usage.fetchedAt > 60000) await pollUsage(run)
    if (now() - store.skills.fetchedAt > 60000) await pollSkills(run)
    if (now() - lastRateAt > 2500) await pollRate(run)
    const snap = store.snapshot(profiles)
    return buildLegacyStats(snap, metrics.state, VERSION)
  })

  const noteMount = (kind) => {
    if (!dumpDir) return
    try {
      const line = new Date().toISOString() + ' ' + kind + '\n'
      appendFileSync(join(dumpDir, 'mounts.log'), line)
    } catch (_) { /* ignore */ }
  }
  registerRpc(ctx, contract, 'note-dashboard', async () => { noteMount('dashboard'); return null })
  registerRpc(ctx, contract, 'note-settings', async () => { noteMount('settings'); return null })

  registerRpc(ctx, contract, 'get-settings', async (_input, run) => {
    const saved = (await run.state.user.namespace('haloflux').get('settings')) || {}
    return {
      anim: saved.anim !== false,
      display: saved.display === 'link' ? 'link' : 'iframe',
      compat: !!saved.compat
    }
  })

  registerRpc(ctx, contract, 'save-settings', async (input, run) => {
    await run.state.user.namespace('haloflux').set('settings', {
      anim: input.anim !== false,
      display: input.display === 'link' ? 'link' : 'iframe',
      compat: !!input.compat
    })
    return { ok: true }
  })
}
