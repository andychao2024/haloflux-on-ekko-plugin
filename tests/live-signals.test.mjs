import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseLiveEvent } from '../src/live-signals.mjs'

test('maps reasoning and message deltas', () => {
  assert.deepEqual(parseLiveEvent({ event: 'reasoning.delta', delta: 'think' }),
    { kind: 'delta', channel: 'reasoning', text: 'think' })
  assert.deepEqual(parseLiveEvent({ event: 'message.delta', delta: 'hi' }),
    { kind: 'delta', channel: 'text', text: 'hi' })
})

test('maps tool events with Studio field names', () => {
  const started = parseLiveEvent({
    event: 'tool.started', tool_name: 'Bash', tool_call_id: 'c1', args: { command: 'ls -la' }
  })
  assert.equal(started.kind, 'tool')
  assert.equal(started.state, 'running')
  assert.equal(started.name, 'Bash')
  assert.equal(started.arg, 'ls -la')
  assert.equal(started.callId, 'c1')

  const failed = parseLiveEvent({ event: 'tool.failed', tool_name: 'Read', tool_call_id: 'c2' })
  assert.equal(failed.state, 'error')
})

test('maps run, plan and resume events', () => {
  assert.deepEqual(parseLiveEvent({ event: 'run.started' }), { kind: 'run', working: true })
  assert.deepEqual(parseLiveEvent({ event: 'run.completed' }), { kind: 'run', working: false })
  const plan = { id: 'p', plan: [{ step: 'a', status: 'running' }] }
  assert.deepEqual(parseLiveEvent({ event: 'plan.updated', task_plan: plan }), { kind: 'plan', plan })
  assert.deepEqual(parseLiveEvent({ event: 'resumed', isWorking: true }), { kind: 'resume', working: true, plans: [] })
  assert.equal(parseLiveEvent({ event: 'unknown' }), null)
})
