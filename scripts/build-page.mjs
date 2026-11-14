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
// 默认用仓库内 page-src/ 的快照，保证 CI/其他机器可复现；
// 从 docker 目录重新同步：node scripts/build-page.mjs /path/to/haloflux-ai-link
const dir = process.argv[2] || join(root, 'page-src')
const html = readFileSync(join(dir, 'index.html'), 'utf8')
const wp = readFileSync(join(dir, 'wp.js'), 'utf8')
const ai = readFileSync(join(dir, 'ai-link.js'), 'utf8')
const build = (ai.match(/var BUILD = '([^']+)'/) || [])[1] || 'v0.0'

/* 只做一处数据口径改动：插件不再展示 GPU（很多设备没有），
   面板改名并去掉面板内与悬浮说明里的 GPU 图例，动效/布局保持原版。 */
function mustReplace(text, from, to, label) {
  if (!text.includes(from)) throw new Error('页面结构已变，未找到：' + label)
  return text.split(from).join(to)
}
let aiPatched = ai
aiPatched = mustReplace(aiPatched, "'CPU / GPU 负载'", "'CPU / 磁盘 IO'", 'CPU/GPU 面板标题')
aiPatched = mustReplace(aiPatched,
  '红 CPU · 蓝 NVMe IO · 紫 GPU（0% 时隐藏）',
  '红 CPU · 蓝 NVMe IO', 'CPU/GPU 悬浮说明')
aiPatched = mustReplace(aiPatched,
  'var gpuNow = (d && d.gpu && isNum(d.gpu.utilization)) ? d.gpu.utilization : null;',
  'var gpuNow = null;', 'GPU 采样')
aiPatched = mustReplace(aiPatched,
  "var gpuTxt3 = 'GPU ' + (gpuNow === null ? '—' : fmtPct(gpuNow));",
  "var gpuTxt3 = '';", 'GPU 图例文字')
aiPatched = mustReplace(aiPatched,
  "label(o.x, gpuTxt3, o.w - gpuW3 - 2, 2, '#b98cff');",
  '', 'GPU 图例绘制')
aiPatched = mustReplace(aiPatched,
  'try { buildBgmToggle(); } catch (e) { /* ignore */ }',
  'try { /* 背景音乐功能已移除 */ } catch (e) { /* ignore */ }', 'BGM 开关')
aiPatched = mustReplace(aiPatched,
  "var t = '代理调度' + (list.length ? ' · ' + list.length : '');",
  "var t = '代理调度';", '代理调度标题计数')

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

/* 只移除 BGM IIFE，保留同一个 <script> 里在它之前的舞台/画布引擎代码。 */
function stripBgmScript(text) {
  const start = text.indexOf('(function initBGM() {')
  if (start < 0) throw new Error('未找到页面 BGM 模块')
  const marker = text.indexOf('window.__bgm = {', start)
  const end = marker < 0 ? -1 : text.indexOf('})();', marker)
  if (end < 0) throw new Error('BGM 模块结构已变')
  return text.slice(0, start) + text.slice(end + '})();'.length)
}

let out = html
  // 完全去掉背景音乐：移除音频元素与自带 BGM 模块，页面不再加载 3.8MB 音频。
  .replace(/<audio id="bgmAudio"[^>]*><\/audio>/, '')
  .replace(/<body([^>]*)>/, `<body$1>\n<script>${escapeScript(shim)}</script>\n<script>${escapeScript(control)}</script>`)
  .replace('<script src="wp.js"></script>', `<script>${escapeScript(wp)}</script>`)
  .replace(/<script src="ai-link\.js[^"]*"><\/script>/, `<script>${escapeScript(aiPatched)}</script>`)

out = stripBgmScript(out)
out = out.replace(/<title>[^<]*<\/title>/, '<title>HALOFLUX ON Ekko</title>')

out = out.replace('</head>', `<style>
/* 插件内只做最小改动，其余布局/动效/卡片尺寸与 docker 版完全一致：
   1. 背景色对齐页面自身 --bg
   2. 右上角控制条隐藏（插件不提供背景音乐） */
html,body{background:#08090b !important}
#aix-topbar{display:none !important}
</style></head>`)

if (out === html) throw new Error('未找到 wp.js / ai-link.js 脚本标签，结构可能已变')

writeFileSync(join(root, 'page-html.mjs'),
  '/* 由 scripts/build-page.mjs 生成，勿手改。来源：docker 版 index.html + wp.js + ai-link.js */\n' +
  'export const PAGE_HTML = ' + JSON.stringify(out) + '\n' +
  'export const PAGE_BUILD = ' + JSON.stringify(build) + '\n')

console.log('page-html.mjs ok, build', build, 'size', out.length)
