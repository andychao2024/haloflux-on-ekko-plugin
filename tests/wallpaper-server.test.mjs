import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startWallpaperServer } from '../src/wallpaper-server.mjs'

test('wallpaper server serves the page, assets and a stats payload', async () => {
  const server = await startWallpaperServer({
    port: 0,
    getStats: async () => ({ ai: { build: 'should-be-replaced', tokensPerSec: 12 } })
  })
  try {
    const base = `http://127.0.0.1:${server.port}`
    const page = await fetch(base + '/')
    assert.equal(page.status, 200)
    assert.match(page.headers.get('content-type') || '', /text\/html/)
    assert.match(await page.text(), /bgmAudio/)

    const health = await fetch(base + '/health').then((r) => r.json())
    assert.equal(health.ok, true)

    const stats = await fetch(base + '/stats').then((r) => r.json())
    assert.equal(stats.ai.tokensPerSec, 12)
    assert.notEqual(stats.ai.build, 'should-be-replaced')

    const audio = await fetch(base + '/audio/sw421k.mp3', { method: 'HEAD' })
    assert.equal(audio.status, 200)
    assert.match(audio.headers.get('content-type') || '', /audio\/mpeg/)
  } finally {
    await server.close()
  }
})
