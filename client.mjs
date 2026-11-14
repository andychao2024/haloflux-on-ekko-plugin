/**
 * P0 探测页：显示业务事件覆盖情况和宿主只读接口返回的字段。
 * @param {HTMLElement} root
 * @param {import('@ekko-studio/plugin-sdk').ClientContext} ctx
 */
export async function mount(root, ctx) {
  root.innerHTML = ''

  const style = document.createElement('style')
  style.textContent = `
    .hp { font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--text-primary, #e6e8ee); padding: 16px; display: grid; gap: 12px; }
    .hp h2 { margin: 0; font-size: 14px; letter-spacing: .4px; }
    .hp .hp-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .hp button { font: inherit; padding: 4px 10px; border-radius: 6px; border: 1px solid rgba(255,255,255,.18); background: rgba(255,255,255,.06); color: inherit; cursor: pointer; }
    .hp button:hover { background: rgba(255,255,255,.12); }
    .hp .hp-muted { color: var(--text-secondary, #9aa0aa); }
    .hp pre { margin: 0; padding: 10px; border-radius: 8px; background: rgba(0,0,0,.28); border: 1px solid rgba(255,255,255,.08); overflow: auto; max-height: 46vh; white-space: pre-wrap; word-break: break-word; }
    .hp .hp-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); gap: 12px; }
    .hp .hp-card { display: grid; gap: 6px; min-width: 0; }
    .hp .hp-counts { display: flex; gap: 6px; flex-wrap: wrap; }
    .hp .hp-pill { padding: 1px 7px; border-radius: 999px; background: rgba(120,200,255,.12); border: 1px solid rgba(120,200,255,.25); }
  `
  root.append(style)

  const wrap = document.createElement('div')
  wrap.className = 'hp'
  wrap.innerHTML = `
    <div class="hp-row">
      <h2>HALOFLUX AI LINK · P0 探测</h2>
      <span class="hp-muted" id="hp-meta">加载中…</span>
      <button id="hp-refresh">立即刷新</button>
      <button id="hp-reset">清空事件</button>
    </div>
    <div class="hp-counts" id="hp-counts"></div>
    <div class="hp-grid">
      <div class="hp-card"><span class="hp-muted">宿主接口（sessions / usage / skills / tasks）</span><pre id="hp-api">—</pre></div>
      <div class="hp-card"><span class="hp-muted">最近业务事件（每条截断 160 字符）</span><pre id="hp-events">—</pre></div>
    </div>
  `
  root.append(wrap)

  const $ = (id) => wrap.querySelector('#' + id)
  const apiEl = $('hp-api')
  const evEl = $('hp-events')
  const countsEl = $('hp-counts')
  const metaEl = $('hp-meta')

  let timer = null
  let busy = false

  async function refresh() {
    if (busy) return
    busy = true
    try {
      const [api, ev] = await Promise.all([
        ctx.rpc.call('probe-api'),
        ctx.rpc.call('probe-events')
      ])
      apiEl.textContent = JSON.stringify(api, null, 2)
      evEl.textContent = JSON.stringify(ev.recent, null, 2)
      countsEl.innerHTML = ''
      const entries = Object.entries(ev.counts || {}).sort((a, b) => b[1] - a[1])
      if (!entries.length) countsEl.innerHTML = '<span class="hp-muted">尚未收到事件，运行一个 Agent 回合后再看</span>'
      for (const [type, count] of entries) {
        const pill = document.createElement('span')
        pill.className = 'hp-pill'
        pill.textContent = `${type} × ${count}`
        countsEl.append(pill)
      }
      metaEl.textContent = `事件 ${ev.total} 条 · Profile ${api.identity ? api.identity.profile : '?'} · 刷新 ${new Date().toLocaleTimeString()}`
    } catch (error) {
      metaEl.textContent = 'RPC 失败：' + (error && error.message ? error.message : String(error))
    } finally {
      busy = false
    }
  }

  $('hp-refresh').onclick = refresh
  $('hp-reset').onclick = async () => {
    try { await ctx.rpc.call('probe-reset'); await refresh() } catch (error) { ctx.ui.notify(error.message || String(error), 'error') }
  }

  await refresh()
  timer = setInterval(() => {
    if (document.visibilityState === 'visible') refresh()
  }, 3000)

  ctx.lifecycle.add(() => {
    if (timer) clearInterval(timer)
    timer = null
  })
}
