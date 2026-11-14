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

  const settings = await ctx.rpc.call('get-settings').catch(() => ({ anim: true, fps: 30, display: 'iframe', url: '' }))
  const anim = !(settings && settings.anim === false)
  const fps = settings && settings.fps === 60 ? 60 : 30
  const display = settings && settings.display === 'link' ? 'link' : 'iframe'
  const url = (settings && typeof settings.url === 'string') ? settings.url.trim() : ''
  const compat = !!(settings && settings.compat)

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
      <div>当前设置为「打开新链接」。</div>
      ${url ? `<code>${url.replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}</code>
      <button id="hl-open">打开看板</button>` : '<div>还没有填写地址，请在「设置」里配置。</div>'}
      <div style="color:#6f747c;font-size:11px">新链接会在浏览器新标签页打开，不在 Studio 内。</div>`
    root.append(box)
    const btn = box.querySelector('#hl-open')
    if (btn) btn.onclick = () => { window.open(url, '_blank', 'noopener,noreferrer') }
    ctx.lifecycle.add(() => { box.remove(); root.classList.remove('hl-root') })
    return
  }

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
    post({ __hl: 'settings', value: { anim, fps, compat } })
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
    <label>显示方式
      <select id="hls-display">
        <option value="iframe">iframe 内嵌（Studio 内直接显示）</option>
        <option value="link">打开新链接（浏览器新标签页）</option>
      </select>
    </label>
    <label>新链接地址
      <input id="hls-url" type="text" placeholder="https://.../?k=..." style="flex:1;min-width:320px;padding:4px 8px;border-radius:6px;background:rgba(255,255,255,.06);color:inherit;border:1px solid rgba(255,255,255,.2)">
    </label>
    <label><input type="checkbox" id="hls-anim"> 显示原版动效舞台（iframe 模式）</label>
    <label><input type="checkbox" id="hls-compat"> 兼容模式（Big Sur / 旧显卡：DPR=1，关闭 will-change）</label>
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
  const displaySel = wrap.querySelector('#hls-display')
  const urlInput = wrap.querySelector('#hls-url')
  const compatBox = wrap.querySelector('#hls-compat')
  const msg = wrap.querySelector('#hls-msg')
  ctx.rpc.call('get-settings').then((s) => {
    animBox.checked = !(s && s.anim === false)
    fpsSel.value = s && s.fps === 60 ? '60' : '30'
    displaySel.value = s && s.display === 'link' ? 'link' : 'iframe'
    urlInput.value = (s && s.url) || ''
    compatBox.checked = !!(s && s.compat)
  }).catch(() => { animBox.checked = true; fpsSel.value = '30'; displaySel.value = 'iframe' })
  wrap.querySelector('#hls-save').onclick = async () => {
    try {
      await ctx.rpc.call('save-settings', {
        anim: !!animBox.checked,
        fps: fpsSel.value === '60' ? 60 : 30,
        display: displaySel.value === 'link' ? 'link' : 'iframe',
        url: urlInput.value.trim(),
        compat: !!compatBox.checked
      })
      msg.textContent = '已保存，重新打开看板生效'
    } catch (error) {
      msg.textContent = '保存失败：' + (error.message || error)
    }
  }
}
