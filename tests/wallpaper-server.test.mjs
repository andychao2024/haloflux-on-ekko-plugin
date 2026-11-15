import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startWallpaperServer } from '../src/wallpaper-server.mjs'

test('wallpaper server requires a token for the page and stats, assets stay public', async () => {
  const server = await startWallpaperServer({
    port: 0,
    token: 'secret-token',
    getStats: async () => ({ ai: { build: 'should-be-replaced', tokensPerSec: 12 } })
  })
  try {
    const base = `http://127.0.0.1:${server.port}`
    assert.equal((await fetch(base + '/')).status, 401)
    assert.equal((await fetch(base + '/stats')).status, 401)

    const page = await fetch(base + '/?k=secret-token')
    assert.equal(page.status, 200)
    assert.match(page.headers.get('content-type') || '', /text\/html/)
    assert.match(await page.text(), /bgmAudio/)
    const cookie = String(page.headers.get('set-cookie') || '').split(';')[0]
    assert.match(cookie, /^halofluxk=secret-token$/)

    const stats = await fetch(base + '/stats', { headers: { cookie } }).then((r) => r.json())
    assert.equal(stats.ai.tokensPerSec, 12)
    assert.notEqual(stats.ai.build, 'should-be-replaced')

    const health = await fetch(base + '/health').then((r) => r.json())
    assert.equal(health.ok, true)

    const audio = await fetch(base + '/audio/sw421k.mp3', { method: 'HEAD' })
    assert.equal(audio.status, 200)
    assert.match(audio.headers.get('content-type') || '', /audio\/mpeg/)
  } finally {
    await server.close()
  }
})
