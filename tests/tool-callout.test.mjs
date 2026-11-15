import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../page-src/ai-link.js', import.meta.url), 'utf8')
const html = readFileSync(new URL('../page-src/index.html', import.meta.url), 'utf8')
const start = source.indexOf('  /** 每次新工具调用换一条随机公式')
const end = source.indexOf('  /** 标题行空间不够', start)
assert.ok(start > 0 && end > start, 'callout helper must exist in ai-link.js')

const CHECKS = [
  ['STABILITY CHECK', 'CFL = |u| Δt / Δx'],
  ['MASS CONSERVATION', 'Σ ρ dV = const'],
  ['RESIDUAL NORM', 'r = ‖b − A·u‖₂'],
  ['BOUNDARY', 'u · n = 0  on ∂Ω'],
  ['PROJECTION', '∇²p = ∇ · u* / Δt']
]

function makeEl() {
  const classes = new Set()
  return {
    textContent: '',
    classList: {
      add(...names) { names.forEach((name) => classes.add(name)) },
      remove(...names) { names.forEach((name) => classes.delete(name)) },
      has: (name) => classes.has(name)
    }
  }
}

function mount(anim = true) {
  const c = {
    box: makeEl(), k: makeEl(), v: makeEl(), index: -1,
    seen: {}, queue: [], busy: false, eventAt: 0, showTimer: 0, hideTimer: 0, offTimer: 0
  }
  const calls = { visible: [] }
  const vd = { pulse: 0, forceFrames: 0 }
  const timers = new Map()
  let seq = 0
  const setTimeoutMock = (fn, ms) => { timers.set(++seq, { fn, ms }); return seq }
  const clearTimeoutMock = (id) => { timers.delete(id) }
  const flush = (ms) => {
    for (const [id, t] of [...timers]) {
      if (t.ms !== ms) continue
      timers.delete(id)
      t.fn()
    }
  }
  const fn = new Function('CON', 'vd', 'window', 'scheduleVisual', 'isNum', 'setTimeout', 'clearTimeout', 'CHECKS',
    source.slice(start, end) + '\nreturn { updateCheckCallout, noteEventCheck }')
  const api = fn(
    { chk: c }, vd,
    { __hlAnim: anim, __hlSetCheckVisible: (on) => calls.visible.push(on) },
    () => {},
    (v) => typeof v === 'number' && isFinite(v),
    setTimeoutMock, clearTimeoutMock,
    CHECKS
  )
  return { c, vd, calls, call: api.updateCheckCallout, note: api.noteEventCheck, flush }
}

test('多会话工具都排队触发，同一次调用不重复', () => {
  const { c, calls, call, flush } = mount()
  const prev = Math.random
  let n = 0
  Math.random = () => [0.7, 0.2, 0.9][Math.min(n++, 2)]
  try {
    call({ ai: { recentTools: [
      { name: 'Bash', callId: 'a1', state: 'running', ageSec: 1, at: Date.now(), agent: 'claude' }
    ] } })
    flush(400)
    const first = [c.k.textContent, c.v.textContent]
    assert.ok(CHECKS.some((row) => row[0] === first[0] && row[1] === first[1]))
    assert.equal(c.box.classList.has('show'), true)
    assert.deepEqual(calls.visible, [true])

    call({ ai: { recentTools: [
      { name: 'Bash', callId: 'a1', state: 'done', ageSec: 0, at: Date.now(), agent: 'claude' }
    ] } })
    assert.deepEqual([c.k.textContent, c.v.textContent], first, '同一次调用完成时不应重复触发')

    // 另一个会话的工具排在列表第二位，也必须触发
    call({ ai: { recentTools: [
      { name: 'Bash', callId: 'a1', state: 'done', ageSec: 0, at: Date.now(), agent: 'claude' },
      { name: 'Read', callId: 'b1', state: 'running', ageSec: 1, at: Date.now(), agent: 'claude' }
    ] } })
    flush(3200)
    flush(400)
    flush(400)
    assert.notDeepEqual([c.k.textContent, c.v.textContent], first, '另一会话的工具应排队显示')
  } finally {
    Math.random = prev
  }
})

test('AI 事件流新条目也能触发公式', () => {
  const { c, calls, call, note, flush } = mount()
  note('新消息 +1')
  call({ ai: { recentTools: [] } })
  flush(400)
  assert.equal(c.box.classList.has('show'), true)
  assert.ok(CHECKS.some((row) => row[0] === c.k.textContent && row[1] === c.v.textContent))
  assert.deepEqual(calls.visible, [true])
})

test('事件流触发有 5 秒节流，工具事件交给工具队列', () => {
  const first = mount()
  first.note('令牌 +1')
  first.note('令牌 +2')
  assert.equal(first.c.queue.length, 1)

  const second = mount()
  second.note('工具调用 +1')
  assert.equal(second.c.queue.length, 0)
})

test('陈旧工具不会在打开页面时触发公式', () => {
  const { c, calls, call, flush } = mount()
  call({ ai: { recentTools: [
    { name: 'Bash', callId: 'old', state: 'done', ageSec: 328, at: Date.now() - 328000, agent: 'claude' }
  ] } })
  flush(400)
  assert.equal(c.k.textContent, '')
  assert.equal(c.box.classList.has('show'), false)
  assert.deepEqual(calls.visible, [])
})

test('关闭动效时隐藏公式和引线', () => {
  const { c, calls, call } = mount(false)
  call({ ai: { recentTools: [
    { name: 'Bash', callId: 'c1', state: 'running', ageSec: 0, at: Date.now() }
  ] } })
  assert.equal(c.box.classList.has('show'), false)
  assert.deepEqual(calls.visible, [false])
})

test('标注框沿用演示页样式，没有蓝色边框', () => {
  assert.match(html, /id="chkK">MASS CONSERVATION/)
  assert.match(html, /Σ ρ dV = const/)
  assert.match(html, /const CHECKS =/)
  assert.match(html, /\.chk\{[^}]*transition:opacity \.4s/)
  assert.doesNotMatch(html, /\.chk\.live/)
  assert.doesNotMatch(html, /box-shadow:0 0 1[46]px rgba\(90,169,255/)
  assert.doesNotMatch(source, /工具运行中/)
})
