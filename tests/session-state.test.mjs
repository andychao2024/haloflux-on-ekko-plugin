import { test } from 'node:test'
import assert from 'node:assert/strict'
import { messagesWorking } from '../src/session-state.mjs'

test('a turn is working while the last message is user, tool or an unanswered call', () => {
  assert.equal(messagesWorking([{ role: 'user' }]), true)
  assert.equal(messagesWorking([{ role: 'user' }, { role: 'tool' }]), true)
  assert.equal(messagesWorking([{ role: 'assistant', tool_calls: [{ id: 'a' }] }]), true)
  assert.equal(messagesWorking([{ role: 'assistant', tool_calls: '[{"id":"a"}]' }]), true)
})

test('a completed assistant reply or empty history is not working', () => {
  assert.equal(messagesWorking([{ role: 'assistant', content: 'done' }]), false)
  assert.equal(messagesWorking([{ role: 'assistant', tool_calls: '[]' }]), false)
  assert.equal(messagesWorking([]), false)
  assert.equal(messagesWorking(null), false)
})
