/**
 * HALOFLUX AI LINK · Studio 插件宿主
 * 页面本身是 docker 版原页面（index.html + wp.js + ai-link.js）的单文件副本，
 * 这里只负责：
 *   1. 用 srcdoc 子 iframe 承载它（样式/全局变量与 Studio 隔离）
 *   2. 把它对 /stats 的请求转成插件 RPC
 *   3. 下发动效开关与帧率设置
 */

export async function mount(root, ctx) {
  if (ctx.view === 'settings') return mountSettings(root, ctx)

  const settings = await ctx.rpc.call('get-settings').catch(() => ({ anim: true, fps: 30 }))
  const anim = !(settings && settings.anim === false)
  const fps = settings && settings.fps === 60 ? 60 : 30

  const style = document.createElement('style')
  style.textContent = `
    .hl-root { position:relative; height:100%; overflow:hidden; background:#05070a; }
    .hl-frame { position:absolute; inset:0; width:100%; height:100%; border:0; background:#05070a; }

  `
  root.append(style)
  root.classList.add('hl-root')

  const frame = document.createElement('iframe')
  frame.className = 'hl-frame'
  frame.setAttribute('title', 'HALOFLUX AI LINK')
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin')
  frame.srcdoc = PAGE_HTML
  root.append(frame)

  function post(message) {
    try { frame.contentWindow.postMessage(message, '*') } catch (_) { /* ignore */ }
  }

  function pushSettings() {
    post({ __hl: 'settings', value: { anim, fps } })
  }

  async function onMessage(event) {
    if (event.source && event.source !== frame.contentWindow) return
    const message = event.data || {}
    if (message.__hl === 'ready') {
      pushSettings()
      return
    }
    if (message.__hl === 'stats-request') {
      let data = null
      try { data = await ctx.rpc.call('stats') } catch (_) { data = null }
      post({ __hl: 'stats-result', id: message.id, data })
    }
  }

  window.addEventListener('message', onMessage)
  ctx.lifecycle.add(() => {
    window.removeEventListener('message', onMessage)
    frame.remove()
    style.remove()
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
    <label><input type="checkbox" id="hls-anim"> 显示原版动效舞台</label>
    <label>舞台帧率
      <select id="hls-fps">
        <option value="30">30 FPS（省电）</option>
        <option value="60">60 FPS（更顺滑）</option>
      </select>
    </label>
    <div><button id="hls-save">保存</button> <span class="muted" id="hls-msg"></span></div>
    <div class="muted">页面与动效来自 HALOFLUX 原作；数据来自 Studio 会话/用量接口与本机指标。插件只读，不读取数据库文件，不发外部网络请求。</div>
    <table>
      <tr><td>插件</td><td>haloflux-ai-link 0.4.0</td></tr>
      <tr><td>原作</td><td>Ryder191（HALOFLUX）</td></tr>
      <tr><td>二次开发</td><td>andychao2024</td></tr>
      <tr><td>许可</td><td>PolyForm Noncommercial 1.0.0</td></tr>
    </table>
  `
  root.append(wrap)
  const animBox = wrap.querySelector('#hls-anim')
  const fpsSel = wrap.querySelector('#hls-fps')
  const msg = wrap.querySelector('#hls-msg')
  ctx.rpc.call('get-settings').then((s) => {
    animBox.checked = !(s && s.anim === false)
    fpsSel.value = s && s.fps === 60 ? '60' : '30'
  }).catch(() => { animBox.checked = true; fpsSel.value = '30' })
  wrap.querySelector('#hls-save').onclick = async () => {
    try {
      await ctx.rpc.call('save-settings', {
        anim: !!animBox.checked,
        fps: fpsSel.value === '60' ? 60 : 30
      })
      msg.textContent = '已保存，重新打开看板生效'
    } catch (error) {
      msg.textContent = '保存失败：' + (error.message || error)
    }
  }
}
