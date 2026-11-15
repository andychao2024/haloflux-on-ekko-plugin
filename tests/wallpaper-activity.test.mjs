import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyWallpaperActivity } from '../src/wallpaper-activity.mjs'

test('壁纸思考流把最近活动会话标成 active', () => {
  const snap = {
    activeSessions: [
      { id: 's1', agent: 'claude', profile: 'default', title: '当前会话' },
      { id: 's2', agent: 'claude', profile: 'default', title: '另一会话' }
    ],
    recentSessions: [
      { id: 's1', agent: 'claude', profile: 'default', title: '当前会话' },
      { id: 's2', agent: 'claude', profile: 'default', title: '另一会话' }
    ],
    streams: [
      { agent: 'claude', sessionId: 's1', state: 'idle', working: 0, ageSec: 300, text: '当前会话的思考' },
      { agent: 'claude', sessionId: 's2', state: 'idle', working: 0, ageSec: 300, text: '另一会话的思考' }
    ]
  }
  applyWallpaperActivity(snap, new Set(['s1']))
  const s1 = snap.streams.find((x) => x.sessionId === 's1')
  const s2 = snap.streams.find((x) => x.sessionId === 's2')
  assert.equal(s1.state, 'live')
  assert.equal(s1.working, 1)
  assert.equal(s2.state, 'active')
})

test('没有历史流的活动会话也会补一条可显示的记录', () => {
  const snap = {
    activeSessions: [{ id: 's2', agent: 'codex', profile: 'default', title: '新会话' }],
    recentSessions: [],
    streams: []
  }
  applyWallpaperActivity(snap, new Set())
  assert.equal(snap.streams.length, 1)
  assert.equal(snap.streams[0].sessionId, 's2')
  assert.equal(snap.streams[0].state, 'active')
})

test('最近 10 分钟有活动且仍在工作的会话标 live', () => {
  const now = Date.now()
  const snap = {
    activeSessions: [],
    recentSessions: [{ id: 's1', agent: 'claude', profile: 'default', lastActive: Math.floor(now / 1000) - 400 }],
    streams: [
      { agent: 'claude', sessionId: 's1', state: 'idle', working: 0, ageSec: 400, text: '长任务' }
    ]
  }
  applyWallpaperActivity(snap, new Set(['s1']), now)
  assert.equal(snap.streams[0].state, 'live')
  assert.equal(snap.streams[0].working, 1)
})

test('很久没活动的会话即使消息未完成也不误标 live', () => {
  const now = Date.now()
  const snap = {
    activeSessions: [],
    recentSessions: [{ id: 's3', agent: 'claude', profile: 'default', title: '遗留会话', lastActive: Math.floor(now / 1000) - 900 }],
    streams: [
      { agent: 'claude', sessionId: 's3', state: 'idle', working: 0, ageSec: 900, text: '旧输出' }
    ]
  }
  applyWallpaperActivity(snap, new Set(['s3']), now)
  assert.equal(snap.streams.length, 1)
  assert.equal(snap.streams[0].state, 'idle')
  assert.equal(snap.streams[0].working, 0)
})
