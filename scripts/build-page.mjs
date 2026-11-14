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
/* ---- 舞台控制：帧率上限 / 暂停 / setParam 桥（不改 ai-link.js） ---- */
(function () {
  var nativeRaf = window.requestAnimationFrame.bind(window);
  var ids = new Map(), seq = 0, targetFps = 30, lastTs = 0;
  window.requestAnimationFrame = function (cb) {
    var id = ++seq; ids.set(id, cb); return id;
  };
  window.cancelAnimationFrame = function (id) { ids.delete(id); };
  function pump(ts) {
    nativeRaf(pump);
    if (!ids.size) return;
    if (lastTs && ts - lastTs < 1000 / targetFps - 1) return;
    lastTs = ts;
    var batch = Array.from(ids.entries());
    ids.clear();
    for (var i = 0; i < batch.length; i++) {
      try { batch[i][1](ts); } catch (e) { console.error('[stage] frame', e); }
    }
  }
  nativeRaf(pump);
  window.__stageSetFps = function (fps) { targetFps = fps >= 55 ? 60 : 30; lastTs = 0; };
  window.__stagePause = function (paused) { window.__wpPaused = !!paused; };
  window.__stageParam = function (name, value) {
    if (typeof window.setParam === 'function') { try { window.setParam(name, value, true); } catch (e) {} }
  };
})();
`

let out = html
  .replace(/<audio id="bgmAudio"[^>]*><\/audio>/, '<audio id="bgmAudio" loop playsinline></audio>')
  .replace('<script src="wp.js"></script>', `<script>${escapeScript(wp)}</script>\n<script>${escapeScript(shim)}</script>\n<script>${escapeScript(control)}</script>`)
  .replace(/<script src="ai-link\.js[^"]*"><\/script>/, `<script>${escapeScript(aiPatched)}</script>`)

out = out.replace('</head>', `<style>
/* Studio 插件页高度通常小于整屏：缩短舞台，给底部面板留空间 */
@media (max-height:780px){ .stage{height:54vh !important} }
@media (max-height:640px){ .stage{height:47vh !important} }
@media (max-height:540px){ .stage{height:40vh !important} }
</style></head>`)

if (out === html) throw new Error('未找到 wp.js / ai-link.js 脚本标签，结构可能已变')

writeFileSync(join(root, 'page-html.mjs'),
  '/* 由 scripts/build-page.mjs 生成，勿手改。来源：docker 版 index.html + wp.js + ai-link.js */\n' +
  'export const PAGE_HTML = ' + JSON.stringify(out) + '\n' +
  'export const PAGE_BUILD = ' + JSON.stringify(build) + '\n')

console.log('page-html.mjs ok, build', build, 'size', out.length)
