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
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
// 默认用仓库内 page-src/ 的快照，保证 CI/其他机器可复现；
// 从 docker 目录重新同步：node scripts/build-page.mjs /path/to/haloflux-ai-link
const dir = process.argv[2] || join(root, 'page-src')
const html = readFileSync(join(dir, 'index.html'), 'utf8')
const wp = readFileSync(join(dir, 'wp.js'), 'utf8')
const ai = readFileSync(join(dir, 'ai-link.js'), 'utf8')
const build = (ai.match(/var BUILD = '([^']+)'/) || [])[1] || 'v0.0'
// 背景音乐内联为 data URL：插件包里没有静态服务器，音频必须随页面一起加载
const bgmPath = join(root, 'assets/bgm.mp3')
const bgm = existsSync(bgmPath) ? 'data:audio/mpeg;base64,' + readFileSync(bgmPath).toString('base64') : ''

/* 页面标题和代理调度的会话数已在 page-src 中统一，构建时不再二次改写。 */
let aiPatched = ai

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
  var settings = { anim: true, fps: 30, gpu: true, toolRows: 8, agentRows: 8, idleSpinSec: 3 };
  var seq = 0, pending = {};
  function rowLimit(value, lo, hi) {
    var n = Number(value);
    return isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : 8;
  }
  function applySettings(v) {
    settings = Object.assign({}, settings, v || {});
    /* 显卡是否显示：ai-link.js 每帧读这个开关，下一帧就生效 */
    window.__hlShowGpu = settings.gpu !== false;
    /* 工具调用/代理调度显示条数：同样每帧读取，保存后无需重载页面 */
    window.__hlToolRows = rowLimit(settings.toolRows, 3, 15);
    window.__hlAgentRows = rowLimit(settings.agentRows, 3, 12);
    var idleSpin = Number(settings.idleSpinSec);
    window.__hlIdleSpinSec = isFinite(idleSpin)
      ? Math.max(2, Math.min(60, Math.round(idleSpin))) : 3;
    if (window.__stageSetFps) window.__stageSetFps(settings.fps === 60 ? 60 : 30);
    /* 关键：不要用 document.visibilityState 去暂停舞台。
       Studio 用 display:none 切换插件视图时，iframe 的 visibilitychange 并不
       保证触发；一旦在 hidden 时把 __wpPaused 置 true，恢复显示后没有人把它
       清回来，index.html 的 frame() 会永远跳过 drawStage()，画面彻底冻结。
       后台标签页的 requestAnimationFrame 本来就会被浏览器自动节流，无需手停。 */
    if (window.__stagePause) window.__stagePause(settings.anim === false);
    window.__hlAnim = settings.anim !== false;
    var canvas = document.getElementById('stage');
    if (canvas) canvas.style.visibility = settings.anim === false ? 'hidden' : 'visible';
    var chk = document.getElementById('chk');
    if (chk) chk.style.display = settings.anim === false ? 'none' : '';
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
    ? '<audio id="bgmAudio" data-src="' + bgm + '" loop preload="auto" playsinline></audio>'
    : '<audio id="bgmAudio" loop preload="auto" playsinline></audio>')
  .replace(/<body([^>]*)>/, `<body$1>\n<script>${escapeScript(shim)}</script>\n<script>${escapeScript(control)}</script>`)
  .replace('<script src="wp.js"></script>', `<script>${escapeScript(wp)}</script>`)
  .replace(/<script src="ai-link\.js[^"]*"><\/script>/, `<script>${escapeScript(aiPatched)}</script>`)

out = out.replace(/<title>[^<]*<\/title>/, '<title>HALOFLUX ON Ekko</title>')

out = out.replace('</head>', `<style>
/* 插件内只做最小改动，其余布局/动效/卡片尺寸与 docker 版完全一致：
   背景色对齐页面自身 --bg；右上角音乐开关保留（与 docker 版一致） */
html,body{background:#08090b !important}
</style></head>`)

if (out === html) throw new Error('未找到 wp.js / ai-link.js 脚本标签，结构可能已变')

writeFileSync(join(root, 'page-html.mjs'),
  '/* 由 scripts/build-page.mjs 生成，勿手改。来源：docker 版 index.html + wp.js + ai-link.js */\n' +
  'export const PAGE_HTML = ' + JSON.stringify(out) + '\n' +
  'export const PAGE_BUILD = ' + JSON.stringify(build) + '\n')

console.log('page-html.mjs ok, build', build, 'size', out.length)
