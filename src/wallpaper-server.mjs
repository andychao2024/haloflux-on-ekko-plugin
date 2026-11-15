/**
 * 壁纸端口服务：把 docker 版的独立页面搬到插件自带端口。
 *
 * - 页面与脚本直接来自仓库内的 page-src 快照，音频使用 assets/bgm.mp3
 * - /stats 返回与原 docker 版一致的兼容结构，由调用方注入数据源
 * - 只绑定 127.0.0.1，不对外网开放；生命周期由插件管理
 */
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function loadFiles() {
  const ai = readFileSync(join(root, 'page-src/ai-link.js'), 'utf8')
  const build = (ai.match(/var BUILD = '([^']+)'/) || [])[1] || 'v0.0'
  return {
    build,
    files: {
      '/': { body: readFileSync(join(root, 'page-src/index.html')), type: MIME['.html'] },
      '/index.html': { body: readFileSync(join(root, 'page-src/index.html')), type: MIME['.html'] },
      '/wp.js': { body: readFileSync(join(root, 'page-src/wp.js')), type: MIME['.js'] },
      '/ai-link.js': { body: Buffer.from(ai), type: MIME['.js'] },
      '/audio/sw421k.mp3': { body: readFileSync(join(root, 'assets/bgm.mp3')), type: MIME['.mp3'] }
    }
  }
}

function send(res, status, type, body, extra = {}) {
  res.writeHead(status, Object.assign({
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  }, extra))
  res.end(body)
}

/**
 * @param {object} options
 * @param {number} options.port
 * @param {() => Promise<object>} options.getStats 返回 docker /stats 结构
 * @returns {Promise<{port:number,url:string,close:()=>Promise<void>}>}
 */
export function startWallpaperServer({ port, getStats }) {
  const { build, files } = loadFiles()
  const server = createServer(async (req, res) => {
    let path
    try { path = new URL(req.url || '/', 'http://127.0.0.1').pathname } catch (_) { path = '/' }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(res, 405, 'text/plain; charset=utf-8', 'method not allowed')
      return
    }
    if (path === '/health') {
      send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ ok: true }))
      return
    }
    if (path === '/stats') {
      try {
        const data = await getStats()
        if (!data || !data.ai) throw new Error('stats unavailable')
        // 页面会拿 /stats.ai.build 和自身 BUILD 比较；使用页面构建号避免自动重载
        data.ai.build = build
        send(res, 200, 'application/json; charset=utf-8', JSON.stringify(data))
      } catch (error) {
        send(res, 503, 'application/json; charset=utf-8', JSON.stringify({ error: 'stats unavailable' }))
      }
      return
    }
    if (path === '/favicon.ico') {
      res.writeHead(204)
      res.end()
      return
    }
    const file = files[path]
    if (!file) {
      send(res, 404, 'text/plain; charset=utf-8', 'not found')
      return
    }
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'Content-Type': file.type, 'Content-Length': file.body.length })
      res.end()
      return
    }
    send(res, 200, file.type, file.body)
  })

  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener('error', onError)
      reject(error)
    }
    server.once('error', onError)
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', onError)
      const actual = server.address().port
      resolve({
        port: actual,
        url: `http://127.0.0.1:${actual}/`,
        close: () => new Promise((done) => {
          server.close(() => done())
          setTimeout(done, 500)
        })
      })
    })
  })
}
