#!/usr/bin/env node
/**
 * 生成插件用的「docker 原版页面」单文件 HTML：
 *   index.html + wp.js + ai-link.js 全部内联
 *   在 ai-link.js 之前插入 fetch/postMessage 桥，把 /stats 请求转给插件 RPC
 *   追加舞台控制（帧率/暂停/参数），不改动 ai-link.js 的任何渲染逻辑
 *
 * 用法：node scripts/build-page.mjs [docker 程序目录]
 * 输出：page-html.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dir = process.argv[2] || '/vol1/1000/appdata/ai-link/haloflux-ai-link'
const html = readFileSync(join(dir, 'index.html'), 'utf8')
const wp = readFileSync(join(dir, 'wp.js'), 'utf8')
const ai = readFileSync(join(dir, 'ai-link.js'), 'utf8')
const build = (ai.match(/var BUILD = '([^']+)'/) || [])[1] || 'v0.0'
import { existsSync, statSync } from 'node:fs'
const bgmPath = join(root, 'assets/bgm.mp3')
const bgm = existsSync(bgmPath) ? 'data:audio/mpeg;base64,' + readFileSync(bgmPath).toString('base64') : ''
const aiPatched = ai
  .replace(/'CPU \/ GPU 负载'/g, "'CPU / 磁盘 IO'")
  .replace('红 CPU · 蓝 NVMe IO · 紫 GPU（0% 时隐藏）', '红 CPU · 蓝 NVMe IO')

const escapeScript = (code) => code.replace(/<\/script/gi, '<\\/script')

const shim = `
/* ---- Studio 插件数据桥：/stats 走 postMessage → 插件 RPC ---- */
(function () {
  var BUILD = ${JSON.stringify(build)};
  /* Studio 插件 iframe 可能是不透明来源，storage 访问会抛 SecurityError；
     这里给 ai-link.js 提供内存版实现，避免初始化中断。 */
  function memoryStore() {
    var data = {};
    return {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
      setItem: function (k, v) { data[k] = String(v); },
      removeItem: function (k) { delete data[k]; },
      clear: function () { data = {}; },
      key: function (i) { return Object.keys(data)[i] || null; },
      get length() { return Object.keys(data).length; }
    };
  }
  ['localStorage', 'sessionStorage'].forEach(function (name) {
    try { window[name].getItem('__hl_probe__'); }
    catch (error) {
      try { Object.defineProperty(window, name, { value: memoryStore(), configurable: true }); } catch (_) {}
    }
  });
  var settings = { anim: true, fps: 30 };
  var seq = 0, pending = {};
  function applySettings(v) {
    settings = Object.assign({}, settings, v || {});
    if (window.__stageSetFps) window.__stageSetFps(settings.fps === 60 ? 60 : 30);
    if (window.__stagePause) {
      window.__stagePause(settings.anim === false || document.visibilityState === 'hidden');
    }
    var canvas = document.getElementById('stage');
    if (canvas) canvas.style.visibility = settings.anim === false ? 'hidden' : 'visible';
    if (settings.compat) {
      try {
        if (!window.__hlCompat) {
          window.__hlCompat = true;
          Object.defineProperty(window, 'devicePixelRatio', { get: function () { return 1; }, configurable: true });
          var st = document.createElement('style');
          st.textContent = '*,*::before,*::after{will-change:auto !important;animation:none !important;transition:none !important}canvas{image-rendering:auto}';
          document.head.appendChild(st);
          window.dispatchEvent(new Event('resize'));
        }
      } catch (e) { /* ignore */ }
    }
  }
  window.addEventListener('message', function (event) {
    var m = event.data || {};
    if (m.__hl === 'stats-result' && pending[m.id]) {
      var done = pending[m.id];
      delete pending[m.id];
      done(m.data);
    } else if (m.__hl === 'settings') {
      applySettings(m.value);
    }
  });
  document.addEventListener('visibilitychange', function () { applySettings(settings); });
  function requestStats() {
    if (window.__hlBridge && typeof window.__hlBridge.stats === 'function') {
      return Promise.resolve(window.__hlBridge.stats());
    }
    return new Promise(function (resolve) {
      var id = ++seq;
      pending[id] = resolve;
      try { parent.postMessage({ __hl: 'stats-request', id: id }, '*'); } catch (e) { resolve(null); }
      setTimeout(function () {
        if (pending[id]) { delete pending[id]; resolve(null); }
      }, 4000);
    });
  }
  var nativeFetch = window.fetch;
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    if (url.indexOf('/stats') >= 0) {
      return requestStats().then(function (data) {
        if (!data || !data.ai) throw new Error('plugin stats unavailable');
        data.ai.build = BUILD;   // 与页面自身构建号一致，避免触发自动刷新
        return new Response(JSON.stringify(data), {
          status: 200, headers: { 'Content-Type': 'application/json' }
        });
      });
    }
    if (url.indexOf('/health') >= 0) {
      return Promise.resolve(new Response('{"ok":true}', {
        status: 200, headers: { 'Content-Type': 'application/json' }
      }));
    }
    return nativeFetch.apply(window, arguments);
  };
  window.__hlApplySettings = applySettings;
  try { parent.postMessage({ __hl: 'ready' }, '*'); } catch (e) { /* ignore */ }
})();
`

const control = `
/* ---- 舞台控制：暂停与 setParam 桥（不改 ai-link.js 的帧率） ---- */
(function () {
  window.__stageSetFps = function () { /* 原版帧率，不做限帧 */ };
  window.__stagePause = function (paused) { window.__wpPaused = !!paused; };
  window.__stageParam = function (name, value) {
    if (typeof window.setParam === 'function') { try { window.setParam(name, value, true); } catch (e) {} }
  };
})();
`

let out = html
  .replace(/<audio id="bgmAudio"[^>]*><\/audio>/, bgm
    ? '<audio id="bgmAudio" data-src="' + bgm + '" loop playsinline></audio>'
    : '<audio id="bgmAudio" loop playsinline></audio>')
  .replace('<script src="wp.js"></script>', `<script>${escapeScript(wp)}</script>\n<script>${escapeScript(shim)}</script>\n<script>${escapeScript(control)}</script>`)
  .replace(/<script src="ai-link\.js[^"]*"><\/script>/, `<script>${escapeScript(aiPatched)}</script>`)

out = out.replace('</head>', `<style>
/* Studio 插件页高度通常小于整屏：缩短舞台，给底部面板留空间 */
@media (max-height:780px){ .stage{height:54vh !important} }
@media (max-height:640px){ .stage{height:47vh !important} }
@media (max-height:540px){ .stage{height:40vh !important} }
/* 窄屏（手机/Studio 侧栏展开）：避免横向滚动，压缩页头与 HUD */
@media (max-width: 640px) {
  html, body { overflow-x: hidden !important; }
  .app { width: 100% !important; overflow-x: hidden !important; }
  header { grid-template-columns: minmax(0,1fr) repeat(2, minmax(0,1fr)) !important;
           gap: 4px 8px !important; padding: 8px 10px 0 !important; }
  header .brand h1 { font-size: 13px !important; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  header .brand p { display: none !important; }
  header .kpi:nth-child(n+4) { display: none !important; }
  header .kpi .k { font-size: 8px !important; letter-spacing: .5px; }
  header .kpi .v { font-size: 15px !important; }
  #stageWrap { height: 46vh !important; }
  .panels { padding: 6px 8px 10px !important; gap: 6px !important; }
  .panels .p { padding: 6px 8px !important; }
  #aix-hud { width: min(72vw, 232px) !important; right: 8px !important; top: 58px !important; }
}
/* 插件内关闭全屏柔光/扫光与 HUD 数值闪烁，避免刷新时整页闪一下；
   舞台本身、面板、状态片不受影响。 */
html,body{background:#05070a !important}
#aix-fx{display:none !important}
#aix-hud .aix-v.aix-on{animation:none !important}
</style></head>`)

if (out === html) throw new Error('未找到 wp.js / ai-link.js 脚本标签，结构可能已变')

writeFileSync(join(root, 'page-html.mjs'),
  '/* 由 scripts/build-page.mjs 生成，勿手改。来源：docker 版 index.html + wp.js + ai-link.js */\n' +
  'export const PAGE_HTML = ' + JSON.stringify(out) + '\n' +
  'export const PAGE_BUILD = ' + JSON.stringify(build) + '\n')

console.log('page-html.mjs ok, build', build, 'size', out.length)
