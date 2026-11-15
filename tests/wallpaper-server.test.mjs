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
    const pageText = await page.text()
    assert.match(pageText, /bgmAudio/)
    assert.match(pageText, /<title>HALOFLUX ON Ekko<\/title>/)
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

test('wallpaper page follows plugin display settings and counts authenticated visitors', async () => {
  const server = await startWallpaperServer({
    port: 0,
    token: 'secret-token',
    viewerTtlMs: 200,
    display: { anim: false, compat: true, gpu: false, toolRows: 10, agentRows: 5, title: '我的看板' },
    getStats: async () => ({ ai: { build: 'v0.0' } })
  })
  try {
    const base = `http://127.0.0.1:${server.port}`
    const html = await fetch(base + '/?k=secret-token').then((r) => r.text())
    assert.match(html, /<title>我的看板<\/title>/)
    assert.match(html, /<h1>我的看板<\/h1>/)
    assert.match(html, /__hlShowGpu=false/)
    assert.match(html, /__hlToolRows=10/)
    assert.match(html, /__hlAgentRows=5/)
    assert.match(html, /__wpPaused=true/)
    assert.match(html, /#stage\{visibility:hidden\}/)
    assert.match(html, /animation:none/)

    assert.equal(server.status().viewers, 0)
    await fetch(base + '/stats?k=secret-token')
    assert.equal(server.status().viewers, 1)
    await fetch(base + '/stats?k=secret-token', { headers: { 'user-agent': 'second-viewer' } })
    assert.equal(server.status().viewers, 2)
    await new Promise((done) => setTimeout(done, 260))
    assert.equal(server.status().viewers, 0)
  } finally {
    await server.close()
  }
})
