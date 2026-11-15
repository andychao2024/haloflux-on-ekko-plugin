/**
 * HALOFLUX ON Ekko · Studio 插件宿主
 * 页面本身是 docker 版原页面（index.html + wp.js + ai-link.js）的单文件副本，
 * 这里只负责：
 *   1. 用 srcdoc 子 iframe 承载它（样式/全局变量与 Studio 隔离）
 *   2. 把它对 /stats 的请求转成插件 RPC
 *   3. 下发动效开关与帧率设置
 */

function pageWithTitle(html, title) {
  const clean = String(title || '').trim()
  if (!clean) return html
  const safe = clean.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]))
  return html.replace(/<h1>[^<]*<\/h1>/, '<h1>' + safe + '</h1>')
}

export async function mount(root, ctx) {
  if (ctx.view === 'settings') return mountSettings(root, ctx)

  // 宿主侧 RPC 没有超时：通道没建立或请求挂住时，await 会永远不返回，
  // 面板就停在空白。这里最多等 3 秒，拿不到就先按默认设置渲染。
  const DEFAULTS = { anim: true, compat: false, title: '' }
  const settings = await Promise.race([
    ctx.rpc.call('get-settings').catch(() => null),
    new Promise((resolve) => setTimeout(() => resolve(null), 3000))
  ]).then((s) => (s && typeof s === 'object' ? s : DEFAULTS))
  const anim = !(settings && settings.anim === false)
  const compat = !!(settings && settings.compat)
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
        while (liveTools.length > 8) liveTools.pop()
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
        pendingSessions.set(meta.id, {
          working: messagesWorking(messages),
          at: Date.now(),
          agent: meta.agent || 'unknown'
        })
        const entries = parseToolMessages(messages, 8, Date.now())
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
        if (merged.length >= 8) break
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

    // 实时层：正在收到事件的 Agent 立即标成活跃，不依赖 session.last_active
    // （CodeBuddy 等外部 Agent 的 last_active 通常在回合结束后才更新）。
    const workingAgents = new Set()
    for (const slot of live.values()) {
      if (slot.working && slot.ts && Date.now() - slot.ts > 10 * 60 * 1000) slot.working = false
      if (slot.working) workingAgents.add(slot.agent)
    }
    for (const rec of pendingSessions.values()) {
      if (rec.working && Date.now() - rec.at < 5 * 60 * 1000) workingAgents.add(rec.agent)
    }
    if (workingAgents.size && Array.isArray(ai.agents)) {
      ai.agents = ai.agents.map((item) => workingAgents.has(item.agent)
        ? Object.assign({}, item, { active: true, running: 1, activeSessions: item.sessions })
        : item)
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
          applyLive(data)
          const liveList = []
          const liveSeen = new Set()
          for (const meta of (data.activeSessions || []).concat(data.recentSessions || [])) {
            if (!meta || !meta.id || liveSeen.has(meta.id)) continue
            liveSeen.add(meta.id)
            liveList.push(meta)
          }
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
    el.textContent = code
    root.appendChild(el)
  }

  if (typeof window.__hlApplySettings === 'function') {
    window.__hlApplySettings({ anim, compat })
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
    .hls select { font:inherit; padding:3px 8px; border-radius:6px; background:rgba(255,255,255,.06);
      color:inherit; border:1px solid rgba(255,255,255,.2); }
    .hls button { font:inherit; padding:5px 12px; border-radius:6px; border:1px solid rgba(255,255,255,.2);
      background:rgba(255,255,255,.06); color:inherit; cursor:pointer; }
    .hls .muted { color:var(--text-secondary,#9aa0aa); }
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
    <label><input type="checkbox" id="hls-anim"> 显示原版动效舞台（iframe 模式，默认开启）</label>
    <label><input type="checkbox" id="hls-compat"> 兼容模式（DPR=1，关闭 will-change 与 CSS 动画）</label>
    <div><button id="hls-save">保存</button> <span class="muted" id="hls-msg"></span></div>
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
  const animBox = wrap.querySelector('#hls-anim')
  const compatBox = wrap.querySelector('#hls-compat')
  const titleInput = wrap.querySelector('#hls-title')
  const msg = wrap.querySelector('#hls-msg')
  ctx.rpc.call('get-settings').then((s) => {
    animBox.checked = !(s && s.anim === false)
    compatBox.checked = !!(s && s.compat)
    titleInput.value = (s && s.title) || ''
  }).catch(() => { animBox.checked = true })
  wrap.querySelector('#hls-save').onclick = async () => {
    try {
      await ctx.rpc.call('save-settings', {
        anim: !!animBox.checked,
        compat: !!compatBox.checked,
        title: titleInput.value.trim()
      })
      msg.textContent = '已保存，重新打开看板生效'
    } catch (error) {
      msg.textContent = '保存失败：' + (error.message || error)
    }
  }
}
