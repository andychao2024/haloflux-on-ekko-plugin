import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../src/store.mjs'
import { buildLegacyStats } from '../src/legacy.mjs'
import { applyMotionSignals } from '../src/motion-signals.mjs'

/** 复刻 ai-link.js updateMotion() 的 busy 判定，用于验证修复确实让舞台转起来。 */
function motionOf(ai) {
  const isNum = (v) => typeof v === 'number' && isFinite(v)
  const C = { busyGraceSec: 30, pendingBusySec: 600, planBusySec: 900 }
  const age = isNum(ai.lastEventAgeSec) ? ai.lastEventAgeSec : 999
  const jobs = isNum(ai.jobsRunning) ? ai.jobsRunning : 0
  const active = isNum(ai.activeAgents) ? ai.activeAgents : 0
  let busy = age <= C.busyGraceSec || (jobs > 0 && active > 0 && age <= C.busyGraceSec * 2)
  const pending = isNum(ai.pendingSec) ? ai.pendingSec : null
  const planBusy = !!(ai.planActive && (!isNum(ai.planAgeSec) || ai.planAgeSec <= C.planBusySec))
  busy = busy || (pending !== null && pending <= C.pendingBusySec) || planBusy
  return { busy, rateTarget: busy ? 1 : 0 }
}

function pluginStats() {
  const store = createStore()
  const now = Math.floor(Date.now() / 1000)
  // 一个「正在工作」的 agent：store 里没有任何事件/计划，正是插件的真实处境
  store.upsertSessions([
    { id: 's1', profile: 'default', agent: 'claude', last_active: now, message_count: 5 }
  ])
  return buildLegacyStats(store.snapshot(null), {}, '0.8.25')
}

test('插件原始 /stats 会让舞台冻结（回归基线）', () => {
  const ai = pluginStats().ai
  assert.equal(ai.lastEventAgeSec, null)
  assert.equal(ai.pendingSec, null)
  assert.equal(ai.planActive, false)
  assert.equal(ai.jobsRunning, null)
  assert.deepEqual(motionOf(ai), { busy: false, rateTarget: 0 })
})

test('实时事件 + 工作会话 -> 舞台恢复运转，且能量不再归零', () => {
  const d = pluginStats()
  const now = Date.now()
  applyMotionSignals(d.ai, {
    now,
    liveEvent: { type: 'tool', at: now - 1000 },
    liveSlots: [{ working: true, ts: now - 2000 }],
    pendingSessions: [{ working: true, at: now - 3000 }]
  })
  assert.equal(d.ai.lastEventAgeSec, 1)
  assert.equal(d.ai.planActive, true)
  assert.equal(d.ai.jobsRunning, 1)
  assert.equal(d.ai.pendingSec, 1)
  assert.deepEqual(motionOf(d.ai), { busy: true, rateTarget: 1 })
  // updateVisuals() 需要 d.link + 数值 tokensPerSec 才会产生能量；两者已具备
  assert.equal(typeof d.ai.tokensPerSec, 'number')
  assert.ok(d.link)
})

test('长工具调用（tokens/s 恒为 0）靠 pendingSec 续命', () => {
  const d = pluginStats()
  const now = Date.now()
  // 45 秒前开始工作、之后没有新事件：超过 busyGraceSec(30)，但仍在 600s 内
  applyMotionSignals(d.ai, {
    now,
    liveEvent: { type: 'tool', at: now - 45000 },
    liveSlots: [{ working: true, ts: now - 45000 }],
    pendingSessions: [{ working: true, at: now - 45000 }]
  })
  assert.equal(d.ai.lastEventAgeSec, 45)
  assert.equal(d.ai.pendingSec, 45)
  assert.deepEqual(motionOf(d.ai), { busy: true, rateTarget: 1 })
})

test('回合结束后不再空转（超过 5 分钟的工作标记被忽略）', () => {
  const d = pluginStats()
  const now = Date.now()
  applyMotionSignals(d.ai, {
    now,
    liveEvent: null,
    liveSlots: [{ working: false, ts: now - 400000 }],
    pendingSessions: [{ working: true, at: now - 400000 }]   // 6分40秒前，已过期
  })
  assert.equal(d.ai.planActive, false)
  assert.equal(d.ai.pendingSec, null)
  assert.equal(d.ai.jobsRunning, 0)
  // 没有任何实时证据时给温和待命值：舞台低速运转而非彻底冻结
  assert.equal(d.ai.lastEventAgeSec, 20)
  assert.equal(motionOf(d.ai).busy, true)
  assert.equal(d.ai.lastEvent, '待命')
})

test('实时事件通道不通时，服务端会话活动时间仍能驱动舞台', () => {
  const d = pluginStats()
  const now = Date.now()
  const lastActive = Math.floor(now / 1000) - 5   // Unix 秒，5 秒前还活跃
  applyMotionSignals(d.ai, {
    now,
    liveEvent: null,
    liveSlots: [],
    pendingSessions: [],
    sessions: [{ id: 's1', lastActive }]
  })
  assert.equal(d.ai.planActive, true)
  assert.equal(d.ai.jobsRunning, 1)
  assert.ok(d.ai.lastEventAgeSec <= 6)
  assert.equal(motionOf(d.ai).rateTarget, 1)
})

test('陈旧会话（超过 180 秒）不会被误判成工作中', () => {
  const d = pluginStats()
  const now = Date.now()
  applyMotionSignals(d.ai, {
    now,
    sessions: [{ id: 's1', lastActive: Math.floor(now / 1000) - 600 }]
  })
  assert.equal(d.ai.planActive, false)
  assert.equal(d.ai.pendingSec, null)
  assert.equal(d.ai.lastEventAgeSec, 20)   // 只保留温和待命
})

test('兼容毫秒时间戳的 last_active', () => {
  const d = pluginStats()
  const now = Date.now()
  applyMotionSignals(d.ai, { now, sessions: [{ lastActive: now - 3000 }] })
  assert.equal(d.ai.planActive, true)
  assert.ok(d.ai.lastEventAgeSec <= 4)
})

test('没有任何实时信号时仍保持待命运转', () => {
  const d = pluginStats()
  applyMotionSignals(d.ai, { now: Date.now() })
  assert.equal(d.ai.lastEventAgeSec, 20)
  assert.equal(d.ai.planActive, false)
  assert.equal(d.ai.lastEvent, '待命')
  assert.equal(motionOf(d.ai).rateTarget, 1)
})

test('不产生 undefined 字段（SDK 会拒绝整份 JSON）', () => {
  const d = pluginStats()
  applyMotionSignals(d.ai, { now: Date.now(), liveSlots: [null], pendingSessions: [null] })
  const bad = []
  const walk = (v, path) => {
    if (v === undefined) { bad.push(path); return }
    if (v && typeof v === 'object') for (const k of Object.keys(v)) walk(v[k], path + '.' + k)
  }
  walk(d, 'root')
  assert.deepEqual(bad, [])
})
