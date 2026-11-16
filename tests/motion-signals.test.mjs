import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../src/store.mjs'
import { buildLegacyStats } from '../src/legacy.mjs'
import { applyMotionSignals } from '../src/motion-signals.mjs'

/** 复刻 ai-link.js updateMotion() 的 busy 判定，用于验证舞台启停。 */
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
  store.upsertSessions([
    { id: 's1', profile: 'default', agent: 'claude', last_active: now, message_count: 5 }
  ])
  return buildLegacyStats(store.snapshot(null), {}, '0.8.29')
}

test('插件原始 /stats 会让舞台冻结（回归基线）', () => {
  const ai = pluginStats().ai
  assert.equal(ai.lastEventAgeSec, null)
  assert.equal(ai.pendingSec, null)
  assert.equal(ai.planActive, false)
  assert.equal(ai.jobsRunning, 0)
  assert.deepEqual(motionOf(ai), { busy: false, rateTarget: 0 })
})

test('实时事件 + 工作会话 -> 舞台运转', () => {
  const d = pluginStats()
  const now = Date.now()
  applyMotionSignals(d.ai, {
    now,
    liveEvent: { type: 'tool', at: now - 1000 },
    liveSlots: [{ working: true, ts: now - 2000 }],
    pendingSessions: [{ working: true, at: now - 3000 }]
  })
  assert.equal(d.ai.lastEventAgeSec, 1)
  assert.equal(d.ai.jobsRunning, 1)
  assert.equal(d.ai.pendingSec, 3)
  assert.deepEqual(motionOf(d.ai), { busy: true, rateTarget: 1 })
  assert.equal(typeof d.ai.tokensPerSec, 'number')
  assert.ok(d.link)
})

test('长工具调用（tokens/s 恒为 0）靠 pendingSec 续命', () => {
  const d = pluginStats()
  const now = Date.now()
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

test('回合结束后自动停止，不再空转', () => {
  const d = pluginStats()
  const now = Date.now()
  applyMotionSignals(d.ai, {
    now,
    liveEvent: null,
    liveSlots: [{ working: false, ts: now - 1000 }],
    pendingSessions: [{ working: true, at: now - 400000 }]
  })
  assert.equal(d.ai.planActive, false)
  assert.equal(d.ai.pendingSec, null)
  assert.equal(d.ai.jobsRunning, 0)
  assert.equal(d.ai.lastEventAgeSec, 999)
  assert.equal(motionOf(d.ai).busy, false)
  assert.equal(d.ai.lastEvent, '待命')
})

test('实时通道不通时，last_active 只给一个短宽限期', () => {
  const d = pluginStats()
  const now = Date.now()
  applyMotionSignals(d.ai, {
    now,
    liveEvent: null,
    liveSlots: [],
    pendingSessions: [],
    sessions: [{ id: 's1', lastActive: Math.floor(now / 1000) - 5 }]
  })
  assert.equal(d.ai.planActive, false)
  assert.equal(d.ai.jobsRunning, 0)
  assert.ok(d.ai.lastEventAgeSec <= 6)
  assert.equal(motionOf(d.ai).rateTarget, 1)
})

test('陈旧会话（超过 60 秒）不会被误判成工作中', () => {
  const d = pluginStats()
  const now = Date.now()
  applyMotionSignals(d.ai, {
    now,
    sessions: [{ id: 's1', lastActive: Math.floor(now / 1000) - 600 }]
  })
  assert.equal(d.ai.planActive, false)
  assert.equal(d.ai.pendingSec, null)
  assert.equal(d.ai.lastEventAgeSec, 999)
  assert.equal(motionOf(d.ai).busy, false)
})

test('兼容毫秒时间戳的 last_active', () => {
  const d = pluginStats()
  const now = Date.now()
  applyMotionSignals(d.ai, { now, sessions: [{ lastActive: now - 3000 }] })
  assert.equal(d.ai.planActive, false)
  assert.ok(d.ai.lastEventAgeSec <= 4)
  assert.equal(motionOf(d.ai).busy, true)
})

test('运行中的任务计划可以作为额外的忙碌信号，但过期后停止', () => {
  const d = pluginStats()
  const now = Date.now()
  d.ai.taskPlan = { plans: [{ state: 'running', ageSec: 5 }] }
  applyMotionSignals(d.ai, { now })
  assert.equal(d.ai.planActive, true)
  assert.equal(motionOf(d.ai).busy, true)

  d.ai.taskPlan = { plans: [{ state: 'running', ageSec: 120 }] }
  applyMotionSignals(d.ai, { now })
  assert.equal(d.ai.planActive, false)
  assert.equal(motionOf(d.ai).busy, false)
})

test('没有任何实时信号时不自动运转', () => {
  const d = pluginStats()
  applyMotionSignals(d.ai, { now: Date.now() })
  assert.equal(d.ai.lastEventAgeSec, 999)
  assert.equal(d.ai.planActive, false)
  assert.equal(d.ai.lastEvent, '待命')
  assert.equal(motionOf(d.ai).rateTarget, 0)
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

test('壁纸页忽略卡在 working 的实时 slot，只认历史轮询', () => {
  const store = createStore()
  const nowSec = Math.floor(Date.now() / 1000)
  store.upsertSessions([
    { id: 's1', profile: 'default', agent: 'claude', last_active: nowSec - 120, message_count: 5 }
  ])
  store.setWorking('s1', true)
  const d = buildLegacyStats(store.snapshot(null), {}, '0.8.30')
  assert.equal(d.ai.jobsRunning, 1)

  applyMotionSignals(d.ai, {
    now: Date.now(),
    liveSlots: [],
    pendingSessions: [],
    sessions: [{ id: 's1', lastActive: nowSec - 120 }]
  })
  assert.equal(d.ai.jobsRunning, 0)
  assert.equal(d.ai.pendingSec, null)
  assert.equal(motionOf(d.ai).busy, false)
})

test('旧计划不会因为会话仍在 working 被重新激活', () => {
  const d = pluginStats()
  const now = Date.now()
  d.ai.taskPlan = { plans: [{ state: 'running', ageSec: 800 }] }
  applyMotionSignals(d.ai, {
    now,
    liveSlots: [{ working: true, ts: now - 1000 }]
  })
  assert.equal(d.ai.planActive, false)
  assert.equal(motionOf(d.ai).busy, true) // 当前实时工作仍然算忙碌
})
