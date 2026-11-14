/**
 * HALOFLUX AI LINK · Studio 插件宿主
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

  const settings = await ctx.rpc.call('get-settings').catch(() => ({ anim: true, fps: 30, display: 'iframe', url: '' }))
  const anim = !(settings && settings.anim === false)
  const display = settings && settings.display === 'link' ? 'link' : 'iframe'
  const compat = !!(settings && settings.compat)
  const title = (settings && typeof settings.title === 'string') ? settings.title.trim() : ''
  const music = !!(settings && settings.music)

  const style = document.createElement('style')
  style.textContent = `
    .hl-root { position:fixed; inset:0; height:auto; width:auto; overflow:hidden; background:#05070a; z-index:0; }
    .hl-link { position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center;
      gap:14px; padding:28px; color:#cfd3db; font:13px/1.6 ui-monospace,Consolas,monospace; text-align:center;
      background:radial-gradient(circle at 50% 30%, #10161a, #05070a 70%); }
    .hl-link b { font-size:16px; color:#98e0cf; letter-spacing:.6px; }
    .hl-link code { max-width:80%; padding:6px 10px; border-radius:6px; background:rgba(255,255,255,.07);
      color:#9aa0aa; word-break:break-all; font-size:11px; }
    .hl-link button { font:inherit; padding:7px 16px; border-radius:6px; border:1px solid rgba(152,224,207,.45);
      background:rgba(152,224,207,.1); color:#dff6ef; cursor:pointer; }
    .hl-link button:hover { background:rgba(152,224,207,.18); }
    .hl-frame { position:absolute; inset:0; width:100%; height:100%; border:0; background:#05070a; }

  `
  root.append(style)
  root.classList.add('hl-root')

  if (display === 'link') {
    const box = document.createElement('div')
    box.className = 'hl-link'
    box.innerHTML = `<b>HALOFLUX AI LINK</b>
      <div>新链接模式：在独立窗口打开看板，不受 Studio 页面重绘影响。</div>
      <button id="hl-open">在新窗口打开</button>
      <div style="color:#6f747c;font-size:11px">数据由当前 Studio 插件后端提供，不使用 docker，也不需要令牌。关闭 Studio 页面后数据会停止更新。</div>`
    root.append(box)

    const bridgeScript = `<script>(function(){
      var seq=0, pending={};
      window.addEventListener('message', function (event) {
        var m = event.data || {};
        if (m.__hl === 'stats-result' && pending[m.id]) { pending[m.id](m.data); delete pending[m.id]; }
      });
      window.__hlBridge = { stats: function () {
        return new Promise(function (resolve) {
          var id = ++seq; pending[id] = resolve;
          try { window.opener.postMessage({ __hl: 'stats-request', id: id }, '*'); } catch (e) { resolve(null); }
          setTimeout(function () { if (pending[id]) { delete pending[id]; resolve(null); } }, 4000);
        });
      } };
    })()</script>`

    const open = () => {
      const win = window.open('', '_blank')
      if (!win) { ctx.ui.notify('浏览器拦截了新窗口，请允许弹窗后重试', 'error'); return }
      const seed = '<script>window.__hlSettings=' + JSON.stringify({ music: music }) + '</script>'
      const html = pageWithTitle(PAGE_HTML, title).replace('<head>', '<head>' + seed + bridgeScript)
      win.document.open()
      win.document.write(html)
      win.document.close()
      setTimeout(() => { try { win.postMessage({ __hl: 'settings', value: { anim, compat } }, '*') } catch (_) {} }, 500)
    }
    box.querySelector('#hl-open').onclick = open

    async function onChildStats(event) {
      const message = event.data || {}
      if (message.__hl !== 'stats-request') return
      let data = null
      try { data = await ctx.rpc.call('stats') } catch (_) { data = null }
      try { event.source.postMessage({ __hl: 'stats-result', id: message.id, data }, '*') } catch (_) {}
    }
    window.addEventListener('message', onChildStats)
    ctx.lifecycle.add(() => {
      window.removeEventListener('message', onChildStats)
      box.remove()
      root.classList.remove('hl-root')
    })
    return
  }

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
  window.__hlSettings = { music: music }

  // ---- 实时会话连接：放在页面端，使用当前查看者的身份与权限 ----
  const live = new Map()          // sessionId -> { agent, profile, title, reasoning, text, ts, working, ... }
  const handles = new Map()       // sessionId -> HostSession
  const liveTools = []
  const backfillTried = new Set()
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
      const toolName = event.name || event.tool || 'tool'
      const arg = typeof event.preview === 'string' ? event.preview
        : typeof event.arguments === 'string' ? event.arguments
          : (event.arguments ? JSON.stringify(event.arguments) : '')
      slot.lastToolAt = Date.now(); slot.ts = Date.now(); slot.working = true
      if (name === 'tool.started') {
        liveToolCount += 1
        liveTools.unshift({ at: Date.now(), ageSec: 0, agent: slot.agent, name: toolName, arg: clipText(arg, 80), state: 'started' })
        while (liveTools.length > 20) liveTools.pop()
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
    for (const meta of (sessions || []).slice(0, 4)) {
      if (!meta || !meta.id || handles.has(meta.id)) continue
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

    if (liveTools.length) {
      ai.recentTools = liveTools.slice(0, 8).concat(Array.isArray(ai.recentTools) ? ai.recentTools : []).slice(0, 8)
      ai.toolCalls = Math.max(Number(ai.toolCalls) || 0, liveToolCount)
    }
    if (liveEvent) {
      ai.lastEvent = liveEvent.type
      ai.lastEventAgeSec = Math.max(0, Math.round((Date.now() - liveEvent.at) / 1000))
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
          ensureLive(data.activeSessions)
          backfill(data.activeSessions)
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

  ctx.lifecycle.add(() => {
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
    <h2>HALOFLUX AI LINK · 设置</h2>
    <label>看板标题
      <input id="hls-title" type="text" maxlength="80" placeholder="Ekko Studio / Rock5 ITX RK3588"
        style="flex:1;min-width:280px;padding:4px 8px;border-radius:6px;background:rgba(255,255,255,.06);color:inherit;border:1px solid rgba(255,255,255,.2)">
    </label>
    <label>显示方式
      <select id="hls-display">
        <option value="iframe">iframe 内嵌（Studio 内直接显示）</option>
        <option value="link">新链接模式（新标签页打开插件看板）</option>
      </select>
    </label>
    <label><input type="checkbox" id="hls-anim"> 显示原版动效舞台（iframe 模式，默认开启）</label>
    <label><input type="checkbox" id="hls-compat"> 兼容模式（DPR=1，关闭 will-change 与 CSS 动画）</label>
    <label><input type="checkbox" id="hls-music"> 启用背景音乐（首次点击页面后播放）</label>
    <div><button id="hls-save">保存</button> <span class="muted" id="hls-msg"></span></div>
    <div class="muted">页面与动效来自 HALOFLUX 原作；数据来自 Studio 会话/用量接口与本机指标。插件只读，不读取数据库文件，不发外部网络请求。</div>
    <table>
      <tr><td>插件</td><td>haloflux-ai-link ${ctx.plugin && ctx.plugin.version ? ctx.plugin.version : ''}</td></tr>
      <tr><td>原作</td><td>Ryder191（HALOFLUX）</td></tr>
      <tr><td>二次开发</td><td>andychao2024</td></tr>
      <tr><td>许可</td><td>PolyForm Noncommercial 1.0.0</td></tr>
    </table>
  `
  root.append(wrap)
  const animBox = wrap.querySelector('#hls-anim')
  const displaySel = wrap.querySelector('#hls-display')
  const compatBox = wrap.querySelector('#hls-compat')
  const titleInput = wrap.querySelector('#hls-title')
  const musicBox = wrap.querySelector('#hls-music')
  const msg = wrap.querySelector('#hls-msg')
  ctx.rpc.call('get-settings').then((s) => {
    animBox.checked = !(s && s.anim === false)
    displaySel.value = s && s.display === 'link' ? 'link' : 'iframe'
    compatBox.checked = !!(s && s.compat)
    titleInput.value = (s && s.title) || ''
    musicBox.checked = !!(s && s.music)
  }).catch(() => { animBox.checked = true; displaySel.value = 'iframe' })
  wrap.querySelector('#hls-save').onclick = async () => {
    try {
      await ctx.rpc.call('save-settings', {
        anim: !!animBox.checked,
        display: displaySel.value === 'link' ? 'link' : 'iframe',
        compat: !!compatBox.checked,
        title: titleInput.value.trim(),
        music: !!musicBox.checked
      })
      msg.textContent = '已保存，重新打开看板生效'
    } catch (error) {
      msg.textContent = '保存失败：' + (error.message || error)
    }
  }
}
