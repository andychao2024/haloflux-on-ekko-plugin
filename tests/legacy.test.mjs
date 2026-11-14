import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../src/store.mjs'
import { buildLegacyStats } from '../src/legacy.mjs'

function noUndefined(value, path = 'root', bad = []) {
  if (value === undefined) { bad.push(path); return bad }
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) noUndefined(value[key], path + '.' + key, bad)
  }
  return bad
}

function seed() {
  const store = createStore()
  const now = Math.floor(Date.now() / 1000)
  store.upsertSessions([
    { id: 'a', profile: 'default', agent: 'claude', model: 'm1', provider: 'p1', title: '旧会话', last_active: now - 500, message_count: 10, input_tokens: 100, output_tokens: 20, cache_read_tokens: 30, cache_write_tokens: 5 },
    { id: 'b', profile: 'default', agent: 'hermes', model: 'm2', provider: 'p2', title: '新会话', last_active: now, message_count: 3, input_tokens: 10, output_tokens: 2 }
  ])
  return { store, now }
}

test('lifetime totals, current session and active list are derived from sessions', () => {
  const { store } = seed()
  const snap = store.snapshot(null)
  assert.equal(snap.totals.tokens, 167)
  assert.equal(snap.totals.messages, 13)
  assert.equal(snap.current.id, 'b')
  assert.equal(snap.current.provider, 'p2')
  assert.deepEqual(snap.activeSessions.map((s) => s.id), ['b'])
})

test('legacy stats contain no undefined fields and keep idle streams valid', () => {
  const { store } = seed()
  store.appendDelta('a', 'reasoning', '历史思考')
  const stats = buildLegacyStats(store.snapshot(null), {}, '0.8.18')
  assert.deepEqual(noUndefined(stats), [])
  assert.equal(stats.link.source, 'studio-plugin')
  assert.equal(stats.ai.streams[0].agent, 'claude')
  assert.equal('workKind' in stats.ai.streams[0], false)
  assert.equal(stats.ai.tokensTotal, 167)
  assert.equal(stats.ai.sessionTitle, '新会话')
})

test('historical tool calls are merged into recentTools with agent labels', () => {
  const { store, now } = seed()
  store.setToolHistory('b', [
    { profile: 'default', agent: 'hermes', sessionId: 'b', at: (now - 5) * 1000, name: 'Read', arg: 'file.js', state: 'done' },
    { profile: 'default', agent: 'hermes', sessionId: 'b', at: (now - 2) * 1000, name: 'Bash', arg: 'npm test', state: 'done' }
  ])
  const stats = buildLegacyStats(store.snapshot(null), {}, '0.8.18')
  assert.deepEqual(stats.ai.recentTools.map((t) => t.name), ['Bash', 'Read'])
  assert.deepEqual(stats.ai.toolAgents, ['hermes'])
  assert.equal(stats.ai.toolSource, 'studio-db')
  assert.equal(stats.ai.toolCalls, 2)
  assert.deepEqual(noUndefined(stats), [])
})

