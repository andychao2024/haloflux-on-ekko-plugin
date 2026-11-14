/**
 * HALOFLUX AI LINK · Studio 看板
 * @param {HTMLElement} root
 * @param {import('@ekko-studio/plugin-sdk').ClientContext} ctx
 */

const CHIP_SLOTS = 5
const MIN_CHIPS = 3
const CHIP_ROT_MS = 6000

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]))
}

function fmtInt(n) {
  if (typeof n !== 'number' || !isFinite(n)) return '—'
  try { return Math.round(n).toLocaleString('en-US') } catch (_) { return String(Math.round(n)) }
}

function fmtCompact(n) {
  if (typeof n !== 'number' || !isFinite(n)) return '—'
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'
  if (n >= 1e4) return (n / 1e3).toFixed(1) + 'k'
  return fmtInt(n)
}

function fmtPct(n) {
  if (typeof n !== 'number' || !isFinite(n)) return '—'
  const r = Math.round(n * 10) / 10
  return (r % 1 === 0 ? String(r) : r.toFixed(1)) + '%'
}

function fmtRate(n) {
  if (typeof n !== 'number' || !isFinite(n)) return '—'
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k'
  return (n < 10 ? n.toFixed(2) : n.toFixed(1))
}

function fmtBps(n) {
  if (typeof n !== 'number' || !isFinite(n)) return '—'
  if (n >= 1048576) return (n / 1048576).toFixed(2) + ' MB/s'
  if (n >= 1024) return (n / 1024).toFixed(1) + ' kB/s'
  return Math.round(n) + ' B/s'
}

function fmtAge(sec) {
  if (typeof sec !== 'number' || !isFinite(sec)) return '—'
  if (sec < 60) return sec + ' 秒前'
  if (sec < 3600) return Math.round(sec / 60) + ' 分钟前'
  if (sec < 86400) return Math.round(sec / 3600) + ' 小时前'
  return Math.round(sec / 86400) + ' 天前'
}

function fmtUptime(sec) {
  if (typeof sec !== 'number' || !isFinite(sec)) return '—'
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  return (h ? h + ':' : '') + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0')
}

function fmtClock(ts) {
  try {
    const d = new Date(ts)
    return d.toTimeString().slice(0, 8)
  } catch (_) { return '—' }
}

function compactAgent(name) {
  const s = String(name || '—')
  if (s.length <= 8) return s.toUpperCase()
  return s.slice(0, 7).toUpperCase() + '…'
}

function chipBase(active, all) {
  if (active.length >= MIN_CHIPS) return active.slice()
  const extra = []
  for (const item of all) if (item && active.indexOf(item) < 0) extra.push(item)
  extra.sort((a, b) => (b.ts || 0) - (a.ts || 0))
  return active.concat(extra.slice(0, MIN_CHIPS - active.length))
}

function chipWindow(state, key, items, slots) {
  slots = slots || CHIP_SLOTS
  if (items.length <= slots) {
    state[key + 'RotAt'] = 0
    state[key + 'Rot'] = 0
    return items.slice()
  }
  const now = Date.now()
  const atKey = key + 'RotAt'
  if (!state[atKey]) state[atKey] = now
  else if (now - state[atKey] >= CHIP_ROT_MS) {
    state[atKey] = now
    state[key + 'Rot'] = (state[key + 'Rot'] || 0) + 1
  }
  const keep = slots - 1
  const rest = items.slice(keep)
  const pick = rest[(state[key + 'Rot'] || 0) % rest.length]
  return items.slice(0, keep).concat(pick ? [pick] : [])
}

export async function mount(root, ctx) {
  if (ctx.view === 'settings') return mountSettings(root, ctx)

  const settings = await ctx.rpc.call('get-settings').catch(() => ({ compact: false }))
  const compact = !!(settings && settings.compact)

  const style = document.createElement('style')
  style.textContent = `
    .hl { --hl-cyan:#98e0cf; --hl-pink:#f0a6c6; --hl-purple:#c9a7ff; --hl-dim:#8b9099;
          --hl-line:rgba(152,224,207,.18); --hl-bg:rgba(8,11,12,.92); --hl-panel:rgba(12,16,18,.86);
          font:11px/1.45 ui-monospace,"Cascadia Mono","SF Mono",Consolas,monospace;
          color:var(--text-primary,#e8eaf0); padding:14px; display:flex; flex-direction:column; gap:10px;
          height:100%; box-sizing:border-box; overflow:auto; }
    .hl * { box-sizing:border-box; }
    .hl .hl-head { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
    .hl .hl-title { font-size:14px; letter-spacing:1px; font-weight:700; color:var(--hl-cyan); }
    .hl .hl-dot { width:6px; height:6px; border-radius:50%; background:var(--hl-cyan); box-shadow:0 0 6px var(--hl-cyan); }
    .hl.off .hl-dot { background:var(--hl-pink); box-shadow:0 0 6px var(--hl-pink); }
    .hl .hl-muted { color:var(--hl-dim); }
    .hl .hl-hud { display:grid; grid-template-columns:repeat(auto-fit,minmax(110px,1fr)); gap:8px;
          padding:9px 10px; border:1px solid var(--hl-line); background:var(--hl-bg); border-radius:8px; }
    .hl .hl-cell { min-width:0; }
    .hl .hl-cell b { display:block; font-size:13px; font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .hl .hl-cell span { color:var(--hl-dim); font-size:9px; letter-spacing:.8px; }
    .hl .hl-kpis { display:grid; grid-template-columns:repeat(5,1fr); gap:8px; }
    .hl .hl-kpi { border:1px solid var(--hl-line); background:var(--hl-bg); border-radius:8px; padding:7px 9px; }
    .hl .hl-kpi b { display:block; font-size:16px; }
    .hl .hl-kpi span { color:var(--hl-dim); font-size:9px; letter-spacing:1px; }
    .hl .hl-grid { flex:1; min-height:0; display:grid; grid-template-columns:repeat(4,1fr); grid-template-rows:repeat(2,minmax(0,1fr)); gap:10px; }
    .hl .hl-panel { border:1px solid var(--hl-line); background:var(--hl-panel); border-radius:8px;
          padding:8px 10px; min-height:${compact ? 150 : 178}px; display:flex; flex-direction:column; gap:6px; min-width:0; }
    .hl .hl-panel h3 { margin:0; font-size:10.5px; letter-spacing:1.2px; color:var(--hl-cyan); display:flex; align-items:center; gap:6px; white-space:nowrap; }
    .hl .hl-panel h3 .hl-chips { margin-left:auto; display:flex; gap:4px; overflow:hidden; }
    .hl .hl-chip { display:inline-flex; align-items:center; gap:4px; padding:0 5px; border:1px solid rgba(255,255,255,.14);
          border-radius:99px; font-size:8.5px; color:var(--hl-dim); cursor:pointer; white-space:nowrap; }
    .hl .hl-chip i { width:4px; height:4px; border-radius:50%; background:#484c55; }
    .hl .hl-chip.on { color:#dff6ef; border-color:var(--hl-cyan); background:rgba(152,224,207,.08); }
    .hl .hl-chip.live i { background:var(--hl-cyan); box-shadow:0 0 4px var(--hl-cyan); }
    .hl .hl-chip.off { opacity:.5; }
    .hl .hl-body { flex:1; min-height:0; overflow:hidden; color:#cfd3db; }
    .hl .hl-body.scroll { overflow:auto; }
    .hl .hl-pre { white-space:pre-wrap; word-break:break-word; }
    .hl .hl-row { display:flex; gap:6px; align-items:baseline; }
    .hl .hl-row .t { color:var(--hl-dim); flex:0 0 auto; }
    .hl .hl-line { display:flex; gap:6px; align-items:center; padding:1px 0; }
    .hl .hl-line .k { flex:0 0 auto; color:var(--hl-dim); }
    .hl .hl-line .v { margin-left:auto; font-variant-numeric:tabular-nums; }
    .hl .hl-bar { flex:1; height:3px; background:rgba(255,255,255,.08); position:relative; overflow:hidden; border-radius:2px; }
    .hl .hl-bar i { position:absolute; inset:0 auto 0 0; width:0; background:var(--hl-cyan); transition:width .35s ease; }
    .hl .hl-bar.pink i { background:var(--hl-pink); }
    .hl .hl-cores { display:flex; gap:2px; align-items:flex-end; height:18px; }
    .hl .hl-cores i { flex:1; background:#c9a94a; opacity:.55; min-height:1px; }
    .hl .hl-cores i.hot { background:#ffd75e; opacity:.95; }
    .hl .hl-steps { display:flex; flex-direction:column; gap:2px; }
    .hl .hl-step { display:flex; gap:6px; font-size:10.5px; }
    .hl .hl-step .ok { color:var(--hl-cyan); }
    .hl .hl-step .run { color:var(--hl-purple); }
    .hl .hl-step .todo { color:var(--hl-dim); }
    .hl .hl-tool { display:flex; gap:6px; font-size:10px; padding:1px 0; }
    .hl .hl-tool .n { color:var(--hl-cyan); flex:0 0 auto; }
    .hl .hl-tool .a { color:var(--hl-dim); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .hl .hl-tool .s { margin-left:auto; flex:0 0 auto; color:var(--hl-dim); }
    .hl .hl-agent { display:flex; gap:6px; align-items:center; padding:2px 0; }
    .hl .hl-agent .n { width:64px; flex:0 0 auto; color:var(--hl-cyan); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .hl .hl-agent .v { width:58px; flex:0 0 auto; text-align:right; color:var(--hl-dim); }
    .hl .hl-agent .on { color:var(--hl-pink); }
    .hl .hl-spark { width:100%; height:52px; display:block; }
    .hl .hl-err { border:1px solid rgba(240,166,198,.5); color:var(--hl-pink); padding:6px 8px; border-radius:6px; display:none; }
    @media (max-width:1200px){ .hl .hl-grid{grid-template-columns:repeat(2,1fr);} }
    @media (max-width:700px){ .hl .hl-grid{grid-template-columns:1fr;} .hl .hl-kpis{grid-template-columns:repeat(2,1fr);} }
  `
  root.append(style)

  const wrap = document.createElement('div')
  wrap.className = 'hl'
  wrap.innerHTML = `
    <div class="hl-head">
      <span class="hl-dot"></span><span class="hl-title">HALOFLUX AI LINK</span>
      <span class="hl-muted" id="hl-state">连接中…</span>
      <span class="hl-muted" id="hl-ver"></span>
    </div>
    <div class="hl-err" id="hl-err"></div>
    <div class="hl-hud" id="hl-hud"></div>
    <div class="hl-kpis" id="hl-kpis"></div>
    <div class="hl-grid">
      <div class="hl-panel"><h3>AI 事件流</h3><div class="hl-body scroll"><div class="hl-pre" id="hl-events">—</div></div></div>
      <div class="hl-panel"><h3>令牌吞吐</h3><div class="hl-body"><canvas class="hl-spark" id="hl-spark"></canvas><div id="hl-rate" class="hl-muted">—</div></div></div>
      <div class="hl-panel"><h3>思考过程 <span class="hl-chips" id="hl-stream-chips"></span></h3><div class="hl-body"><div class="hl-pre" id="hl-think">等待 Agent 输出…</div></div></div>
      <div class="hl-panel"><h3>CPU / 磁盘 IO</h3><div class="hl-body scroll" id="hl-sys"></div></div>
      <div class="hl-panel"><h3>任务计划 <span class="hl-chips" id="hl-plan-chips"></span></h3><div class="hl-body scroll" id="hl-plan"></div></div>
      <div class="hl-panel"><h3>工具调用 <span class="hl-muted" id="hl-tool-count"></span></h3><div class="hl-body scroll" id="hl-tools"></div></div>
      <div class="hl-panel"><h3>代理调度</h3><div class="hl-body scroll" id="hl-agents"></div></div>
      <div class="hl-panel"><h3>系统负载索引</h3><div class="hl-body" id="hl-index"></div></div>
    </div>
  `
  root.append(wrap)

  const $ = (id) => wrap.querySelector('#' + id)
  const spark = $('hl-spark')
  const sparkCtx = spark.getContext ? spark.getContext('2d') : null
  const rateHist = []
  const state = { streamPinned: null, planPinned: null, sig: '', planSig: '' }

  function setLine(el, title, value, pct, pink) {
    const row = document.createElement('div')
    row.className = 'hl-line'
    row.innerHTML = `<span class="k">${esc(title)}</span>
      <span class="hl-bar${pink ? ' pink' : ''}"><i style="width:${Math.max(0, Math.min(100, pct || 0))}%"></i></span>
      <span class="v">${esc(value)}</span>`
    el.append(row)
  }

  function renderHud(snap) {
    const ai = snap.usage || {}
    const today = ai.today || {}
    const rate = snap.rate || {}
    const host = snap.host || {}
    const agents = snap.agents || []
    const top = agents[0] || {}
    const model = (agents.find((a) => a.model) || {}).model || '—'
    const disk = host.disk
    const diskTxt = disk
      ? `↓${fmtRate(disk.readMBps)}/↑${fmtRate(disk.writeMBps)} MB/s`
      : '不可用'
    const cells = [
      ['模型', model],
      ['今日用量', fmtCompact(today.tokens || 0)],
      ['速率', fmtRate(rate.tokensPerSec) + ' tok/s'],
      ['命中率', fmtPct(rate.cacheHit || 0)],
      ['CPU', fmtPct(host.cpu)],
      ['硬盘', diskTxt],
      ['会话', `${snap.sessions.active}/${snap.sessions.total}`],
      ['连接', `${snap.server ? snap.server.connections : 0} 会话`]
    ]
    $('hl-hud').innerHTML = cells.map(([k, v]) =>
      `<div class="hl-cell"><span>${esc(k)}</span><b title="${esc(v)}">${esc(v)}</b></div>`).join('')
    $('hl-kpis').innerHTML = [
      ['今日令牌', fmtCompact(today.tokens || 0)],
      ['活跃代理', String(agents.filter((a) => a.active).length)],
      ['任务计划', String((snap.taskPlan && snap.taskPlan.plans || []).filter((p) => p.state === 'running').length)],
      ['近期工具', String((snap.tools || []).length)],
      ['消息数', fmtCompact((ai.totals || {}).sessions ? agents.reduce((n, a) => n + (a.messages || 0), 0) : agents.reduce((n, a) => n + (a.messages || 0), 0))]
    ].map(([k, v]) => `<div class="hl-kpi"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')
  }

  function renderEvents(snap) {
    const list = snap.events || []
    $('hl-events').innerHTML = list.length
      ? list.slice(0, 18).map((e) =>
        `<div class="hl-row"><span class="t">${fmtClock(e.at)}</span><span>${esc(e.type)}</span><span class="hl-muted">${esc(e.text)}</span></div>`).join('')
      : '<span class="hl-muted">等待事件…</span>'
  }

  function renderRate(snap) {
    const rate = snap.rate || {}
    const tps = rate.tokensPerSec || 0
    rateHist.push(tps)
    while (rateHist.length > 60) rateHist.shift()
    $('hl-rate').textContent = `现在 ${fmtRate(tps)} tok/s · 输出 ${fmtRate(rate.outputPerSec)} tok/s · 峰值 ${fmtRate(Math.max(...rateHist, 0))}`
    if (!sparkCtx) return
    const dpr = window.devicePixelRatio || 1
    const w = spark.clientWidth || 240
    const h = spark.clientHeight || 52
    if (spark.width !== Math.round(w * dpr) || spark.height !== Math.round(h * dpr)) {
      spark.width = Math.round(w * dpr)
      spark.height = Math.round(h * dpr)
    }
    const g = sparkCtx
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, w, h)
    const max = Math.max(1, ...rateHist)
    g.beginPath()
    g.strokeStyle = '#98e0cf'
    g.lineWidth = 1.4
    rateHist.forEach((v, i) => {
      const x = (i / Math.max(1, rateHist.length - 1)) * w
      const y = h - 3 - (v / max) * (h - 8)
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y)
    })
    g.stroke()
  }

  function renderStreams(snap) {
    const list = Array.isArray(snap.streams) ? snap.streams : []
    const active = list.filter((s) => s.working || s.state === 'live' || s.state === 'active')
    const base = chipBase(active, list)
    let pinned = null
    if (state.streamPinned) {
      pinned = base.find((s) => s.agent === state.streamPinned) || null
      if (!pinned) state.streamPinned = null
    }
    let view
    if (pinned) {
      const others = base.filter((s) => s !== pinned)
      view = [pinned].concat(chipWindow(state, 'stm', others, CHIP_SLOTS - 1))
    } else {
      view = chipWindow(state, 'stm', base)
    }
    const focus = pinned || active[0] || base[0] || null
    const sig = view.map((s) => s.agent + ':' + s.state + ':' + (s.working ? 1 : 0)).join(',') + '|' + (focus ? focus.agent : '')
    if (sig !== state.sig) {
      state.sig = sig
      const chips = $('hl-stream-chips')
      chips.innerHTML = view.length ? view.map((s) => {
        const label = s.agent === focus || view.length <= 4 ? String(s.agent).toUpperCase() : compactAgent(s.agent)
        return `<span class="hl-chip${s === focus ? ' on' : ''}${s.state === 'live' || s.working ? ' live' : ''}" data-agent="${esc(s.agent)}" title="${esc(s.agent + ' · ' + s.state)}"><i></i>${esc(label)}</span>`
      }).join('') : '<span class="hl-muted">暂无数据</span>'
      for (const chip of chips.querySelectorAll('.hl-chip[data-agent]')) {
        chip.onclick = () => {
          const name = chip.getAttribute('data-agent')
          state.streamPinned = state.streamPinned === name ? null : name
          state.sig = ''
          renderStreams(snap)
        }
      }
    }
    const think = $('hl-think')
    if (!focus) {
      think.innerHTML = '<span class="hl-muted">等待 Agent 输出…</span>'
    } else {
      const meta = `${String(focus.agent).toUpperCase()} · ${focus.state}${focus.workSec ? ' · ' + focus.workSec + 's' : ''}${focus.ageSec != null ? ' · ' + fmtAge(focus.ageSec) : ''}`
      const text = focus.text || '（暂无文本，正在生成…）'
      think.innerHTML = `<div class="hl-line"><span class="k">${esc(meta)}</span></div><div class="hl-pre">${esc(text.slice(-1200))}</div>`
    }
  }

  function renderPlan(snap) {
    const tp = snap.taskPlan || {}
    const plans = Array.isArray(tp.plans) ? tp.plans : []
    const active = plans.filter((p) => p.sessionActive)
    const base = chipBase(active, plans)
    let pinned = null
    if (state.planPinned) {
      pinned = base.find((p) => p.agent === state.planPinned) || null
      if (!pinned) state.planPinned = null
    }
    const view = pinned
      ? [pinned].concat(chipWindow(state, 'pln', base.filter((p) => p !== pinned), CHIP_SLOTS - 1))
      : chipWindow(state, 'pln', base)
    const focus = pinned || active[0] || base[0] || null
    const sig = view.map((p) => p.agent + ':' + p.state + ':' + p.done + '/' + p.total).join(',') + '|' + (focus ? focus.agent : '')
    if (sig !== state.planSig) {
      state.planSig = sig
      const chips = $('hl-plan-chips')
      chips.innerHTML = view.length ? view.map((p) =>
        `<span class="hl-chip${p === focus ? ' on' : ''}${p.state === 'running' ? ' live' : ''}${p.state !== 'running' ? ' off' : ''}" data-agent="${esc(p.agent)}" title="${esc(p.agent + ' · ' + p.done + '/' + p.total)}"><i></i>${esc(String(p.agent).toUpperCase())}</span>`).join('')
        : ''
      for (const chip of chips.querySelectorAll('.hl-chip[data-agent]')) {
        chip.onclick = () => {
          const name = chip.getAttribute('data-agent')
          state.planPinned = state.planPinned === name ? null : name
          state.planSig = ''
          renderPlan(snap)
        }
      }
    }
    const body = $('hl-plan')
    if (!focus) {
      body.innerHTML = '<span class="hl-muted">暂无任务计划</span>'
      return
    }
    const head = `<div class="hl-line"><span class="k">${esc(focus.done + '/' + focus.total)}</span><span class="v">${esc(focus.state)}</span></div>`
    body.innerHTML = head + '<div class="hl-steps">' + (focus.steps || []).map((s) => {
      const cls = s.status === 'completed' ? 'ok' : s.status === 'in_progress' ? 'run' : 'todo'
      const mark = s.status === 'completed' ? '✓' : s.status === 'in_progress' ? '▶' : '○'
      return `<div class="hl-step"><span class="${cls}">${mark}</span><span>${esc(s.step)}</span></div>`
    }).join('') + '</div>'
  }

  function renderTools(snap) {
    const list = snap.tools || []
    $('hl-tool-count').textContent = list.length ? `${list.length} 条` : ''
    $('hl-tools').innerHTML = list.length ? list.map((t) =>
      `<div class="hl-tool"><span class="n">${esc(t.name)}</span><span class="a">${esc(t.arg)}</span><span class="s">${fmtClock(t.at)}</span></div>`).join('')
      : '<span class="hl-muted">暂无工具调用</span>'
  }

  function renderAgents(snap) {
    const list = snap.agents || []
    const max = Math.max(1, ...list.map((a) => a.tokens || 0))
    $('hl-agents').innerHTML = list.length ? list.map((a) =>
      `<div class="hl-agent"><span class="n" title="${esc(a.agent)}">${esc(a.agent)}</span>
        <span class="hl-bar"><i style="width:${Math.round((a.tokens || 0) / max * 100)}%"></i></span>
        <span class="v${a.active ? ' on' : ''}">${a.active ? '运行' : fmtCompact(a.tokens)}</span></div>`).join('')
      : '<span class="hl-muted">暂无 Agent</span>'
  }

  function renderSystem(snap) {
    const host = snap.host || {}
    const disk = host.disk
    const net = host.net
    const box = $('hl-sys')
    box.innerHTML = ''
    setLine(box, 'CPU', fmtPct(host.cpu), host.cpu, host.cpu >= 85)
    const cores = host.cpuCores || []
    if (cores.length) {
      const div = document.createElement('div')
      div.className = 'hl-cores'
      div.innerHTML = cores.slice(0, 32).map((v) => `<i style="height:${Math.max(2, Math.round(v / 100 * 18))}px" class="${v >= 80 ? 'hot' : ''}"></i>`).join('')
      box.append(div)
    }
    setLine(box, '硬盘忙', disk ? fmtPct(disk.utilization) : '—', disk ? disk.utilization : 0, disk && disk.utilization >= 85)
    setLine(box, '读/写', disk ? `${fmtRate(disk.readMBps)}/${fmtRate(disk.writeMBps)} MB/s` : '—', disk ? Math.min(100, (disk.readMBps + disk.writeMBps) * 4) : 0)
    setLine(box, '内存', fmtPct(host.ram), host.ram, host.ram >= 85)
    setLine(box, '网络', net ? `${fmtBps((net.rxPerSec || 0) + (net.txPerSec || 0))}` : '—', net ? Math.min(100, ((net.rxPerSec || 0) + (net.txPerSec || 0)) / 104857.6) : 0)

    const idx = $('hl-index')
    idx.innerHTML = ''
    setLine(idx, 'CPU', fmtPct(host.cpu), host.cpu, host.cpu >= 85)
    setLine(idx, '磁盘', disk ? fmtPct(disk.utilization) : '—', disk ? disk.utilization : 0, disk && disk.utilization >= 85)
    setLine(idx, '内存', fmtPct(host.ram), host.ram, host.ram >= 85)
    setLine(idx, '网络', net ? fmtBps((net.rxPerSec || 0) + (net.txPerSec || 0)) : '—', net ? Math.min(100, ((net.rxPerSec || 0) + (net.txPerSec || 0)) / 104857.6) : 0)
    setLine(idx, '会话', `${snap.sessions.active}/${snap.sessions.total}`, snap.sessions.total ? Math.round(snap.sessions.active / snap.sessions.total * 100) : 0)
    setLine(idx, '运行', fmtUptime(host.uptimeSec), 0)
  }

  let timer = null
  let busy = false

  async function tick() {
    if (busy || document.visibilityState === 'hidden') return
    busy = true
    try {
      const snap = await ctx.rpc.call('snapshot')
      wrap.classList.remove('off')
      $('hl-err').style.display = 'none'
      $('hl-state').textContent = '在线'
      if (snap.server) $('hl-ver').textContent = `v${snap.server.version}`
      renderHud(snap)
      renderEvents(snap)
      renderRate(snap)
      renderStreams(snap)
      renderPlan(snap)
      renderTools(snap)
      renderAgents(snap)
      renderSystem(snap)
    } catch (error) {
      wrap.classList.add('off')
      $('hl-state').textContent = '离线'
      const err = $('hl-err')
      err.style.display = 'block'
      err.textContent = '快照读取失败：' + (error && error.message ? error.message : String(error))
    } finally {
      busy = false
    }
  }

  await tick()
  timer = setInterval(tick, 1000)
  const onVis = () => { if (document.visibilityState === 'visible') tick() }
  document.addEventListener('visibilitychange', onVis)
  ctx.lifecycle.add(() => {
    if (timer) clearInterval(timer)
    document.removeEventListener('visibilitychange', onVis)
  })
}

function mountSettings(root, ctx) {
  const style = document.createElement('style')
  style.textContent = `
    .hls { font:12px/1.6 ui-monospace,Consolas,monospace; padding:20px; max-width:720px; display:flex; flex-direction:column; gap:14px; }
    .hls label { display:flex; gap:10px; align-items:center; }
    .hls button { font:inherit; padding:5px 12px; border-radius:6px; border:1px solid rgba(255,255,255,.2); background:rgba(255,255,255,.06); color:inherit; cursor:pointer; }
    .hls .muted { color:var(--text-secondary,#9aa0aa); }
    .hls table { border-collapse:collapse; } .hls td { padding:2px 10px 2px 0; vertical-align:top; }
  `
  root.append(style)
  const wrap = document.createElement('div')
  wrap.className = 'hls'
  wrap.innerHTML = `
    <h2>HALOFLUX AI LINK · 设置</h2>
    <label><input type="checkbox" id="hls-compact"> 紧凑布局（面板更矮）</label>
    <div><button id="hls-save">保存</button> <span class="muted" id="hls-msg"></span></div>
    <div class="muted">数据来源：Studio 会话与用量接口、当前账号可访问的 Profile、本机系统指标。插件只读，不读取数据库文件，不发外部网络请求。</div>
    <table>
      <tr><td>插件</td><td>haloflux-ai-link 0.2.0</td></tr>
      <tr><td>原作</td><td>Ryder191（HALOFLUX）</td></tr>
      <tr><td>二次开发</td><td>andychao2024</td></tr>
      <tr><td>许可</td><td>PolyForm Noncommercial 1.0.0</td></tr>
    </table>
  `
  root.append(wrap)
  const box = wrap.querySelector('#hls-compact')
  const msg = wrap.querySelector('#hls-msg')
  ctx.rpc.call('get-settings').then((s) => { box.checked = !!(s && s.compact) }).catch(() => {})
  wrap.querySelector('#hls-save').onclick = async () => {
    try {
      await ctx.rpc.call('save-settings', { compact: !!box.checked })
      msg.textContent = '已保存，重新打开看板生效'
    } catch (error) {
      msg.textContent = '保存失败：' + (error.message || error)
    }
  }
}
