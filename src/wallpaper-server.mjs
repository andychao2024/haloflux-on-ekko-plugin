/**
 * 壁纸端口服务：把 docker 版的独立页面搬到插件自带端口。
 *
 * - 页面与脚本直接来自仓库内的 page-src 快照，音频使用 assets/bgm.mp3
 * - /stats 返回与原 docker 版一致的兼容结构，由调用方注入数据源
 * - 默认绑定 0.0.0.0；页面与 /stats 需要访问密钥，静态资源公开
 *   （与 docker 版一致，避免 iframe 子资源因 Cookie 限制被 401）
 */
import { createHash, timingSafeEqual } from 'node:crypto'
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

const COOKIE = 'halofluxk'
const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const clampRows = (value, lo, hi) => {
  const n = Number(value)
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : 8
}
const escapeHtml = (value) => String(value || '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]))

function pageHtml(html, display) {
  const d = display || {}
  let out = html
  const title = typeof d.title === 'string' ? d.title.trim() : ''
  const safe = escapeHtml(title || 'HALOFLUX ON Ekko').slice(0, 80)
  if (title) out = out.replace(/<h1>[^<]*<\/h1>/, '<h1>' + safe + '</h1>')
  out = out.replace(/<title>[^<]*<\/title>/, '<title>' + safe + '</title>')
  const boot = '<script>(function(){' +
    'window.__hlShowGpu=' + (d.gpu !== false ? 'true' : 'false') + ';' +
    'window.__hlToolRows=' + clampRows(d.toolRows, 3, 15) + ';' +
    'window.__hlAgentRows=' + clampRows(d.agentRows, 3, 12) + ';' +
    'window.__wpPaused=' + (d.anim === false ? 'true' : 'false') + ';' +
    'window.__hlAnim=' + (d.anim !== false ? 'true' : 'false') + ';' +
    (d.compat ? "try{Object.defineProperty(window,'devicePixelRatio',{get:function(){return 1},configurable:true})}catch(e){}" : '') +
    '})();</script>'
  out = out.replace(/<body([^>]*)>/, '<body$1>' + boot)
  if (d.anim === false) {
    out = out.replace('</head>', '<style>#stage{visibility:hidden}</style></head>')
  }
  if (d.compat) {
    out = out.replace('</head>', '<style>*,*::before,*::after{will-change:auto !important;animation:none !important;transition:none !important}canvas{image-rendering:auto}</style></head>')
  }
  return out
}

function loadFiles(display) {
  const ai = readFileSync(join(root, 'page-src/ai-link.js'), 'utf8')
  const build = (ai.match(/var BUILD = '([^']+)'/) || [])[1] || 'v0.0'
  const page = Buffer.from(pageHtml(readFileSync(join(root, 'page-src/index.html'), 'utf8'), display))
  return {
    build,
    files: {
      '/': { body: page, type: MIME['.html'] },
      '/index.html': { body: page, type: MIME['.html'] },
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

function tokenOk(candidate, token) {
  if (!token) return true
  const a = createHash('sha256').update(String(candidate || '')).digest()
  const b = createHash('sha256').update(String(token)).digest()
  return timingSafeEqual(a, b)
}

function parseCookies(req) {
  const out = {}
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

function providedToken(req, url) {
  const h = req.headers || {}
  let t = ''
  if (h['x-ai-link-token']) t = String(h['x-ai-link-token'])
  else if (h.authorization && /^Bearer\s+(.+)$/i.test(String(h.authorization))) t = RegExp.$1
  if (!t && url) t = url.searchParams.get('k') || url.searchParams.get('token') || ''
  if (!t) t = parseCookies(req)[COOKIE] || ''
  return String(t).trim()
}

function loginPage() {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>HALOFLUX ON Ekko</title>
<style>
html,body{height:100%;margin:0;background:#08090b;color:#cfd2d8;font:14px ui-monospace,Consolas,monospace}
body{display:flex;align-items:center;justify-content:center}
form{display:flex;gap:8px;padding:22px;border:1px solid #25282e;background:#0e0f12}
input{font:inherit;padding:6px 9px;background:#08090b;color:#f4f5f7;border:1px solid #3a3e46;outline:none}
button{font:inherit;padding:6px 12px;background:#98e0cf;color:#08110d;border:0;cursor:pointer}
</style>
<form method="get"><input name="k" type="password" placeholder="访问密钥" autofocus><button>进入</button></form>
</html>`
}

/**
 * @param {object} options
 * @param {number} options.port
 * @param {string} options.host
 * @param {string} options.token 访问密钥；空字符串表示开放模式
 * @param {() => Promise<object>} options.getStats 返回 docker /stats 结构
 * @returns {Promise<{port:number,url:string,close:()=>Promise<void>}>}
 */
export function startWallpaperServer({ port, host = '0.0.0.0', token = '', display = {}, getStats, viewerTtlMs = 15000 }) {
  const { build, files } = loadFiles(display)
  const viewers = new Map()
  const pruneViewers = (now) => {
    for (const [key, at] of viewers) if (now - at > viewerTtlMs) viewers.delete(key)
  }
  const viewerKey = (req) => {
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim()
    return ip + '|' + String(req.headers['user-agent'] || '')
  }
  const server = createServer(async (req, res) => {
    let url
    try { url = new URL(req.url || '/', 'http://127.0.0.1') } catch (_) { url = new URL('/', 'http://127.0.0.1') }
    const path = url.pathname
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(res, 405, 'text/plain; charset=utf-8', 'method not allowed')
      return
    }
    if (path === '/health') {
      send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ ok: true }))
      return
    }
    if (path === '/favicon.ico') {
      res.writeHead(204)
      res.end()
      return
    }

    const isAsset = /\.[a-z0-9]+$/i.test(path) && path !== '/index.html'
    const needsAuth = !isAsset && path !== '/health'
    const setCookie = []
    if (needsAuth && token) {
      const provided = providedToken(req, url)
      if (!tokenOk(provided, token)) {
        if (path === '/stats') {
          send(res, 401, 'application/json; charset=utf-8', JSON.stringify({ error: 'unauthorized' }))
        } else {
          send(res, 401, 'text/html; charset=utf-8', loginPage())
        }
        return
      }
      const fromQuery = url.searchParams.get('k') || url.searchParams.get('token')
      if (fromQuery && tokenOk(fromQuery, token)) {
        setCookie.push(`${COOKIE}=${encodeURIComponent(fromQuery)}; Path=/; Max-Age=2592000; SameSite=Lax`)
      }
    }
    const headers = setCookie.length ? { 'Set-Cookie': setCookie } : {}

    if (path === '/stats') {
      const nowMs = Date.now()
      viewers.set(viewerKey(req), nowMs)
      pruneViewers(nowMs)
      try {
        const data = await getStats()
        if (!data || !data.ai) throw new Error('stats unavailable')
        // 页面会拿 /stats.ai.build 和自身 BUILD 比较；使用页面构建号避免自动重载
        data.ai.build = build
        send(res, 200, 'application/json; charset=utf-8', JSON.stringify(data), headers)
      } catch (error) {
        send(res, 503, 'application/json; charset=utf-8', JSON.stringify({ error: 'stats unavailable' }))
      }
      return
    }
    const file = files[path]
    if (!file) {
      send(res, 404, 'text/plain; charset=utf-8', 'not found')
      return
    }
    if (req.method === 'HEAD') {
      res.writeHead(200, Object.assign({ 'Content-Type': file.type, 'Content-Length': file.body.length }, headers))
      res.end()
      return
    }
    send(res, 200, file.type, file.body, headers)
  })

  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener('error', onError)
      reject(error)
    }
    server.once('error', onError)
    server.listen(port, host, () => {
      server.removeListener('error', onError)
      const actual = server.address().port
      resolve({
        port: actual,
        url: `http://${host}:${actual}/`,
        status: () => {
          pruneViewers(Date.now())
          return { viewers: viewers.size, running: true }
        },
        close: () => new Promise((done) => {
          server.close(() => done())
          setTimeout(done, 500)
        })
      })
    })
  })
}
