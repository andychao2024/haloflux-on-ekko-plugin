import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { assertContracts, registerRpc } from './sdk/harness/contracts.mjs'

const contract = assertContracts(JSON.parse(readFileSync(new URL('./contracts/plugin.json', import.meta.url), 'utf8')))

const MAX_EVENTS = 200
const events = []
const counts = Object.create(null)
let startedAt = Date.now()

function clip(value, max) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > max ? text.slice(0, max) + '…' : text
}

function summarizeEvent(event) {
  const data = event && event.data && typeof event.data === 'object' ? event.data : {}
  const delta = typeof data.delta === 'string' ? data.delta : null
  const sample = {}
  for (const key of Object.keys(data).slice(0, 12)) {
    const value = data[key]
    sample[key] = value === null || typeof value === 'number' || typeof value === 'boolean'
      ? value
      : clip(value, 160)
  }
  return {
    at: new Date().toISOString(),
    type: event && event.type,
    profile: event && event.identity && event.identity.profile,
    userId: event && event.identity && event.identity.userId,
    deltaLen: delta ? delta.length : 0,
    data: sample
  }
}

function slimSession(item) {
  const s = item && typeof item === 'object' ? item : {}
  return {
    id: s.id,
    profile: s.profile,
    source: s.source,
    agent: s.agent,
    agent_mode: s.agent_mode,
    model: s.model,
    provider: s.provider,
    title: clip(s.title || '', 40),
    message_count: s.message_count,
    tool_call_count: s.tool_call_count,
    input_tokens: s.input_tokens,
    output_tokens: s.output_tokens,
    cache_read_tokens: s.cache_read_tokens,
    last_active: s.last_active,
    is_archived: s.is_archived
  }
}

function slimUsage(value) {
  const v = value && typeof value === 'object' ? value : {}
  const pick = {}
  for (const key of [
    'origin', 'total_input_tokens', 'total_output_tokens', 'total_cache_read_tokens',
    'total_cache_write_tokens', 'total_reasoning_tokens', 'total_sessions',
    'total_api_calls', 'period_days', 'account_attribution_available'
  ]) if (key in v) pick[key] = v[key]
  pick.filter_options = v.filter_options && typeof v.filter_options === 'object'
    ? {
        accounts: Array.isArray(v.filter_options.accounts) ? v.filter_options.accounts.slice(0, 6) : undefined,
        models: Array.isArray(v.filter_options.models) ? v.filter_options.models.slice(0, 6) : undefined,
        agents: Array.isArray(v.filter_options.agents) ? v.filter_options.agents.slice(0, 10) : undefined,
        profiles: v.filter_options.profiles
      }
    : v.filter_options
  pick.by_agent = Array.isArray(v.by_agent) ? v.by_agent.slice(0, 10) : v.by_agent
  pick.by_model = Array.isArray(v.by_model) ? v.by_model.slice(0, 5) : v.by_model
  pick.by_day = Array.isArray(v.by_day) ? v.by_day.slice(-3) : v.by_day
  pick.keys = Object.keys(v).slice(0, 30)
  return pick
}

/** @param {import('@ekko-studio/plugin-sdk').PluginContext} ctx */
export function apply(ctx) {
  startedAt = Date.now()
  const dumpDir = ctx.paths && ctx.paths.dataDir ? ctx.paths.dataDir : null
  let lastDump = 0
  let dirty = false
  const dump = (force) => {
    if (!dumpDir) return
    const now = Date.now()
    if (!force && (!dirty || now - lastDump < 5000)) return
    try {
      mkdirSync(dumpDir, { recursive: true })
      writeFileSync(join(dumpDir, 'events.json'), JSON.stringify({
        startedAt, now, counts, recent: events.slice(-80)
      }, null, 2))
      lastDump = now
      dirty = false
    } catch (error) {
      ctx.log.warn('probe dump failed', String((error && error.message) || error))
    }
  }
  ctx.lifecycle.add(() => dump(true))

  ctx.events.on('*', (event) => {
    try {
      const type = String((event && event.type) || 'unknown')
      counts[type] = (counts[type] || 0) + 1
      events.push(summarizeEvent(event))
      while (events.length > MAX_EVENTS) events.shift()
      dirty = true
      dump(false)
    } catch (error) {
      ctx.log.warn('probe event failed', String((error && error.message) || error))
    }
  })

  registerRpc(ctx, contract, 'probe-events', async () => ({
    startedAt,
    now: Date.now(),
    total: Object.values(counts).reduce((a, b) => a + b, 0),
    counts,
    recent: events.slice(-60)
  }))

  registerRpc(ctx, contract, 'probe-api', async (_input, run) => {
    const out = {
      at: new Date().toISOString(),
      identity: {
        userId: run.identity.userId,
        profile: run.identity.profile,
        surface: run.identity.surface || null
      },
      calls: {}
    }
    const runCall = async (name, fn, slim) => {
      try {
        const value = await fn()
        out.calls[name] = { ok: true, value: slim ? slim(value) : value }
      } catch (error) {
        out.calls[name] = {
          ok: false,
          error: String((error && error.message) || error),
          code: error && error.code,
          status: error && error.status
        }
      }
    }

    await runCall('sessions', () => run.host.sessions.list({ limit: 6 }), (value) => {
      const list = Array.isArray(value && value.sessions) ? value.sessions : []
      return {
        total: value && value.total,
        count: list.length,
        keys: list[0] ? Object.keys(list[0]).slice(0, 40) : [],
        profiles: [...new Set(list.map((s) => s.profile))],
        sessions: list.map(slimSession)
      }
    })
    await runCall('usageToday', () => run.host.request('/api/studio/usage/stats', { query: { period: 'today' } }), slimUsage)
    await runCall('usage7d', () => run.host.request('/api/studio/usage/stats', { query: { days: 7 } }), slimUsage)
    await runCall('skills', () => run.host.request('/api/hermes/skills/usage/stats'), (value) => ({
      keys: value && typeof value === 'object' ? Object.keys(value).slice(0, 20) : [],
      sample: clip(value, 600)
    }))
    await runCall('sessionTasks', () => run.host.request('/api/studio/session-tasks'), (value) => ({
      total: value && value.total,
      has_more: value && value.has_more,
      keys: value && value.tasks && value.tasks[0] ? Object.keys(value.tasks[0]) : [],
      sample: value && Array.isArray(value.tasks) ? value.tasks.slice(0, 2) : null
    }))
    try {
      if (dumpDir) writeFileSync(join(dumpDir, 'probe-api.json'), JSON.stringify(out, null, 2))
    } catch (error) {
      ctx.log.warn('probe api dump failed', String((error && error.message) || error))
    }
    return out
  })

  registerRpc(ctx, contract, 'probe-reset', async () => {
    events.length = 0
    for (const key of Object.keys(counts)) delete counts[key]
    startedAt = Date.now()
    return null
  })
}
