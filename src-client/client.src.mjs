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
  const display = settings && settings.display === 'link' ? 'link' : 'iframe'
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
      const html = PAGE_HTML.replace('<head>', '<head>' + bridgeScript)
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
  const parsed = new DOMParser().parseFromString(PAGE_HTML, 'text/html')
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

  let statsBusy = false
  window.__hlBridge = {
    stats: async () => {
      if (statsBusy) return window.__hlBridge.last || null
      statsBusy = true
      try {
        const data = await ctx.rpc.call('stats')
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
    <label>显示方式
      <select id="hls-display">
        <option value="iframe">iframe 内嵌（Studio 内直接显示）</option>
        <option value="link">新链接模式（新标签页打开插件看板）</option>
      </select>
    </label>
    <label><input type="checkbox" id="hls-anim"> 显示原版动效舞台（iframe 模式）</label>
    <label><input type="checkbox" id="hls-compat"> 兼容模式（Big Sur / 旧显卡：DPR=1，关闭 will-change）</label>
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
  const msg = wrap.querySelector('#hls-msg')
  ctx.rpc.call('get-settings').then((s) => {
    animBox.checked = !(s && s.anim === false)
    displaySel.value = s && s.display === 'link' ? 'link' : 'iframe'
    compatBox.checked = !!(s && s.compat)
  }).catch(() => { animBox.checked = true; displaySel.value = 'iframe' })
  wrap.querySelector('#hls-save').onclick = async () => {
    try {
      await ctx.rpc.call('save-settings', {
        anim: !!animBox.checked,
        display: displaySel.value === 'link' ? 'link' : 'iframe',
        compat: !!compatBox.checked
      })
      msg.textContent = '已保存，重新打开看板生效'
    } catch (error) {
      msg.textContent = '保存失败：' + (error.message || error)
    }
  }
}
