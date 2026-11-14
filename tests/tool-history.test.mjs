import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseToolMessages } from '../src/tool-history.mjs'

test('extracts tool calls from assistant tool_calls with arguments', () => {
  const messages = [
    { role: 'assistant', timestamp: 100, tool_calls: [{ id: 'c1', function: { name: 'Bash', arguments: '{"command":"ls"}' } }] },
    { role: 'tool', timestamp: 100, tool_call_id: 'c1', tool_name: 'Bash', content: 'a.txt' }
  ]
  const tools = parseToolMessages(messages)
  assert.equal(tools.length, 1)
  assert.equal(tools[0].name, 'Bash')
  assert.equal(tools[0].at, 100000)
  assert.match(tools[0].arg, /ls/)
})

test('keeps only the newest 8 calls and parses stringified tool_calls', () => {
  const messages = []
  for (let i = 0; i < 10; i++) {
    messages.push({
      role: 'assistant', timestamp: 1000 + i,
      tool_calls: [{ id: 'c' + i, function: { name: 'Bash', arguments: '{"command":"echo ' + i + '"}' } }]
    })
  }
  const tools = parseToolMessages(messages)
  assert.equal(tools.length, 8)
  assert.match(tools[0].arg, /echo 9/)
  assert.match(tools[7].arg, /echo 2/)

  const one = parseToolMessages([{
    role: 'assistant', timestamp: 5,
    tool_calls: JSON.stringify([{ function: { name: 'Read', arguments: { file_path: '/a' } } }])
  }])
  assert.equal(one[0].name, 'Read')
  assert.match(one[0].arg, /file_path/)
})

test('falls back to tool messages without a matching call', () => {
  const tools = parseToolMessages([
    { role: 'tool', timestamp: 20, tool_name: 'Grep', content: 'x' },
    { role: 'tool', timestamp: 10, tool_name: 'Read', tool_call_id: 'missing', content: 'y' }
  ])
  assert.deepEqual(tools.map((t) => t.name), ['Grep', 'Read'])
})
