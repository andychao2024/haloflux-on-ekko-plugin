import { readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { assertContracts, registerRpc } from './sdk/harness/contracts.mjs'
import { createStore } from './src/store.mjs'
import { createMetrics } from './src/metrics.mjs'
import { buildLegacyStats } from './src/legacy.mjs'

const contract = assertContracts(JSON.parse(readFileSync(new URL('./contracts/plugin.json', import.meta.url), 'utf8')))
const VERSION = '0.8.25'

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

// 列表条数的边界：工具面板最多 15 行（再挤下去每行不足 9px），
// 代理面板沿用原版 12 行上限；两者默认都是 8 行。
const TOOL_ROWS_DEFAULT = 8
const TOOL_ROWS_MIN = 3
const TOOL_ROWS_MAX = 15
const AGENT_ROWS_DEFAULT = 8
const AGENT_ROWS_MIN = 3
const AGENT_ROWS_MAX = 12

// Studio 侧栏里的插件入口由用户导航配置控制；插件设置只负责增删这一项。
const NAV_ITEM = 'plugin:haloflux-ai-link/dashboard'

const clampInt = (value, lo, hi, fallback) => {
  const n = Number(value)
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : fallback
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

  async function readSettings(run) {
    return (await run.state.user.namespace('haloflux').get('settings')) || {}
  }

  /**
   * 把插件入口同步到当前用户的 Studio 导航配置。
   * 返回 true 表示已经一致或写入成功；宿主拒绝写入时抛错，由调用方决定是否降级。
   */
  async function syncNavigation(run, showIcon) {
    const current = await run.host.request('/api/navigation')
    const items = current && Array.isArray(current.items) ? current.items.slice() : []
    const has = items.includes(NAV_ITEM)
    if (showIcon === has) return true
    const next = showIcon ? items.concat(NAV_ITEM) : items.filter((item) => item !== NAV_ITEM)
    await run.host.request('/api/navigation', { method: 'PUT', body: { items: next } })
    return true
  }

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
  let prevRateIds = new Set()   // 上一次参与统计的会话，避免会话进出造成假峰值
  const rateDeltas = []         // { at, tok, out } 最近 90 秒
  let lastRateAt = 0
  const contextLimitBusy = new Set()

  async function pollRate(run) {
    if (rateBusy || !run || now() - lastRateTry < 2500) return
    lastRateTry = now()
    // 最近 6 个会话都纳入统计：Hermes CLI 等外部 Agent 的 last_active
    // 不一定在生成过程中刷新，只按 600 秒窗口会把它漏掉。
    const ids = [...store.sessions.values()]
      .filter((s) => !s.archived)
      .sort((a, b) => (b.lastActive || 0) - (a.lastActive || 0))
      .slice(0, 6)
      .map((s) => s.id)
    for (const [id, stream] of store.streams) {
      if (stream.working && !ids.includes(id)) ids.push(id)
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
        // 只统计连续两次都在采样集合里的会话；否则中断后重入会被当成瞬时爆发
        if (prev && prevRateIds.has(id)) {
          tokDelta += Math.max(0, tok - prev.tok)
          outDelta += Math.max(0, out - prev.out)
        }
        prevUsage.set(id, { tok, out })
        input += row.input_tokens || 0
        cacheRead += row.cache_read_tokens || 0
      }
      prevRateIds = new Set(ids)
      const at = now()
      rateDeltas.push({ at, tok: tokDelta, out: outDelta })
      while (rateDeltas.length > 2 && at - rateDeltas[0].at > 20000) rateDeltas.shift()
      let tokSum = 0
      let outSum = 0
      for (const item of rateDeltas) { tokSum += item.tok; outSum += item.out }
      // 20 秒窗口；窗口不满时按实际跨度折算，避免开头数值虚高
      const span = Math.max(5, Math.min(20, (at - rateDeltas[0].at) / 1000))
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
    // 必须 await：RPC 返回时 run.signal 会中止，没 await 的请求会被取消
    // （日志里表现为 “operation was aborted”）。与 stats 保持一致。
    if (now() - store.usage.fetchedAt > 60000) await pollUsage(run)
    if (now() - store.skills.fetchedAt > 60000) await pollSkills(run)
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

  registerRpc(ctx, contract, 'rate', async (_input, run) => {
    lastViewerAt = now()
    await pollRate(run)
    const rate = store.rate
    return {
      tokensPerSec: round(rate.tokensPerSec || 0, 1),
      outputPerSec: round(rate.outputPerSec || 0, 1),
      cacheHit: round(rate.cacheHit || 0, 1)
    }
  })

  registerRpc(ctx, contract, 'get-settings', async (_input, run) => {
    const saved = await readSettings(run)
    return {
      anim: saved.anim !== false,
      compat: !!saved.compat,
      gpu: saved.gpu !== false,
      showIcon: saved.showIcon !== false,
      music: !!saved.music,
      toolRows: clampInt(saved.toolRows, TOOL_ROWS_MIN, TOOL_ROWS_MAX, TOOL_ROWS_DEFAULT),
      agentRows: clampInt(saved.agentRows, AGENT_ROWS_MIN, AGENT_ROWS_MAX, AGENT_ROWS_DEFAULT),
      title: typeof saved.title === 'string' ? saved.title.slice(0, 80) : ''
    }
  })

  registerRpc(ctx, contract, 'save-settings', async (input, run) => {
    const showIcon = input.showIcon !== false
    await run.state.user.namespace('haloflux').set('settings', {
      anim: input.anim !== false,
      compat: !!input.compat,
      gpu: input.gpu !== false,
      showIcon,
      music: !!input.music,
      toolRows: clampInt(input.toolRows, TOOL_ROWS_MIN, TOOL_ROWS_MAX, TOOL_ROWS_DEFAULT),
      agentRows: clampInt(input.agentRows, AGENT_ROWS_MIN, AGENT_ROWS_MAX, AGENT_ROWS_DEFAULT),
      title: typeof input.title === 'string' ? input.title.replace(/[\r\n]/g, ' ').trim().slice(0, 80) : ''
    })
    let navSynced = false
    try {
      navSynced = await syncNavigation(run, showIcon)
    } catch (error) {
      ctx.log.warn('navigation sync failed: ' + String((error && error.message) || error))
    }
    return { ok: true, navSynced }
  })

  registerRpc(ctx, contract, 'ensure-navigation', async (_input, run) => {
    const saved = await readSettings(run)
    const showIcon = saved.showIcon !== false
    let synced = false
    try {
      synced = await syncNavigation(run, showIcon)
    } catch (error) {
      ctx.log.warn('navigation sync failed: ' + String((error && error.message) || error))
    }
    return { showIcon, synced }
  })
}
