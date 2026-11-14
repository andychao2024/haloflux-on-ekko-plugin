#!/usr/bin/env node
/**
 * 从 HALOFLUX docker 版 index.html 抽取「原版舞台」：
 *   - 保留：舞台标记、全部内联 CSS、canvas 动画引擎、演示定时器捕获
 *   - 去掉：wp.js、ai-link.js、演示面板内容与加载兜底、BGM 资源
 *   - 追加：接管脚本（停演示定时器、静音底部画布、移除演示 DOM、暂停/参数桥）
 *
 * 用法：node scripts/extract-stage.mjs [index.html 路径]
 * 输出：src-client/stage.html（可读）、stage-html.mjs（客户端内联字符串）
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = process.argv[2] || '/vol1/1000/appdata/ai-link/haloflux-ai-link/index.html'
const html = readFileSync(source, 'utf8')

const bodyStart = html.indexOf('<body')
const firstScript = html.indexOf('<script', bodyStart)
if (bodyStart < 0 || firstScript < 0) throw new Error('index.html 结构不符合预期')

let body = html.slice(html.indexOf('>', bodyStart) + 1, firstScript)

const scripts = []
for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
  scripts.push(m[1])
}
const timerCapture = scripts.find((s) => s.includes('__aixLegacyTimers'))
const engine = scripts.find((s) => s.includes('const TAU = Math.PI * 2'))
if (!timerCapture || !engine) throw new Error('未找到舞台脚本或定时器捕获脚本')

const styles = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n')
const title = (html.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || 'HALOFLUX stage'

// BGM 在插件里不加载，保留空 audio 元素避免脚本取不到节点
body = body.replace(/\sdata-src="[^"]*"/g, '').replace(/\spreload="auto"/g, '')

const overrideCss = `
/* ---- Studio 插件舞台：只保留动画背景 ---- */
html,body{height:100%;margin:0;padding:0;overflow:hidden;background:#05070a}
.app{height:100vh !important;display:block !important}
header,.panels,.ov{display:none !important}
.stage{position:absolute !important;inset:0 !important;height:auto !important;min-height:0 !important}
`

const takeover = `
/* Studio 插件接管：停掉演示面板的定时器与绘制，只留舞台 */
(function () {
  try {
    if (window.__aixLegacyTimers) {
      for (var i = 0; i < window.__aixLegacyTimers.length; i++) clearInterval(window.__aixLegacyTimers[i]);
      window.__aixLegacyTimers = [];
    }
    if (window.__aixNativeSetInterval) {
      window.setInterval = window.__aixNativeSetInterval;
      delete window.__aixNativeSetInterval;
    }
    ['drawAdv', 'drawDiff', 'drawVal', 'drawIdx', 'agentsTick'].forEach(function (name) {
      if (typeof window[name] === 'function') window[name] = function () {};
    });
    var drop = document.querySelectorAll('header, .panels, .ov');
    for (var j = 0; j < drop.length; j++) drop[j].parentNode && drop[j].parentNode.removeChild(drop[j]);

    /* 帧率限制 + 对上层暴露控制口；引擎每帧都会重新取 requestAnimationFrame */
    var nativeRaf = window.requestAnimationFrame.bind(window);
    var ids = new Map(), seq = 0, targetFps = 30, lastTs = 0;
    window.requestAnimationFrame = function (cb) {
      var id = ++seq;
      ids.set(id, cb);
      return id;
    };
    window.cancelAnimationFrame = function (id) { ids.delete(id); };
    function pump(ts) {
      nativeRaf(pump);
      if (!ids.size) return;
      var gap = 1000 / targetFps;
      if (lastTs && ts - lastTs < gap - 1) return;
      lastTs = ts;
      var batch = Array.from(ids.entries());
      ids.clear();
      for (var k = 0; k < batch.length; k++) {
        try { batch[k][1](ts); } catch (error) { console.error('[stage] frame failed', error); }
      }
    }
    nativeRaf(pump);

    window.__stageSetFps = function (fps) { targetFps = fps >= 55 ? 60 : 30; lastTs = 0; };
    window.__stagePause = function (paused) { window.__wpPaused = !!paused; };
    window.__stageParam = function (name, value) {
      if (typeof window.setParam === 'function') { try { window.setParam(name, value, true); } catch (_) {} }
    };
    window.__stageReady = true;
  } catch (error) {
    console.error('[stage] takeover failed', error);
  }
})();
`

const outHtml = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
${styles}
</style>
<style>${overrideCss}</style>
</head>
<body>
${body}
<script>${timerCapture}</script>
<script>${engine}</script>
<script>${takeover}</script>
</body>
</html>
`

mkdirSync(join(root, 'src-client'), { recursive: true })
writeFileSync(join(root, 'src-client/stage.html'), outHtml)
writeFileSync(join(root, 'stage-html.mjs'),
  '/* 由 scripts/extract-stage.mjs 生成，勿手改。来源：docker 版 index.html */\n' +
  'export const STAGE_HTML = ' + JSON.stringify(outHtml) + '\n')

console.log('stage.html', outHtml.length, 'bytes')
console.log('stage-html.mjs ok, engine', engine.length, 'bytes')
