import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../src/store.mjs'
import { buildLegacyStats } from '../src/legacy.mjs'

test('live tools and working streams produce motion signals', () => {
  const store = createStore()
  const now = Math.floor(Date.now() / 1000)
  store.upsertSessions([{ id: 's1', profile: 'default', agent: 'claude', last_active: now }])
  store.noteSignal('s1', Date.now())
  store.setWorking('s1', true)
  store.noteTool('s1', { name: 'Bash', arg: 'ls', state: 'running', callId: 'c1' })
  const snap = store.snapshot(null)
  assert.equal(snap.motion.jobsRunning, 1)
  assert.ok(snap.motion.pendingSec >= 0)
  assert.ok(snap.motion.lastEventAt > 0)

  const stats = buildLegacyStats(snap, {}, '0.8.29')
  assert.equal(stats.ai.pendingSec, snap.motion.pendingSec)
  assert.equal(stats.ai.jobsRunning, 1)
  assert.ok(stats.ai.lastEventAgeSec >= 0)

  store.finishTool('s1', 'c1', 'Bash', 'done')
  assert.equal(store.snapshot(null).tools[0].state, 'done')
  store.setWorking('s1', false)
  store.noteSignal('s1', Date.now())
  const after = store.snapshot(null)
  assert.equal(after.motion.jobsRunning, 0)
  assert.equal(after.motion.pendingSec, null)
})
