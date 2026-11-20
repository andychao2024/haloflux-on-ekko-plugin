/**
 * HALOFLUX ON Ekko · Studio 插件宿主
 * 页面本身是 docker 版原页面（index.html + wp.js + ai-link.js）的单文件副本，
 * 这里只负责：
 *   1. 用 srcdoc 子 iframe 承载它（样式/全局变量与 Studio 隔离）
 *   2. 把它对 /stats 的请求转成插件 RPC
 *   3. 下发动效开关与帧率设置
 */

// 与 server.mjs 的边界保持一致；页面端再夹一次，避免旧设置或手改数据越界。
const MAX_TOOL_ROWS = 15
const MAX_AGENT_ROWS = 12
const IDLE_SPIN_MIN = 2
const IDLE_SPIN_MAX = 60
const IDLE_SPIN_DEFAULT = 3
function clampInt(value, lo, hi, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : fallback
}

// 新版舞台配色（科技感）：只替换「圆环内」的装饰色（圆网曲线、跑灯、彗星），
// 外层光环（buildOuter/HAZE_COL）、环上卡片（TINTS）、大气、车道、光斑等保持原版不动。
// 背景（#08090b）、阴影、纯白高光、节点小圆圈（白色）一律不动。
// 用「模板字面量里带动态 alpha」的精确前缀做替换，只命中圆环内的动态颜色，
// 面板/数据图里固定 alpha 的粉色（rgba(240,166,198,.45) 等）不受影响。
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
  // 飞出流光单体（newFlyer）：保持原版 tint 二选一（s0 紫罗兰 / s1 冰蓝）
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

function pageWithTitle(html, title) {
  const clean = String(title || '').trim()
  if (!clean) return html
  const safe = clean.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]))
  return html
    .replace(/<h1>[^<]*<\/h1>/, '<h1>' + safe + '</h1>')
    .replace(/<title>[^<]*<\/title>/, '<title>' + safe + '</title>')
}

export async function mount(root, ctx) {
  // 页面内联脚本的构建号；插件页 stats 必须返回同一个值，
  // 否则页面 checkBuild 会把 'plugin' 当成新版本并周期性重载。
  const PAGE_BUILD = (PAGE_HTML.match(/var BUILD = '([^']+)'/) || [])[1] || ''
  // 侧栏入口开关默认开启：每次打开看板或设置页时顺手校正一次。
  // Studio 升级后导航配置可能被重置，这里能把插件入口自动补回来。
  ctx.rpc.call('ensure-navigation').catch(() => {})

  if (ctx.view === 'settings') return mountSettings(root, ctx)

  // 宿主侧 RPC 没有超时：通道没建立或请求挂住时，await 会永远不返回，
  // 面板就停在空白。这里最多等 3 秒，拿不到就先按默认设置渲染。
  const DEFAULTS = { anim: true, compat: false, gpu: true, showIcon: true, wallpaper: false, wallpaperPort: 8790, wallpaperToken: '', toolRows: 8, agentRows: 8, idleSpinSec: 3, title: '' }
  const settings = await Promise.race([
    ctx.rpc.call('get-settings').catch(() => null),
    new Promise((resolve) => setTimeout(() => resolve(null), 3000))
  ]).then((s) => (s && typeof s === 'object' ? s : DEFAULTS))
  const anim = !(settings && settings.anim === false)
  const compat = !!(settings && settings.compat)
  const gpu = !(settings && settings.gpu === false)
  const toolRows = clampInt(settings && settings.toolRows, 3, 15, 8)
  const agentRows = clampInt(settings && settings.agentRows, 3, 12, 8)
  const idleSpinSec = clampInt(settings && settings.idleSpinSec, IDLE_SPIN_MIN, IDLE_SPIN_MAX, IDLE_SPIN_DEFAULT)
  const stage = (settings && settings.stage === 'classic') ? 'classic' : 'nova'
  const title = (settings && typeof settings.title === 'string') ? settings.title.trim() : ''

  const style = document.createElement('style')
  style.textContent = `
    .hl-root { position:fixed; inset:0; height:auto; width:auto; overflow:hidden; background:#08090b; z-index:0; }
    .hl-frame { position:absolute; inset:0; width:100%; height:100%; border:0; background:#08090b; }

  `
  root.append(style)
  root.classList.add('hl-root')

  // 把原版页面挂到插件提供的 root 节点里（不要替换 document.body：
  // Studio 的插件宿主需要保留自己的根节点，替换会触发宿主重排/重挂载）。
  const parsed = new DOMParser().parseFromString(pageWithTitle(PAGE_HTML, title), 'text/html')
  const scripts = [...parsed.body.querySelectorAll('script')].map((el) => el.textContent)
  parsed.body.querySelectorAll('script').forEach((el) => el.remove())

  const injected = []
  for (const node of parsed.head.querySelectorAll('style,meta[name="viewport"]')) {
    const clone = node.cloneNode(true)
    document.head.appendChild(clone)
    injected.push(clone)
  }

  root.classList.add('hl-root')
  root.innerHTML = parsed.body.innerHTML

  // ---- 实时会话连接：放在页面端，使用当前查看者的身份与权限 ----
  const live = new Map()          // sessionId -> { agent, profile, title, reasoning, text, ts, working, ... }
  const handles = new Map()       // sessionId -> HostSession
  const liveTools = []
  const backfillTried = new Set()
  const firstChecked = new Set()
  const toolBackfill = new Map()      // sessionId -> { at, entries }
  const toolBusy = new Set()
  const pendingSessions = new Map()   // sessionId -> { working, at, agent }
  let liveRate = null
  let rateBusy = false

  async function refreshRate() {
    if (rateBusy) return
    rateBusy = true
    try {
      const rate = await ctx.rpc.call('rate')
      if (rate) liveRate = rate
    } catch (_) { /* ignore */ } finally { rateBusy = false }
  }
  let liveToolCount = 0
  let liveEvent = null

  function liveSlot(sessionId, meta) {
    let slot = live.get(sessionId)
    if (!slot) {
      slot = {
        sessionId,
        agent: meta.agent || 'unknown',
        profile: meta.profile || 'default',
        title: meta.title || '',
        reasoning: '', text: '', ts: 0,
        working: false, workStartedAt: 0, lastToolAt: 0,
        plan: null
      }
      live.set(sessionId, slot)
    }
    if (meta.agent) slot.agent = meta.agent
    if (meta.title) slot.title = meta.title
    return slot
  }

  function clipText(text, max) {
    const value = String(text || '')
    return value.length > max ? value.slice(-max) : value
  }

  const TOOL_ARG_KEYS = ['command', 'file_path', 'path', 'pattern', 'query', 'url',
    'prompt', 'description', 'session_id', 'sessionId', 'skill', 'tool', 'action', 'glob']

  /** 与 docker 版一致：工具参数只显示最有代表性的一行，而不是整段 JSON。 */
  function toolArgText(input) {
    if (typeof input === 'string') return input.replace(/\s+/g, ' ').trim().slice(0, 160)
    if (!input || typeof input !== 'object') return ''
    let v = null
    for (const key of TOOL_ARG_KEYS) {
      if (typeof input[key] === 'string' && input[key].trim()) { v = input[key]; break }
    }
    if (v === null) {
      for (const key of Object.keys(input)) {
        if (typeof input[key] === 'string' && input[key].trim()) { v = input[key]; break }
      }
    }
    return v === null ? '' : String(v).replace(/\s+/g, ' ').trim().slice(0, 160)
  }

  function onLiveEvent(sessionId, meta, event) {
    const name = String((event && event.event) || '')
    const slot = liveSlot(sessionId, meta)
    if (name === 'reasoning.delta' || name === 'thinking.delta' || name === 'interim.delta') {
      slot.reasoning = clipText(slot.reasoning + String(event.delta || ''), 2400)
      slot.ts = Date.now(); slot.working = true
      liveEvent = { type: 'thinking', at: Date.now() }
      return
    }
    if (name === 'message.delta') {
      slot.text = clipText(slot.text + String(event.delta || ''), 2400)
      slot.ts = Date.now(); slot.working = true
      liveEvent = { type: 'message', at: Date.now() }
      return
    }
    if (name === 'tool.started' || name === 'tool.completed' || name === 'tool.failed') {
      // Studio 的 SessionEvent 字段是 tool_name / args / tool_call_id；
      // 兼容其他 Agent 可能使用的 name / arguments 形式。
      const toolName = event.tool_name || event.name || event.tool || 'tool'
      const callId = String(event.tool_call_id || event.id || '')
      const rawArg = event.args !== undefined ? event.args
        : (event.arguments !== undefined ? event.arguments : event.preview)
      const arg = toolArgText(rawArg)
      slot.lastToolAt = Date.now(); slot.ts = Date.now(); slot.working = true
      if (name === 'tool.started') {
        liveToolCount += 1
        liveTools.unshift({
          at: Date.now(), ageSec: 0, agent: slot.agent, callId,
          name: toolName, arg: clipText(arg, 160), state: 'running'
        })
        while (liveTools.length > MAX_TOOL_ROWS) liveTools.pop()
      } else {
        // 完成/失败要落到同一条调用上，面板才会从青色变为灰色/红色
        const hit = (callId && liveTools.find((tool) => tool.callId === callId && tool.state === 'running')) ||
          liveTools.find((tool) =>
            tool.name === toolName && tool.agent === slot.agent && tool.state === 'running')
        if (hit) {
          hit.state = name === 'tool.failed' ? 'error' : 'done'
          hit.at = Date.now()
          hit.ageSec = 0
        }
      }
      liveEvent = { type: 'tool', at: Date.now() }
      return
    }
    if (name === 'run.started' || name === 'run.updated' || name === 'run.queued') {
      slot.working = true; slot.ts = Date.now(); slot.workStartedAt = slot.workStartedAt || Date.now()
      return
    }
    if (name === 'run.completed' || name === 'run.failed' || name === 'run.stopped') {
      slot.working = false; slot.workStartedAt = 0; slot.ts = Date.now()
      liveEvent = { type: name.replace('run.', ''), at: Date.now() }
      return
    }
    if (name === 'plan.updated') {
      slot.plan = event.task_plan || event.plan || slot.plan
      return
    }
    if (name === 'resumed') {
      slot.working = !!event.isWorking
      slot.workStartedAt = slot.working ? Date.now() : 0
      const plans = Array.isArray(event.taskPlans) ? event.taskPlans : []
      if (plans[0]) slot.plan = plans[0]
    }
  }

  /** 页面首次进入时，用最后一条消息判断会话是否仍在回合中。
      Codex 等外部 Agent 的 last_active 可能很久不更新，不能只等实时事件。 */
  function firstCheck(meta) {
    if (!meta || !meta.id || firstChecked.has(meta.id)) return Promise.resolve()
    firstChecked.add(meta.id)
    if (!ctx.host || !ctx.host.sessions || typeof ctx.host.sessions.messages !== 'function') {
      return Promise.resolve()
    }
    return ctx.host.sessions.messages(meta.id, { limit: 12 }).then((res) => {
      const messages = res && Array.isArray(res.messages) ? res.messages : []
      if (!messagesWorking(messages)) return
      const slot = liveSlot(meta.id, meta)
      if (!slot.working) {
        slot.working = true
        slot.workStartedAt = slot.workStartedAt || Date.now()
        slot.ts = Date.now()
      }
      // 首次检测结果同时放进 pending，避免随后的 resumed(isWorking:false)
      // 或空实时事件把它立刻覆盖掉。
      pendingSessions.set(meta.id, {
        working: true, at: Date.now(), agent: meta.agent || 'unknown', first: true
      })
    }).catch(() => { /* 首次检测失败不阻塞页面 */ })
  }

  async function firstCheckAll(sessions) {
    const targets = (sessions || []).slice(0, 4).filter((meta) => meta && meta.id)
    await Promise.all(targets.map(firstCheck))
  }

  async function ensureLive(sessions) {
    if (!ctx.host || !ctx.host.sessions || typeof ctx.host.sessions.connect !== 'function') return
    const targets = (sessions || []).slice(0, 4).filter((meta) => meta && meta.id)
    // 只保留当前关注列表里的连接，避免长时间打开页面后积累大量句柄
    const keep = new Set(targets.map((meta) => meta.id))
    for (const [id, handle] of [...handles]) {
      if (keep.has(id)) continue
      try { if (handle && handle.close) handle.close() } catch (_) { /* ignore */ }
      handles.delete(id)
      live.delete(id)
    }
    for (const meta of targets) {
      if (handles.has(meta.id)) continue
      try {
        const handle = await ctx.host.sessions.connect(meta.id, (event) => {
          try { onLiveEvent(meta.id, meta, event) } catch (_) { /* ignore */ }
        })
        handles.set(meta.id, handle)
        liveSlot(meta.id, meta)
      } catch (_) { /* ignore */ }
    }
  }

  function backfill(sessions) {
    if (!ctx.host || !ctx.host.sessions || typeof ctx.host.sessions.messages !== 'function') return
    for (const meta of (sessions || []).slice(0, 3)) {
      if (!meta || !meta.id || backfillTried.has(meta.id)) continue
      const slot = live.get(meta.id)
      if (slot && (slot.reasoning || slot.text)) { backfillTried.add(meta.id); continue }
      backfillTried.add(meta.id)
      ctx.host.sessions.messages(meta.id, { limit: 8 }).then((res) => {
        const plans = Array.isArray(res && res.taskPlans) ? res.taskPlans : []
        if (plans[0]) liveSlot(meta.id, meta).plan = plans[0]
        const messages = Array.isArray(res && res.messages) ? res.messages : []
        for (let i = messages.length - 1; i >= 0; i--) {
          const message = messages[i]
          if (!message || message.role !== 'assistant') continue
          const text = message.reasoning_content || message.reasoning || message.content
          if (text && String(text).trim()) {
            const target = liveSlot(meta.id, meta)
            if (!target.reasoning && !target.text) {
              target.reasoning = clipText(String(text).trim(), 1200)
              target.ts = Number(message.timestamp) * 1000 || Date.now()
            }
            break
          }
        }
      }).catch(() => { /* ignore */ })
    }
  }

  function backfillTools(sessions) {
    if (!ctx.host || !ctx.host.sessions || typeof ctx.host.sessions.messages !== 'function') return
    const now = Date.now()
    for (const meta of (sessions || []).slice(0, 3)) {
      if (!meta || !meta.id) continue
      const rec = toolBackfill.get(meta.id)
      if (rec && now - rec.at < 10000) continue
      if (toolBusy.has(meta.id)) continue
      toolBusy.add(meta.id)
      // 先占位，失败时也等 10 秒再试，避免每秒轮询打满会话接口
      toolBackfill.set(meta.id, { at: now, entries: rec ? rec.entries : [] })
      ctx.host.sessions.messages(meta.id, { limit: 40 }).then((res) => {
        const messages = Array.isArray(res && res.messages) ? res.messages : []
        const previous = pendingSessions.get(meta.id)
        pendingSessions.set(meta.id, {
          working: messagesWorking(messages),
          at: Date.now(),
          agent: meta.agent || 'unknown',
          first: !!(previous && previous.first)
        })
        const entries = parseToolMessages(messages, MAX_TOOL_ROWS, Date.now())
          .map((item) => Object.assign({}, item, { agent: meta.agent || 'unknown' }))
        toolBackfill.set(meta.id, { at: Date.now(), entries })
      }).catch(() => { /* ignore */ }).finally(() => toolBusy.delete(meta.id))
    }
  }

  function planFromRaw(raw, slot) {
    if (!raw || !Array.isArray(raw.plan)) return null
    const steps = raw.plan.map((step) => ({ id: step.id, step: clipText(step.step || '', 120), status: step.status || 'pending' }))
    const done = steps.filter((step) => step.status === 'completed').length
    return {
      agent: slot.agent, profile: slot.profile, sessionId: slot.sessionId, title: slot.title || null,
      state: raw.execution_state || 'running', sessionActive: true,
      done, total: steps.length, steps,
      ts: raw.updated_at || Date.now(), ageSec: 0
    }
  }

  function applyLive(d) {
    if (!d || !d.ai) return d
    const ai = d.ai
    const liveAgents = new Set([...live.values()].map((slot) => slot.agent))
    const baseStreams = (Array.isArray(ai.streams) ? ai.streams : [])
      .filter((item) => !live.has(item.sessionId) && !liveAgents.has(item.agent))
    const liveStreams = []
    for (const slot of live.values()) {
      if (!slot.reasoning && !slot.text && !slot.working) continue
      const ageSec = slot.ts ? Math.max(0, Math.round((Date.now() - slot.ts) / 1000)) : null
      liveStreams.push({
        agent: slot.agent, profile: slot.profile, sessionId: slot.sessionId, title: slot.title,
        text: clipText(slot.reasoning || slot.text, 1200),
        kind: slot.reasoning ? 'think' : 'text',
        state: slot.working ? 'live' : (ageSec !== null && ageSec < 180 ? 'active' : 'idle'),
        working: slot.working ? 1 : 0,
        workKind: slot.working && slot.lastToolAt && Date.now() - slot.lastToolAt < 15000 ? 'tool' : (slot.working ? 'model' : undefined),
        workSec: slot.working && slot.workStartedAt ? Math.round((Date.now() - slot.workStartedAt) / 1000) : undefined,
        ageSec, ts: slot.ts || null
      })
    }
    const streams = liveStreams.concat(baseStreams)
      .sort((a, b) => (b.working || 0) - (a.working || 0) || (b.ts || 0) - (a.ts || 0))
      .slice(0, 10)
    ai.streams = streams

    const livePlans = []
    for (const slot of live.values()) {
      const plan = planFromRaw(slot.plan, slot)
      if (plan) livePlans.push(plan)
    }
    if (livePlans.length) {
      const basePlans = ((ai.taskPlan && ai.taskPlan.plans) || []).filter((plan) => !livePlans.some((item) => item.agent === plan.agent))
      const plans = livePlans.concat(basePlans).slice(0, 10)
      ai.taskPlan = Object.assign({}, plans[0], { plans })
    }

    // 历史工具来自页面端的会话历史回填；再叠加实时事件收到的调用。
    const backfilledTools = []
    for (const rec of toolBackfill.values()) {
      for (const tool of rec.entries) {
        backfilledTools.push(Object.assign({}, tool, {
          ageSec: tool.at ? Math.max(0, Math.round((Date.now() - tool.at) / 1000)) : null
        }))
      }
    }
    const baseTools = backfilledTools.concat(Array.isArray(ai.recentTools) ? ai.recentTools : [])
    if (liveTools.length || baseTools.length) {
      const merged = []
      for (const tool of liveTools.concat(baseTools).sort((a, b) => (b.at || 0) - (a.at || 0))) {
        // 同一次调用可能同时出现在实时事件和服务端历史里，15 秒内同名同参只保留一条
        const dup = merged.some((item) =>
          item.name === tool.name && (item.arg || '') === (tool.arg || '') &&
          Math.abs((item.at || 0) - (tool.at || 0)) < 15000)
        if (!dup) merged.push(tool)
        if (merged.length >= MAX_TOOL_ROWS) break
      }
      ai.recentTools = merged
      ai.toolAgents = [...new Set(merged.map((t) => t.agent).filter(Boolean))]
      ai.toolCalls = Math.max(Number(ai.toolCalls) || 0, liveToolCount, merged.length)
    }
    if (liveEvent) {
      ai.lastEvent = liveEvent.type
      ai.lastEventAgeSec = Math.max(0, Math.round((Date.now() - liveEvent.at) / 1000))
    }
    if (liveRate) {
      ai.tokensPerSec = liveRate.tokensPerSec
      ai.outputTokensPerSec = liveRate.outputPerSec
      ai.cacheHitRate = liveRate.cacheHit
    }

    // ---- 动效忙碌信号（关键修复）----
    // buildLegacyStats() 返回的 lastEventAgeSec / planActive / pendingSec /
    // jobsRunning 一律是 null：插件服务端的 store 没有接入会话事件流。
    // ai-link.js 的 updateMotion() 因此把 CAM.spinActive 判成 false，节拍、
    // 运镜、圆环钩子全部停摆；updateVisuals() 也把 FLOW 飞出物压到接近 0。
    // 结果就是数据面板在刷新、舞台却完全静止。用页面端的实时事件与会话
    // 历史重建这些信号（纯函数实现见 src/motion-signals.mjs）。
    applyMotionSignals(ai, {
      now: Date.now(),
      liveEvent,
      liveSlots: live.values(),
      pendingSessions: pendingSessions.values(),
      // 服务端的 activeSessions/recentSessions.lastActive 是 HTTP 轮询结果，
      // 即使实时事件通道不通也能判定「有 agent 在活动」。
      sessions: (d.activeSessions || []).concat(d.recentSessions || [])
    })

    // 实时层：正在收到事件的 Agent 立即标成活跃，不依赖 session.last_active
    // （CodeBuddy 等外部 Agent 的 last_active 通常在回合结束后才更新）。
    const workingAgents = new Set()
    for (const slot of live.values()) {
      if (slot.working && slot.ts && Date.now() - slot.ts > 10 * 60 * 1000) slot.working = false
      if (slot.working) workingAgents.add(slot.agent)
    }
    const nowSec = Math.floor(Date.now() / 1000)
    const recentWorkIds = new Set()
    for (const meta of (d.activeSessions || []).concat(d.recentSessions || [])) {
      const last = Number(meta && meta.lastActive)
      if (last > 0 && nowSec - (last > 1e12 ? Math.floor(last / 1000) : last) <= 600) {
        recentWorkIds.add(meta.id)
      }
    }
    for (const [id, rec] of pendingSessions) {
      if (rec.working && Date.now() - rec.at < 60 * 1000 && (recentWorkIds.has(id) || rec.first)) {
        workingAgents.add(rec.agent)
      }
    }
    // 有实时/未完成信号时以它为准；没有信号时保留最近 60 秒活动的 Agent，
    // 避免后台数据暂时缺失时把整块面板全部清空。
    if (Array.isArray(ai.agents)) {
      ai.agents = ai.agents.map((item) => {
        const working = workingAgents.has(item.agent)
        const raw = Number(item.lastActive)
        const last = raw > 1e12 ? Math.floor(raw / 1000) : raw
        const recent = last > 0 && nowSec - last <= 60
        const active = working || recent
        return Object.assign({}, item, {
          active,
          running: active ? 1 : 0,
          activeSessions: working ? (item.activeSessions || item.sessions || 0) : 0
        })
      })
      ai.activeAgents = ai.agents.filter((item) => item.active).length
    }
    return d
  }

  let statsBusy = false
  window.__hlBridge = {
    stats: async () => {
      if (statsBusy) return window.__hlBridge.last || null
      statsBusy = true
      try {
        const data = await ctx.rpc.call('stats')
        if (data) {
          const liveList = []
          const liveSeen = new Set()
          for (const meta of (data.activeSessions || []).concat(data.recentSessions || [])) {
            if (!meta || !meta.id || liveSeen.has(meta.id)) continue
            liveSeen.add(meta.id)
            liveList.push(meta)
          }
          // 首次进入时先看最后一条消息，避免 Codex 等 last_active 不更新的
          // 会话要等下一轮实时事件才显示激活。
          await firstCheckAll(liveList)
          if (data.ai && PAGE_BUILD) data.ai.build = PAGE_BUILD
          applyLive(data)
          ensureLive(liveList)
          backfill(data.recentSessions)
          backfillTools(data.recentSessions)
        }
        window.__hlBridge.last = data
        return data
      } catch (_) {
        return null
      } finally {
        statsBusy = false
      }
    }
  }

  for (const code of scripts) {
    const el = document.createElement('script')
    el.textContent = applyStageTheme(code, stage)
    root.appendChild(el)
  }

  if (typeof window.__hlApplySettings === 'function') {
    window.__hlApplySettings({ anim, compat, gpu, toolRows, agentRows, idleSpinSec })
  }

  refreshRate()
  const rateTimer = setInterval(refreshRate, 2500)

  ctx.lifecycle.add(() => {
    clearInterval(rateTimer)
    for (const handle of handles.values()) {
      try { if (handle && handle.close) handle.close() } catch (_) { /* ignore */ }
    }
    handles.clear()
    for (const node of injected) node.remove()
    try { root.innerHTML = '' } catch (_) { /* ignore */ }
    root.classList.remove('hl-root')
  })
}

function mountSettings(root, ctx) {
  const style = document.createElement('style')
  style.textContent = `
    .hls { font:12px/1.6 ui-monospace,Consolas,monospace; padding:20px; max-width:720px; display:flex; flex-direction:column; gap:14px; }
    .hls label { display:flex; gap:10px; align-items:center; }
    .hls select, .hls input[type=number] { font:inherit; padding:3px 8px; border-radius:6px;
      background:rgba(255,255,255,.06); color:inherit; border:1px solid rgba(255,255,255,.2); }
    .hls input[type=number] { width:68px; }
    .hls button { font:inherit; padding:5px 12px; border-radius:6px; border:1px solid rgba(255,255,255,.2);
      background:rgba(255,255,255,.06); color:inherit; cursor:pointer; }
    .hls .muted { color:var(--text-secondary,#9aa0aa); }
    .hls .save-msg { opacity:0; transform:translateY(3px); transition:opacity .2s ease, transform .2s ease; }
    .hls .save-msg.show { opacity:1; transform:none; }
    .hls table { border-collapse:collapse; } .hls td { padding:2px 10px 2px 0; vertical-align:top; }
  `
  root.append(style)
  const wrap = document.createElement('div')
  wrap.className = 'hls'
  wrap.innerHTML = `
    <h2>HALOFLUX ON Ekko · 设置</h2>
    <label>看板标题
      <input id="hls-title" type="text" maxlength="80" placeholder="Ekko Studio / Rock5 ITX RK3588"
        style="flex:1;min-width:280px;padding:4px 8px;border-radius:6px;background:rgba(255,255,255,.06);color:inherit;border:1px solid rgba(255,255,255,.2)">
    </label>
    <label><input type="checkbox" id="hls-show-icon"> 在 Studio 侧栏显示插件图标（默认开启；关闭后入口会隐藏）</label>
    <label><input type="checkbox" id="hls-wallpaper"> 启用壁纸服务</label>
    <label>壁纸端口
      <input id="hls-wallpaper-port" type="number" min="1024" max="65535" step="1" value="8790">
    </label>
    <label>访问密钥
      <input id="hls-wallpaper-token" type="text" maxlength="128" style="flex:1;min-width:220px;padding:4px 8px;border-radius:6px;background:rgba(255,255,255,.06);color:inherit;border:1px solid rgba(255,255,255,.2)">
      <button type="button" id="hls-wallpaper-random">随机</button>
    </label>
    <div class="muted">壁纸地址：<span id="hls-wallpaper-url">http://127.0.0.1:8790/</span></div>
    <div class="muted">壁纸访问者：<span id="hls-wallpaper-viewers">0</span></div>
    <label>舞台配色
      <select id="hls-stage">
        <option value="nova">Nova</option>
        <option value="classic">HALOFLUX</option>
      </select>
    </label>
    <label><input type="checkbox" id="hls-anim"> 显示原版动效舞台（iframe 模式，默认开启）</label>
    <label><input type="checkbox" id="hls-gpu"> 显示显卡（GPU 曲线与显存，默认开启；未检测到显卡时不显示）</label>
    <label>工具调用显示条数
      <input id="hls-tool-rows" type="number" min="3" max="15" step="1" value="8">
      <span class="muted">默认 8，可设 3–15</span>
    </label>
    <label>代理调度显示行数
      <input id="hls-agent-rows" type="number" min="3" max="12" step="1" value="8">
      <span class="muted">默认 8，可设 3–12（超出的 Agent 在末行轮换）</span>
    </label>
    <label>空闲圆环旋转间隔
      <input id="hls-idle-spin" type="number" min="2" max="60" step="1" value="3">
      <span class="muted">秒</span>
    </label>
    <label><input type="checkbox" id="hls-compat"> 兼容模式（DPR=1，关闭 will-change 与 CSS 动画）</label>
    <div><button id="hls-save">保存</button> <span class="muted save-msg" id="hls-msg"></span></div>
    <div class="muted">页面与动效来自 HALOFLUX 原作；数据来自 Studio 会话/用量接口与本机指标。插件只读，不读取数据库文件，不发外部网络请求。</div>
    <table>
      <tr><td>插件</td><td>HALOFLUX ON Ekko ${ctx.plugin && ctx.plugin.version ? ctx.plugin.version : ''}</td></tr>
      <tr><td>原作</td><td>Ryder191（HALOFLUX）</td></tr>
      <tr><td>二次开发</td><td>andychao2024</td></tr>
      <tr><td>数据对接思路</td><td>参考 yeshuiwushen/haloflux-ai-link</td></tr>
      <tr><td>许可</td><td>PolyForm Noncommercial 1.0.0</td></tr>
    </table>
  `
  root.append(wrap)
  const showIconBox = wrap.querySelector('#hls-show-icon')
  const wallpaperBox = wrap.querySelector('#hls-wallpaper')
  const wallpaperPortBox = wrap.querySelector('#hls-wallpaper-port')
  const wallpaperTokenBox = wrap.querySelector('#hls-wallpaper-token')
  const wallpaperUrl = wrap.querySelector('#hls-wallpaper-url')
  const wallpaperViewers = wrap.querySelector('#hls-wallpaper-viewers')
  const accessHost = () => {
    try {
      if (location.ancestorOrigins && location.ancestorOrigins.length) {
        return new URL(location.ancestorOrigins[0]).hostname
      }
    } catch (_) { /* ignore */ }
    return (location && location.hostname) || '127.0.0.1'
  }
  const updateWallpaperUrl = () => {
    const port = clampInt(wallpaperPortBox.value, 1024, 65535, 8790)
    const host = accessHost()
    const token = wallpaperTokenBox.value.trim()
    wallpaperUrl.textContent = 'http://' + host + ':' + port + '/' + (token ? '?k=' + encodeURIComponent(token) : '')
  }
  wallpaperPortBox.addEventListener('input', updateWallpaperUrl)
  wallpaperTokenBox.addEventListener('input', updateWallpaperUrl)
  wrap.querySelector('#hls-wallpaper-random').onclick = () => {
    const bytes = new Uint8Array(16)
    crypto.getRandomValues(bytes)
    wallpaperTokenBox.value = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
    updateWallpaperUrl()
  }
  const animBox = wrap.querySelector('#hls-anim')
  const gpuBox = wrap.querySelector('#hls-gpu')
  const compatBox = wrap.querySelector('#hls-compat')
  const toolRowsBox = wrap.querySelector('#hls-tool-rows')
  const agentRowsBox = wrap.querySelector('#hls-agent-rows')
  const idleSpinBox = wrap.querySelector('#hls-idle-spin')
  const stageBox = wrap.querySelector('#hls-stage')
  const titleInput = wrap.querySelector('#hls-title')
  const msg = wrap.querySelector('#hls-msg')
  let msgTimer = 0
  const setMsg = (text) => {
    clearTimeout(msgTimer)
    msg.textContent = text
    msg.classList.remove('show')
    void msg.offsetWidth
    msg.classList.add('show')
    msgTimer = setTimeout(() => msg.classList.remove('show'), 5000)
  }
  const refreshViewers = () => {
    ctx.rpc.call('wallpaper-status').then((s) => {
      wallpaperViewers.textContent = s && s.running ? String(s.viewers || 0) : '未启用'
    }).catch(() => { wallpaperViewers.textContent = '-' })
  }
  refreshViewers()
  const viewersTimer = setInterval(refreshViewers, 2000)
  ctx.lifecycle.add(() => {
    clearInterval(viewersTimer)
    clearTimeout(msgTimer)
  })
  ctx.rpc.call('get-settings').then((s) => {
    showIconBox.checked = !(s && s.showIcon === false)
    wallpaperBox.checked = !!(s && s.wallpaper)
    wallpaperPortBox.value = String(clampInt(s && s.wallpaperPort, 1024, 65535, 8790))
    wallpaperTokenBox.value = (s && typeof s.wallpaperToken === 'string') ? s.wallpaperToken : ''
    updateWallpaperUrl()
    animBox.checked = !(s && s.anim === false)
    gpuBox.checked = !(s && s.gpu === false)
    compatBox.checked = !!(s && s.compat)
    toolRowsBox.value = String(clampInt(s && s.toolRows, 3, MAX_TOOL_ROWS, 8))
    agentRowsBox.value = String(clampInt(s && s.agentRows, 3, MAX_AGENT_ROWS, 8))
    idleSpinBox.value = String(clampInt(s && s.idleSpinSec, IDLE_SPIN_MIN, IDLE_SPIN_MAX, IDLE_SPIN_DEFAULT))
    stageBox.value = (s && s.stage === 'classic') ? 'classic' : 'nova'
    titleInput.value = (s && s.title) || ''
  }).catch(() => {
    showIconBox.checked = true; wallpaperBox.checked = false
    animBox.checked = true; gpuBox.checked = true; idleSpinBox.value = '3'; updateWallpaperUrl()
  })
  wrap.querySelector('#hls-save').onclick = async () => {
    try {
      const saved = await ctx.rpc.call('save-settings', {
        showIcon: !!showIconBox.checked,
        wallpaper: !!wallpaperBox.checked,
        wallpaperPort: clampInt(wallpaperPortBox.value, 1024, 65535, 8790),
        wallpaperToken: wallpaperTokenBox.value.trim(),
        anim: !!animBox.checked,
        gpu: !!gpuBox.checked,
        compat: !!compatBox.checked,
        toolRows: clampInt(toolRowsBox.value, 3, MAX_TOOL_ROWS, 8),
        agentRows: clampInt(agentRowsBox.value, 3, MAX_AGENT_ROWS, 8),
        idleSpinSec: clampInt(idleSpinBox.value, IDLE_SPIN_MIN, IDLE_SPIN_MAX, IDLE_SPIN_DEFAULT),
        stage: stageBox.value === 'classic' ? 'classic' : 'nova',
        title: titleInput.value.trim()
      })
      if (saved && typeof saved.wallpaperToken === 'string' && saved.wallpaperToken !== wallpaperTokenBox.value) {
        wallpaperTokenBox.value = saved.wallpaperToken
        updateWallpaperUrl()
      }
      if (saved && saved.wallpaperError) setMsg('壁纸服务：' + saved.wallpaperError)
      else if (saved && saved.navSynced === false) setMsg('设置已保存，但 Studio 拒绝修改侧栏入口；可到 Studio 导航设置里手动调整')
      else setMsg('已保存，重新打开看板生效')
      refreshViewers()
    } catch (error) {
      setMsg('保存失败：' + (error.message || error))
    }
  }
}
