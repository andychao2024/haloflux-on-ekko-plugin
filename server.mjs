import { readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { assertContracts, registerRpc } from './sdk/harness/contracts.mjs'
import { createStore } from './src/store.mjs'
import { createMetrics } from './src/metrics.mjs'
import { buildLegacyStats } from './src/legacy.mjs'

const contract = assertContracts(JSON.parse(readFileSync(new URL('./contracts/plugin.json', import.meta.url), 'utf8')))
const VERSION = '0.9.1'

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

  let lastSessionsAt = 0
  async function pollSessions(run) {
    if (!run || now() - lastSessionsAt < 8000) return
    lastSessionsAt = now()
    try {
      const listed = await run.host.sessions.list({ limit: 2000 })
      const list = Array.isArray(listed && listed.sessions) ? listed.sessions : []
      store.upsertSessions(list)
    } catch (error) {
      ctx.log.warn('sessions poll failed: ' + String((error && error.message) || error))
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
  const contextLimitBusy = new Set()

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
        store.setSessionUsage(id, row)
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

  const metricTimer = setInterval(() => { if (viewerActive()) metrics.sample() }, 2000)

  ctx.lifecycle.add(() => {
    clearInterval(metricTimer)
  })

  metrics.sample()


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
    return snap
  })

  registerRpc(ctx, contract, 'stats', async (_input, run) => {
    lastViewerAt = now()
    const role = roleCache.has(run.identity.userId) ? roleOf(run) : null
    if (!roleCache.has(run.identity.userId)) roleOf(run).catch(() => {})
    const resolved = role && role.then ? await role : role
    const profiles = resolved === 'super_admin' ? null : [run.identity.profile || 'default']
    // 这些请求都在 Studio 进程内，耗时通常是几十毫秒；必须 await，
    // 否则 RPC 返回时 run.signal 中止，请求会被取消（表现为 “operation was aborted”）。
    if (now() - store.usage.fetchedAt > 60000) await pollUsage(run)
    if (now() - store.skills.fetchedAt > 60000) await pollSkills(run)
    if (now() - lastRateAt > 2500) await pollRate(run)
    await pollSessions(run)
    const snap = store.snapshot(profiles)
    if (snap.current && snap.current.model && (!snap.context || !snap.context.limit)) {
      const model = snap.current.model
      const provider = snap.current.provider || ''
      if (!contextLimitBusy.has(model)) {
        contextLimitBusy.add(model)
        run.host.request('/api/studio/sessions/context-length', { query: { model, provider } })
          .then((v) => { if (v && Number.isFinite(v.context_length)) store.setContextLimit(model, v.context_length) })
          .catch(() => {})
          .finally(() => contextLimitBusy.delete(model))
      }
    }
    return buildLegacyStats(snap, metrics.state, VERSION)
  })

  registerRpc(ctx, contract, 'get-settings', async (_input, run) => {
    const saved = (await run.state.user.namespace('haloflux').get('settings')) || {}
    return {
      anim: saved.anim !== false,
      compat: !!saved.compat,
      title: typeof saved.title === 'string' ? saved.title.slice(0, 80) : '',
      music: !!saved.music
    }
  })

  registerRpc(ctx, contract, 'save-settings', async (input, run) => {
    await run.state.user.namespace('haloflux').set('settings', {
      anim: input.anim !== false,
      compat: !!input.compat,
      title: typeof input.title === 'string' ? input.title.replace(/[\r\n]/g, ' ').trim().slice(0, 80) : '',
      music: !!input.music
    })
    return { ok: true }
  })
}
