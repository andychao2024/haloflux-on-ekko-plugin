import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { assertContracts, registerRpc } from './sdk/harness/contracts.mjs'
import { createStore } from './src/store.mjs'
import { createMetrics } from './src/metrics.mjs'
import { buildLegacyStats } from './src/legacy.mjs'
import { startWallpaperServer } from './src/wallpaper-server.mjs'
import { parseToolMessages } from './src/tool-history.mjs'
import { messagesWorking } from './src/session-state.mjs'
import { applyMotionSignals } from './src/motion-signals.mjs'
import { applyWallpaperActivity } from './src/wallpaper-activity.mjs'
import { createConnections } from './src/conn.mjs'

const contract = assertContracts(JSON.parse(readFileSync(new URL('./contracts/plugin.json', import.meta.url), 'utf8')))
const VERSION = '0.10.04'

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
const IDLE_SPIN_DEFAULT = 3
const IDLE_SPIN_MIN = 2
const IDLE_SPIN_MAX = 60
const WALLPAPER_PENDING_WINDOW_SEC = 3600
// 历史轮询兜底的保鲜窗口。轮询每 10 秒一次，但 Studio host 请求偶发被中止
// （日志表现为 "operation was aborted"），一次失败就让 60 秒窗口断粮，
// 会造成 codex 长工具执行期间「运行中→离线→又运行中」的闪烁。
// 放宽到 120 秒（约可扛 10 次连续失败），配合失败时沿用上次工作状态。
const WALLPAPER_PENDING_TTL_MS = 120 * 1000

const WALLPAPER_PORT_DEFAULT = 8790

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
  // 壁纸页没有 iframe 页面通道；由插件生命周期持有 sessions.connect，
  // 把当前回合的思考/工具/计划写进共享 store。
  const liveConn = createConnections({ host: ctx.host, store, log: ctx.log, max: 4 })
  const dumpDir = ctx.paths && ctx.paths.dataDir ? ctx.paths.dataDir : null
  // 重启后先恢复上次成功拿到的会话列表；Studio 后台 host API 在没有
  // 插件页时可能暂时不可用，至少让壁纸端还能显示并连接已知会话。
  try {
    if (dumpDir) {
      const cached = JSON.parse(readFileSync(join(dumpDir, 'snapshot.json'), 'utf8'))
      const list = Array.isArray(cached && cached.sessions) ? cached.sessions : []
      if (list.length) {
        store.upsertSessions(list.map((s) => ({
          id: s.id,
          profile: s.profile,
          agent: s.agent,
          title: s.title,
          last_active: s.lastActive,
          message_count: s.messageCount,
          input_tokens: s.inputTokens,
          output_tokens: s.outputTokens,
          cache_read_tokens: s.cacheRead,
          cache_write_tokens: s.cacheWrite,
          tool_call_count: s.toolCalls,
          is_archived: s.archived
        })))
      }
    }
  } catch (_) { /* first run or old cache format */ }
  let lastViewerAt = 0
  let usageBusy = false
  let rateBusy = false
  let lastUsageTry = 0
  let lastSkillTry = 0
  let lastRateTry = 0
  const roleCache = new Map()

  let wallpaper = null
  let wallpaperPort = 0
  let wallpaperToken = ''
  let wallpaperTokenCurrent = ''
  let wallpaperBusy = null
  let wallpaperError = ''
  let wallpaperDisplayKey = ''
  const wallpaperPending = new Map()   // sessionId -> { working, at }

  const makeToken = () => randomBytes(16).toString('hex')
  // 首次安装随机生成访问密钥并持久化到插件共享状态
  const wallpaperConfigReady = (async () => {
    let cfg = null
    try { cfg = await ctx.state.plugin.get('wallpaper') } catch (_) { cfg = null }
    if (!cfg || typeof cfg !== 'object') cfg = {}
    if (typeof cfg.token !== 'string' || !cfg.token) cfg.token = makeToken()
    wallpaperToken = cfg.token
    try { await ctx.state.plugin.set('wallpaper', cfg) } catch (_) { /* ignore */ }
    return cfg
  })()

  function wallpaperRun() {
    // 壁纸服务没有 Studio 页面身份，使用插件激活身份（管理员），只读。
    return {
      identity: ctx.identity,
      host: ctx.host,
      signal: ctx.signal
    }
  }

  async function stopWallpaper() {
    if (!wallpaper) return
    const current = wallpaper
    wallpaper = null
    wallpaperPort = 0
    wallpaperTokenCurrent = ''
    wallpaperDisplayKey = ''
    try { await liveConn.closeAll() } catch (_) { /* ignore */ }
    try { await current.close() } catch (_) { /* ignore */ }
  }

  let liveToolAt = 0

  async function backfillWallpaperTools(run) {
    const host = run && run.host ? run.host : ctx.host
    const recent = store.snapshot(null).recentSessions.slice(0, 4)
    for (const meta of recent) {
      if (!meta || !meta.id) continue
      try {
        const res = await host.sessions.messages(meta.id, { limit: 40 })
        const messages = Array.isArray(res && res.messages) ? res.messages : []
        const plans = Array.isArray(res && res.taskPlans) ? res.taskPlans : []
        if (plans[0]) store.setPlan(meta.id, plans[0])
        const at = now()
        const lastActive = Number(meta.lastActive) || 0
        const lastActiveSec = lastActive > 1e12 ? lastActive / 1000 : lastActive
        // 外部 Agent（Codex 等）的 last_active 可能到回合结束才更新；
        // 用 1 小时窗口兜底长回合，避免壁纸端误判为停止。
        const recent = lastActiveSec > 0 && at / 1000 - lastActiveSec <= WALLPAPER_PENDING_WINDOW_SEC
        wallpaperPending.set(meta.id, { working: recent && messagesWorking(messages), at, agent: meta.agent || 'unknown' })
        const list = parseToolMessages(messages, 8, at).map((item) => ({
          profile: meta.profile || 'default',
          agent: meta.agent || 'unknown',
          sessionId: meta.id,
          at: item.at,
          name: item.name,
          arg: item.arg,
          state: item.state
        }))
        for (let i = messages.length - 1; i >= 0; i--) {
          const message = messages[i]
          if (!message || message.role !== 'assistant') continue
          const text = message.reasoning_content || message.reasoning || message.content
          if (text && String(text).trim()) {
            const rawTs = Number(message.timestamp)
            const ts = rawTs > 1e12 ? rawTs : rawTs > 0 ? rawTs * 1000 : at
            store.backfillStream(meta.id, String(text).trim(), ts)
          }
          break
        }
        store.setToolHistory(meta.id, list)
      } catch (error) {
        // 轮询失败不推倒重来：沿用上一次的工作状态并续命（at 不更新内容只续时间戳，
        // 由 WALLPAPER_PENDING_TTL_MS 限制最长续命），避免单次请求被中止时
        // 看板把仍在工作的 codex 闪断成离线。
        const prev = wallpaperPending.get(meta.id)
        if (prev && prev.working) {
          wallpaperPending.set(meta.id, { ...prev, at: now() })
        }
        ctx.log.warn('wallpaper pending poll failed: ' + String((error && error.message) || error))
      }
    }
    const cutoff = now() - 300000
    for (const [id, rec] of wallpaperPending) if (!rec || rec.at < cutoff) wallpaperPending.delete(id)
  }

  // 壁纸页直接复用插件设置里的显示项；保存后重启服务即可让已打开的页面刷新。
  function wallpaperDisplay(settings) {
    return {
      anim: settings.anim !== false,
      compat: !!settings.compat,
      gpu: settings.gpu !== false,
      toolRows: clampInt(settings.toolRows, TOOL_ROWS_MIN, TOOL_ROWS_MAX, TOOL_ROWS_DEFAULT),
      agentRows: clampInt(settings.agentRows, AGENT_ROWS_MIN, AGENT_ROWS_MAX, AGENT_ROWS_DEFAULT),
      idleSpinSec: clampInt(settings.idleSpinSec, IDLE_SPIN_MIN, IDLE_SPIN_MAX, IDLE_SPIN_DEFAULT),
      stage: settings.stage === 'classic' ? 'classic' : 'nova',
      title: typeof settings.title === 'string' ? settings.title : ''
    }
  }

  async function ensureWallpaper(settings) {
    await wallpaperConfigReady
    const want = !!settings.wallpaper
    const port = clampInt(settings.wallpaperPort, 1024, 65535, WALLPAPER_PORT_DEFAULT)
    const token = (typeof settings.wallpaperToken === 'string' && settings.wallpaperToken.trim()) || wallpaperToken
    const display = wallpaperDisplay(settings)
    const displayKey = JSON.stringify(display)
    if (!want) {
      await stopWallpaper()
      wallpaperError = ''
      return false
    }
    if (wallpaper && wallpaperPort === port && wallpaperTokenCurrent === token && wallpaperDisplayKey === displayKey) return true
    if (wallpaperBusy) { try { await wallpaperBusy } catch (_) { /* ignore */ } }
    wallpaperBusy = (async () => {
      await stopWallpaper()
      try {
        wallpaper = await startWallpaperServer({
          port,
          token,
          display,
          getStats: () => {
            return buildStats(wallpaperRun(), { live: true }).catch((error) => {
              ctx.log.warn('wallpaper stats failed: ' + String((error && error.message) || error))
              throw error
            })
          }
        })
        wallpaperPort = port
        wallpaperTokenCurrent = token
        wallpaperToken = token
        wallpaperDisplayKey = displayKey
        wallpaperError = ''
        ctx.log.info('wallpaper server listening on ' + wallpaper.url)
        return true
      } catch (error) {
        wallpaper = null
        wallpaperPort = 0
        wallpaperDisplayKey = ''
        wallpaperError = String((error && error.message) || error)
        ctx.log.warn('wallpaper server failed: ' + wallpaperError)
        return false
      }
    })()
    try { return await wallpaperBusy } finally { wallpaperBusy = null }
  }

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
      lastSessionsAt = 0
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
      lastRateTry = 0
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
    void liveConn.closeAll()
    stopWallpaper()
  })

  // Studio 重启后不需要先打开设置页：按最后一次保存的全局配置自动拉起壁纸服务
  wallpaperConfigReady.then((cfg) => {
    if (!cfg || !cfg.enabled) return
    return ensureWallpaper(Object.assign({}, cfg.display || {}, {
      wallpaper: true, wallpaperPort: cfg.port, wallpaperToken: cfg.token
    }))
  }).catch(() => { /* ignore */ })

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
    const workingByAgent = new Map()
    const workingSessions = new Set()
    const recentWorkIds = new Set((snap.recentSessions || [])
      .filter((item) => {
        const last = Number(item && item.lastActive)
        const at = last > 1e12 ? last / 1000 : last
        return at > 0 && now() / 1000 - at <= 600
      })
      .map((item) => item.id))
    for (const [id, rec] of wallpaperPending) {
      if (!rec || !rec.working || now() - rec.at >= WALLPAPER_PENDING_TTL_MS) continue
      if (!recentWorkIds.has(id)) continue
      workingSessions.add(id)
      if (rec.agent) workingByAgent.set(rec.agent, (workingByAgent.get(rec.agent) || 0) + 1)
    }
    // 历史消息暂时没标出“未完成”，但思考流刚刚更新时也说明 Agent 仍在工作。
    for (const stream of snap.streams) {
      if (!stream || !stream.agent || workingSessions.has(stream.sessionId)) continue
      if (typeof stream.ageSec === 'number' && stream.ageSec <= 60) {
        workingByAgent.set(stream.agent, Math.max(1, workingByAgent.get(stream.agent) || 0))
      }
    }
    applyWallpaperActivity(snap, workingSessions)
    if (snap.taskPlan && Array.isArray(snap.taskPlan.plans)) {
      for (const plan of snap.taskPlan.plans) {
        if (!workingSessions.has(plan.sessionId)) continue
        // 只恢复最近 10 分钟内更新的计划；不要把历史已结束计划重新拉起来。
        const age = typeof plan.ageSec === 'number' ? plan.ageSec : null
        if (plan.state !== 'running' && (age === null || age > 600)) continue
        plan.state = 'running'
        plan.sessionActive = true
      }
    }
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

  async function buildStats(run, options = {}) {
    lastViewerAt = now()
    const role = roleCache.has(run.identity.userId) ? roleOf(run) : null
    if (!roleCache.has(run.identity.userId)) roleOf(run).catch(() => {})
    const resolved = role && role.then ? await role : role
    const profiles = resolved === 'super_admin' ? null : [run.identity.profile || 'default']
    // 壁纸 /stats 不能等待 Studio 后台 host 请求：没有插件页时这些请求
    // 可能一直挂起。先返回缓存/实时连接数据，再在后台刷新；插件页 RPC
    // 仍保持 await，确保页面首次打开时能拿到最新数据。
    const liveMode = options.live === true
    if (liveMode) {
      if (now() - store.usage.fetchedAt > 60000) void pollUsage(run).catch(() => {})
      if (now() - store.skills.fetchedAt > 60000) void pollSkills(run).catch(() => {})
      void pollSessions(run).catch(() => {})
      void pollRate(run).catch(() => {})
      if (now() - liveToolAt > 10000) {
        liveToolAt = now()
        void backfillWallpaperTools(run).catch(() => {})
      }
    } else {
      // 这些请求通常在几十毫秒内完成；必须 await，否则 RPC 返回时
      // run.signal 中止会取消请求（日志里是 “operation was aborted”）。
      if (now() - store.usage.fetchedAt > 60000) await pollUsage(run)
      if (now() - store.skills.fetchedAt > 60000) await pollSkills(run)
      await pollSessions(run)
      try { await pollRate(run) } catch (_) { /* ignore */ }
      if (now() - liveToolAt > 10000) {
        liveToolAt = now()
        try { await backfillWallpaperTools(run) } catch (_) { /* ignore */ }
      }
    }
    const snap = store.snapshot(profiles)
    writeDump('snapshot.json', {
      at: now(),
      sessions: [...store.sessions.values()].map((s) => ({
        id: s.id,
        profile: s.profile,
        agent: s.agent,
        title: s.title,
        lastActive: s.lastActive,
        messageCount: s.messageCount,
        inputTokens: s.inputTokens,
        outputTokens: s.outputTokens,
        cacheRead: s.cacheRead,
        cacheWrite: s.cacheWrite,
        toolCalls: s.toolCalls,
        archived: !!s.archived
      }))
    })
    // 只有壁纸服务自己的 /stats 才维持后台实时连接；插件页的 stats RPC
    // 已有页面端 live slot，不需要再重复订阅。
    const useLive = options.live === true && !!wallpaper
    if (useLive) liveConn.sync(snap.recentSessions.slice(0, 4))
    const liveSlots = useLive ? liveConn.slots() : []
    const workingSessions = new Set()
    const agentBySession = new Map()
    for (const [id, rec] of wallpaperPending) {
      if (!rec || !rec.working || now() - rec.at >= WALLPAPER_PENDING_TTL_MS) continue
      workingSessions.add(id)
      if (rec.agent) agentBySession.set(id, rec.agent)
    }
    for (const slot of liveSlots) {
      if (!slot || !slot.working) continue
      workingSessions.add(slot.sessionId)
      if (slot.agent) agentBySession.set(slot.sessionId, slot.agent)
    }
    const workingByAgent = new Map()
    for (const id of workingSessions) {
      const agent = agentBySession.get(id)
      if (agent) workingByAgent.set(agent, (workingByAgent.get(agent) || 0) + 1)
    }
    applyWallpaperActivity(snap, workingSessions)
    if (snap.taskPlan && Array.isArray(snap.taskPlan.plans)) {
      for (const plan of snap.taskPlan.plans) {
        if (!workingSessions.has(plan.sessionId)) continue
        // 只恢复最近 10 分钟内更新的计划；不要把历史已结束计划重新拉起来。
        const age = typeof plan.ageSec === 'number' ? plan.ageSec : null
        if (plan.state !== 'running' && (age === null || age > 600)) continue
        plan.state = 'running'
        plan.sessionActive = true
      }
    }
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
    const stats = buildLegacyStats(snap, metrics.state, VERSION)
    // 代理调度：有实时/未完成信号时以它为准；没有信号时保留最近 60 秒活动的 Agent，
    // 避免后台数据暂时缺失时把整块面板全部清空。
    let activeAgents = 0
    const nowSec = Math.floor(now() / 1000)
    for (const agent of stats.ai.agents) {
      const count = workingByAgent.get(agent.agent) || 0
      const raw = Number(agent.lastActive)
      const last = raw > 1e12 ? Math.floor(raw / 1000) : raw
      const recent = last > 0 && nowSec - last <= 60
      agent.active = count > 0 || recent
      agent.running = agent.active ? 1 : 0
      agent.activeSessions = count
      if (agent.active) activeAgents += 1
    }
    stats.ai.activeAgents = activeAgents
    // 与插件页共用同一套忙碌判定；壁纸端把后台实时 slot 一并交给它，
    // 当前回合的思考/工具事件可以立即驱动动效。
    applyMotionSignals(stats.ai, {
      now: now(),
      liveEvent: useLive ? liveConn.lastEvent() : null,
      liveSlots,
      pendingSessions: wallpaperPending.values(),
      sessions: snap.recentSessions
    })
    return stats
  }

  registerRpc(ctx, contract, 'stats', async (_input, run) => buildStats(run))

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
    await wallpaperConfigReady
    await ensureWallpaper({ ...saved, wallpaperToken })

    return {
      anim: saved.anim !== false,
      compat: !!saved.compat,
      gpu: saved.gpu !== false,
      showIcon: saved.showIcon !== false,
      wallpaper: !!saved.wallpaper,
      wallpaperPort: clampInt(saved.wallpaperPort, 1024, 65535, WALLPAPER_PORT_DEFAULT),
      wallpaperToken: wallpaperToken,
      toolRows: clampInt(saved.toolRows, TOOL_ROWS_MIN, TOOL_ROWS_MAX, TOOL_ROWS_DEFAULT),
      agentRows: clampInt(saved.agentRows, AGENT_ROWS_MIN, AGENT_ROWS_MAX, AGENT_ROWS_DEFAULT),
      idleSpinSec: clampInt(saved.idleSpinSec, IDLE_SPIN_MIN, IDLE_SPIN_MAX, IDLE_SPIN_DEFAULT),
      stage: saved.stage === 'classic' ? 'classic' : 'nova',
      title: typeof saved.title === 'string' ? saved.title.slice(0, 80) : ''
    }
  })

  registerRpc(ctx, contract, 'wallpaper-status', async () => {
    if (!wallpaper || typeof wallpaper.status !== 'function') return { viewers: 0, running: false }
    let status = null
    try { status = wallpaper.status() } catch (_) { status = null }
    const viewers = status && Number.isFinite(status.viewers) ? Math.max(0, Math.round(status.viewers)) : 0
    return { viewers, running: true }
  })

  registerRpc(ctx, contract, 'save-settings', async (input, run) => {
    await wallpaperConfigReady
    const showIcon = input.showIcon !== false
    const token = (typeof input.wallpaperToken === 'string' && input.wallpaperToken.trim()) || makeToken()
    wallpaperToken = token
    const savedSettings = {
      anim: input.anim !== false,
      compat: !!input.compat,
      gpu: input.gpu !== false,
      showIcon,
      wallpaper: !!input.wallpaper,
      wallpaperPort: clampInt(input.wallpaperPort, 1024, 65535, WALLPAPER_PORT_DEFAULT),
      wallpaperToken: token,
      toolRows: clampInt(input.toolRows, TOOL_ROWS_MIN, TOOL_ROWS_MAX, TOOL_ROWS_DEFAULT),
      agentRows: clampInt(input.agentRows, AGENT_ROWS_MIN, AGENT_ROWS_MAX, AGENT_ROWS_DEFAULT),
      idleSpinSec: clampInt(input.idleSpinSec, IDLE_SPIN_MIN, IDLE_SPIN_MAX, IDLE_SPIN_DEFAULT),
      stage: input.stage === 'classic' ? 'classic' : 'nova',
      title: typeof input.title === 'string' ? input.title.replace(/[\r\n]/g, ' ').trim().slice(0, 80) : ''
    }
    await run.state.user.namespace('haloflux').set('settings', savedSettings)
    try {
      await ctx.state.plugin.set('wallpaper', {
        enabled: savedSettings.wallpaper,
        port: savedSettings.wallpaperPort,
        token,
        display: wallpaperDisplay(savedSettings)
      })
    } catch (_) { /* 共享状态不可用时不阻断保存 */ }
    await ensureWallpaper(savedSettings)
    let navSynced = false
    try {
      navSynced = await syncNavigation(run, showIcon)
    } catch (error) {
      ctx.log.warn('navigation sync failed: ' + String((error && error.message) || error))
    }
    return { ok: true, navSynced, wallpaperError, wallpaperToken }
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
