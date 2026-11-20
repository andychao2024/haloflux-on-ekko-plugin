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

// 与 src-client/client.src.mjs 里的 STAGE_NOVA_REMAP 保持同步：
// 只替换「圆环内」的装饰色（圆网曲线、跑灯、彗星），外层光环、环上卡片、
// 大气、车道、光斑等保持原版。背景与纯白高光不动。
// 科技风 6 色系：原版粉 #f0a6c6 / 淡琥珀橙 #f8c08c（介于原版 #ffb066 与过淡的 #f4d0af 之间） / 紫罗兰 #9669ff /
// 冰蓝 #6fd8ff / 冰蓝白 #d6e8f4 / 青绿 #5fe8c0
const STAGE_NOVA_REMAP = [
  // 圆网曲线 6 色随机必须排在单色替换之前：前面两条单色规则会把
  // k<0.1 / 其余两个分支的色值先改掉，导致整条 6 色匹配 MISS。
  ['const k = rnd();\n    x.strokeStyle = k < 0.05 ? `rgba(240,166,198,${al})` : k < 0.1 ? `rgba(180,170,235,${al})` : `rgba(228,231,238,${al})`;',
   'const k = rnd();\n    const ncol = (k * 6) | 0;\n    x.strokeStyle = [`rgba(240,166,198,${al})`, `rgba(248,192,140,${al})`, `rgba(150,105,255,${al})`, `rgba(111,216,255,${al})`, `rgba(214,232,244,${al})`, `rgba(95,232,192,${al})`][ncol];'],
  ['rgba(180,170,235,${', 'rgba(150,105,255,${'],  // 圆网淡紫 → 亮紫罗兰 #9669ff（残余引用）
  ['rgba(228,231,238,${', 'rgba(214,232,244,${'],  // 圆网冷白 → 冰蓝白 #d6e8f4
  // 圆环内 6 色随机：原版粉 #f0a6c6 / 淡琥珀橙 #f8c08c（介于原版 #ffb066 与过淡的 #f4d0af 之间） / 紫罗兰 #9669ff / 冰蓝 #6fd8ff / 冰蓝白 #d6e8f4 / 青绿 #5fe8c0
  // 彗星 6 色随机：tint 改为 0~5 六选一
  ["c.tint ? '200,190,250' : '255,255,255'", "['150,105,255','214,232,244','240,166,198','111,216,255','248,192,140','95,232,192'][c.tint]"],
  ['tint: rnd() < 0.15', 'tint: (rnd() * 6) | 0'],
  // 节点标记小圈圈：约半数保留原白，其余从琥珀橙/紫罗兰/冰蓝/青绿四色随机
  ['b.strokeStyle = `rgba(235,238,244,${rr(0.35, 0.8)})`; b.lineWidth = 0.8;',
   'const ncc = rnd(); b.strokeStyle = ncc < 0.5 ? `rgba(235,238,244,${rr(0.35, 0.8)})` : [`rgba(248,192,140,${rr(0.35, 0.8)})`, `rgba(150,105,255,${rr(0.35, 0.8)})`, `rgba(111,216,255,${rr(0.35, 0.8)})`, `rgba(95,232,192,${rr(0.35, 0.8)})`][(ncc * 4) | 0]; b.lineWidth = 0.8;'],
  // 点状圆环链：每条链整链一色（半数原白 + 四色随机）
  ["b.strokeStyle = 'rgba(235,238,244,.55)'; b.lineWidth = 0.8;",
   "b.strokeStyle = (rnd() < 0.5 ? 'rgba(235,238,244,.55)' : ['rgba(248,192,140,.55)', 'rgba(150,105,255,.55)', 'rgba(111,216,255,.55)', 'rgba(95,232,192,.55)'][(rnd() * 4) | 0]); b.lineWidth = 0.8;"],
  // 环外三层（车道线/飞出流光/雾带）：三色版 —— 紫罗兰 #9669ff / 冰蓝 #6fd8ff / 青绿 #5fe8c0，
  // 与圆环内科技风呼应。车道线用冰蓝，飞出流光 tint 0→紫罗兰(s0)/1→冰蓝(s1)，雾带 0/1/2→紫罗兰/冰蓝/青绿。
  // 车道线：淡紫白 → 冰蓝，alpha 保持原版 0.035（三色观感更亮，不再额外提亮）
  ['x.strokeStyle = `rgba(210,205,235,${rr(0.01, 0.035)})`; x.lineWidth = rr(0.5, 1);',
   'x.strokeStyle = `rgba(111,216,255,${rr(0.01, 0.028)})`; x.lineWidth = rr(0.5, 1);'],
  // 飞出流光：保留 GR.s0/s1 渐变引用与原版 tint 概率
  ['sp: rr(260, 900), lw: rnd() < 0.08 ? rr(1.2, 1.7) : rr(0.5, 1), lv: rnd() < 0.12 ? 1 : 0, tint: rnd() < 0.22 ? 1 : 0, burst: false',
   'sp: rr(260, 900), lw: rnd() < 0.08 ? rr(1.2, 1.7) : rr(0.5, 1), lv: rnd() < 0.12 ? 1 : 0, tint: rnd() < 0.22 ? 1 : 0, burst: false'],
  // 飞出流光爆发包（spawnFlyBurst）：概率还原原版（0.3）
  ['const sp = rr(450, 1150), len = rr(70, 320), r0 = RO + rr(0, 8), tint = rnd() < 0.3 ? 1 : 0, lv = rnd() < 0.45 ? 2 : 1;',
   'const sp = rr(450, 1150), len = rr(70, 320), r0 = RO + rr(0, 8), tint = rnd() < 0.3 ? 1 : 0, lv = rnd() < 0.45 ? 2 : 1;'],
  // 飞出流光描边（drawFlyers）：保留原版渐变引用
  ['S.strokeStyle = f0.tint ? GR.s1 : GR.s0;',
   'S.strokeStyle = f0.tint ? GR.s1 : GR.s0;'],
  // 雾带渐变（drawOuterFar）：保留原版 s0/s1/s2 三选一引用
  ["S.strokeStyle = GR['s' + (h.tint === 1 ? 0 : h.tint === 2 ? 2 : 1)];",
   "S.strokeStyle = GR['s' + (h.tint === 1 ? 0 : h.tint === 2 ? 2 : 1)];"],
  // 雾带 tint 分布：沿用原版 0/1/2 三选一
  ['tint: k < 0.55 ? 0 : k < 0.85 ? 1 : 2, drift: rr(-0.04, 0.04)',
   'tint: k < 0.55 ? 0 : k < 0.85 ? 1 : 2, drift: rr(-0.04, 0.04)'],
  // 三渐变改三色版（减淡：中段 .7→.45、末梢 .42→.3，整体比原版更淡）：s0 紫罗兰 / s1 冰蓝 / s2 青绿
  ["GR.s0 = mkG([[0, 'rgba(248,248,255,1)'], [0.35, 'rgba(228,226,242,.8)'], [1, 'rgba(190,190,214,.3)']], RMAX * 0.95);",
   "GR.s0 = mkG([[0, 'rgba(150,105,255,1)'], [0.35, 'rgba(150,105,255,.45)'], [1, 'rgba(120,80,220,.3)']], RMAX * 0.95);"],
  ["GR.s1 = mkG([[0, 'rgba(240,236,255,1)'], [0.3, 'rgba(196,182,244,.82)'], [1, 'rgba(160,140,228,.3)']], RMAX * 0.95);",
   "GR.s1 = mkG([[0, 'rgba(111,216,255,1)'], [0.3, 'rgba(111,216,255,.45)'], [1, 'rgba(70,160,210,.3)']], RMAX * 0.95);"],
  ["GR.s2 = mkG([[0, 'rgba(225,245,242,1)'], [0.3, 'rgba(176,214,210,.8)'], [1, 'rgba(140,180,186,.3)']], RMAX * 0.95);",
   "GR.s2 = mkG([[0, 'rgba(95,232,192,1)'], [0.3, 'rgba(95,232,192,.45)'], [1, 'rgba(50,170,140,.3)']], RMAX * 0.95);"],
  // 雾带光晕 HAZE_COL：改三色版（紫罗兰 / 冰蓝 / 青绿）
  ["const HAZE_COL = ['196,180,252', '242,242,252', '190,222,222'];",
   "const HAZE_COL = ['150,105,255', '111,216,255', '95,232,192'];"],
  // 雾带描边 alpha 因子还原原版（0.05 / 0.6）：三色饱和度高，不再额外提亮
  ['S.globalAlpha = Math.min(1, h.alpha * e * 0.05 * C.hazeBright); S.lineWidth = 2.2; S.stroke();',
   'S.globalAlpha = Math.min(1, h.alpha * e * 0.04 * C.hazeBright); S.lineWidth = 2.2; S.stroke();'],
  ['S.globalAlpha = Math.min(1, h.alpha * e * 0.6 * C.hazeBright); S.lineWidth = 0.55; S.stroke();',
   'S.globalAlpha = Math.min(1, h.alpha * e * 0.5 * C.hazeBright); S.lineWidth = 0.55; S.stroke();']
]

function applyStageTheme(code, stage) {
  if (stage === 'classic') return code
  let out = code
  for (const [from, to] of STAGE_NOVA_REMAP) out = out.split(from).join(to)
  return out
}

function pageHtml(html, display) {
  const d = display || {}
  let out = html
  const title = typeof d.title === 'string' ? d.title.trim() : ''
  const safe = escapeHtml(title || 'HALOFLUX ON Ekko').slice(0, 80)
  if (title) out = out.replace(/<h1>[^<]*<\/h1>/, '<h1>' + safe + '</h1>')
  out = out.replace(/<title>[^<]*<\/title>/, '<title>' + safe + '</title>')
  const idleSpin = Number(d.idleSpinSec)
  const idleSpinSec = Number.isFinite(idleSpin)
    ? Math.min(60, Math.max(2, Math.round(idleSpin))) : 3
  const boot = '<script>(function(){' +
    'window.__hlShowGpu=' + (d.gpu !== false ? 'true' : 'false') + ';' +
    'window.__hlToolRows=' + clampRows(d.toolRows, 3, 15) + ';' +
    'window.__hlAgentRows=' + clampRows(d.agentRows, 3, 12) + ';' +
    'window.__hlIdleSpinSec=' + idleSpinSec + ';' +
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
  const stage = display && display.stage === 'classic' ? 'classic' : 'nova'
  const rawAi = readFileSync(join(root, 'page-src/ai-link.js'), 'utf8')
  const build = (rawAi.match(/var BUILD = '([^']+)'/) || [])[1] || 'v0.0'
  const ai = applyStageTheme(rawAi, stage)
  const page = Buffer.from(pageHtml(applyStageTheme(readFileSync(join(root, 'page-src/index.html'), 'utf8'), stage), display))
  const wp = Buffer.from(applyStageTheme(readFileSync(join(root, 'page-src/wp.js'), 'utf8'), stage))
  return {
    build,
    files: {
      '/': { body: page, type: MIME['.html'] },
      '/index.html': { body: page, type: MIME['.html'] },
      '/wp.js': { body: wp, type: MIME['.js'] },
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
