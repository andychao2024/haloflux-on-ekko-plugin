import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../src/store.mjs'
import { createConnections } from '../src/conn.mjs'

function setup() {
  const store = createStore()
  store.upsertSessions([{
    id: 's1', profile: 'default', agent: 'claude',
    title: 'live test', last_active: Math.floor(Date.now() / 1000)
  }])
  let listener = null
  let closed = 0
  const host = {
    sessions: {
      connect: async (_id, cb) => {
        listener = cb
        return { close: async () => { closed += 1 } }
      }
    }
  }
  const conn = createConnections({
    host, store, max: 4,
    log: { warn: () => {} }
  })
  return {
    store, conn,
    emit: (event) => listener(event),
    closed: () => closed
  }
}

test('后台会话连接把思考增量写进共享 store', async () => {
  const t = setup()
  t.conn.sync([{ id: 's1' }])
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(t.conn.size(), 1)

  t.emit({ event: 'reasoning.delta', delta: 'thinking...' })
  const snap = t.store.snapshot(null)
  assert.equal(snap.streams[0].text, 'thinking...')
  assert.equal(snap.streams[0].working, 1)
  assert.equal(t.conn.slots()[0].working, true)
  assert.equal(t.conn.lastEvent().type, 'think')
})

test('后台工具 started/completed 落在同一条记录上', async () => {
  const t = setup()
  t.conn.sync([{ id: 's1' }])
  await new Promise((resolve) => setImmediate(resolve))

  t.emit({
    event: 'tool.started', tool_name: 'Bash', tool_call_id: 'c1',
    args: { command: 'ls -la' }
  })
  let snap = t.store.snapshot(null)
  assert.equal(snap.tools.length, 1)
  assert.equal(snap.tools[0].name, 'Bash')
  assert.equal(snap.tools[0].arg, 'ls -la')
  assert.equal(snap.tools[0].state, 'running')

  t.emit({ event: 'tool.completed', tool_name: 'Bash', tool_call_id: 'c1' })
  snap = t.store.snapshot(null)
  assert.equal(snap.tools.length, 1)
  assert.equal(snap.tools[0].state, 'done')
})

test('实时回合会清掉上一回合的历史回填文本', async () => {
  const t = setup()
  t.conn.sync([{ id: 's1' }])
  await new Promise((resolve) => setImmediate(resolve))

  t.store.backfillStream('s1', 'old answer', Date.now())
  t.emit({ event: 'message.delta', delta: 'new answer' })
  let snap = t.store.snapshot(null)
  assert.equal(snap.streams[0].text, 'new answer')

  // 当前回合工作时，10 秒一次的历史回填不能把实时文本盖回去。
  t.store.backfillStream('s1', 'stale answer', Date.now())
  snap = t.store.snapshot(null)
  assert.equal(snap.streams[0].text, 'new answer')
})

test('run 结束和 resume 快照能正确切换 working', async () => {
  const t = setup()
  t.conn.sync([{ id: 's1' }])
  await new Promise((resolve) => setImmediate(resolve))

  t.emit({ event: 'run.started' })
  assert.equal(t.conn.slots()[0].working, true)
  t.emit({ event: 'run.completed' })
  assert.equal(t.conn.slots()[0].working, false)

  t.emit({ event: 'resumed', isWorking: true, taskPlans: [] })
  assert.equal(t.conn.slots()[0].working, true)

  t.emit({ event: 'resumed', isWorking: false, taskPlans: [] })
  assert.equal(t.conn.slots()[0].working, false)
})

test('sync 只保留目标会话，关闭句柄会释放连接', async () => {
  const t = setup()
  t.conn.sync([{ id: 's1' }])
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(t.conn.size(), 1)

  await t.conn.closeAll()
  assert.equal(t.conn.size(), 0)
  assert.equal(t.closed(), 1)
})
