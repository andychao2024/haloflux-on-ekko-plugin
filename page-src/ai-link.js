/*!
 * HALOFLUX · AI LINK — AI telemetry overlay + visual linkage
 * ------------------------------------------------------------------
 * A NONCOMMERCIAL fan modification of HALOFLUX by Ryder191
 * (RYDER CODE / Ms MAIKEBAIs CAT). Original: https://github.com/Ryder191/haloflux
 * License: PolyForm Noncommercial 1.0.0 (see LICENSE) — noncommercial use only.
 * 基于 HALOFLUX 修改（本地 AI 数据联动版），非商业用途。
 * ------------------------------------------------------------------
 * Polls the telemetry service once per second at the page's own origin
 * ("/stats"; file:// falls back to http://127.0.0.1:8737/stats),
 * paints a sci-fi HUD in the bottom-left corner and repaints the wallpaper
 * itself: tokens/s raises the energy (speed + bloom + comets + flares) and
 * every tool call / message fires a decaying pulse, all via the page's own
 * setParam(). The user's preset is captured as the baseline and restored
 * exactly when the link goes quiet.
 *
 * Transport chain (all tolerated to fail silently):
 *   1. fetch()  with abort timeout
 *   2. XMLHttpRequest
 *   3. JSONP (<script> — bypasses CORS entirely, works from file:// in CEF)
 * ================================================================ */
(function () {
  'use strict';

  /* ------------------------------------------------------------ settings */

  var BUILD = 'v2.44';   // 写入 <html data-ai-build> 与 __aiLink.state().build，便于确认刷新到了新版
  // v2.3：分享令牌 ?k= 由服务端 v1.8.0 强制校验；检测 401 时 HUD 显示"需要访问令牌"
  // v2.4：右上角新增 BGM 音乐开关（默认关闭），与"显示"按钮并排
  // v2.6：右上角两个开关统一进 flex 容器并清掉旧的 fixed 定位，窄屏换行不重叠
  // v2.7：HUD 增加当前任务卡、Top 技能、近 7 日令牌趋势条

  var AUTH_FAIL = false;   // 最近一次失败是不是 401（令牌缺失/错误）

  /* 分享模式：页面从别的机器打开时，数据接口指向“当前页面的主机”，并带上访问令牌 */
  function AI_SHARE_KEY() {
    try {
      if (typeof URLSearchParams === 'function') {
        var q = new URLSearchParams(location.search || '');
        var v = q.get('k') || q.get('token') || '';
        if (v) return v;
      }
    } catch (e) { /* fall through */ }
    try {
      // token may contain - _ . etc.; only '&' terminates it
      var m = /[?&](?:k|token)=([^&]+)/.exec(location.search || '');
      return m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : '';
    } catch (e) { return ''; }
  }
  function AI_ENDPOINT() {
    var k = AI_SHARE_KEY();
    var qs = k ? '?k=' + encodeURIComponent(k) : '';
    // Optional override, handy when the page is hosted somewhere that does not
    // proxy /stats: ?api=https://host/path  (or window.AI_LINK_API).
    var override = '';
    try { override = new URLSearchParams(location.search || '').get('api') || ''; } catch (e) { /* ignore */ }
    if (!override) {
      try { if (typeof window.AI_LINK_API === 'string') override = window.AI_LINK_API; } catch (e) { /* ignore */ }
    }
    if (override) {
      override = override.replace(/\/+$/, '');
      return (/\/stats$/i.test(override) ? override : override + '/stats') + qs;
    }
    // Page and API on the same origin: works over HTTPS behind a reverse proxy
    // and inside cross-site iframes. Fetching http://host:8737 from an https
    // page is blocked as mixed content, which is why the embedded view used to
    // sit at "离线" with no data linkage.
    try {
      if (/^https?:$/.test(location.protocol) && location.origin && location.origin !== 'null') {
        return location.origin + '/stats' + qs;
      }
    } catch (e) { /* ignore */ }
    return 'http://127.0.0.1:8737/stats' + qs;
  }

  /** Host shown in the HUD ("服务 / 数据链路"), so an embedded view no longer
      claims 127.0.0.1:8737 while talking to the reverse-proxy origin. */
  function API_LABEL() {
    try {
      var u = new URL(CONFIG.endpoint, (typeof location !== 'undefined' ? location.href : undefined));
      return u.host || '127.0.0.1:8737';
    } catch (e) { return '127.0.0.1:8737'; }
  }

  var CONFIG = {
    endpoint: AI_ENDPOINT(),
    pollMs: 1000,
    requestTimeoutMs: 2600,    // /stats 要做 SQLite 聚合，留足余量避免误判断链
    jsonpTimeoutMs: 2500,
    offlineAfterMs: 4000,      // no good sample for this long -> LINK: OFFLINE
    position: 'top-right',     // 'bottom-left' | 'top-right' | 'off'（top-right 避让底部数据面板）
    driveVisuals: true,        // repaint the wallpaper itself (bloom/comets/flares)
    screenFx: true,            // soft full-screen bloom + sweep on strong events
    autoCamera: true,          // 跟官方一致：默认开启自动运镜（手动缩放/拖动会临时接管）
    autoSpin: true,            // 跟官方一致：默认开启圆环自动旋转（滚轮手动转会短暂优先）
    spinWhenIdle: false,       // false = 没有 agent 活动时圆环冻结，保持不动
    camWhenIdle: false,        // false = 空闲时自动运镜也停下，画面完全静止
    busyGraceSec: 30,          // 最后一次 agent 事件后继续转多久（避免工具间隙频繁停转）
    pendingBusySec: 600,       // 未完成回合（最后一条不是已完成的助手回复）最长算“工作中”
    planBusySec: 900,          // 运行中的任务计划最长算“工作中”（内部模型可能没有 token 用量）
    buildReloadIdleMs: 15000,  // 发现新版本后，空闲多久自动刷新页面（避免一直跑旧脚本）
    buildReloadMaxMs: 60000,   // 发现新版本后最长等多久必定刷新
    tpsSpeedGain: 0.8,         // tokens/s 达到 tpsFullScale 时，在 1× 基础上额外加速到 1.8×
    motionSmooth: 3.0,         // 倍率缓动速度（每秒收敛比例，避免每秒采样造成跳变）
    resetViewMs: 20000,        // 20 秒无操作回到初始视角
    hoverDelayMs: 1000,        // 鼠标停住多久弹出详细解析
    lineLayer: false,          // 额外数据线层：已停用（和原版光束不同源，观感违和）
    lineDebug: false,          // 诊断用：true 时左上角画红块
    lineMax: 40,               // 数据线最多同时多少根
    aiRingCards: false,        // 用真实进程数据重绘环带卡片（实验性）；false = 保留页面自带的卡片纹理
    tpsFullScale: 2500,        // tokens/s that maps to "full" energy
    tokenBurst: 20000,         // tokens gained in one tick that counts as a burst
    verbose: false
  };

  /* Read simple overrides from the URL: ?aihud=off | ?aihud=top-right */
  try {
    var q = new URLSearchParams(location.search);
    var pos = q.get('aihud');
    if (pos === 'off') CONFIG.position = 'off';
    else if (pos === 'top-right' || pos === 'bottom-left') CONFIG.position = pos;
  } catch (e) { /* old browser: keep defaults */ }

  /* -------------------------------------------------------------- helpers */

  var noop = function () {};
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  /* Studio 插件设置：工具调用/代理调度显示条数。
     页面每帧读取 window.__hl*Rows，保存设置后不用重新打开看板；边界与插件设置一致。 */
  function rowLimit(name, lo, hi) {
    var n = Number(window[name]);
    return isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : 8;
  }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  function fmtInt(n) {
    if (!isNum(n)) return '—';
    n = Math.round(n);
    try { return n.toLocaleString('en-US'); } catch (e) { return String(n); }
  }
  function fmtCompact(n) {
    if (!isNum(n)) return '—';
    if (n >= 1000000) return (n / 1000000).toFixed(2) + 'M';
    if (n >= 10000) return (n / 1000).toFixed(1) + 'k';
    return fmtInt(n);
  }
  /** 上下文用量：模型窗口已知时显示 “已用 / 上限”，否则只显示已用。 */
  function fmtCtx(ai) {
    if (!ai || !isNum(ai.contextTokens)) return '—';
    if (isNum(ai.contextLimit) && ai.contextLimit > 0) {
      return fmtCompact(ai.contextTokens) + ' / ' + fmtCompact(ai.contextLimit);
    }
    return fmtCompact(ai.contextTokens);
  }
  function fmtRate(n) {
    if (!isNum(n)) return '—';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return (n < 10 ? n.toFixed(2) : n.toFixed(1));
  }
  /** HUD 硬盘 IO 用：固定短文本，避免小数位太多把行挤满（单位 MB/s）。 */
  function fmtIO(n) {
    if (!isNum(n)) return '—';
    if (n >= 100) return String(Math.round(n));
    if (n >= 10) return n.toFixed(1);
    return n.toFixed(2);
  }
  /** 字节/秒转带单位的可读文本（网络专用，避免 fmtRate(v)+'B/s' 出现 14.5B/s）。 */
  function fmtBps(n) {
    if (!isNum(n)) return '—';
    if (n >= 1048576) return (n / 1048576).toFixed(2) + ' MB/s';
    if (n >= 1024) return (n / 1024).toFixed(1) + ' kB/s';
    return Math.round(n) + ' B/s';
  }
  function fmtPct(n) {
    if (!isNum(n)) return '—';
    var r = Math.round(n * 10) / 10;
    return (r % 1 === 0 ? String(r) : r.toFixed(1)) + '%';
  }
  function fmtUptime(sec) {
    if (!isNum(sec)) return '—';
    sec = Math.max(0, Math.floor(sec));
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    function p(x) { return (x < 10 ? '0' : '') + x; }
    return h + ':' + p(m) + ':' + p(s);
  }
  /** 相对时间：技能行区分“使用中”与“N 分钟/小时/天前”。 */
  function fmtAge(sec) {
    if (!isNum(sec)) return '—';
    sec = Math.max(0, Math.floor(sec));
    if (sec < 60) return sec + '秒';
    if (sec < 3600) return Math.floor(sec / 60) + '分钟';
    if (sec < 86400) return Math.floor(sec / 3600) + '小时';
    return Math.floor(sec / 86400) + '天';
  }
  function shortTitle(t, n) {
    if (!t) return '—';
    t = String(t).replace(/\s+/g, ' ').trim();
    if (!t) return '—';
    return t.length > n ? t.slice(0, n - 1) + '…' : t;
  }
  /** Agent 名缩写：用于多 Agent 合并时给每条工具调用加来源标签。 */
  function agentShort(name) {
    var n = String(name || '').toLowerCase();
    if (n === 'claude' || n === 'claude-code') return 'Claude';
    if (n === 'codex') return 'Codex';
    if (n === 'codebuddy') return 'Buddy';
    if (n === 'qwen' || n === 'qwen-code') return 'Qwen';
    if (n === 'dsh') return 'DSH';
    if (n === 'opencode') return 'OpenCode';
    if (!name) return '?';
    return shortTitle(name, 8);
  }

  /** 标题行空间不够时使用的短标签，保证 4 个 Agent 状态片还能排在同一行。 */
  function compactAgent(name) {
    var n = String(name || '').toLowerCase();
    if (n === 'codebuddy') return 'BUDDY';
    if (n === 'ekko-agent' || n === 'ekko') return 'EKKO';
    if (n === 'qwen-code') return 'QWEN';
    return String(name || '').toUpperCase();
  }
  /** 工具调用面板的数据来源说明。 */
  function toolSourceLabel(ai) {
    var agents = (ai && ai.toolAgents) || [];
    if ((ai && ai.toolSource === 'mixed-live') || agents.length > 1) {
      var names = [];
      for (var i = 0; i < agents.length; i++) {
        var n = agentShort(agents[i]);
        if (names.indexOf(n) < 0) names.push(n);
      }
      return (names.length ? names.join(' + ') : '多 Agent') + ' 实时';
    }
    if (ai && ai.toolSource === 'claude-transcript') return 'Claude 实时';
    if (ai && ai.toolSource === 'codex-thread') return 'Codex 实时';
    if (ai && ai.toolSource === 'codebuddy-transcript') return 'Buddy 实时';
    if (ai && ai.toolSource === 'qwen-transcript') return 'Qwen 实时';
    if (ai && ai.toolSource === 'dsh-transcript') return 'DSH 实时';
    if (ai && ai.toolSource === 'opencode-db') return 'OpenCode 实时';
    if (ai && ai.toolSource === 'studio-db') return 'Studio 记录';
    return '';
  }

  /* ------------------------------------------------------------- DOM set-up */

  var CSS = [
    ':root{--aix-cyan:#98e0cf;--aix-white:#f4f5f7;--aix-dim:#6b6f78;--aix-pink:#f0a6c6;}',
    '#aix-hud{position:fixed;left:14px;bottom:14px;width:258px;z-index:2147483000;',
    'pointer-events:none;user-select:none;-webkit-user-select:none;font-family:ui-monospace,"Cascadia Mono","SF Mono",Consolas,"Liberation Mono",monospace;',
    'font-size:10px;line-height:1.35;color:var(--aix-cyan);',
    'background:linear-gradient(180deg,rgba(8,11,12,.975),rgba(6,9,10,.955));',
    'border:1px solid rgba(152,224,207,.28);',
    'box-shadow:0 0 0 1px rgba(0,0,0,.5),0 8px 30px rgba(0,0,0,.55);',
    'padding:8px 10px 9px;letter-spacing:.6px;opacity:1;',
    'transition:opacity .35s ease,border-color .35s ease,filter .35s ease;',
    'clip-path:polygon(0 0,calc(100% - 12px) 0,100% 12px,100% 100%,12px 100%,0 calc(100% - 12px));}',
    '#aix-hud.aix-tr{left:auto;right:14px;bottom:auto;top:90px;}',
    '#aix-hud.aix-offline{opacity:.62;border-color:rgba(240,166,198,.45);}',
    '#aix-hud.aix-offline .aix-v{color:#a8909c;}',
    '#aix-hud .aix-scan{position:absolute;top:0;right:0;bottom:0;left:0;pointer-events:none;opacity:.35;',
    'background:repeating-linear-gradient(180deg,rgba(152,224,207,.05) 0 1px,transparent 1px 3px);}',
    '#aix-hud .aix-head{display:flex;align-items:center;justify-content:space-between;',
    'padding-bottom:2px;position:relative;}',
    '#aix-hud .aix-name{font-size:10px;font-weight:800;letter-spacing:2.2px;color:var(--aix-white);}',
    '#aix-hud .aix-name b{color:var(--aix-cyan);font-weight:800;}',
    '#aix-hud .aix-status{font-size:8px;letter-spacing:1.4px;display:flex;align-items:center;gap:4px;color:var(--aix-cyan);margin-left:auto;}',
    '#aix-hud .aix-grip{width:16px;height:12px;flex:0 0 auto;margin-left:7px;pointer-events:auto;cursor:grab;',
    'background-image:radial-gradient(circle,rgba(152,224,207,.75) 1px,transparent 1.2px);',
    'background-size:5px 5px;background-position:1px 1px;opacity:.5;transition:opacity .2s;}',
    '#aix-hud .aix-grip:hover{opacity:1;}',
    '#aix-hud.aix-dragging{opacity:.94;}',
    '#aix-hud .aix-dot{width:5px;height:5px;border-radius:50%;background:var(--aix-cyan);',
    'box-shadow:0 0 6px var(--aix-cyan);animation:aix-blink 2.2s steps(1,end) infinite;}',
    '#aix-hud.aix-offline .aix-dot{background:var(--aix-pink);box-shadow:0 0 6px var(--aix-pink);animation-duration:.9s;}',
    '#aix-hud .aix-rule{height:1px;margin:5px 0 6px;',
    'background:linear-gradient(90deg,rgba(152,224,207,.55),rgba(152,224,207,.08) 60%,transparent);}',
    '#aix-hud .aix-row{display:flex;align-items:baseline;justify-content:space-between;gap:8px;',
    'min-height:13px;white-space:nowrap;}',
    '#aix-hud .aix-k{color:var(--aix-dim);font-size:8.5px;letter-spacing:1.3px;flex:0 0 auto;}',
    '#aix-hud .aix-v{color:var(--aix-white);font-size:10px;font-weight:700;',
    'font-variant-numeric:tabular-nums;text-align:right;overflow:hidden;text-overflow:ellipsis;}',
    '#aix-hud .aix-v.aix-cyan{color:var(--aix-cyan);}',
    '#aix-hud .aix-v.aix-big{font-size:15px;letter-spacing:.5px;}',
    '#aix-hud .aix-v.aix-on{animation:aix-flash .45s ease-out;}',
    '#aix-hud .aix-unit{color:var(--aix-dim);font-weight:400;font-size:9px;}',
    '#aix-hud .aix-bar{position:relative;flex:0 0 62px;height:3px;margin-left:auto;',
    'background:rgba(152,224,207,.12);overflow:hidden;}',
    '#aix-hud .aix-bar i{position:absolute;left:0;top:0;bottom:0;width:0;background:var(--aix-cyan);',
    'box-shadow:0 0 6px rgba(152,224,207,.8);transition:width .45s ease;}',
    '#aix-hud .aix-bar.aix-pink i{background:var(--aix-pink);box-shadow:0 0 6px rgba(240,166,198,.8);}',
    '#aix-hud .aix-spark{display:flex;align-items:flex-end;gap:2px;height:16px;margin-top:6px;}',
    '#aix-hud .aix-spark i{flex:1 1 auto;height:1px;background:rgba(152,224,207,.55);',
    'transition:height .3s ease,background .3s ease;min-height:1px;}',
    '#aix-hud .aix-days{display:flex;align-items:flex-end;gap:3px;height:14px;margin:4px 0 1px;}',
    '#aix-hud .aix-days i{flex:1 1 auto;height:1px;background:rgba(152,224,207,.32);',
    'min-height:1px;transition:height .3s ease,background .3s ease;}',
    '#aix-hud .aix-days i.today{background:rgba(240,166,198,.75);}',
    '#aix-hud .aix-foot{display:flex;justify-content:space-between;margin-top:4px;',
    'font-size:8px;letter-spacing:1px;color:var(--aix-dim);}',
    '#aix-hud .aix-foot .aix-ev{color:rgba(152,224,207,.7);overflow:hidden;text-overflow:ellipsis;}',
    '#aix-hud .aix-hint{margin-top:3px;font-size:7.5px;letter-spacing:.8px;color:rgba(107,111,120,.85);', 
    'border-top:1px solid rgba(152,224,207,.12);padding-top:3px;}',
    '@keyframes aix-blink{0%,60%{opacity:1}61%,100%{opacity:.25}}',
    '@keyframes aix-flash{0%{color:#fff;text-shadow:0 0 10px rgba(152,224,207,.95),0 0 22px rgba(152,224,207,.5)}',
    '100%{text-shadow:none}}',
    '@media (max-width:900px){#aix-hud{width:214px;font-size:9px;}',
    '#aix-hud .aix-unit{display:none;}}',
    '#aix-hud.aix-hidden{display:none;}'
  ].join('');

  function injectCss() {
    if (document.getElementById('aix-style')) return;
    var st = document.createElement('style');
    st.id = 'aix-style';
    st.type = 'text/css';
    st.appendChild(document.createTextNode(CSS));
    (document.head || document.documentElement).appendChild(st);
  }

  var el = {};
  var hud = null;
  var sparkBars = [];
  var SPARK_N = 22;

  function buildHud() {
    if (hud || CONFIG.position === 'off') return;
    injectCss();

    hud = document.createElement('div');
    hud.id = 'aix-hud';
    if (CONFIG.position === 'top-right') hud.className = 'aix-tr';
    hud.setAttribute('aria-hidden', 'true');

    function row(key, label, cls, withBar) {
      var r = document.createElement('div');
      r.className = 'aix-row';
      var k = document.createElement('span');
      k.className = 'aix-k';
      k.textContent = label;
      var v = document.createElement('span');
      v.className = 'aix-v' + (cls ? ' ' + cls : '');
      v.id = 'aix-' + key;
      v.textContent = '—';
      r.appendChild(k);
      if (withBar) {
        var bar = document.createElement('span');
        bar.className = 'aix-bar';
        var fill = document.createElement('i');
        bar.appendChild(fill);
        r.appendChild(bar);
        el[key + 'Bar'] = fill;
        el[key + 'BarWrap'] = bar;
      }
      r.appendChild(v);
      el[key] = v;
      el[key + 'Row'] = r;
      return r;
    }

    var head = document.createElement('div');
    head.className = 'aix-head';
    head.innerHTML = '<span class="aix-name">AI <b>链路</b></span>' +
      '<span class="aix-status"><span class="aix-dot"></span><span id="aix-status-txt">等待</span></span>' +
      '<span class="aix-grip" title="按住拖动"></span>';

    var rule = document.createElement('div');
    rule.className = 'aix-rule';

    var rows = document.createElement('div');
    rows.appendChild(row('title', '会话', 'aix-cyan'));
    rows.appendChild(row('model', '模型'));
    rows.appendChild(row('tokens', '今日用量', 'aix-big'));
    rows.appendChild(row('rate', '速率', 'aix-cyan'));
    rows.appendChild(row('hit', '命中率'));
    rows.appendChild(row('tools', '工具调用'));
    rows.appendChild(row('msgs', '消息数'));
    rows.appendChild(row('cpu', 'CPU', '', true));
    rows.appendChild(row('disk', '硬盘', '', true));
    rows.appendChild(row('uptime', '运行时长'));
    rows.appendChild(row('task', '当前任务', 'aix-cyan'));
    rows.appendChild(row('skills', '技能'));
    rows.appendChild(row('daily', '近 7 日'));

    // 7-day token trend: one bar per day, today highlighted.
    var days = document.createElement('div');
    days.className = 'aix-days';
    el.daysBars = [];
    for (var di = 0; di < 7; di++) {
      var dbar = document.createElement('i');
      dbar.style.height = '1px';
      days.appendChild(dbar);
      el.daysBars.push(dbar);
    }

    var spark = document.createElement('div');
    spark.className = 'aix-spark';
    for (var i = 0; i < SPARK_N; i++) {
      var b = document.createElement('i');
      b.style.height = '1px';
      spark.appendChild(b);
      sparkBars.push(b);
    }

    var foot = document.createElement('div');
    foot.className = 'aix-foot';
    var ev = document.createElement('span');
    ev.className = 'aix-ev';
    ev.id = 'aix-last';
    ev.textContent = '等待遥测…';
    var ag = document.createElement('span');
    ag.id = 'aix-agents';
    ag.textContent = '';
    foot.appendChild(ev);
    foot.appendChild(ag);

    var scan = document.createElement('div');
    scan.className = 'aix-scan';

    hud.appendChild(scan);
    hud.appendChild(head);
    hud.appendChild(rule);
    hud.appendChild(rows);
    hud.appendChild(days);
    hud.appendChild(spark);
    hud.appendChild(foot);

    var hint = document.createElement('div');
    hint.className = 'aix-hint';
    var act = document.createElement('div');
    act.className = 'aix-hint aix-act';
    act.textContent = '活跃度 —';
    el.act = act;
    hud.appendChild(act);
    hint.textContent = '单击放近 · 双击更近 · 拖动平移 · 滚轮转圈';
    el.hint = hint;
    hud.appendChild(hint);
    (document.body || document.documentElement).appendChild(hud);

    el.statusTxt = document.getElementById('aix-status-txt');
    el.statusDot = hud.querySelector('.aix-dot');
    el.last = ev;
    el.agents = ag;

    // initial paint：首个采样还没回来，先显示“连接中”，不要误报离线
    setOnline(false);
    if (el.statusTxt) el.statusTxt.textContent = '连接中';
    hud.classList.remove('aix-offline');
  }

  /* ==================================================================
     数据线层：盖在光环上的一层"命中/未命中"流线
       白线 = 缓存命中，红线 = 未命中；线的数量跟 token 吞吐走
     ================================================================== */

  var LINES = { cv: null, ctx: null, parts: [], acc: 0, raf: 0, last: 0, w: 0, h: 0, on: false, dirty: 0, lastRed: 0 };

  function buildLinesLayer() {
    if (LINES.cv || !CONFIG.lineLayer) return;
    var wrap = document.getElementById('stageWrap');
    if (!wrap) return;
    try {
      var cv = document.createElement('canvas');
      cv.id = 'aix-lines';
      cv.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;width:100%;height:100%;' +
        'display:block;pointer-events:none;z-index:1;';
      wrap.appendChild(cv);
      LINES.cv = cv;
      LINES.ctx = cv.getContext('2d');
      LINES.on = !!LINES.ctx;
      if (LINES.on && typeof requestAnimationFrame === 'function') LINES.raf = requestAnimationFrame(linesFrame);
    } catch (e) { LINES.on = false; }
  }

  /** 在画布可见范围内随机放一根线（红/白由参数决定） */
  function pushLine(forceRed) {
    var g = LINES.geo;
    if (!g) return;
    // 起点放在画面中偏左，让线有足够距离横穿过去，而不是一出场就飞出右边缘
    var sx = g.w * (0.20 + Math.random() * 0.44);
    var sy = g.h * (0.08 + Math.random() * 0.84);
    var ddx = sx - g.cxs, ddy = sy - g.cys;
    var pr = Math.sqrt(ddx * ddx + ddy * ddy) / Math.max(0.2, g.z);
    var isRed = !!forceRed;
    LINES.parts.push({
      a: Math.atan2(ddy, ddx),
      r: pr,
      len: isRed ? (240 + Math.random() * 240) : ((g.ROw - g.Rw) * (0.45 + Math.random() * 0.9) + 90),
      v: (g.ROw - g.Rw) * (0.16 + Math.random() * 0.26),
      life: 0,
      max: isRed ? (4.0 + Math.random() * 2.0) : (1.6 + Math.random() * 1.4),
      red: isRed,
      wd: isRed ? 3.0 : 1.6
    });
  }

  function linesFrame(now) {
    var L = LINES;
    if (!L.on) return;
    L.raf = requestAnimationFrame(linesFrame);

    now = now || (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (now - L.last < 32) return;                     // ~30fps
    var dt = L.last ? Math.min(0.12, (now - L.last) / 1000) : 0.033;
    L.last = now;

    var cv = L.cv, ctx = L.ctx;
    var wrap = document.getElementById('stageWrap');
    if (!cv || !ctx || !wrap) return;

    var ai = (CON.last && CON.last.ai) || {};
    var tps = isNum(ai.tokensPerSec) ? ai.tokensPerSec : 0;
    var energy = clamp(vd.energy, 0, 1);
    var online = CON.last ? !!CON.last.link : true;   // 还没拿到第一帧数据时先按在线处理，线层立刻有东西
    // 常驻基线流量（8 条/秒），有 token 时再加速；否则空闲时几乎不产线，等于看不见
    var rate = !online ? 0 : (8 + Math.min(18, tps / 2000));

    // 完全静止时直接返回，连清屏都不做
    if (!L.parts.length && rate <= 0 && !L.dirty) { L.last = now; return; }

    var w = wrap.clientWidth || 0, h = wrap.clientHeight || 0;
    if (w < 4 || h < 4) return;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
    }
    L.w = w; L.h = h;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    if (window.__wpPaused) { L.dirty = 0; L.parts.length = 0; return; }
    if (!online) { L.parts.length = 0; L.dirty = 0; return; }

    if (CONFIG.lineDebug) {
      ctx.fillStyle = 'rgba(255,0,0,.85)';
      ctx.fillRect(16, 16, 180, 40);
      ctx.fillStyle = '#fff';
      ctx.font = '13px monospace';
      ctx.fillText('LINES ' + L.parts.length + ' / ' + Math.round(w) + 'x' + Math.round(h), 24, 42);
    }

    var g = pageGeo();
    var z = g ? g.cam.z : 1;
    var cxs = g ? (g.cx - g.cam.x) * z + g.W / 2 : w * 0.07;
    var cys = g ? (g.cy - g.cam.y) * z + g.H / 2 : h * 0.5;
    var Rw = g ? g.R : Math.min(w, h) * 0.8;
    var ROw = g ? g.RO : Rw * 1.3;
    var span = 0.95;
    try { if (typeof thS === 'number' && thS > 0.05) span = thS * 0.98; } catch (e) { /* ignore */ }
    L.geo = { cxs: cxs, cys: cys, z: z, w: w, h: h, Rw: Rw, ROw: ROw };

    // 生成：令牌吞吐越高，线越多（但整体压到很少，避免和处理好的白噪背景混在一起）
    L.acc += rate * dt;
    var miss = isNum(CON.missRate) ? clamp(CON.missRate, 0, 1) : 0.01;
    // 红线按 100:1 起步：真实未命中率再低也至少 1%，这样一眼能看见
    var redP = clamp(Math.max(miss, 0.01), 0.01, 0.15);
    var budget = 0;
    while (L.acc >= 1 && budget < 6) {
      L.acc -= 1; budget++;
      var isRed = Math.random() < redP;
      // 100:1 太稀，保证至少每 4 秒出现一根红线，否则肉眼看不出区别
      if (!isRed && (now - L.lastRed) > 4000) isRed = true;
      if (isRed) L.lastRed = now;
      pushLine(isRed);
    }
    while (L.parts.length > (CONFIG.lineMax || 60)) L.parts.shift();

    // 保证画面里始终有一根红线：超过 2.5 秒没有红就立刻补一根
    var hasRed = false;
    for (i = 0; i < L.parts.length; i++) if (L.parts[i].red) { hasRed = true; break; }
    if (!hasRed && (now - L.lastRed) > 2500) {
      pushLine(true);
      L.lastRed = now;
    }

    // 更新位置/寿命
    var i, p;
    for (i = L.parts.length - 1; i >= 0; i--) {
      p = L.parts[i];
      p.life += dt;
      if (p.life >= p.max) { L.parts.splice(i, 1); continue; }
      p.r += p.v * dt * (0.45 + energy);
    }

    // 绘制：先画白线，再画红线（红线压在最上面）；都带一圈暗色描边，亮背景上也看得见
    ctx.globalCompositeOperation = 'source-over';
    var pass, ca, sa, alpha, r0, r1, t;
    for (pass = 0; pass < 2; pass++) {
      var wantRed = pass === 1;
      for (i = 0; i < L.parts.length; i++) {
        p = L.parts[i];
        if (!!p.red !== wantRed) continue;
        t = p.life / p.max;
        alpha = Math.sin(Math.PI * t) * (0.6 + 0.4 * energy);
        if (alpha < 0.03) continue;
        ca = Math.cos(p.a); sa = Math.sin(p.a);
        r0 = p.r * z; r1 = (p.r + p.len) * z;
        ctx.beginPath();
        ctx.moveTo(cxs + ca * r0, cys + sa * r0);
        ctx.lineTo(cxs + ca * r1, cys + sa * r1);
        if (wantRed) {
          ctx.lineWidth = 7.5;
          ctx.strokeStyle = 'rgba(0,0,0,' + (alpha * 0.55).toFixed(3) + ')';
          ctx.stroke();
          ctx.lineWidth = 4.2;
          ctx.strokeStyle = 'rgba(255,30,30,' + alpha.toFixed(3) + ')';
          ctx.stroke();
          ctx.lineWidth = 1.4;
          ctx.strokeStyle = 'rgba(255,215,215,' + (alpha * 0.85).toFixed(3) + ')';
          ctx.stroke();
        } else {
          ctx.lineWidth = 3.6;
          ctx.strokeStyle = 'rgba(0,0,0,' + (alpha * 0.40).toFixed(3) + ')';
          ctx.stroke();
          ctx.lineWidth = 1.4;
          ctx.strokeStyle = 'rgba(250,252,255,' + (alpha * 0.8).toFixed(3) + ')';
          ctx.stroke();
        }
      }
    }
    L.dirty = L.parts.length > 0 ? 1 : 0;
  }


  /* ---- HUD 拖动：按住右上角的小点拖走，双击复位 ---- */
  var HUD_POS_KEY = 'aihud.pos.v1';

  function placeHud(x, y) {
    if (!hud) return;
    var w = hud.offsetWidth || 258;
    var h = hud.offsetHeight || 200;
    var vw = window.innerWidth || 1280;
    var vh = window.innerHeight || 720;
    x = clamp(x, 4, Math.max(4, vw - w - 4));
    y = clamp(y, 4, Math.max(4, vh - h - 4));
    hud.style.left = Math.round(x) + 'px';
    hud.style.top = Math.round(y) + 'px';
    hud.style.right = 'auto';
    hud.style.bottom = 'auto';
  }

  function saveHudPos() {
    if (!hud) return;
    try {
      var r = hud.getBoundingClientRect();
      localStorage.setItem(HUD_POS_KEY, JSON.stringify({ x: Math.round(r.left), y: Math.round(r.top) }));
    } catch (e) { /* ignore */ }
  }

  function resetHudPos() {
    if (!hud) return;
    hud.style.left = '';
    hud.style.top = '';
    hud.style.right = '';
    hud.style.bottom = '';
    try { localStorage.removeItem(HUD_POS_KEY); } catch (e) { /* ignore */ }
  }

  function initHudDrag() {
    if (!hud || CON.hudDrag) return;
    var grip = hud.querySelector('.aix-grip');
    if (!grip) return;
    CON.hudDrag = true;

    try {
      var saved = JSON.parse(localStorage.getItem(HUD_POS_KEY) || 'null');
      if (saved && isFinite(saved.x) && isFinite(saved.y)) placeHud(saved.x, saved.y);
    } catch (e) { /* ignore */ }

    var drag = null;
    grip.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      try { e.preventDefault(); e.stopPropagation(); } catch (err) { /* ignore */ }
      var r = hud.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      hud.classList.add('aix-dragging');
      try { if (grip.setPointerCapture) grip.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    });
    window.addEventListener('pointermove', function (e) {
      if (!drag) return;
      try { e.preventDefault(); } catch (err) { /* ignore */ }
      placeHud(e.clientX - drag.dx, e.clientY - drag.dy);
    }, true);
    window.addEventListener('pointerup', function () {
      if (!drag) return;
      drag = null;
      hud.classList.remove('aix-dragging');
      saveHudPos();
    }, true);
    grip.addEventListener('dblclick', function (e) {
      try { e.stopPropagation(); } catch (err) { /* ignore */ }
      resetHudPos();
    });
    window.addEventListener('resize', function () {
      if (!hud.style.left) return;
      placeHud(parseFloat(hud.style.left) || 0, parseFloat(hud.style.top) || 0);
    });
  }

  /* --------------------------------------------------------- paint helpers */

  function flash(node) {
    if (!node) return;
    node.classList.remove('aix-on');
    /* force reflow so the animation can restart */
    void node.offsetWidth;
    node.classList.add('aix-on');
  }

  function setText(key, txt, pulse) {
    var node = el[key];
    if (!node) return;
    if (node.textContent !== txt) {
      node.textContent = txt;
      if (pulse !== false) flash(node);
    }
  }

  function setBar(key, pct) {
    var fill = el[key + 'Bar'];
    if (!fill) return;
    var w = isNum(pct) ? clamp(pct, 0, 100) : 0;
    fill.style.width = w.toFixed(1) + '%';
    var wrap = el[key + 'BarWrap'];
    if (wrap) wrap.classList.toggle('aix-pink', isNum(pct) && pct >= 85);
  }

  var sparkValues = [];

  function pushSpark(v) {
    sparkValues.push(isNum(v) ? v : 0);
    while (sparkValues.length > SPARK_N) sparkValues.shift();
    var maxV = 1;
    for (var i = 0; i < sparkValues.length; i++) if (sparkValues[i] > maxV) maxV = sparkValues[i];
    maxV = Math.max(maxV, 1);
    for (var j = 0; j < sparkBars.length; j++) {
      var idx = j - (sparkBars.length - sparkValues.length);
      var val = idx >= 0 ? sparkValues[idx] : 0;
      var h = 1 + Math.round(15 * (val / maxV));
      sparkBars[j].style.height = h + 'px';
      sparkBars[j].style.background = val > 0
        ? 'rgba(152,224,207,' + (0.35 + 0.65 * (val / maxV)).toFixed(2) + ')'
        : 'rgba(152,224,207,.12)';
    }
  }

  var online = false;

  function setOnline(v) {
    if (!hud) return;
    online = !!v;
    hud.classList.toggle('aix-offline', !online);
    if (el.statusTxt) el.statusTxt.textContent = online ? '在线' : '离线';
  }

  /* -------------------------------------------------------------- render */

  function render(d) {
    // 先置在线，面板里的“状态”行才能在同一帧显示“已连接”
    setOnline(true);
    try { updateConsole(d); } catch (e) { /* 面板出错不影响 HUD */ }
    if (!hud) return;
    var ai = (d && d.ai) || {};

    setText('title', shortTitle(ai.sessionTitle, 30));
    setText('model', ai.model ? String(ai.model) : '—');
    // 主行显示今日用量（本地 0 点起），累计值仍保留在悬停说明里。
    setText('tokens', isNum(ai.todayTokens) ? fmtCompact(ai.todayTokens) : '—');
    if (el.tokensRow) {
      el.tokensRow.title = '今日用量 ' + (isNum(ai.todayTokens) ? fmtCompact(ai.todayTokens) : '—') +
        '\n累计 ' + fmtCompact(ai.tokensTotal);
    }
    setText('rate', fmtRate(ai.tokensPerSec) + (isNum(ai.tokensPerSec) ? ' tok/s' : ''));
    setText('hit', isNum(ai.cacheHitRate) ? fmtPct(ai.cacheHitRate) : '—');
    setText('tools', fmtInt(ai.toolCalls));
    setText('msgs', fmtInt(ai.messages));
    setText('uptime', fmtUptime(d.uptimeSec));

    // ---- 当前任务 / 技能 / 7 日趋势 ----
    // “当前任务”改为本会话任务计划里正在执行的那一步：计划每推进一步，
    // /stats.ai.taskPlan 就变一次，这里随之更新。没有进行中的计划时整行
    // 自动隐藏，避免再显示别的会话几十分钟前的旧目标。
    var tp = ai.taskPlan;
    var sameSession = !!(tp && tp.sessionId && ai.sessionId &&
      String(tp.sessionId) === String(ai.sessionId));
    var liveStep = null;
    if (sameSession && Array.isArray(tp.steps)) {
      for (var ti = 0; ti < tp.steps.length; ti++) {
        if (tp.steps[ti] && tp.steps[ti].status === 'in_progress') { liveStep = tp.steps[ti]; break; }
      }
    }
    var taskTxt = null;
    if (liveStep) taskTxt = shortTitle(liveStep.step, 18);
    else if (sameSession && tp.total && tp.done >= tp.total && isNum(tp.ageSec) && tp.ageSec <= 600)
      taskTxt = '计划完成 ' + tp.done + '/' + tp.total;
    setText('task', taskTxt || '—');
    if (el.taskRow) el.taskRow.style.display = taskTxt ? '' : 'none';
    if (el.task) {
      var tips = [];
      if (sameSession) {
        if (tp.title) tips.push(tp.title);
        if (liveStep) tips.push('▸ ' + liveStep.step);
        else tips.push(tp.state === 'running' ? '计划执行中'
          : '计划已完成 ' + tp.done + '/' + tp.total);
        var all = Array.isArray(tp.steps) ? tp.steps : [];
        for (var tj = 0; tj < all.length && tj < 8; tj++) {
          var st = all[tj].status;
          tips.push((st === 'completed' ? '✓ ' : st === 'in_progress' ? '▸ ' : '· ') + all[tj].step);
        }
      }
      el.task.title = tips.join('\n');
    }
    // “技能”行改为显示当前正在使用的技能（v2.38）。以前显示的是全时段
    // 累计次数最多的技能，容易被误读成“现在正在用”。服务端 /stats 的
    // currentSkill 取最近一次技能调用：只有调用仍新鲜、且所属会话还活着
    // 才标记 active，其余情况退化为“最近使用 + 多久以前”。
    var cs = ai.currentSkill;
    var skillTxt = '—';
    var skillTips = [];
    if (cs && cs.name) {
      var ageTxt = isNum(cs.ageSec) ? fmtAge(cs.ageSec) + '前' : '';
      skillTxt = shortTitle(cs.name, 12) + (cs.active ? ' · 使用中' : (ageTxt ? ' · ' + ageTxt : ''));
      skillTips.push((cs.active ? '正在使用：' : '最近使用：') + cs.name +
        (cs.agent ? ' · ' + cs.agent : '') + (ageTxt ? ' · ' + ageTxt : ''));
      if (cs.action) skillTips.push('触发方式：' + (cs.action === 'manage' ? '管理' : '调用'));
    }
    setText('skills', skillTxt);
    if (el.skills) {
      if (typeof el.skills.classList !== 'undefined') {
        el.skills.classList.toggle('aix-cyan', !!(cs && cs.active));
      }
      var topList = (Array.isArray(ai.skills) ? ai.skills.slice(0, 5) : [])
        .map(function (s) { return s.name + ' · ' + s.count + ' 次'; });
      if (skillTips.length && topList.length) skillTips.push('累计使用：');
      el.skills.title = skillTips.concat(topList).join('\n');
    }
    var daily = Array.isArray(ai.daily) ? ai.daily.slice(-7) : [];
    var daySum = 0, dayMax = 0;
    for (var di = 0; di < daily.length; di++) {
      daySum += daily[di].tokens || 0;
      dayMax = Math.max(dayMax, daily[di].tokens || 0);
    }
    setText('daily', daily.length ? fmtCompact(daySum) : '—');
    if (el.daily) {
      el.daily.title = daily.map(function (x) { return x.date + ' · ' + fmtCompact(x.tokens); }).join('\n');
    }
    if (el.daysBars) {
      for (var bi = 0; bi < el.daysBars.length; bi++) {
        var bar = el.daysBars[bi];
        var rec = daily[bi];
        if (!rec) { bar.style.height = '1px'; bar.className = ''; bar.title = ''; continue; }
        var hh = Math.max(1, Math.round(13 * (rec.tokens || 0) / (dayMax || 1)));
        bar.style.height = hh + 'px';
        bar.className = (bi === daily.length - 1) ? 'today' : '';
        bar.title = rec.date + ' · ' + fmtCompact(rec.tokens) + ' 令牌 · ' + rec.sessions + ' 会话';
      }
    }

    var cpu = isNum(d.cpu) ? d.cpu : null;
    setText('cpu', fmtPct(cpu));
    setBar('cpu', cpu);

    // 硬盘 IO：主值显示读/写速率，右侧细条显示设备忙碌度（io_ticks 占比）。
    // 服务端 /stats.disk 已在 Linux 上从 /proc/diskstats 采集，无数据时显示“不可用”。
    var dk = d.disk;
    var dkOk = !!(dk && dk.available && isNum(dk.utilization));
    var dkRead = dkOk && isNum(dk.readMBps) ? dk.readMBps : null;
    var dkWrite = dkOk && isNum(dk.writeMBps) ? dk.writeMBps : null;
    if (dkOk) {
      // 单位单独包一层：窄屏（HUD 214px）隐藏单位，避免值被省略号截断
      if (el.disk) {
        el.disk.innerHTML = '↓' + fmtIO(dkRead) + '/↑' + fmtIO(dkWrite) +
          '<span class="aix-unit"> MB/s</span>';
      }
    } else {
      setText('disk', '不可用');
    }
    setBar('disk', dkOk ? dk.utilization : null);
    if (el.disk) {
      el.disk.title = dkOk
        ? '硬盘 IO（' + (dk.device || '—') + (dk.model ? ' · ' + dk.model : '') + '）\n' +
          '读：' + fmtRate(dkRead) + ' MB/s\n' +
          '写：' + fmtRate(dkWrite) + ' MB/s\n' +
          '忙碌：' + fmtPct(dk.utilization) + ' · ' + (isNum(dk.iops) ? dk.iops : '—') + ' IOPS'
        : '硬盘 IO 不可用（非 Linux 或无 /proc/diskstats）';
    }

    if (el.last) {
      var ev = ai.lastEvent ? zhEvent(ai.lastEvent) : '空闲';
      if (isNum(ai.lastEventAgeSec)) ev += ' · ' + ai.lastEventAgeSec + '秒前';
      if (el.last.textContent !== ev) el.last.textContent = ev;
    }
    if (el.agents) {
      var a = '代理 ' + (isNum(ai.activeAgents) ? ai.activeAgents : '—') +
        ' · 会话 ' + (isNum(ai.sessions) ? ai.sessions : '—');
      if (el.agents.textContent !== a) el.agents.textContent = a;
    }

    pushSpark(ai.tokensPerSec);

    if (el.act) {
      var actE = clamp(Math.sqrt((ai.tokensPerSec || 0) / 2500), 0, 1);
      var nb = Math.round(actE * 10);
      var bar = '';
      for (var bi = 0; bi < 10; bi++) bar += (bi < nb ? '▮' : '▯');
      var atxt = '活跃度 ' + bar + ' ' + Math.round(actE * 100) + '%';
      if (el.act.textContent !== atxt) el.act.textContent = atxt;
    }
  }

  function renderOffline() {
    if (hud) {
      setOnline(false);
      pushSpark(0);
      setBar('cpu', null);
      setBar('disk', null);
    }
    if (CON.built) { try { renderPanes(CON.last); } catch (e) { /* ignore */ } }
    if (AUTH_FAIL) {
      if (CON.stBig) CON.stBig.textContent = '需要访问令牌 · URL 加 ?k=<令牌>';
      if (CON.checks) CON.checks[0] = ['令牌缺失', '8737 返回 401 · 加 ?k=<令牌>'];
    } else {
      if (CON.stBig) CON.stBig.textContent = '链路中断 · 等待 AI 服务';
      if (CON.checks) CON.checks[0] = ['链路中断', API_LABEL() + ' 无响应'];
    }
  }

  /* --------------------------------------------------- visual linkage
     Two signals drive the picture:
       E  "energy"  — smoothed tokens/s (sustained AI activity)
       P  "pulse"   — decaying spike fired by new tool calls / messages /
                      big token bursts / session switches
     They are added on top of the wallpaper's OWN current values (captured
     from the page's C table), so the user's preset stays the baseline and
     everything is put back exactly when the link goes quiet.
     Only parameters without a rebuild flag are touched (no 'resize'/'web'/
     'slots'/'flyers' entries) so nothing expensive happens per frame. */

  /* 这一组是"从环里飞出来的东西"：按 AI 活跃度整体缩放，
     空闲时压到 base×idle（接近消失），思考时回到 base 甚至更猛。
     和 VIS 不同，它们是乘性映射，允许低于用户基线。 */
  var FLOW = {
    flyerCount:  { fallback: 3,   min: 0,   max: 3,   idle: 0.00, integer: true, rebuild: true }, // 单独飞出流线数量（重建）——动态写会每 250ms 重建一次数组，故不驱动
    flyerBright: { fallback: 3,   min: 0,   max: 3,   idle: 0.03 },
    flyerSpeed:  { fallback: 2.2, min: 0.2, max: 3,   idle: 0.35 },
    burstRate:   { fallback: 3.5, min: 0,   max: 5,   idle: 0.04 },   // 成组飞出流线频率
    burstSize:   { fallback: 3,   min: 0.2, max: 3,   idle: 0.30 },
    burstBright: { fallback: 2.5, min: 0,   max: 2.5, idle: 0.03 },
    hazeCount:   { fallback: 8,   min: 0,   max: 30,  idle: 0.10, integer: true },  // 宽光带数量（就是那些长条纹）
    hazeBright:  { fallback: 1.5, min: 0,   max: 3,   idle: 0.04 },   // 宽光带亮度
    beamBright:  { fallback: 1.8, min: 0,   max: 2.5, idle: 0.04 },   // 伸缩光束亮度
    beamLen:     { fallback: 1.8, min: 0.2, max: 1.8, idle: 0.20 },
    beamWidth:   { fallback: 0.7, min: 0.3, max: 3,   idle: 0.30 },
    beamGlow:    { fallback: 3.5, min: 0,   max: 6,   idle: 0.03 },   // 伸缩光束柔光
    flareRate:   { fallback: 3.5, min: 0,   max: 5,   idle: 0.05 },   // 根部闪光
    flareBright: { fallback: 2,   min: 0,   max: 2,   idle: 0.05 },
    dashBright:  { fallback: 1.9, min: 0,   max: 2,   idle: 0.08 },   // 流动短线
    cometPerBeat:{ fallback: 2.3, min: 0,   max: 6,   idle: 0.08 },
    cometBurst:  { fallback: 9,   min: 0,   max: 12,  idle: 0.10 },
    cometTrickle:{ fallback: 1.5, min: 0,   max: 6,   idle: 0.00 }
  };

  var VIS = {
    tempo:       { fallback: 0.6, min: 0.4, max: 2.5, gain: 1.10, pulse: 0.22 },
    ringSpeed:   { fallback: 0.6, min: 0,   max: 3,   gain: 1.70, pulse: 0.35 },
    glow:        { fallback: 1.1, min: 0,   max: 1.5, gain: 0.22, pulse: 0.16 },
    dataFlicker: { fallback: 1,   min: 0,   max: 4,   gain: 1.10, pulse: 1.50 },
    rimBright:   { fallback: 1,   min: 0,   max: 2,   gain: 0.15, pulse: 0.40, hit: 0.25 },
    runnerBright:{ fallback: 0.5, min: 0,   max: 2,   gain: 0.55, pulse: 0.25, hit: 0.35 },
    runnerSpeed: { fallback: 0.6, min: 0.1, max: 4,   gain: 1.25, pulse: 0.20 },
    webSpin:     { fallback: 1,   min: 0,   max: 5,   gain: 0.90, pulse: 0.20 }
  };

  var vd = {
    base: null,          // the page's own values, captured from C
    cur: {},             // last value we wrote per parameter (dedupe only)
    written: {},         // last value actually pushed to C (survives settle)
    energy: 0,           // smoothed 0..1
    energyTarget: 0,
    hit: 0,              // 0..1  缓存命中率
    pulse: 0,            // 0..1.2, decays
    running: false,
    raf: 0,
    lastPaint: 0,
    forceFrames: 0,
    lastFlow: 0,
    seen: { tools: null, msgs: null, tokens: null, title: null, session: null },
    writes: 0
  };

  function hasSetParam() {
    return typeof window.setParam === 'function';
  }

  function applyParam(name, value) {
    if (!hasSetParam()) return;
    try {
      window.setParam(name, value, true);   // silent = do not touch the saved preset
    } catch (e) { /* parameter not present in this build — ignore */ }
  }

  /** The wallpaper's live parameter table (`const C` in index.html). */
  function pageParams() {
    try {
      if (typeof C === 'object' && C) return C;
    } catch (e) { /* not there */ }
    return null;
  }

  function captureBase() {
    var c = pageParams(), base = {};
    for (var k in VIS) {
      if (!Object.prototype.hasOwnProperty.call(VIS, k)) continue;
      var spec = VIS[k];
      var v = (c && typeof c[k] === 'number' && isFinite(c[k])) ? c[k] : spec.fallback;
      base[k] = clamp(v, spec.min, spec.max);
    }
    for (var f in FLOW) {
      if (!Object.prototype.hasOwnProperty.call(FLOW, f)) continue;
      var fspec = FLOW[f];
      var fv = (c && typeof c[f] === 'number' && isFinite(c[f])) ? c[f] : fspec.fallback;
      base[f] = clamp(fv, fspec.min, fspec.max);
    }
    vd.base = base;
    return base;
  }

  function writeParam(k, v) {
    v = Math.round(v * 1000) / 1000;
    if (vd.cur[k] !== undefined && Math.abs(vd.cur[k] - v) < 0.0015) return;
    vd.cur[k] = v;
    vd.written[k] = v;
    applyParam(k, v);
    vd.writes++;
  }

  /* ---- screen-level feedback: a soft cyan bloom + a sensor sweep ---- */

  var FX_CSS = [
    '#aix-fx{position:fixed;top:0;right:0;bottom:0;left:0;z-index:2147482000;pointer-events:none;overflow:hidden;}',
    '#aix-fx .aix-fx-glow{position:absolute;top:-8%;right:-8%;bottom:-8%;left:-8%;opacity:0;',
    'background:radial-gradient(ellipse at 50% 50%,rgba(152,224,207,.16),rgba(152,224,207,.05) 46%,transparent 72%);}',
    '#aix-fx .aix-fx-scan{position:absolute;left:0;right:0;top:-3px;height:2px;opacity:0;',
    'background:linear-gradient(90deg,transparent,rgba(224,255,248,.55),transparent);',
    'box-shadow:0 0 14px rgba(152,224,207,.55);}',
    '@keyframes aix-fx-sweep{0%{opacity:.85;transform:translateY(0)}100%{opacity:0;transform:translateY(103vh)}}'
  ].join('');

  function buildFx() {
    if (!CONFIG.screenFx || el.fx) return;
    try {
      var st = document.getElementById('aix-fx-style');
      if (!st) {
        st = document.createElement('style');
        st.id = 'aix-fx-style';
        st.type = 'text/css';
        st.appendChild(document.createTextNode(FX_CSS));
        (document.head || document.documentElement).appendChild(st);
      }
      var fx = document.createElement('div');
      fx.id = 'aix-fx';
      fx.setAttribute('aria-hidden', 'true');
      var glow = document.createElement('div');
      glow.className = 'aix-fx-glow';
      var scan = document.createElement('div');
      scan.className = 'aix-fx-scan';
      fx.appendChild(glow);
      fx.appendChild(scan);
      (document.body || document.documentElement).appendChild(fx);
      el.fx = fx;
      el.fxGlow = glow;
      el.fxScan = scan;
    } catch (e) { /* no fx, no problem */ }
  }

  function flashScreen(strong) {
    if (!el.fxGlow) return;
    try {
      var s = el.fxScan;
      if (strong && s) {
        s.style.animation = 'none';
        void s.offsetWidth;
        s.style.animation = 'aix-fx-sweep 1100ms linear forwards';
      }
    } catch (e) { /* ignore */ }
  }

  function updateScreenFx(p) {
    if (!el.fxGlow) return;
    try {
      var o = Math.round(clamp(p, 0, 1.2) * 0.5 * 100) / 100;
      if (o <= 0.02) {
        if (el.fxGlow.style.display !== 'none') { el.fxGlow.style.display = 'none'; el.fxGlow.style.opacity = '0'; }
        return;
      }
      if (el.fxGlow.style.display === 'none') el.fxGlow.style.display = 'block';
      if (el.fxGlow.style.opacity !== String(o)) el.fxGlow.style.opacity = String(o);
    } catch (e) { /* ignore */ }
  }

  /* ---- frame loop ---- */

  function visualFrame(now) {
    vd.raf = 0;
    if (!CONFIG.driveVisuals || !hasSetParam()) { vd.running = false; return; }
    if (!vd.base) captureBase();

    now = now || Date.now();
    if (vd.lastPaint && now - vd.lastPaint < 28) { scheduleVisual(); return; }   // ~30 fps
    var dt = vd.lastPaint ? Math.min(0.25, (now - vd.lastPaint) / 1000) : 0.05;
    vd.lastPaint = now;

    if (vd.pulse > 0) vd.pulse = Math.max(0, vd.pulse - dt * 1.6);
    vd.energy += (vd.energyTarget - vd.energy) * Math.min(1, dt * 9);   // 收得更快，~0.3s 跟随

    var E = clamp(vd.energy, 0, 1);
    var P = clamp(vd.pulse, 0, 1.2);
    var H = clamp(vd.hit, 0, 1);
    var c = pageParams();

    for (var k in VIS) {
      if (!Object.prototype.hasOwnProperty.call(VIS, k)) continue;
      var spec = VIS[k];

      // the wallpaper (settings panel / preset change) overwrote our value:
      // adopt it as the new baseline instead of fighting it.
      // Compare against `written`, not `cur`: the settle path clears `cur`, so a
      // preset changed while the link was idle used to be missed and then
      // overwritten by a stale vd.base on the next burst of activity.
      if (c && typeof c[k] === 'number' && vd.written[k] !== undefined && Math.abs(c[k] - vd.written[k]) > 0.03) {
        vd.base[k] = clamp(c[k], spec.min, spec.max);
      }

      writeParam(k, clamp(vd.base[k] + E * spec.gain + P * spec.pulse + H * (spec.hit || 0), spec.min, spec.max));
    }

    // 飞出物（流线/根部闪光/成组光束）：按活跃度整体缩放，空闲时几乎不可见
    var A = clamp(Math.max(E, P * 0.9), 0, 1);
    if (!vd.lastFlow || now - vd.lastFlow > 90) {
      vd.lastFlow = now;
      for (var fk in FLOW) {
        if (!Object.prototype.hasOwnProperty.call(FLOW, fk)) continue;
        var fs = FLOW[fk];
        // Params with a rebuild flag (flyerCount) trigger initFlyers() from
        // setParam; driving them here rebuilds thousands of objects every few
        // hundred ms. Leave them at the user's value.
        if (fs.rebuild) continue;
        // Adopt preset changes made while the link was idle, same as VIS.
        if (c && typeof c[fk] === 'number' && vd.written[fk] !== undefined && Math.abs(c[fk] - vd.written[fk]) > 0.03) {
          vd.base[fk] = clamp(c[fk], fs.min, fs.max);
        }
        var fb = vd.base[fk];
        if (typeof fb !== 'number') continue;
        var fv = fb * (fs.idle + (1 - fs.idle) * A) * (1 + 0.45 * A);   // 活跃时比原版更猛（×1.45），闲时接近 0
        if (fs.integer) fv = Math.round(fv);
        writeParam(fk, clamp(fv, fs.min, fs.max));
      }
    }

    updateScreenFx(P);

    if (E > 0.004 || P > 0.004 || vd.forceFrames > 0) {
      if (vd.forceFrames > 0) vd.forceFrames--;
      scheduleVisual();
      return;
    }

    // settled: hand the wallpaper back exactly as the user configured it
    for (var k2 in vd.base) {
      if (!Object.prototype.hasOwnProperty.call(vd.base, k2)) continue;
      if (FLOW[k2]) continue;            // 飞出物保持"空闲≈消失"，不还原
      vd.cur[k2] = undefined;
      vd.written[k2] = vd.base[k2];      // C is back at the baseline now
      applyParam(k2, vd.base[k2]);
    }
    updateScreenFx(0);
    vd.lastPaint = 0;
    vd.running = false;
  }

  function scheduleVisual() {
    if (vd.raf) return;
    vd.running = true;
    if (typeof requestAnimationFrame === 'function') vd.raf = requestAnimationFrame(visualFrame);
    else vd.raf = setTimeout(function () { visualFrame(Date.now()); }, 33);
  }

  /** 只有 agent 有活动时圆环才转；空闲时冻结在当前角度。
      tokensPerSecond 越高，节拍与圆环通过 CAM.rateTarget 加速（1×~1.8×）。 */
  function updateMotion(d) {
    var ai = (d && d.ai) || {};
    var busy = false;
    var age = 999;
    var tps = 0;
    if (d && d.link) {
      age = isNum(ai.lastEventAgeSec) ? ai.lastEventAgeSec : 999;
      var jobs = isNum(ai.jobsRunning) ? ai.jobsRunning : 0;
      var active = isNum(ai.activeAgents) ? ai.activeAgents : 0;
      tps = isNum(ai.tokensPerSec) ? Math.max(0, ai.tokensPerSec) : 0;
      // 正常任务：最后一个事件后 30 秒内视为活动；
      // 长工具调用（事件稀疏）时，只要会话仍标记为运行就放宽到 60 秒。
      busy = age <= CONFIG.busyGraceSec ||
        (jobs > 0 && active > 0 && age <= CONFIG.busyGraceSec * 2);

      // 内部模型（如 CodeBuddy 用内置模型）不会写 session_usage，tokensPerSecond
      // 恒为 0，长回合进行中也可能没有新消息。此时用两个替代信号：
      // 1) 最后一条消息仍是 user/tool（回合未完成）；
      // 2) 任务计划仍在 running 且会话有效。
      // 两者都有时间上限，避免崩溃/久等的会话让画面无限转下去。
      var pending = isNum(ai.pendingSec) ? ai.pendingSec : null;
      CAM.planBusy = !!(ai.planActive &&
        (!isNum(ai.planAgeSec) || ai.planAgeSec <= CONFIG.planBusySec));
      CAM.pendingSec = pending;
      busy = busy ||
        (pending !== null && pending <= CONFIG.pendingBusySec) ||
        CAM.planBusy;
    } else {
      CAM.planBusy = false;
      CAM.pendingSec = null;
    }
    CAM.spinActive = CONFIG.spinWhenIdle ? true : busy;
    CAM.lastAge = age;
    CAM.tps = tps;
    // sqrt 让低吞吐也有可感知的提速，高吞吐再平滑接近上限。
    var load = clamp(Math.sqrt(tps / CONFIG.tpsFullScale), 0, 1);
    CAM.rateTarget = CAM.spinActive ? 1 + CONFIG.tpsSpeedGain * load : 0;
    // 旧版壁纸若没有 updateBeat（无法挂节拍钩子），至少让圆环按目标倍率转。
    if (!CAM.beatHooked) CAM.rate = CAM.rateTarget;

    // 所有 Agent 停工时，用户放大/平移的视角也收回默认（留 2.5 秒手动操作缓冲）。
    if (!CAM.spinActive && Date.now() - CAM.lastManualAt > 2500) idleCameraReset();
  }

  /** 每帧把倍率缓动到目标值；返回 0 表示节拍/圆环应完全停住。 */
  function motionRate(dt) {
    var k = 1 - Math.exp(-Math.max(0, dt) * CONFIG.motionSmooth);
    CAM.rate += (CAM.rateTarget - CAM.rate) * k;
    if (CAM.rate < 0.01) CAM.rate = 0;
    if (CAM.rate > 4) CAM.rate = 4;
    return CAM.rate;
  }

  /** 用吞吐倍率缩放官方节拍时钟：高吞吐节拍更快，空闲（倍率 0）时停拍。 */
  function installBeatHook() {
    if (CAM.beatHooked) return true;
    try {
      if (typeof updateBeat !== 'function') return false;
      var origBeat = updateBeat;
      updateBeat = function (dt) {
        var r = motionRate(dt);
        if (r <= 0) {
          // 停拍后让节拍包络自然衰减，避免画面亮度停在最后一拍。
          try { if (typeof env === 'number' && env > 0) env *= Math.exp(-dt * 4.5); } catch (e) { /* ignore */ }
          return;
        }
        origBeat(dt * r);
      };
      CAM.beatHooked = true;
      return true;
    } catch (e) { return false; }
  }

  /** No data at all -> release the parameters back to the wallpaper. */
  function visualIdle() {
    if (!CONFIG.driveVisuals) return;
    vd.energyTarget = 0;
    vd.hit = 0;
    vd.pulse = 0;
    vd.forceFrames = 2;
    scheduleVisual();
  }

  /** Feed one /stats sample into the visual driver. */
  function updateVisuals(d) {
    if (!CONFIG.driveVisuals || !hasSetParam()) return;
    var ai = (d && d.ai) || {};
    if (!d || !d.link || !isNum(ai.tokensPerSec)) { visualIdle(); return; }

    var tpsE = clamp(Math.sqrt(ai.tokensPerSec / CONFIG.tpsFullScale), 0, 1);

    // Between two model steps tokens/s drops to 0 for a while (tools are running).
    // Keep a low "still alive" floor that fades out over ~20s after the last event.
    var age = isNum(ai.lastEventAgeSec) ? ai.lastEventAgeSec : 999;
    // Studio 的 usage 行在两次模型调用之间可能隔 30~60 秒（工具执行），
    // 底噪跟着 20 秒吞吐窗口一起衰减，避免任务在跑却整屏判为空闲。
    var recent = age <= 2 ? 1 : Math.max(0, 1 - (age - 2) / 88);

    if (age > 90) tpsE = 0;
    vd.energyTarget = Math.max(tpsE, recent * 0.35);
    // 缓存命中率通常 90%~100%，映射到 0..1 驱动细线亮度
    vd.hit = isNum(ai.cacheHitRate) ? clamp((ai.cacheHitRate - 90) / 10, 0, 1) : 0;

    var s = vd.seen, bump = 0, strong = false;
    if (s.tools !== null && isNum(ai.toolCalls) && ai.toolCalls > s.tools) {
      bump += 0.55 + Math.min(0.35, (ai.toolCalls - s.tools) * 0.08);
      strong = true;
    }
    if (s.msgs !== null && isNum(ai.messages) && ai.messages > s.msgs) bump += 0.45;
    if (s.tokens !== null && isNum(ai.tokensTotal) && ai.tokensTotal - s.tokens >= CONFIG.tokenBurst) bump += 0.25;
    if (s.title !== null && ai.sessionTitle && ai.sessionTitle !== s.title) { bump += 0.8; strong = true; }
    if (s.session !== null && ai.sessionId && ai.sessionId !== s.session) { bump += 0.6; strong = true; }

    s.tools = ai.toolCalls;
    s.msgs = ai.messages;
    s.tokens = ai.tokensTotal;
    s.title = ai.sessionTitle;
    s.session = ai.sessionId;

    if (bump > 0) {
      vd.pulse = Math.min(1.2, vd.pulse + bump);
      flashScreen(strong);
    }
    vd.forceFrames = 3;
    scheduleVisual();
  }

  /* ------------------------------------------------------------ transports */

  var preferred = 'fetch';   // learned at runtime
  var failStreak = 0;        // consecutive failed poll cycles
  var timeoutNow = CONFIG.requestTimeoutMs;
  var lastConsoleState = null;

  function logState(kind, detail) {
    if (lastConsoleState === kind) return;
    lastConsoleState = kind;
    try {
      if (kind === 'online') console.info('[AI LINK] connected via ' + preferred);
      else if (kind === 'offline') console.info('[AI LINK] local service unreachable — HUD shows OFFLINE, retrying every ' + CONFIG.pollMs + 'ms');
      else if (kind === 'transport') console.debug('[AI LINK] switching transport to ' + detail);
      else if (CONFIG.verbose) console.debug('[AI LINK] ' + kind + ' ' + (detail || ''));
    } catch (e) { /* ignore */ }
  }

  function transportFetch() {
    return new Promise(function (resolve, reject) {
      var ctl = null, timer = 0, done = false;
      function finish(ok, val) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (ok) resolve(val); else reject(val);
      }
      try {
        ctl = (typeof AbortController === 'function') ? new AbortController() : null;
        timer = setTimeout(function () {
          try { if (ctl) ctl.abort(); } catch (e) { /* ignore */ }
          finish(false, new Error('timeout'));
        }, timeoutNow);

        fetch(CONFIG.endpoint + (CONFIG.endpoint.indexOf('?') < 0 ? '?' : '&') + 't=' + Date.now(),
          ctl ? { signal: ctl.signal, cache: 'no-store', mode: 'cors' } : { cache: 'no-store', mode: 'cors' })
          .then(function (r) {
            if (!r.ok) {
              var he = new Error('http ' + r.status);
              if (r.status === 401) he.auth = true;
              throw he;
            }
            return r.json();
          })
          .then(function (j) { finish(true, j); })
          .catch(function (e) { finish(false, e); });
      } catch (e) {
        finish(false, e);
      }
    });
  }

  function transportXhr() {
    return new Promise(function (resolve, reject) {
      var xhr, done = false;
      function finish(ok, val) {
        if (done) return;
        done = true;
        try { xhr.onload = xhr.onerror = xhr.ontimeout = null; } catch (e) { /* ignore */ }
        if (ok) resolve(val); else reject(val);
      }
      try {
        xhr = new XMLHttpRequest();
        // endpoint may already carry ?k=<token>; appending a bare '?t=' would
        // turn the token into "token?t=..." and every XHR fallback would 401.
        xhr.open('GET', CONFIG.endpoint + (CONFIG.endpoint.indexOf('?') < 0 ? '?' : '&') + 't=' + Date.now(), true);
        xhr.timeout = timeoutNow;
        xhr.onload = function () {
          if (xhr.status !== 200) {
            var he = new Error('http ' + xhr.status);
            if (xhr.status === 401) he.auth = true;
            return finish(false, he);
          }
          try { finish(true, JSON.parse(xhr.responseText)); }
          catch (e) { finish(false, e); }
        };
        xhr.onerror = function () { finish(false, new Error('xhr error')); };
        xhr.ontimeout = function () { finish(false, new Error('xhr timeout')); };
        xhr.send(null);
      } catch (e) {
        finish(false, e);
      }
    });
  }

  var jsonpSeq = 0;

  function transportJsonp() {
    return new Promise(function (resolve, reject) {
      var name = '__aix_cb_' + (++jsonpSeq) + '_' + Math.random().toString(36).slice(2, 7);
      var script = document.createElement('script');
      var timer = 0, done = false;

      function cleanup() {
        try { delete window[name]; } catch (e) { try { window[name] = undefined; } catch (e2) { /* ignore */ } }
        try { script.onerror = script.onload = null; if (script.parentNode) script.parentNode.removeChild(script); } catch (e) { /* ignore */ }
      }
      function finish(ok, val) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        cleanup();
        if (ok) resolve(val); else reject(val);
      }

      window[name] = function (data) { finish(true, data); };
      script.onerror = function () { finish(false, new Error('jsonp error')); };
      timer = setTimeout(function () { finish(false, new Error('jsonp timeout')); }, CONFIG.jsonpTimeoutMs);
      script.src = CONFIG.endpoint + (CONFIG.endpoint.indexOf('?') < 0 ? '?' : '&') +
        'callback=' + name + '&t=' + Date.now();
      (document.head || document.documentElement).appendChild(script);
    });
  }

  var TRANSPORTS = { fetch: transportFetch, xhr: transportXhr, jsonp: transportJsonp };
  var CHAIN = {
    fetch: ['fetch', 'xhr', 'jsonp'],
    xhr: ['xhr', 'fetch', 'jsonp'],
    jsonp: ['jsonp', 'fetch', 'xhr']
  };

  function pollOnce() {
    var order = (CHAIN[preferred] || CHAIN.fetch).slice();
    // While the service is down, keep retries fast: skip the slow JSONP probe,
    // but still try it every 5th cycle so a JSONP-only setup is discovered.
    if (failStreak >= 2 && preferred !== 'jsonp') {
      order = order.filter(function (n) { return n !== 'jsonp'; });
    }
    if (failStreak > 0 && failStreak % 5 === 0 && order.indexOf('jsonp') < 0) order.push('jsonp');

    var i = 0;
    var sawAuth = false;
    function attempt() {
      if (i >= order.length) return Promise.reject(new Error('all transports failed'));
      var name = order[i++];
      return TRANSPORTS[name]().then(function (data) {
        if (!data || typeof data !== 'object') throw new Error('bad payload');
        if (preferred !== name) { preferred = name; logState('transport', name); }
        return data;
      }).catch(function (e) {
        if (e && e.auth) sawAuth = true;
        return attempt();
      });
    }
    // 顶层收敛一次：只有全部传输都失败且其中出现过 401，才判定为缺令牌。
    // （此前 fetch 失败 → XHR 401 → JSONP 成功时，AUTH_FAIL 会被错误保留。）
    return attempt().then(function (data) { AUTH_FAIL = false; return data; },
                           function (e) { AUTH_FAIL = sawAuth; throw e; });
  }

  /* --------------------------------------------------------------- loop */

  var lastGoodAt = 0;
  var running = false;

  /* 服务端把 ai-link.js 的构建号放进 /stats.ai.build。已打开的页面如果一直
     不刷新，就会继续跑旧版动画逻辑（例如新版已支持内部模型工作信号，旧版
     仍会误判空闲）。发现构建号不一致时，等画面空闲 15 秒或最多 60 秒后自动
     刷新一次；sessionStorage 记录已刷新到的版本，避免代理缓存旧脚本时反复
     刷新。 */
  var buildSeenAt = 0;
  function checkBuild(d) {
    var srv = d && d.ai && d.ai.build;
    if (!srv || srv === BUILD) {
      buildSeenAt = 0;
      try {
        if (sessionStorage.getItem('ailink.buildReload') === BUILD) {
          sessionStorage.removeItem('ailink.buildReload');
        }
      } catch (e) { /* ignore */ }
      return;
    }
    if (!buildSeenAt) buildSeenAt = Date.now();
    var waited = Date.now() - buildSeenAt;
    if (!((!CAM.spinActive && waited >= CONFIG.buildReloadIdleMs) ||
          waited >= CONFIG.buildReloadMaxMs)) return;
    var guard = '';
    try { guard = sessionStorage.getItem('ailink.buildReload') || ''; } catch (e) { /* ignore */ }
    if (guard === srv) return;
    try { sessionStorage.setItem('ailink.buildReload', srv); } catch (e) { /* ignore */ }
    try { location.reload(); } catch (e) { /* ignore */ }
  }

  function tick() {
    if (running) { setTimeout(tick, CONFIG.pollMs); return; }
    running = true;
    pollOnce().then(function (data) {
      running = false;
      failStreak = 0;
      timeoutNow = CONFIG.requestTimeoutMs;
      lastGoodAt = Date.now();
      logState('online');
      try { render(data); } catch (e) { /* never break the wallpaper */ }
      try { updateMotion(data); } catch (e) { /* ignore */ }
      try { checkBuild(data); } catch (e) { /* ignore */ }
      try { updateVisuals(data); } catch (e) { /* ignore */ }
      setTimeout(tick, CONFIG.pollMs);
    }).catch(function () {
      running = false;
      failStreak++;
      timeoutNow = 700;      // short timeouts keep the 1s retry cadence while offline
      // 单次超时不算断链：/stats 偶尔要做 SQLite 聚合，可能慢一拍。
      // 超过 offlineAfterMs 没有好样本才翻成离线，避免 HUD 闪红。
      var stale = !lastGoodAt || Date.now() - lastGoodAt > CONFIG.offlineAfterMs;
      if (stale) {
        try { renderOffline(); } catch (e) { /* ignore */ }
        try { updateMotion(null); } catch (e) { /* ignore */ }
        try { visualIdle(); } catch (e) { /* ignore */ }
      }
      logState('offline');
      setTimeout(tick, CONFIG.pollMs);
    });
  }

  /* Fallback: if a sample stops arriving (tab throttling, service killed) the
     HUD flips to OFFLINE on its own without waiting for a request to fail. */
  setInterval(function () {
    if (!lastGoodAt) return;
    if (Date.now() - lastGoodAt > CONFIG.offlineAfterMs && online) {
      renderOffline();
      updateMotion(null);
      visualIdle();
    }
  }, 1500);

  /* ==================================================================
     AI 控制台：把壁纸自带的那套英文假仪表盘换成真实 AI 遥测
     - 顶部 5 个 KPI   -> 令牌 / 代理 / 工具 / 消息 / 会话
     - 底部 8 个面板    -> 事件流 / 吞吐 / Agent 思考流 / CPU-GPU / 链路 /
                          工具消息 / 代理调度 / 会话索引
     - 画布标注(CHECKS) -> 实时 AI 指标
     ================================================================== */

  var CON = {
    built: false,
    panes: [],
    hist: { tps: [], cpu: [], gpu: [], disk: [], tools: [], msgs: [], ram: [], net: [] },
    prev: null,
    events: [],
    missRate: 0.02,
    procMap: {},
    roster: null,
    zoomed: false,
    zoomTimer: 0,
    camZoomBase: 1,
    last: null
  };

  /* 插件设置里可以关掉显卡；宿主通过 __hlShowGpu 下发，未设置时默认显示。 */
  function gpuVisible() { return window.__hlShowGpu !== false; }

  var PANEL_TITLES = ['AI 事件流', '令牌吞吐', '思考过程', 'CPU / GPU 负载',
    '任务计划', '工具调用', '代理调度', '系统负载索引'];

  var CONSOLE_CSS = [
    // 顶部 5 根白色 KPI 长条：保留真实比例，同时恢复持续呼吸动效（原先由演示脚本随机驱动）
    '.kpi .seg i{transform-origin:left center;animation:aixSegPulse 3.2s ease-in-out infinite;}',
    '.kpi:nth-child(3) .seg i{animation-delay:-.65s}',
    '.kpi:nth-child(4) .seg i{animation-delay:-1.3s}',
    '.kpi:nth-child(5) .seg i{animation-delay:-1.95s}',
    '.kpi:nth-child(6) .seg i{animation-delay:-2.6s}',
    '@keyframes aixSegPulse{0%,100%{transform:scaleX(.88)}50%{transform:scaleX(1)}}',
    '.aix-pane{position:absolute;left:9px;right:9px;top:23px;bottom:5px;background:#0e0f12;',
    'overflow:hidden;z-index:3;font-family:ui-monospace,"Cascadia Mono",Consolas,monospace;',
    'font-size:9.5px;line-height:1.4;color:#8c9199;letter-spacing:.3px;}',
    '.aix-pane canvas{display:block;width:100%;height:100%;}',
    '.aix-pane .row{display:flex;justify-content:space-between;gap:6px;white-space:nowrap;}',
    '.aix-pane .row b{font-weight:700;color:#f4f5f7;font-variant-numeric:tabular-nums;}',
    '.aix-pane.tp{display:flex;flex-direction:column;bottom:2px;}',
    // 思考过程 / 任务计划的 Agent 状态片移到面板标题行，正文不再被状态片占高度
    '.p.aix-hch h3{display:flex;align-items:center;gap:7px;min-width:0;margin-bottom:4px;}',
    '.p.aix-hch h3 .aix-ttl{flex:0 0 auto;}',
    '.p.aix-hch h3 .aix-hchips{display:flex;align-items:center;gap:4px;flex:1 1 auto;min-width:0;overflow:hidden;}',
    '.p.aix-hch-plan .aix-hchips .ss-chip.on{border-color:#c9a7ff;color:#e6dcff;background:rgba(201,167,255,.1);}',
    '.p.aix-hch-plan .aix-hchips .ss-chip.live .ss-dot{background:#c9a7ff;box-shadow:0 0 4px #c9a7ff;animation:ssPulse 1.1s ease-in-out infinite;}',
    '.aix-hchips .ss-chip.off{opacity:.5;}',
    '.aix-pane .tp-head{display:flex;justify-content:space-between;gap:6px;font-size:9.5px;line-height:1.2;color:#6b6f78;white-space:nowrap;overflow:hidden;flex:0 0 auto;}',
    '.aix-pane .tp-head span:first-child{color:#dff6ef;font-weight:700;flex:0 0 auto;}',
    '.aix-pane .tp-head span:last-child{overflow:hidden;text-overflow:ellipsis;}',
    '.aix-pane .tp-bar{height:2px;background:#1b1e23;margin:3px 0 4px;flex:0 0 auto;}',
    '.aix-pane .tp-bar i{display:block;height:100%;width:0;background:#c9a7ff;box-shadow:0 0 4px rgba(201,167,255,.55);transition:width .35s;}',
    '.aix-pane .tp-bar i.done{background:#c9a7ff;box-shadow:0 0 6px rgba(201,167,255,.85);}',
    '.aix-pane .tp-list{flex:1;min-height:0;overflow:hidden;display:flex;flex-direction:column;gap:1px;}',
    '.aix-pane .tp-step{display:flex;gap:5px;font-size:10.5px;line-height:1.4;white-space:nowrap;overflow:hidden;color:#6b6f78;}',
    '.aix-pane .tp-step i{font-style:normal;width:7px;flex:0 0 auto;text-align:center;color:#c9a7ff;}',
    '.aix-pane .tp-step span{overflow:hidden;text-overflow:ellipsis;}',
    '.aix-pane .tp-step.done{color:#4f545c;}',
    '.aix-pane .tp-step.done i{color:#c9a7ff;}',
    '.aix-pane .tp-step.run{color:#dff6ef;}',
    '.aix-pane .tp-step.run i{color:#c9a7ff;animation:ssPulse 1.1s ease-in-out infinite;}',
    '.aix-pane .tp-step.todo{color:#6b6f78;}',
    '.aix-pane .tp-empty{font-size:10px;color:#4f545c;padding-top:2px;}',
    '.aix-pane .teal{color:#98e0cf;} .aix-pane .pink{color:#f0a6c6;}',
    // 事件流配色对齐官方 lab.html 第一张卡：正文暗灰、最后一条白色加粗，
    // 类型词：工具蓝 / 消息青 / 令牌白 / 切会话浅红，时间戳最暗。
    '.aix-pane .ev-list{height:100%;overflow:hidden;display:flex;flex-direction:column;justify-content:flex-end;}',
    '.aix-pane .ev{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#6b6f78;flex:0 0 auto;}',
    '.aix-pane .ev:last-child{color:#f4f5f7;font-weight:600;}',
    '.aix-pane .ev i{color:#3f434a;font-style:normal;margin-right:5px;}',
    '.aix-pane .ev .vb{display:inline-block;width:44px;font-weight:800;font-style:normal;}',
    '.aix-pane .ev .vb.build{color:#5aa9ff;}',
    '.aix-pane .ev .vb.check{color:#cfd2d8;}',
    '.aix-pane .ev .vb.read{color:#98e0cf;}',
    '.aix-pane .ev .vb.qa{color:#f4f5f7;}',
    '.aix-pane .ev .vb.sess{color:#ff9d9d;}',
    // 代理调度：活跃 Agent 的亮格做青色流光，整行有一道缓慢扫光；
    // 空闲行只保留暗青底色，避免满屏都在闪，动效层次和思考流的青色一致。
    '.aix-pane.ap{display:flex;flex-direction:column;gap:3px;}',
    '.aix-pane.ag-dense{gap:1px;}',
    '.aix-pane .ag{display:flex;gap:4px;align-items:center;position:relative;overflow:hidden;',
    'flex:1;min-height:0;margin-bottom:0;}',
    '.aix-pane .ag .cell{flex:1;height:6px;background:#1d1f24;transition:background-color .45s ease,box-shadow .45s ease;}',
    '.aix-pane.ag-dense .ag .cell{height:5px;}',
    '.aix-pane .ag .cell.on{background:rgba(var(--agr,152,224,207),.26);box-shadow:none;}',
    '.aix-pane .ag.on .cell.on{background:linear-gradient(90deg,rgba(var(--agr,152,224,207),.45),',
    'var(--agc,#98e0cf),#f4f5f7,var(--agc,#98e0cf),rgba(var(--agr,152,224,207),.45));',
    'background-size:240% 100%;box-shadow:0 0 5px rgba(var(--agr,152,224,207),.75);animation:aixAgFlow 3s linear infinite;}',
    '@keyframes aixAgFlow{0%{background-position:120% 0}100%{background-position:-120% 0}}',
    '.aix-pane .ag::after{content:"";position:absolute;top:50%;margin-top:-7px;height:14px;left:-24%;width:22%;pointer-events:none;',
    'background:linear-gradient(90deg,transparent,rgba(var(--agr,152,224,207),.14),transparent);',
    'animation:aixAgScan 5.2s linear infinite;}',
    '.aix-pane .ag:nth-child(2)::after{animation-delay:-1.3s}',
    '.aix-pane .ag:nth-child(3)::after{animation-delay:-2.6s}',
    '.aix-pane .ag:nth-child(4)::after{animation-delay:-3.9s}',
    '.aix-pane .ag.on::after{background:linear-gradient(90deg,transparent,rgba(var(--agr,152,224,207),.3),transparent);}',
    '@keyframes aixAgScan{0%{transform:translateX(0)}100%{transform:translateX(560%)}}',
    '.aix-pane .ag.bump{background:linear-gradient(90deg,rgba(var(--agr,152,224,207),.12),transparent);}',
    '.aix-pane .ag .id{flex:0 0 60px;width:60px;min-width:0;color:var(--agc,#cfd2d8);opacity:.72;',
    'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transition:opacity .3s ease;}',
    '.aix-pane .ag.on .id{opacity:1;text-shadow:0 0 8px rgba(var(--agr,152,224,207),.55);}',
    '.aix-pane .ag .st{flex:0 0 44px;width:44px;display:flex;align-items:center;justify-content:flex-end;',
    'gap:3px;color:#6b6f78;white-space:nowrap;}',
    '.aix-pane .ag .pdot{width:4px;height:4px;border-radius:50%;background:#3f434a;flex:0 0 auto;}',
    '.aix-pane .ag.on .st{color:#dff6ef;}',
    '.aix-pane .ag.on .pdot{background:var(--agc,#98e0cf);box-shadow:0 0 5px var(--agc,#98e0cf);animation:ssPulse 1.1s ease-in-out infinite;}',
    '@media (prefers-reduced-motion: reduce){.aix-pane .ag::after,.aix-pane .ag.on .cell.on,.aix-pane .ag.on .pdot{animation:none}}',
    '.aix-pane .bar{height:3px;background:#1d1f24;margin-top:3px;}',
    '.aix-pane .bar i{display:block;height:100%;background:#98e0cf;}',
    /* Agent 思考流：打字机 + 光标闪烁，参考 HALOFLUX 的流式代码面板 */
    '.aix-pane.ss{display:flex;flex-direction:column;}',
    '.aix-pane .ss-chips,.aix-hchips{display:flex;gap:4px;overflow:hidden;flex:0 0 auto;}',
    '.aix-pane .ss-chips{margin-bottom:3px;}',
    '.aix-pane .ss-chip,.aix-hchips .ss-chip{display:inline-flex;align-items:center;font-size:8.5px;line-height:1.1;',
    'padding:1px 4px;border:1px solid #23262c;color:#6b6f78;white-space:nowrap;cursor:pointer;}',
    '.aix-pane .ss-chip.on,.aix-hchips .ss-chip.on{border-color:#98e0cf;color:#dff6ef;background:rgba(152,224,207,.07);}',
    '.aix-pane .ss-dot,.aix-hchips .ss-dot{width:4px;height:4px;border-radius:50%;background:#3f434a;margin-right:4px;flex:0 0 auto;}',
    '.aix-pane .ss-chip.live .ss-dot,.aix-hchips .ss-chip.live .ss-dot{background:#98e0cf;box-shadow:0 0 4px #98e0cf;animation:ssPulse 1.1s ease-in-out infinite;}',
    '.aix-pane .ss-body{flex:1;min-height:0;display:flex;align-items:flex-end;overflow:hidden;}',
    '.aix-pane .ss-text{display:block;width:100%;white-space:pre-wrap;word-break:break-word;',
    'font-size:11px;line-height:1.45;color:#c9cdd4;}',
    '.aix-pane .ss-meta{flex:0 0 auto;display:flex;justify-content:space-between;margin-top:2px;',
    'color:#4f545c;font-size:8.5px;white-space:nowrap;overflow:hidden;}',
    '.aix-pane .ss-caret{display:inline-block;width:5px;height:9px;background:#98e0cf;margin-left:1px;',
    'box-shadow:0 0 4px rgba(152,224,207,.7);animation:ssBlink 1s steps(1) infinite;}',
    '@media (max-width:1300px){.aix-hchips{gap:3px;}.aix-hchips .ss-chip{font-size:8px;padding:0 3px;}}',
    '@keyframes ssBlink{50%{opacity:0}}',
    '@keyframes ssPulse{50%{opacity:.35}}'
  ].join('');

  function injectConsoleCss() {
    if (document.getElementById('aix-console-style')) return;
    var st = document.createElement('style');
    st.id = 'aix-console-style';
    st.type = 'text/css';
    st.appendChild(document.createTextNode(CONSOLE_CSS));
    (document.head || document.documentElement).appendChild(st);
  }

  /* ---- 让页面自己写的文字被我们接管（顶部 KPI / 大标题） ---- */
  function watchText(el, getter) {
    if (!el || typeof MutationObserver !== 'function') return;
    try {
      var mo = new MutationObserver(function () {
        var want = getter();
        if (want != null && el.textContent !== want) el.textContent = want;
      });
      mo.observe(el, { childList: true, characterData: true, subtree: true });
    } catch (e) { /* ignore */ }
  }

  function kpiValues(d) {
    var ai = (d && d.ai) || {};
    return [
      fmtCompact(ai.tokensTotal),
      fmtInt(ai.activeAgents),
      fmtInt(ai.toolCalls),
      fmtInt(ai.messages),
      fmtInt(ai.sessions)
    ];
  }

  /* ---- 面板：每个 .p 上盖一块自己的内容 ---- */
  function buildPane(p, idx) {
    p.style.position = 'relative';
    var h3 = p.querySelector('h3');
    var title = PANEL_TITLES[idx] || (h3 ? h3.textContent : '');
    if (h3) {
      h3.textContent = '';
      var ttl = document.createElement('span');
      ttl.className = 'aix-ttl';
      ttl.textContent = title;
      h3.appendChild(ttl);
      h3.setAttribute('title', title);
    }
    var pane = document.createElement('div');
    pane.className = 'aix-pane';
    p.appendChild(pane);

    var obj = { el: pane, index: idx, kind: 'dom' };
    // 思考过程 / 任务计划：Agent 状态片放进标题行，正文可以占满整块并放大字号
    if (h3 && (idx === 2 || idx === 4)) {
      p.classList.add('aix-hch');
      p.classList.add(idx === 4 ? 'aix-hch-plan' : 'aix-hch-stream');
      var hch = document.createElement('span');
      hch.className = 'aix-hchips';
      h3.appendChild(hch);
      obj.headChips = hch;
      fitPaneTop(p, pane, h3);
    }
    var builder = PANE_BUILDERS[idx];
    if (builder) builder(pane, obj);
    CON.panes.push(obj);
    return obj;
  }

  /* 标题行里放了状态片后 h3 会略高一点，实时量出来，避免压住面板正文 */
  function fitPaneTop(p, pane, h3) {
    var fit = function () {
      try {
        var pr = p.getBoundingClientRect();
        var hr = h3.getBoundingClientRect();
        var top = Math.round(hr.bottom - pr.top + 4);
        pane.style.top = Math.max(18, top) + 'px';
      } catch (e) { /* ignore */ }
    };
    fit();
    if (typeof ResizeObserver === 'function') {
      try { new ResizeObserver(fit).observe(h3); } catch (e) { /* ignore */ }
    }
    window.addEventListener('resize', fit);
  }

  function canvasPane(pane, obj) {
    var c = document.createElement('canvas');
    pane.appendChild(c);
    obj.kind = 'canvas';
    obj.canvas = c;
    obj.ctx = null;
  }

  function rowsPane(pane, obj) {
    obj.kind = 'rows';
    obj.rows = [];
    for (var i = 0; i < 7; i++) {
      var r = document.createElement('div');
      r.className = 'row';
      r.innerHTML = '<span>—</span><b>—</b>';
      pane.appendChild(r);
      obj.rows.push(r);
    }
  }

  function planPane(pane, obj) {
    obj.kind = 'plan';
    pane.className += ' tp';
    var chips = obj.headChips;
    var head = document.createElement('div');
    head.className = 'tp-head';
    var left = document.createElement('span');
    var right = document.createElement('span');
    head.appendChild(left);
    head.appendChild(right);
    var bar = document.createElement('div');
    bar.className = 'tp-bar';
    var fill = document.createElement('i');
    bar.appendChild(fill);
    var list = document.createElement('div');
    list.className = 'tp-list';
    pane.appendChild(head);
    pane.appendChild(bar);
    pane.appendChild(list);
    obj.planChips = chips;
    obj.planHead = left;
    obj.planMeta = right;
    obj.planFill = fill;
    obj.planList = list;
    obj.planSig = '';
    obj.planChipSig = '';
    obj.planPinned = null;
  }

  function feedPane(pane, obj) {
    obj.kind = 'feed';
    obj.list = document.createElement('div');
    obj.list.className = 'ev-list';
    pane.appendChild(obj.list);
  }

  function streamPane(pane, obj) {
    obj.kind = 'stream';
    pane.className += ' ss';
    var chips = obj.headChips;
    var body = document.createElement('div');
    body.className = 'ss-body';
    var text = document.createElement('span');
    text.className = 'ss-text';
    var node = document.createTextNode('');
    var caret = document.createElement('i');
    caret.className = 'ss-caret';
    text.appendChild(node);
    text.appendChild(caret);
    body.appendChild(text);
    var meta = document.createElement('div');
    meta.className = 'ss-meta';
    var src = document.createElement('span');
    var age = document.createElement('span');
    meta.appendChild(src);
    meta.appendChild(age);
    pane.appendChild(body);
    pane.appendChild(meta);
    obj.chips = chips;
    obj.textNode = node;
    obj.metaSrc = src;
    obj.metaAge = age;
    obj.stream = { sig: '', agent: null, full: '', shown: 0, pinned: null, timer: 0 };
    obj.stream.timer = setInterval(function () { typeTick(obj); }, 40);
  }

  /** 模仿 HALOFLUX 的打字机节奏，但按内容长度自适应提速：
      太长时不能等十几秒才播完，否则看到的内容就落后于 Agent 了。 */
  function typeTick(obj) {
    var st = obj.stream;
    if (!st || st.shown >= st.full.length) return;
    var step = Math.max(2, Math.min(12, Math.ceil(st.full.length / 60)));
    st.shown = Math.min(st.full.length, st.shown + step);
    obj.textNode.nodeValue = st.full.slice(0, st.shown);
  }

  function ssAgeLabel(sec) {
    if (!isNum(sec)) return '—';
    if (sec < 60) return sec + '秒前';
    if (sec < 3600) return Math.round(sec / 60) + '分钟前';
    return Math.round(sec / 3600) + '小时前';
  }

  function ssStateLabel(s) {
    if (!s) return '—';
    if (typeof s.pendingSec === 'number') return '生成中';
    if (s.working) return s.workKind === 'tool' ? '执行中' : '生成中';
    if (s.state === 'live') return '流式';
    if (s.state === 'active') return s.kind === 'think' ? '思考' : '输出';
    return '空闲';
  }

  /* ---- 代理调度：按 Agent 名固定配色，行数随 Agent 数量自动增减 ---- */
  var AG_ROT_MS = 6000;      // 超过可视行数时，末行轮换其余 Agent 的间隔
  var AG_MAX_ROWS = 12;      // 最多铺 12 行，再多的 Agent 走轮换
  var AG_COLORS = {};        // agent 名 -> 首次出现时定下的颜色，后续轮询不变
  // 16 个在暗底上互相拉得开的颜色；名字散列选中后若已被占用，就顺延到下一个空位。
  // 16 个以内不会撞色；再多的 Agent 从头复用，名字本身仍可区分。
  var AG_PALETTE = [
    { hex: '#ff8f8f', rgb: '255,143,143' },   // 珊瑚
    { hex: '#ffaa6e', rgb: '255,170,110' },   // 橙
    { hex: '#ffcf7a', rgb: '255,207,122' },   // 琥珀
    { hex: '#e4e078', rgb: '228,224,120' },   // 黄
    { hex: '#aae178', rgb: '170,225,120' },   // 青柠
    { hex: '#78e196', rgb: '120,225,150' },   // 绿
    { hex: '#78e6be', rgb: '120,230,190' },   // 薄荷
    { hex: '#7fe0ff', rgb: '127,224,255' },   // 青
    { hex: '#7fb8ff', rgb: '127,184,255' },   // 蓝
    { hex: '#a0a0ff', rgb: '160,160,255' },   // 靛
    { hex: '#c9a7ff', rgb: '201,167,255' },   // 紫
    { hex: '#eba0eb', rgb: '235,160,235' },   // 品红
    { hex: '#f0a6c6', rgb: '240,166,198' },   // 粉
    { hex: '#ffa0b4', rgb: '255,160,180' },   // 玫瑰
    { hex: '#cdb496', rgb: '205,180,150' },   // 沙色
    { hex: '#cdcdd7', rgb: '205,205,215' }    // 银
  ];

  function agentColor(name) {
    name = String(name || '—');
    if (AG_COLORS[name]) return AG_COLORS[name];
    var h = 0;
    for (var i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    var idx = h % AG_PALETTE.length;
    var used = {};
    for (var k in AG_COLORS) if (AG_COLORS.hasOwnProperty(k)) used[AG_COLORS[k].idx] = 1;
    for (var t = 0; t < AG_PALETTE.length && used[idx]; t++) idx = (idx + 1) % AG_PALETTE.length;
    var base = AG_PALETTE[idx];
    var col = { hex: base.hex, rgb: base.rgb, idx: idx };
    AG_COLORS[name] = col;
    return col;
  }

  function agentsPane(pane, obj) {
    obj.kind = 'agents';
    pane.classList.add('ap');
    obj.rows = [];
    obj.agRot = 0;
    obj.agRotAt = 0;
    var h3 = pane.parentElement ? pane.parentElement.querySelector('h3') : null;
    obj.headEl = h3;
    obj.titleEl = h3 ? h3.querySelector('.aix-ttl') : null;
  }

  // 行按需创建：Agent 少时不铺空行，多了自动补，最多 AG_MAX_ROWS 行
  function ensureAgentRows(obj, n) {
    while (obj.rows.length < n) {
      var row = document.createElement('div');
      row.className = 'ag';
      var id = document.createElement('span');
      id.className = 'id';
      row.appendChild(id);
      var cells = [];
      for (var j = 0; j < 8; j++) {
        var c = document.createElement('i');
        c.className = 'cell';
        // 逐格错开相位，活跃行的流光会形成从左到右的波，而不是整排同一节奏
        c.style.animationDelay = (-j * 0.22).toFixed(2) + 's';
        row.appendChild(c);
        cells.push(c);
      }
      var st = document.createElement('span');
      st.className = 'st';
      var dot = document.createElement('i');
      dot.className = 'pdot';
      var stTxt = document.createElement('span');
      stTxt.textContent = '空闲';
      st.appendChild(dot);
      st.appendChild(stTxt);
      row.appendChild(st);
      obj.el.appendChild(row);
      obj.rows.push({ el: row, id: id, cells: cells, st: stTxt, sig: '', colorName: '', bumpTimer: 0 });
    }
  }

  var PANE_BUILDERS = [
    feedPane,     // 0 AI 事件流
    canvasPane,   // 1 令牌吞吐
    streamPane,   // 2 Agent 思考流
    canvasPane,   // 3 CPU / GPU
    planPane,     // 4 任务计划
    canvasPane,   // 5 工具调用
    agentsPane,   // 6 代理调度
    canvasPane    // 7 会话索引
  ];

  function buildConsole() {
    if (CON.built) return;
    var panels = document.querySelectorAll('.panels .p');
    if (!panels.length) return;
    CON.built = true;
    injectConsoleCss();

    var brandP = document.querySelector('.brand p');
    if (brandP) brandP.textContent = '本地 AI 会话遥测 · 实时数据联动';

    var labels = ['令牌总量', '活跃代理', '工具调用', '消息数', '会话数'];
    var kpis = document.querySelectorAll('.kpi');
    for (var i = 0; i < kpis.length && i < labels.length; i++) {
      var k = kpis[i].querySelector('.k');
      var v = kpis[i].querySelector('.v');
      if (k) k.textContent = labels[i];
      if (v) {
        (function (el, idx) {
          watchText(el, function () {
            var vals = kpiValues(CON.last);
            return vals[idx];
          });
        })(v, i);
      }
    }

    // 舞台右下角的大号“工具 / 令牌 / 会话”与副标题和 HUD、顶部 KPI 重复，
    // 直接在 HTML 里隐藏（见 index.html 的 .ov.status），这里不再接管它的文字。
    CON.stBig = null;

    // 原来钉在光环上的标注改成"跟随鼠标的详细解析"（bindHover），这里把固定的那个收起来
    try {
      var chkBox = document.getElementById('chk');
      if (chkBox) chkBox.style.display = 'none';
      if (typeof drawCallout === 'function') drawCallout = function () { };
      CON.checks = null;
    } catch (e) { /* ignore */ }

    // 顶部 5 个 KPI 的 seg 条也接上数据（宽度 = 占比）
    CON.segs = document.querySelectorAll('.kpi .seg i');

    for (var j = 0; j < panels.length && j < 8; j++) buildPane(panels[j], j);

    // 交接完成：撤掉启动遮罩，永久隐藏原生面板内容，只保留标题 + AI-LINK 面板
    var root = document.documentElement;
    if (root.classList) {
      root.classList.remove('aix-boot');
      root.classList.add('aix-ready');
    }

    CON.last = null;
  }

  /* ---- 事件流 ---- */
  function zhEvent(e) {
    if (!e) return '空闲';
    var s = String(e);
    s = s.replace(/^tool\/call/, '工具调用').replace(/^assistant\/message/, '模型回复')
      .replace(/^user\/message/, '用户消息').replace(/^step\/start/, '开始一步')
      .replace(/^turn\/start/, '开始回合').replace(/^job\/registered/, '任务启动')
      .replace(/^job\/settled/, '任务结束');
    return s;
  }

  function pushEvent(text) {
    var d = new Date();
    function p(x) { return (x < 10 ? '0' : '') + x; }
    CON.events.push({ t: p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()), text: text });
    while (CON.events.length > 10) CON.events.shift();
  }

  /* ---- 主更新：每个 /stats 采样调用一次 ---- */
  function updateConsole(d) {
    if (!CON.built) { buildConsole(); if (!CON.built) return; }
    CON.last = d;
    var ai = (d && d.ai) || {};

    // 进程名单（卡片按固定下标绑定，只有数值更新）
    var procList = (d && Array.isArray(CON.showAll ? d.topAll : d.top))
      ? (CON.showAll ? d.topAll : d.top)
      : ((d && Array.isArray(d.top)) ? d.top : []);
    if (procList.length) {
      var pmap = {}, pnames = [];
      for (var pi = 0; pi < procList.length; pi++) {
        pmap[procList[pi].name] = procList[pi];
        pnames.push(procList[pi].name);
      }
      CON.list = procList;
      CON.procMap = Object.assign({}, CON.procMap, pmap);
      CON.roster = pnames;
      CON.procLive = pmap;
      // 应用数量变化超过 25% 时，重建卡片环（应用多→卡片变小变横排，应用少→竖排大字）
      var pc = procList.length;
      if (pc > 0 && (!CON.appCount || Math.abs(pc - CON.appCount) / Math.max(1, CON.appCount) > 0.25)) {
        CON.appCount = pc;
        try { if (typeof buildCards === 'function') buildCards(); } catch (e) { /* ignore */ }
      }
    }

    // 历史（90 秒）
    CON.hist.tps.push(isNum(ai.tokensPerSec) ? ai.tokensPerSec : 0);
    CON.hist.cpu.push(isNum(d && d.cpu) ? d.cpu : 0);
    CON.hist.gpu.push(d && d.gpu && isNum(d.gpu.utilization) ? d.gpu.utilization : 0);
    CON.hist.disk.push(d && d.disk && isNum(d.disk.utilization) ? d.disk.utilization : 0);
    // 计数器偶发缺失时沿用上一个值，避免“0 → 恢复”被算成一次巨大增量
    CON.hist.tools.push(isNum(ai.toolCalls) ? ai.toolCalls : (CON.hist.tools.length ? CON.hist.tools[CON.hist.tools.length - 1] : 0));
    CON.hist.msgs.push(isNum(ai.messages) ? ai.messages : (CON.hist.msgs.length ? CON.hist.msgs[CON.hist.msgs.length - 1] : 0));
    CON.hist.ram.push(isNum(d && d.ram) ? d.ram : 0);
    var netBps = (d && d.net && isNum(d.net.rxPerSec)) ? (d.net.rxPerSec + (d.net.txPerSec || 0)) : 0;
    CON.hist.net.push(clamp(netBps / (12 * 1048576) * 100, 0, 100));
    for (var k in CON.hist) { if (CON.hist[k].length > 90) CON.hist[k].shift(); }

    // 事件
    var prev = CON.prev;
    if (prev) {
      if (isNum(ai.toolCalls) && isNum(prev.toolCalls) && ai.toolCalls > prev.toolCalls)
        pushEvent('工具调用 +' + (ai.toolCalls - prev.toolCalls) + ' · ' + (ai.lastEvent ? zhEvent(ai.lastEvent) : ''));
      if (isNum(ai.messages) && isNum(prev.messages) && ai.messages > prev.messages)
        pushEvent('新消息 +' + (ai.messages - prev.messages));
      if (isNum(ai.tokensTotal) && isNum(prev.tokensTotal) && ai.tokensTotal > prev.tokensTotal)
        pushEvent('令牌 +' + fmtCompact(ai.tokensTotal - prev.tokensTotal));
      if (ai.sessionId && prev.sessionId && ai.sessionId !== prev.sessionId)
        pushEvent('切换会话：' + shortTitle(ai.sessionTitle, 16));
    } else {
      pushEvent('链路建立 · ' + (ai.lastEvent ? zhEvent(ai.lastEvent) : '监控中'));
    }

    // 缓存命中/未命中：用最新一步的增量算，再做指数平滑，避免某一步全命中就变 0
    if (prev && isNum(ai.inputTokens) && isNum(prev.inputTokens) &&
      isNum(ai.cacheReadTokens) && isNum(prev.cacheReadTokens)) {
      var dIn = Math.max(0, ai.inputTokens - prev.inputTokens);
      var dCa = Math.max(0, ai.cacheReadTokens - prev.cacheReadTokens);
      if (dIn + dCa > 0) {
        var inst = dIn / (dIn + dCa);
        CON.missRate = clamp(0.75 * CON.missRate + 0.25 * inst, 0, 1);
      }
    }
    CON.prev = ai;

    // KPI
    var vals = kpiValues(d);
    var kpis = document.querySelectorAll('.kpi .v');
    for (var i = 0; i < kpis.length && i < vals.length; i++) {
      if (kpis[i].textContent !== vals[i]) kpis[i].textContent = vals[i];
    }
    if (CON.stBig) {
      var big = '工具 ' + fmtInt(ai.toolCalls) + ' · 令牌 ' + fmtCompact(ai.tokensTotal) + ' · 会话 ' + fmtInt(ai.sessions);
      if (CON.stBig.textContent !== big) CON.stBig.textContent = big;
    }
    if (CON.segs && CON.segs.length) {
      var ratios = [0.9, Math.min(1, (ai.activeAgents || 0) / 6), 0.8, 0.7, Math.min(1, (ai.sessions || 0) / 12)];
      for (var s = 0; s < CON.segs.length; s++) CON.segs[s].style.width = (ratios[s] * 100).toFixed(0) + '%';
    }

    // 光环上的浮动标注
    if (CON.checks) {
      var tps = isNum(ai.tokensPerSec) ? ai.tokensPerSec : 0;
      CON.checks[0] = ['令牌吞吐', fmtRate(tps) + ' tok/s · 20 秒窗口'];
      CON.checks[1] = ['当前模型', (ai.model || '—') + ' · ' + (ai.provider || '—')];
      CON.checks[2] = ['工具调用', fmtInt(ai.toolCalls) + ' 次 · 消息 ' + fmtInt(ai.messages)];
      CON.checks[3] = ['会话令牌', fmtCompact(ai.tokensTotal) + ' · 上下文 ' + fmtCtx(ai)];
      CON.checks[4] = ['本地链路', API_LABEL() + ' · ' + (d && d.uptimeSec ? fmtUptime(d.uptimeSec) : '—')];
    }

    renderPanes(d);
    refreshSlots();
  }

  /* ---- 面板渲染 ---- */
  function renderPanes(d) {
    var ai = (d && d.ai) || {};
    for (var i = 0; i < CON.panes.length; i++) {
      var p = CON.panes[i];
      try {
        if (p.kind === 'canvas') { drawPane(p, d); continue; }
        if (p.kind === 'feed') renderFeed(p);
        else if (p.kind === 'stream') renderStreams(p, d);
        else if (p.kind === 'plan') renderPlan(p, d);
        else if (p.kind === 'rows') renderRows(p, d);
        else if (p.kind === 'agents') renderAgents(p, d);
      } catch (e) { /* 单个面板出错不影响整体 */ }
    }
  }

  /* 参考 lab.html「INVESTIGATION FEED」：把事件类型拆成固定宽度彩色词，
     后面再跟正文；最后一条由 CSS 提亮加粗。 */
  function eventTag(text) {
    var s = String(text || '');
    if (s.indexOf('工具调用') === 0) return { label: '工具调用', cls: 'build', rest: s.slice(4) };
    if (s.indexOf('新消息') === 0) return { label: '新消息', cls: 'read', rest: s.slice(3) };
    if (s.indexOf('令牌') === 0) return { label: '令牌', cls: 'qa', rest: s.slice(2) };
    if (s.indexOf('切换会话') === 0) return { label: '切换会话', cls: 'sess', rest: s.slice(4) };
    return { label: '', cls: 'check', rest: s };
  }

  function renderFeed(p) {
    var html = '';
    for (var i = 0; i < CON.events.length; i++) {
      var e = CON.events[i];
      var tag = eventTag(e.text);
      html += '<div class="ev"><i>' + e.t + '</i>' +
        (tag.label ? '<b class="vb ' + tag.cls + '">' + esc(tag.label) + '</b>' : '') +
        esc(String(tag.rest || '').replace(/^\s*[·:：-]\s*/, '')) + '</div>';
    }
    p.list.innerHTML = html;
    // 面板矮于 10 行时从最旧一条开始裁掉，保证最新一条始终贴底可见
    while (p.list.children.length > 1) {
      var lr = p.list.getBoundingClientRect();
      var fr = p.list.firstElementChild.getBoundingClientRect();
      if (fr.top >= lr.top - 0.5) break;   // 首行没有被裁切，说明全部放得下
      p.list.removeChild(p.list.firstChild);
    }
  }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function escAttr(s) {
    return esc(s).replace(/"/g, '&quot;');
  }

  function setRow(row, k, v) {
    row.children[0].textContent = k;
    row.children[1].textContent = v;
  }

  /* 任务计划：每个 Agent 一张计划卡；顶部状态片可点击锁定某个 Agent，
     再点一次恢复跟随当前会话 / 运行中的计划。 */
  function renderPlan(p, d) {
    var ai = (d && d.ai) || {};
    var tp = ai.taskPlan || null;
    var plans = (tp && Array.isArray(tp.plans)) ? tp.plans : (tp ? [tp] : []);
    var focus = null, i;
    // 状态片优先放激活会话的计划；不足 3 个时用最近结束的计划补齐。
    var activePlans = [];
    for (i = 0; i < plans.length; i++) {
      if (plans[i] && plans[i].sessionActive) activePlans.push(plans[i]);
    }
    // 同样最少显示 3 个：激活不足时用最近结束的计划补齐。
    var basePlans = chipBase(activePlans, plans);
    var pinnedPlan = null;
    if (p.planPinned) {
      for (i = 0; i < basePlans.length; i++) {
        if (basePlans[i].agent === p.planPinned) { pinnedPlan = basePlans[i]; break; }
      }
      if (!pinnedPlan) p.planPinned = null;
    }
    var viewPlans;
    if (pinnedPlan) {
      var otherPlans = [];
      for (i = 0; i < basePlans.length; i++) {
        if (basePlans[i] !== pinnedPlan) otherPlans.push(basePlans[i]);
      }
      viewPlans = [pinnedPlan].concat(chipWindow(p, 'pln', otherPlans, CHIP_SLOTS - 1));
    } else {
      viewPlans = chipWindow(p, 'pln', basePlans, CHIP_SLOTS);
    }
    focus = pinnedPlan || activePlans[0] || basePlans[0] || plans[0] || null;
    var focusAgent = focus ? (focus.agent || '') : '';

    // 状态片：一个 Agent 一个，运行中的带脉冲点；当前查看的高亮。
    var chipSig = focusAgent + '|';
    for (i = 0; i < viewPlans.length; i++) {
      var a = viewPlans[i] || {};
      chipSig += (a.agent || '?') + ':' + (a.state || '') + ':' +
        (a.sessionActive ? 1 : 0) + ':' +
        (isNum(a.done) ? a.done : 0) + '/' + (isNum(a.total) ? a.total : 0) + ',';
    }
    if (chipSig !== p.planChipSig) {
      p.planChipSig = chipSig;
      if (!viewPlans.length) {
        p.planChips.innerHTML = '';
      } else {
        var chtml = '';
        for (i = 0; i < viewPlans.length; i++) {
          var pa = viewPlans[i] || {};
          var label = pa.agent ? String(pa.agent).toUpperCase() : '计划';
          var live = pa.state === 'running' && pa.sessionActive;
          var tip = label + ' · ' + (pa.state || '—') +
            ' · ' + (isNum(pa.done) ? pa.done : 0) + '/' + (isNum(pa.total) ? pa.total : 0);
          chtml += '<span class="ss-chip' +
            (pa.agent && pa.agent === focusAgent ? ' on' : '') +
            (live ? ' live' : '') +
            (pa.state === 'ended' ? ' off' : '') +
            (pa.agent ? '" data-agent="' + escAttr(pa.agent) : '') +
            '" title="' + escAttr(tip) + '">' +
            '<i class="ss-dot"></i>' + esc(label) + '</span>';
        }
        p.planChips.innerHTML = chtml;
        var chips = p.planChips.querySelectorAll('.ss-chip[data-agent]');
        for (i = 0; i < chips.length; i++) {
          chips[i].onclick = (function (name) {
            return function (e) {
              if (e && e.stopPropagation) e.stopPropagation();
              p.planPinned = (p.planPinned === name) ? null : name;
              p.planChipSig = '';
              p.planSig = '';
              renderPlan(p, d);
              return false;
            };
          })(chips[i].getAttribute('data-agent'));
        }
      }
    }

    var steps = (focus && Array.isArray(focus.steps)) ? focus.steps : [];
    if (!focus || !steps.length) {
      p.planHead.textContent = '暂无任务计划';
      p.planMeta.textContent = '';
      p.planFill.style.width = '0%';
      p.planFill.className = '';
      p.planList.innerHTML = '<div class="tp-empty">Studio 还没有计划快照</div>';
      p.planSig = '';
      return;
    }
    var total = isNum(focus.total) ? focus.total : steps.length;
    var done = isNum(focus.done) ? focus.done : 0;
    var allDone = done >= total;
    p.planHead.textContent = done + '/' + total + ' · ' + (allDone ? '已完成' : (focus.state === 'running' ? '进行中' : '已暂停'));
    var meta = focus.agent ? agentShort(focus.agent) + ' · ' : '';
    if (isNum(focus.ageSec)) meta += ssAgeLabel(focus.ageSec);
    if (focus.title) meta += (meta ? ' · ' : '') + shortTitle(focus.title, 12);
    p.planMeta.textContent = meta;
    p.planFill.style.width = (total ? Math.round(100 * done / total) : 0) + '%';
    p.planFill.className = allDone ? 'done' : '';

    var view = steps.slice(0, 8);
    var sig = focusAgent + '|' + focus.sessionId + '|' +
      view.map(function (x) { return x.status + '|' + x.step; }).join('\n') + '#' + total;
    if (sig !== p.planSig) {
      p.planSig = sig;
      var html = '';
      for (var j = 0; j < view.length; j++) {
        var stp = view[j];
        var cls = stp.status === 'completed' ? 'done' : (stp.status === 'in_progress' ? 'run' : 'todo');
        var mark = stp.status === 'completed' ? '✓' : (stp.status === 'in_progress' ? '▸' : '·');
        html += '<div class="tp-step ' + cls + '"><i>' + mark + '</i><span>' +
          esc(stp.step) + '</span></div>';
      }
      p.planList.innerHTML = html;
    }
  }

  function renderRows(p, d) {     // 数据链路
    var ai = (d && d.ai) || {};
    var rows = p.rows;
    setRow(rows[0], '服务', API_LABEL());
    setRow(rows[1], '传输', preferred === 'fetch' ? 'fetch（直连）' : preferred === 'xhr' ? 'XHR（兼容）' : 'JSONP（脚本）');
    setRow(rows[2], '刷新', CONFIG.pollMs + ' 毫秒');
    setRow(rows[3], '状态', online ? '已连接' : '未连接');
    setRow(rows[4], '会话总数', isNum(ai.sessions) ? ai.sessions + ' 个' : '—');
    setRow(rows[5], '服务版本', (d && d.server && d.server.version) ? 'v' + d.server.version : '—');
    setRow(rows[6], '预览', '8738 端口');
  }

  /* 状态片公共规则：不激活的先隐藏，最多 5 个；超过 5 个激活时前 4 个固定，
     第 5 个位置每 6 秒轮换一个未显示的激活 Agent（新增 Agent 也会轮到）。 */
  var CHIP_SLOTS = 5;
  var MIN_CHIPS = 3;   // 激活不足 3 个时，用最近激活过的补满 3 个
  var CHIP_ROT_MS = 6000;

  /* 状态片下限：激活的不足 3 个时，用最近激活过的 Agent 补齐到 3 个。
     传入的 active 和 all 来自同一批对象，all 已按“运行中 → 时间倒序”排列，
     这里再按 ts 倒序兜底，保证补上来的是最后激活的几个。 */
  function chipBase(active, all, min) {
    min = min || MIN_CHIPS;
    if (active.length >= min) return active.slice();
    var extra = [], i;
    for (i = 0; i < all.length; i++) {
      var x = all[i];
      if (!x || active.indexOf(x) >= 0) continue;
      extra.push(x);
    }
    extra.sort(function (a, b) {
      var ta = isNum(a.ts) ? a.ts : (isNum(a.ageSec) ? -a.ageSec * 1000 : 0);
      var tb = isNum(b.ts) ? b.ts : (isNum(b.ageSec) ? -b.ageSec * 1000 : 0);
      return tb - ta;
    });
    return active.concat(extra.slice(0, min - active.length));
  }

  function chipWindow(p, key, items, slots) {
    slots = slots || CHIP_SLOTS;
    if (items.length <= slots) {
      p[key + 'RotAt'] = 0;
      p[key + 'Rot'] = 0;
      return items.slice();
    }
    var now = Date.now();
    var atKey = key + 'RotAt';
    if (!p[atKey]) p[atKey] = now;
    else if (now - p[atKey] >= CHIP_ROT_MS) {
      p[atKey] = now;
      p[key + 'Rot'] = (p[key + 'Rot'] || 0) + 1;
    }
    var keep = slots - 1;
    var rest = items.slice(keep);
    var pick = rest[(p[key + 'Rot'] || 0) % rest.length];
    return items.slice(0, keep).concat(pick ? [pick] : []);
  }

  /* Agent 思考流：顶部是每个 Agent 的状态片，下方用打字机播报最近一条
     思考 / 输出；点击状态片可以锁定某个 Agent（再点一次恢复跟随最新）。 */
  function renderStreams(p, d) {
    var ai = (d && d.ai) || {};
    var list = Array.isArray(ai.streams) ? ai.streams : [];
    var st = p.stream;
    var focus = null, i;
    // 优先显示激活（正在生成 / 刚结束）的 Agent；不足 3 个时补最近激活过的。
    var active = [];
    for (i = 0; i < list.length; i++) {
      var si = list[i];
      if (si && (si.working || si.state === 'live' || si.state === 'active')) active.push(si);
    }
    // 激活不足 3 个时补上最近激活过的，至少显示 3 个状态片。
    var base = chipBase(active, list);
    var pinnedEntry = null;
    if (st.pinned) {
      for (i = 0; i < base.length; i++) {
        if (base[i].agent === st.pinned) { pinnedEntry = base[i]; break; }
      }
      // 锁定的 Agent 已不再显示：取消锁定，窗口回到最近激活列表。
      if (!pinnedEntry) st.pinned = null;
    }
    var view;
    if (pinnedEntry) {
      var others = [];
      for (i = 0; i < base.length; i++) if (base[i] !== pinnedEntry) others.push(base[i]);
      view = [pinnedEntry].concat(chipWindow(p, 'stm', others, CHIP_SLOTS - 1));
    } else {
      view = chipWindow(p, 'stm', base, CHIP_SLOTS);
    }
    focus = pinnedEntry || active[0] || base[0] || null;
    var focusAgent = focus ? focus.agent : null;

    if (p.forceCompact && p.el.clientWidth >= 340) p.forceCompact = false;
    var narrow = p.el.clientWidth < 340 || !!p.forceCompact;
    var sig = (focusAgent || '') + (narrow ? '|c' : '|f') +
      '|' + Math.round(p.el.clientWidth / 20) + '|';
    for (i = 0; i < view.length; i++) {
      sig += view[i].agent + ':' + view[i].state + ':' + (view[i].working ? 1 : 0) + ',';
    }
    if (sig !== st.sig) {
      st.sig = sig;
      if (!view.length) {
        p.chips.innerHTML = '<span class="ss-chip">暂无 Agent 数据</span>';
      } else {
        var html = '';
        for (i = 0; i < view.length; i++) {
          var a = view[i];
          var fullLabel = String(a.agent).toUpperCase();
          var label = narrow ? compactAgent(a.agent) : fullLabel;
          var tip = fullLabel + ' · ' + (a.state || '—') +
            (isNum(a.ageSec) ? ' · ' + ssAgeLabel(a.ageSec) : '');
          html += '<span class="ss-chip' + (a.agent === focusAgent ? ' on' : '') +
            (a.state === 'live' || a.working ? ' live' : '') +
            '" data-agent="' + escAttr(a.agent) + '" title="' + escAttr(tip) + '">' +
            '<i class="ss-dot"></i>' + esc(label) + '</span>';
        }
        p.chips.innerHTML = html;
        // 窄屏先换短标签；仍然放不下就收掉末尾几个，用 +N 标记（悬停可看是谁）
        if (!narrow && p.chips.scrollWidth > p.chips.clientWidth + 1) {
          p.forceCompact = true;
          p.stream.sig = '';
          renderStreams(p, d);
          return;
        }
        if (narrow) {
          var remain = p.chips.querySelectorAll('.ss-chip[data-agent]');
          var cut = [];
          while (p.chips.scrollWidth > p.chips.clientWidth + 1 && remain.length > 1) {
            var lastChip = remain[remain.length - 1];
            cut.push(lastChip.getAttribute('data-agent'));
            p.chips.removeChild(lastChip);
            remain = p.chips.querySelectorAll('.ss-chip[data-agent]');
          }
          if (cut.length) {
            var more = document.createElement('span');
            more.className = 'ss-chip more';
            more.textContent = '+' + cut.length;
            more.title = cut.join(' · ');
            p.chips.appendChild(more);
          }
        }
        var chips = p.chips.querySelectorAll('.ss-chip[data-agent]');
        for (i = 0; i < chips.length; i++) {
          chips[i].onclick = (function (name) {
            return function (e) {
              if (e && e.stopPropagation) e.stopPropagation();
              p.stream.pinned = (p.stream.pinned === name) ? null : name;
              p.stream.sig = '';
              renderStreams(p, d);
              return false;
            };
          })(chips[i].getAttribute('data-agent'));
        }
      }
    }

    if (!focus) {
      if (st.full !== '等待 Agent 输出…') {
        st.agent = null; st.full = '等待 Agent 输出…'; st.shown = 0; p.textNode.nodeValue = '';
      }
      p.metaSrc.textContent = '—';
      p.metaAge.textContent = '暂无数据';
      return;
    }
    var text = String(focus.text || '');
    if (st.agent !== focus.agent || st.full !== text) {
      st.agent = focus.agent;
      st.full = text;
      st.shown = 0;
      p.textNode.nodeValue = '';
    }
    p.metaSrc.textContent = String(focus.agent).toUpperCase() + ' · ' + ssStateLabel(focus) +
      ' · ' + (focus.kind === 'think' ? 'thinking' : 'output');
    var pending = (typeof focus.pendingSec === 'number');
    var running = !pending && focus.working && isNum(focus.workSec);
    var runTxt = running
      ? (focus.workSec < 60 ? focus.workSec + 's' : Math.round(focus.workSec / 60) + 'm')
      : '';
    p.metaAge.textContent = (pending ? '已等 ' + focus.pendingSec + 's'
      : (running ? '已运行 ' + runTxt : ssAgeLabel(focus.ageSec))) +
      (focus.title ? ' · ' + shortTitle(focus.title, 18) : '');
  }

  function renderAgents(p, d) {
    var ai = (d && d.ai) || {};
    // 活跃优先，其次按会话量；新增 Agent 会自动排进列表，颜色按名称固定
    var list = Array.isArray(ai.agents) ? ai.agents.slice() : [];
    list.sort(function (a, b) {
      var aa = a.active ? 1 : 0, ba = b.active ? 1 : 0;
      if (aa !== ba) return ba - aa;
      var as = a.sessions || 0, bs = b.sessions || 0;
      if (as !== bs) return bs - as;
      return String(a.agent || '').localeCompare(String(b.agent || ''));
    });

    // 显示行数由插件设置决定（默认 8，范围 3–12）；超出的 Agent 在末行轮换
    var maxRows = Math.max(3, Math.min(AG_MAX_ROWS, rowLimit('__hlAgentRows', 3, AG_MAX_ROWS)));
    var wrap = list.length > maxRows;
    var shown = list.slice(0, maxRows);
    if (wrap) {
      // 前 maxRows-1 行固定，最后一行每 6 秒轮换一个未显示的 Agent，新增的也能看到
      var keep = maxRows - 1;
      var now = Date.now();
      if (!p.agRotAt) p.agRotAt = now;
      else if (now - p.agRotAt >= AG_ROT_MS) { p.agRotAt = now; p.agRot = (p.agRot || 0) + 1; }
      var pick = list[keep + ((p.agRot || 0) % (list.length - keep))];
      shown = list.slice(0, keep).concat(pick ? [pick] : []);
    } else {
      p.agRotAt = 0;
      p.agRot = 0;
    }

    ensureAgentRows(p, Math.max(4, shown.length));
    for (var i = 0; i < p.rows.length; i++) {
      var row = p.rows[i];
      var a = shown[i];
      if (!a) {
        row.el.style.display = 'none';
        row.el.classList.remove('on', 'bump');
        row.sig = '';
        clearTimeout(row.bumpTimer);
        continue;
      }
      row.el.style.display = '';
      var name = String(a.agent || '—');
      if (row.colorName !== name) {
        var col = agentColor(name);
        row.el.style.setProperty('--agc', col.hex);
        row.el.style.setProperty('--agr', col.rgb);
        row.colorName = name;
      }
      // 名称交给 CSS 省略号裁切；悬停 title 可看完整名与颜色
      row.id.textContent = name;
      row.id.title = name + ' · ' + fmtInt(a.sessions) + ' 个会话';
      // 亮格数：活跃代理全亮，其余按会话量给一点底色
      var lit = a.active ? 8 : Math.min(3, Math.max(1, Math.round((a.sessions || 0) / 5)));
      for (var j = 0; j < row.cells.length; j++) {
        row.cells[j].className = 'cell' + (j < lit ? ' on' : '');
      }
      row.st.textContent = a.active ? '运行中' : ((a.sessions || 0) + '会话');
      row.el.classList.toggle('on', !!a.active);
      // 状态真正变化时给整行一次短暂的亮起，让轮询里的变化更容易被注意到
      var sig = name + '|' + (a.active ? '1' : '0') + '|' + lit + '|' + (a.sessions || 0);
      if (row.sig !== sig) {
        row.sig = sig;
        row.el.classList.add('bump');
        clearTimeout(row.bumpTimer);
        row.bumpTimer = setTimeout(function (el) {
          return function () { el.classList.remove('bump'); };
        }(row.el), 700);
      }
    }
    p.el.classList.toggle('ag-dense', shown.length > 6);
    if (p.titleEl) {
      var t = '代理调度' + (list.length ? ' · ' + list.length : '');
      if (p.titleEl.textContent !== t) p.titleEl.textContent = t;
    }
    if (p.headEl) {
      p.headEl.title = (wrap
        ? '共 ' + list.length + ' 个 Agent，当前显示 ' + shown.length + ' 行，末行每 6 秒轮换'
        : '按活跃优先排序，每个 Agent 的颜色按名称固定') + '；仅显示有未归档会话的 Agent';
    }
  }

  /* ---- 画布面板 ---- */
  function ensureCanvas(p) {
    var c = p.canvas;
    if (!c) return null;
    var r = c.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return null;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = Math.round(r.width), h = Math.round(r.height);
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
      p.ctx = null;
    }
    if (!p.ctx) {
      p.ctx = c.getContext('2d');
      if (!p.ctx) return null;
    }
    p.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { x: p.ctx, w: w, h: h };
  }

  var FONT_SM = '8px ui-monospace,"Cascadia Mono",Consolas,monospace';

  function chartFrame(o) {
    var x = o.x, w = o.w, h = o.h;
    x.clearRect(0, 0, w, h);
    x.strokeStyle = 'rgba(37,40,46,.9)';
    x.lineWidth = 1;
    x.beginPath();
    x.moveTo(0, h - 0.5); x.lineTo(w, h - 0.5);
    x.moveTo(0, 0.5); x.lineTo(w, 0.5);
    x.stroke();
  }

  function drawSeries(o, data, color, max, fill, hLimit) {
    var x = o.x, w = o.w, n = data.length;
    var h = hLimit || o.h;
    if (n < 2) return null;
    var step = w / (n - 1);
    var top = h * 0.16, bot = h * 0.94;
    var lastY = bot;
    x.beginPath();
    for (var i = 0; i < n; i++) {
      var px = i * step;
      var py = bot - (Math.min(max, data[i]) / max) * (bot - top);
      if (i === 0) x.moveTo(px, py); else x.lineTo(px, py);
      lastY = py;
    }
    x.strokeStyle = color;
    x.lineWidth = 1.1;
    x.stroke();
    if (fill) {
      x.lineTo(w, h);
      x.lineTo(0, h);
      x.closePath();
      var g = x.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, fill);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      x.fillStyle = g;
      x.fill();
    }
    return { x: w, y: lastY };
  }

  function label(x, text, px, py, color, font) {
    x.font = font || FONT_SM;
    x.fillStyle = color;
    x.textBaseline = 'top';
    x.fillText(text, px, py);
  }

  /** Trim text to maxW pixels, appending an ellipsis. Caller sets x.font first. */
  function clipText(x, text, maxW) {
    if (!text || maxW <= 2) return '';
    if (x.measureText(text).width <= maxW) return text;
    var lo = 0, hi = text.length;
    while (lo < hi) {
      var mid = (lo + hi + 1) >> 1;
      if (x.measureText(text.slice(0, mid) + '…').width <= maxW) lo = mid;
      else hi = mid - 1;
    }
    return lo > 2 ? text.slice(0, lo) + '…' : '';
  }

  function drawPane(p, d) {
    var o = ensureCanvas(p);
    if (!o) return;
    var ai = (d && d.ai) || {};
    chartFrame(o);
    if (p.index === 1) {              // 令牌吞吐
      var max = 1;
      for (var i = 0; i < CON.hist.tps.length; i++) if (CON.hist.tps[i] > max) max = CON.hist.tps[i];
      max = Math.max(max * 1.15, 100);
      drawSeries(o, CON.hist.tps, '#98e0cf', max, 'rgba(152,224,207,.28)');
      label(o.x, '现在 ' + fmtRate(ai.tokensPerSec) + ' tok/s', 2, 2, '#f4f5f7');
      label(o.x, '命中率 ' + (isNum(ai.cacheHitRate) ? fmtPct(ai.cacheHitRate) : '—'),
        o.w - 62, 2, 'rgba(152,224,207,.85)');
      label(o.x, '峰值 ' + fmtRate(max) + ' · 90 秒', 2, o.h - 12, '#6b6f78');
    } else if (p.index === 3) {       // CPU / GPU / diskIO 实时负载（红=CPU，紫=GPU，蓝=硬盘）
      var chartH = Math.max(28, o.h - 46);
      var showGpu3 = gpuVisible();
      var gpuNow = (showGpu3 && d && d.gpu && isNum(d.gpu.utilization)) ? d.gpu.utilization : null;
      var diskNow = (d && d.disk && isNum(d.disk.utilization)) ? d.disk.utilization : null;
      var lastDisk = diskNow === null ? null
        : drawSeries(o, CON.hist.disk, '#5aa9ff', 100, 'rgba(90,169,255,.14)', chartH);
      // 不工作时（不可用或 0%）不画 GPU 曲线，避免贴底的紫线被误读成负载
      var gpuBusy = gpuNow !== null && gpuNow > 0;
      var lastGpu = gpuBusy
        ? drawSeries(o, CON.hist.gpu, '#b98cff', 100, 'rgba(185,140,255,.16)', chartH) : null;
      var lastCpu = drawSeries(o, CON.hist.cpu, '#ff6b6b', 100, 'rgba(255,107,107,.18)', chartH);
      if (lastDisk) { o.x.fillStyle = '#a9d0ff'; o.x.fillRect(o.w - 3, lastDisk.y - 1.5, 3, 3); }
      if (lastGpu) { o.x.fillStyle = '#d9c4ff'; o.x.fillRect(o.w - 3, lastGpu.y - 1.5, 3, 3); }
      if (lastCpu) { o.x.fillStyle = '#ffb3b3'; o.x.fillRect(o.w - 3, lastCpu.y - 1.5, 3, 3); }
      var cpuTxt3 = 'CPU ' + fmtPct(d && d.cpu);
      var gpuTxt3 = showGpu3 ? ('GPU ' + (gpuNow === null ? '—' : fmtPct(gpuNow))) : '';
      // 具体是哪块盘（sda / nvme0n1）放在悬浮说明里，图例统一叫 diskIO
      var diskTxt3 = 'diskIO ' + (diskNow === null ? '—' : fmtPct(diskNow));
      label(o.x, cpuTxt3, 2, 2, '#ff6b6b');
      o.x.font = FONT_SM;
      // 图例顺序：左 CPU、中 diskIO、右 GPU
      var diskW3 = o.x.measureText(diskTxt3).width;
      var gpuW3 = showGpu3 ? o.x.measureText(gpuTxt3).width : 0;
      label(o.x, diskTxt3, Math.max(o.x.measureText(cpuTxt3).width + 12, (o.w - diskW3) / 2), 2, '#5aa9ff');
      if (showGpu3) label(o.x, gpuTxt3, o.w - gpuW3 - 2, 2, '#b98cff');

      // 每个逻辑核心一根小柱（红色，和 CPU 曲线同色；≥80% 更亮）
      var cores = (d && d.cpuCores) || [];
      var nCores = cores.length;
      if (nCores) {
        var bw = (o.w - 2) / nCores;
        var by = chartH + 7;
        var bh = Math.max(6, o.h - by - 12);
        for (var ci = 0; ci < nCores; ci++) {
          var cval = clamp(cores[ci], 0, 100) / 100;
          var chh = Math.max(1, bh * cval);
          o.x.fillStyle = cores[ci] >= 80 ? 'rgba(255,214,102,.95)' : 'rgba(255,214,102,.5)';
          o.x.fillRect(ci * bw + 0.5, by + (bh - chh), Math.max(1.5, bw - 1.6), chh);
        }
        label(o.x, nCores + ' 核 · 内存 ' + fmtPct(d && d.ram) + ' · 每秒采样', 2, o.h - 10, '#5c6068');
      }
    } else if (p.index === 5) {       // 正在运行的 Agent：最近工具调用
      var wantRows = rowLimit('__hlToolRows', 3, 15);
      // 面板高度放不下时按行数上限缩，保证设置条数不会把最后几行裁掉
      var fitRows = Math.max(1, Math.floor((o.h - 14) / 10));
      var list = (ai.recentTools || []).slice(0, Math.min(wantRows, fitRows));
      var src = toolSourceLabel(ai);
      var showAgent = list.length && ai.toolAgents && ai.toolAgents.length > 1;
      if (src) label(o.x, src, 2, 1, '#98e0cf');
      var cntTxt = list.length ? '最近 ' + list.length + ' 条' : '';
      if (cntTxt) {
        o.x.font = FONT_SM;
        label(o.x, cntTxt, o.w - o.x.measureText(cntTxt).width - 3, 1, '#6b7079');
      }
      if (!list.length) {
        label(o.x, '当前没有工具调用', 2, Math.max(20, o.h / 2 - 6), '#4a4f57');
      } else {
        // 行高压在 9–13px：设置的行数多时自动压缩，而不是把最后几行挤出面板
        var y0 = 14, lh = Math.max(9, Math.min(13, (o.h - y0 - 2) / Math.max(1, list.length)));
        var rows = Math.min(list.length, Math.floor((o.h - y0) / lh));
        for (var ti = 0; ti < rows; ti++) {
          var t = list[ti] || {};
          var yy = y0 + ti * lh;
          var col = t.state === 'error' ? '#ff6b6b' : (t.state === 'running' ? '#98e0cf' : '#7b818b');
          o.x.fillStyle = col;
          o.x.fillRect(2, yy + 3.5, 3.5, 3.5);
          o.x.font = FONT_SM;
          var nmText = (showAgent && t.agent ? agentShort(t.agent) + '·' : '') + String(t.name || '?');
          var nm = clipText(o.x, nmText, showAgent ? 104 : 86);
          label(o.x, nm, 10, yy, col === '#7b818b' ? '#b9bec6' : col);
          var ageTxt = isNum(t.ageSec)
            ? (t.ageSec < 60 ? t.ageSec + 's' : (t.ageSec < 3600 ? Math.round(t.ageSec / 60) + 'm' : Math.round(t.ageSec / 3600) + 'h'))
            : '';
          var ageW = ageTxt ? o.x.measureText(ageTxt).width + 4 : 0;
          o.x.font = FONT_SM;
          var nameW = o.x.measureText(nm).width;
          var argMax = o.w - 10 - nameW - 6 - ageW - 3;
          var argTxt = t.arg ? clipText(o.x, String(t.arg), argMax) : '';
          if (argTxt) label(o.x, argTxt, 10 + nameW + 6, yy, '#5d626a');
          if (ageTxt) {
            o.x.font = FONT_SM;
            o.x.textAlign = 'right';
            label(o.x, ageTxt, o.w - 3, yy, t.state === 'running' ? '#6f8f89' : '#4d525a');
            o.x.textAlign = 'left';
          }
        }
      }
    } else if (p.index === 7) {       // 系统负载索引：CPU 红 / diskIO 蓝 / 内存 绿 / 网络 黄
      var cols = 60, rows = 4;
      var cw = o.w / cols, chh = o.h / rows;
      var metrics = [CON.hist.cpu, CON.hist.disk, CON.hist.ram, CON.hist.net];
      var tints = ['rgba(255,107,107,', 'rgba(90,169,255,', 'rgba(110,220,150,', 'rgba(240,200,80,'];
      for (var mi = 0; mi < rows; mi++) {
        var arr = metrics[mi] || [];
        for (var ci = 0; ci < cols; ci++) {
          var hidx = arr.length - cols + ci;
          var hv = hidx >= 0 ? arr[hidx] : 0;
          var hnorm = Math.max(0, Math.min(1, hv / 100));
          // 磁盘的 %util 天然偏低（几百 MB/s 也只有 10~20%），平方根压缩让小负载也能看出来
          var shown = mi === 1 ? Math.sqrt(hnorm) : hnorm;
          o.x.fillStyle = (mi === 1 ? hnorm <= 0.002 : hnorm <= 0.02)
            ? '#16181c'
            : tints[mi] + (0.18 + shown * 0.8).toFixed(2) + ')';
          o.x.fillRect(ci * cw, mi * chh + 9, cw - 0.6, chh - 10);
        }
      }
      label(o.x, 'CPU 红 / 硬盘IO 蓝 / 内存 绿 / 网络 黄', 2, 0, '#6b6f78');
    }
  }

  /* ==================================================================
     交互：接管页面相机（updateCam）
       · 单击画面   -> 相机推到点击点（原生渲染，清晰不糊）
       · 滚轮       -> 圆环旋转（"转圈"）
       · 双击小卡片 -> 相机飞到那张卡片上，放大到能看清内容
       · Esc / Z    -> 回到自动运镜
     ================================================================== */

  var CAM = {
    hooked: false,
    active: false,
    level: 0,                 // 0 = 1×, 1 = 2×, 2 = 3×
    tx: 0, ty: 0, tz: 1,
    focus: null,
    drag: null,
    idleTimer: 0,
    ringHooked: false,
    manualSpinUntil: 0,       // 手动滚轮转环后的保护期，期间不让节拍自动转向覆盖
    spinActive: false,        // 当前是否有 agent 活动；false 时圆环自动冻结
    rate: 0,                  // 当前节拍/圆环倍率（0=停，1=正常，最高约 1.8）
    rateTarget: 0,            // 由 tokensPerSecond 计算的目标倍率
    tps: 0,                   // 最近一次采样的 tokens/s，调试用
    pendingSec: null,         // 最近一个未完成回合已持续多少秒（内部模型没有 usage 时的主要信号）
    planBusy: false,          // 是否有运行中的任务计划
    beatHooked: false,
    idleHome: false,          // 正在平滑收回默认视角
    lastManualAt: 0,          // 最后一次手动缩放/平移时间，空闲复位前留一点操作缓冲
    spin: 0
  };

  function pageGeo() {
    try {
      if (typeof cam !== 'object' || !cam) return null;
      if (typeof W !== 'number' || typeof H !== 'number') return null;
      return {
        cam: cam, W: W, H: H, cx: cx, cy: cy, R: R, RO: RO,
        slots: (typeof slots === 'object' && slots) ? slots : null,
        ringRot: ringRot,
        normA: (typeof normA === 'function') ? normA : null
      };
    } catch (e) { return null; }
  }

  function installCameraHook() {
    if (CAM.hooked) return true;
    try {
      if (typeof updateCam !== 'function') return false;
      var orig = updateCam;
      updateCam = function (dt) {
        if (CAM.active) { camTick(dt); return; }
        if (!CONFIG.autoCamera) return;
        // 空闲时同样停住镜头：没有 agent 活动就保持当前机位，不再自动推拉
        if (!CONFIG.camWhenIdle && !CAM.spinActive) return;
        orig(dt);
      };
      CAM.hooked = true;
      return true;
    } catch (e) { return false; }
  }

  /** 圆环旋转：官方自动转 + 手动滚轮短暂优先；关掉自转时只跑我们的缓动 */
  function installRingHook() {
    if (CAM.ringHooked) return true;
    try {
      if (typeof updateRing !== 'function') return false;
      var origUpdate = updateRing;
      updateRing = function (dt) {
        // 倍率由 installBeatHook 每帧推进（drawStage 先跑节拍再跑圆环）。
        if (CONFIG.autoSpin && CAM.spinActive) { origUpdate(dt * CAM.rate); return; }
        // 空闲（或手动关闭自转）：不跑官方的 0.02 慢漂移，圆环真正停住；
        // 但滚轮触发的这段缓动仍要走完，手动操作不受影响。
        if (rot && rot.t < rot.dur) {
          rot.t += dt;
          ringRot = rot.from + (rot.to - rot.from) * rot.ease(Math.min(1, rot.t / rot.dur));
        }
      };
      if (typeof ringMove === 'function') {
        var origMove = ringMove;
        ringMove = function () {
          if (!CONFIG.autoSpin || !CAM.spinActive) return;
          if (Date.now() < CAM.manualSpinUntil) return;   // 刚用滚轮转过，别马上被节拍改回去
          origMove();
        };
      }
      CAM.ringHooked = true;
      return true;
    } catch (e) { return false; }
  }

  function camTick(dt) {
    var k = Math.min(1, dt * 6.5);
    cam.x += (CAM.tx - cam.x) * k;
    cam.y += (CAM.ty - cam.y) * k;
    cam.z += (CAM.tz - cam.z) * Math.min(1, dt * 5);
    if (Math.abs(CAM.tz - cam.z) < 0.008) cam.z = CAM.tz;
    // 空闲收回默认视角完成后交还页面；页面在空闲时同样停住，所以不会再被推近。
    if (CAM.idleHome &&
        Math.abs(CAM.tz - cam.z) < 0.01 &&
        Math.abs(CAM.tx - cam.x) < 1 &&
        Math.abs(CAM.ty - cam.y) < 1) {
      cam.z = CAM.tz; cam.x = CAM.tx; cam.y = CAM.ty;
      CAM.active = false;
      CAM.idleHome = false;
    }
  }

  function worldAt(sx, sy) {
    var g = pageGeo();
    if (!g) return null;
    return {
      x: (sx - g.W / 2) / g.cam.z + g.cam.x,
      y: (sy - g.H / 2) / g.cam.z + g.cam.y,
      g: g
    };
  }

  function zoomTo(x, y, z) {
    if (!installCameraHook()) return false;
    var g = pageGeo();
    if (!g) return false;
    CAM.active = true;
    CAM.tx = x; CAM.ty = y; CAM.tz = clamp(z, 0.8, 9);
    CON.zoomed = true;
    vd.pulse = Math.min(1.2, vd.pulse + 0.55);
    vd.forceFrames = 3;
    scheduleVisual();
    return true;
  }

  var ZOOM_STEPS = [1, 2, 3];   // 1× / 放大 1 倍 / 放大 2 倍

  /** 20 秒没有操作就回到初始视角 */
  function touchIdle() {
    CAM.lastManualAt = Date.now();
    CAM.idleHome = false;
    clearTimeout(CAM.idleTimer);
    CAM.idleTimer = setTimeout(resetView, CONFIG.resetViewMs);
  }

  /** 所有 Agent 停工时，把放大/平移过的视角平滑收回默认 1× 居中。 */
  function idleCameraReset() {
    var g = pageGeo();
    if (!g) return;
    var atHome = Math.abs(g.cam.z - 1) < 0.01 &&
      Math.abs(g.cam.x - g.W / 2) < 1 && Math.abs(g.cam.y - g.H / 2) < 1;
    if (atHome && !CAM.active) { CON.zoomed = false; CAM.level = 0; return; }
    if (!installCameraHook()) return;
    CAM.level = 0;
    CAM.drag = null;
    CAM.focus = null;
    CAM.idleHome = true;
    CAM.active = true;
    CAM.tx = g.W / 2;
    CAM.ty = g.H / 2;
    CAM.tz = 1;
    CON.zoomed = false;
    scheduleVisual();
  }

  function resetView() {
    clearTimeout(CAM.idleTimer);
    CAM.level = 0;
    CAM.drag = null;
    CAM.focus = null;
    CON.zoomed = false;
    if (CONFIG.autoCamera) {                    // 自动运镜开着时交还给页面继续运镜
      CAM.active = false;
      if (typeof releaseCamera === 'function') releaseCamera();
      return;
    }
    var g = pageGeo();
    if (!g || !installCameraHook()) return;
    CAM.active = true;
    CAM.tx = g.W / 2;
    CAM.ty = g.H / 2;
    CAM.tz = 1;
  }

  /** 缩放档位：1× / 1.8× / 2.6×，单击走一档，双击到第二档 */
  function setZoomLevel(level, sx, sy) {
    var g = pageGeo();
    if (!g || !installCameraHook()) return;
    level = clamp(level, 0, ZOOM_STEPS.length - 1);
    CAM.level = level;
    CAM.active = true;
    CAM.focus = null;
    if (level === 0) {
      CAM.tx = g.W / 2;
      CAM.ty = g.H / 2;
      CAM.tz = 1;
      CON.zoomed = false;
    } else {
      if (isNum(sx)) {
        var p = worldAt(sx, sy);
        if (p) { CAM.tx = p.x; CAM.ty = p.y; }
      }
      CAM.tz = ZOOM_STEPS[level];
      CON.zoomed = true;
    }
    flashScreen(level > 0);
    touchIdle();
    scheduleVisual();
  }

  /** 单击：下一档（1× → 1.8× → 2.6× → 回到 1×） */
  function clickStep(sx, sy) {
    setZoomLevel((CAM.level + 1) % ZOOM_STEPS.length, sx, sy);
  }

  /** 双击：直接到第二档；已经在第二档就复位 */
  function dblStep(sx, sy) {
    setZoomLevel(CAM.level >= 2 ? 0 : 2, sx, sy);
  }

  /* ---- 按住右键拖动视角 ---- */
  function beginDrag(e) {
    var g = pageGeo();
    if (!g || !installCameraHook()) return;
    CAM.active = true;
    CAM.drag = { x: e.clientX, y: e.clientY };
    CAM.tx = g.cam.x;
    CAM.ty = g.cam.y;
    CAM.tz = g.cam.z;
    try { document.body.style.setProperty('cursor', 'grabbing', 'important'); } catch (err) { /* ignore */ }
    touchIdle();
  }

  /** 按屏幕像素平移视角（左/右键拖动、__aiLink.pan 共用） */
  function panBy(dx, dy) {
    var g = pageGeo();
    if (!g || !installCameraHook()) return;
    CAM.active = true;
    var z = Math.max(0.5, g.cam.z);
    CAM.tx = clamp(CAM.tx - dx / z, -g.W * 0.15, g.W * 1.15);
    CAM.ty = clamp(CAM.ty - dy / z, -g.H * 0.15, g.H * 1.15);
    g.cam.x = CAM.tx;
    g.cam.y = CAM.ty;
    touchIdle();
  }

  function endDrag() {
    if (!CAM.drag) return;
    CAM.drag = null;
    try { document.body.style.removeProperty('cursor'); } catch (err) { /* ignore */ }
    touchIdle();
  }

  /** 双击命中圆环上的小卡片就飞过去（Ctrl + 双击） */
  function focusSlot(sx, sy) {
    var p = worldAt(sx, sy);
    if (!p) return false;
    var g = p.g;
    if (!g.slots || !g.slots.length) return false;

    var ang = Math.atan2(p.y - g.cy, p.x - g.cx);
    var best = null, bd = 99;
    for (var i = 0; i < g.slots.length; i++) {
      var s = g.slots[i];
      var d = Math.abs(g.normA ? g.normA(s.a + g.ringRot - ang) : (s.a + g.ringRot - ang));
      if (d < bd) { bd = d; best = s; }
    }
    if (!best || bd > 0.3) return false;      // 点得离环带太远，不算选中卡片

    var A = best.a + g.ringRot;
    var rr = (g.R + g.RO) / 2;
    var px = g.cx + Math.cos(A) * rr;
    var py = g.cy + Math.sin(A) * rr;
    var band = Math.max(40, g.RO - g.R);
    var z = clamp(0.85 * Math.min(g.W, g.H) / band, 2.2, 9);
    CAM.focus = { slot: best, at: Date.now() };
    zoomTo(px, py, z);
    CAM.level = 2;
    touchIdle();
    flashScreen(true);
    if (el.fxScan) {
      try {
        el.fxScan.style.animation = 'none';
        void el.fxScan.offsetWidth;
        el.fxScan.style.animation = 'aix-fx-sweep 700ms linear forwards';
      } catch (e) { /* ignore */ }
    }
    return true;
  }

  function releaseCamera() {
    // 兼容旧调用：自动运镜开着就交还页面，否则回到初始视角
    if (CONFIG.autoCamera) {
      var g = pageGeo();
      if (g && installCameraHook()) {
        CAM.active = false;
        try {
          camFrom = { x: cam.x, y: cam.y, z: cam.z };
          camPhase = 'move';
          shotT = 0;
        } catch (e) { /* ignore */ }
      }
      CAM.focus = null;
      CON.zoomed = false;
      return;
    }
    resetView();
  }

  /** 滚轮：转动圆环 */
  function spinBy(delta) {
    try {
      if (typeof rot !== 'object' || !rot) return;
      CAM.manualSpinUntil = Date.now() + 1400;   // 手动操作后 1.4 秒内压过节拍自动转向
      rot.from = ringRot;
      rot.to = ringRot + delta;
      rot.t = 0;
      rot.dur = 0.42;
      rot.ease = function (t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; };
      rot.hold = 0.25;
      if (CAM.focus) { /* 聚焦时也允许转，卡片会跟着转走 */ }
    } catch (e) { /* ignore */ }
  }

  /* ==================================================================
     环带上的数据小卡片：接管页面的 renderSlot()，把假数据换成真实 AI 数据
     ================================================================== */

  var CARD_ICONS = {};

  function cardIcon(name, src) {
    if (!src) return null;
    var rec = CARD_ICONS[name];
    if (rec && rec.src === src) return rec.img.complete ? rec.img : null;
    try {
      var img = new Image();
      img.src = src;
      CARD_ICONS[name] = { src: src, img: img };
      return img.complete ? img : null;
    } catch (e) { return null; }
  }

  function fitText(x, text, maxW, font) {
    x.font = font;
    if (x.measureText(text).width <= maxW) return text;
    var t = String(text);
    while (t.length > 1 && x.measureText(t + '…').width > maxW) t = t.slice(0, -1);
    return t + '…';
  }

  function drawAiCard(x, s, w, h) {
    var d = CON.last || {};
    var procs = Array.isArray(CON.list) ? CON.list : (Array.isArray(d.top) ? d.top : []);
    var pad = 8;
    try { if (typeof rimW === 'function') pad = rimW() + 8; } catch (e) { /* ignore */ }

    // 底纹：右侧一条随机条码，保持原版的"仪表"质感
    var bx = w * 0.72, bw = w * 0.22;
    for (var i = 0; i < 10; i++) {
      var bh = (0.15 + Math.random() * 0.7) * h;
      x.fillStyle = 'rgba(225,228,236,' + (0.05 + Math.random() * 0.2).toFixed(2) + ')';
      x.fillRect(bx + i * (bw / 10), (h - bh) / 2, Math.max(1, bw / 26), bh);
    }

    // 每张卡片按"在 slots 里的位置"固定领一个进程，一格一个，不循环
    if (s._idx === undefined) {
      try { s._idx = (typeof slots === 'object' && slots && slots.indexOf) ? slots.indexOf(s) : 0; } catch (e) { s._idx = 0; }
      if (s._idx < 0) s._idx = 0;
    }
    if (!s._pname && s._idx < procs.length) s._pname = procs[s._idx].name;
    if (!s._pname) return;                      // 没有进程占用这格 —— 留空，只保留底纹

    var it = (CON.procMap && CON.procMap[s._pname]) || procs[s._idx] || null;
    if (!it) it = { name: s._pname, cpu: null, memMB: null, icon: null };
    var live = !!(CON.procLive && CON.procLive[it.name]);
    var dim = live ? 1 : 0.45;
    var useMem = false;
    var cpuTxt = isNum(it.cpu) ? it.cpu.toFixed(1) + '%' : '—';
    var memTxt = isNum(it.memMB) ? (it.memMB >= 1024 ? (it.memMB / 1024).toFixed(1) + 'G' : it.memMB + 'M') : '—';
    var mainTxt = cpuTxt;

    // 图标（来自服务端从 exe 里抽的 PNG），在下面"五行"的第一行绘制
    var ico = cardIcon(it.name, it.icon);
    var d0 = CON.last || {};
    var net = d0.net || {};
    var netTxt = (isNum(net.rxPerSec) || isNum(net.txPerSec))
      ? fmtBps((net.rxPerSec || 0) + (net.txPerSec || 0)) : '—';

    // 紧凑模式（应用多、卡片小）：横向排版 图标 + 名字 + 指标
    if (CON.compact) {
      var iz = Math.min(h - 2, Math.max(8, h * 0.52));
      var cx2 = pad;
      if (ico) {
        try { x.drawImage(ico, pad, (h - iz) / 2, iz, iz); } catch (e) { /* ignore */ }
        cx2 = pad + iz + 3;
      }
      var fa = Math.max(3.4, Math.min(9, h * 0.30));
      var fb = Math.max(5, Math.min(15, h * 0.46));
      var nameFont2 = '700 ' + fa.toFixed(2) + 'px ui-monospace,Consolas,monospace';
      x.fillStyle = 'rgba(152,224,207,' + (0.92 * dim).toFixed(2) + ')';
      var totalH2 = fa + fb + (h > 30 ? 1.6 + Math.max(3.4, Math.min(8, h * 0.26)) : 0);
      var ty2 = Math.max(0.6, (h - totalH2) / 2);
      x.fillText(fitText(x, it.name || '—', w - cx2 - 8, nameFont2), cx2, ty2);
      x.font = '800 ' + fb.toFixed(2) + 'px ui-monospace,Consolas,monospace';
      x.fillStyle = (isNum(it.cpu) && it.cpu >= 5) ? 'rgba(240,166,198,' + (0.98 * dim).toFixed(2) + ')' : 'rgba(235,238,244,' + (0.96 * dim).toFixed(2) + ')';
      x.fillText('CPU ' + (isNum(it.cpu) ? it.cpu.toFixed(1) + '%' : '—'), cx2, ty2 + fa + 1.0);
      if (h > 30) {
        var f3 = Math.max(3.4, Math.min(8, h * 0.26));
        var third = 'GPU ' + (isNum(it.gpu) && it.gpu > 0 ? Math.round(it.gpu) + '%' : '—') + ' · ' +
          (isNum(it.memMB) ? (it.memMB >= 1024 ? (it.memMB / 1024).toFixed(1) + 'G' : it.memMB + 'M') : '—') + ' · ' + netTxt;
        x.font = '700 ' + f3.toFixed(2) + 'px ui-monospace,Consolas,monospace';
        x.fillStyle = 'rgba(140,146,158,' + (0.95 * dim).toFixed(2) + ')';
        x.fillText(fitText(x, third, w - cx2 - 8, '700 ' + f3.toFixed(2) + 'px ui-monospace,Consolas,monospace'), cx2, ty2 + fa + fb + 2.2);
      }
      return;
    }

    // 五行竖排：图标 / CPU / GPU / 内存 / 网络（d0/net/netTxt 已在上面声明）
    var rows = [
      { kind: 'icon' },
      { kind: 'cpu', t: 'CPU ' + (isNum(it.cpu) ? it.cpu.toFixed(1) + '%' : '—') },
      { kind: 'gpu', t: 'GPU ' + (isNum(it.gpu) && it.gpu > 0
        ? it.gpu.toFixed(1) + '%'
        : (d0.gpu && isNum(d0.gpu.utilization) ? Math.round(d0.gpu.utilization) + '%' : '—')) },
      { kind: 'mem', t: '内存 ' + (isNum(it.memMB) ? (it.memMB >= 1024 ? (it.memMB / 1024).toFixed(1) + 'G' : it.memMB + 'M') : '—') },
      { kind: 'net', t: '网络 ' + netTxt }
    ];
    var showRows = h >= 46 ? 5 : (h >= 34 ? 4 : 3);   // 卡片太矮就少放几行
    var useRows = rows.slice(0, showRows);
    var iconRowH = h * (showRows >= 5 ? 0.30 : 0.34);
    var textRowH = (h - iconRowH) / (useRows.length - 1);

    for (var ri = 0; ri < useRows.length; ri++) {
      var row = useRows[ri];
      if (row.kind === 'icon') {
        var isz = Math.min(iconRowH - 2, Math.max(18, h * 0.30), w * 0.20);
        if (ico) {
          try { x.drawImage(ico, pad, (iconRowH - isz) / 2, isz, isz); } catch (e) { /* ignore */ }
        }
        var nfs = Math.max(3.2, Math.min(16, textRowH * 0.42));
        x.font = '700 ' + nfs.toFixed(2) + 'px ui-monospace,Consolas,monospace';
        x.fillStyle = (it.sys ? 'rgba(150,152,160,' : 'rgba(152,224,207,') + (0.92 * dim).toFixed(2) + ')';
        x.fillText(fitText(x, it.name || '—', w - pad - (ico ? isz + 4 : 0) - 10,
          '700 ' + nfs.toFixed(2) + 'px ui-monospace,Consolas,monospace'),
          pad + (ico ? isz + 4 : 0), (iconRowH - nfs) / 2);
        continue;
      }
      var fs = Math.max(4.2, Math.min(26, textRowH * 0.70));
      var font = '800 ' + fs.toFixed(2) + 'px ui-monospace,Consolas,monospace';
      var color;
      if (row.kind === 'cpu') color = (isNum(it.cpu) && it.cpu >= 5) ? 'rgba(240,166,198,' + (0.98 * dim).toFixed(2) + ')' : 'rgba(235,238,244,' + (0.96 * dim).toFixed(2) + ')';
      else if (row.kind === 'gpu') color = 'rgba(196,184,246,' + (0.96 * dim).toFixed(2) + ')';
      else if (row.kind === 'net') color = 'rgba(226,204,120,' + (0.95 * dim).toFixed(2) + ')';
      else color = 'rgba(140,146,158,' + (0.95 * dim).toFixed(2) + ')';
      x.fillStyle = color;
      x.fillText(fitText(x, row.t, w - pad - 10, font), pad,
        iconRowH + (ri - 1) * textRowH + (textRowH - fs) * 0.5);
    }
  }

  /** 接管 buildCards：把原来随机 16~62px 的卡片统一加高，数量相应减少，五行才看得清 */
  function installCardGeometry() {
    try {
      if (typeof buildCards !== 'function') return false;
      buildCards = function () {
        var band = RO - R;
        var mid = R * 1.02;   // 按内边缘半径算角间距，否则内圈会重叠
        var Hband = Math.max(58, Math.min(420, band * 0.62));  // 环带允许的最大卡片高度
        var count = CON.appCount || 0;
        var circ = 6.2831853 * mid;
        // 应用多就把卡片压小，保证每种进程都能分到一格；应用少就放大
        var Hfit = count > 0 ? (circ / count) * 0.72 : Hband;
        var H = Math.max(26, Math.min(Hband, Hfit));
        CON.compact = (H < 70);           // 卡片小的时候改用横向紧凑排版
        var gapPx = Math.max(7, H * 0.20);
        var da = H / mid;
        var gap = gapPx / mid;
        var a = 0;
        var next = [];
        while (a < 6.2831853 - 0.03) {
          next.push({ a: a + da / 2, da: da, hpx: H, c: null, flash: 0, _idx: next.length, _pname: null });
          a += da + gap;
        }
        slots = next;
        try { Object.assign(rot, { from: 0, to: 0, t: 1, dur: 1, hold: 0 }); } catch (e) { /* ignore */ }
        CON.cardH = Math.round(H);
        CON.cardN = next.length;
        return next.length;
      };
      buildCards();
      // 网页预览（http）要适配任意窗口；壁纸端（file://）只按大屏构建一次
      CON.cardAdaptive = /^https?:$/.test(location.protocol);
      CON.cardSize = Math.min(window.innerWidth, window.innerHeight);
      if (!CON.resizeHooked) {
        CON.resizeHooked = true;
        var rt = 0;
        try {
          window.addEventListener('resize', function () {
            clearTimeout(rt);
            rt = setTimeout(function () {
              try {
                var nw = Math.min(window.innerWidth, window.innerHeight);
                if (!CON.cardAdaptive) {
                  // 壁纸端：尺寸基本没变就什么都不做
                  if (CON.cardSize && Math.abs(nw - CON.cardSize) / CON.cardSize < 0.12) return;
                  if (CON.lastRebuild && (Date.now() - CON.lastRebuild) < 2500) return;
                }
                buildCards();
                CON.lastRebuild = Date.now();
                CON.cardSize = nw;
              } catch (e) { /* ignore */ }
            }, CON.cardAdaptive ? 120 : 450);
          });
        } catch (e) { /* ignore */ }
      }
      return true;
    } catch (e) { return false; }
  }

  /* 右上角控制条：只保留 BGM 音乐开关（Linux 没有进程数据，
     「显示：用户应用」按钮已移除）。 */
  function topRightBar() {
    var c = document.getElementById('aix-topbar');
    if (c) return c;
    c = document.createElement('div');
    c.id = 'aix-topbar';
    // No absolute positioning on the children: the bar is the only thing
    // anchored, and its children are laid out in one flex row. max-width +
    // wrap keeps two long labels from ever stacking on top of each other on
    // narrow screens (HA card / phone).
    c.style.cssText = 'position:fixed;top:9px;right:12px;z-index:140;display:flex;' +
      'align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap;' +
      'max-width:calc(100vw - 20px);pointer-events:auto;';
    // Keep the bar before .app so that, on phones, it can sit in normal flow
    // and scroll away with the page instead of staying fixed over the title.
    var app = document.querySelector('.app');
    if (app && app.parentNode === document.body) document.body.insertBefore(c, app);
    else document.body.appendChild(c);
    return c;
  }

  function toggleBtnStyle(active) {
    // active=true 时高亮（BGM 开），否则用与"显示"一致的低调配色
    return 'position:static;left:auto;top:auto;right:auto;bottom:auto;flex:0 0 auto;' +
      'padding:3px 9px;font:600 11px/1.5 ui-monospace,Consolas,monospace;' +
      'color:' + (active ? '#08110d' : '#cfe9e2') + ';' +
      'background:' + (active ? 'rgba(150,220,205,.9)' : 'rgba(8,12,14,.72)') + ';' +
      'border:1px solid rgba(150,220,205,.45);border-radius:4px;cursor:pointer;' +
      'pointer-events:auto;user-select:none;letter-spacing:.4px;white-space:nowrap;';
  }

  /** Keep the BGM toggle in the flex bar and clear positioning left over from
      an older build (where it was fixed at top:9/right:12). Also removes the
      obsolete 显示 toggle if an older cached page left it in the DOM. */
  function normalizeTopBar() {
    var c = topRightBar();
    ['aix-bgm', 'aix-toggle'].forEach(function (id) {
      if (id === 'aix-toggle') {
        var old = document.getElementById('aix-toggle');
        if (old && old.parentNode) old.parentNode.removeChild(old);
        return;
      }
      var b = document.getElementById(id);
      if (!b) return;
      b.style.position = 'static';
      b.style.left = b.style.top = b.style.right = b.style.bottom = '';
      b.style.zIndex = '';
      b.style.flex = '0 0 auto';
      b.style.margin = '0';
      if (b.parentNode !== c) c.appendChild(b);
    });
    return c;
  }

  /** 右上角开关：BGM 背景音乐（默认关闭，状态存 localStorage） */
  function buildBgmToggle() {
    var c = topRightBar();
    if (document.getElementById('aix-bgm')) return;
    var KEY = 'haloflux.bgm.v1';
    var b = document.createElement('div');
    b.id = 'aix-bgm';
    b.title = '点击开关背景音乐（浏览器要求首次点击才能出声）';

    function readState() {
      var s = { on: false, vol: 60 };
      try { s = Object.assign(s, JSON.parse(localStorage.getItem(KEY) || 'null') || {}); } catch (e) { /* ignore */ }
      s.on = !!s.on;
      return s;
    }
    function paint() {
      // 高亮按“真的在出声”判断；只看 isOn() 会在自动播放被拦时误显示为开
      var on = !!(window.__bgm && (window.__bgm.isPlaying
        ? window.__bgm.isPlaying()
        : (window.__bgm.isOn && window.__bgm.isOn())));
      b.textContent = '♪ 音乐：' + (on ? '开' : '关');
      b.style.cssText = toggleBtnStyle(on);
    }
    b.addEventListener('click', function (ev) {
      if (ev && ev.stopPropagation) ev.stopPropagation();
      if (ev && ev.preventDefault) ev.preventDefault();
      if (!window.__bgm) { paint(); return; }         // 音频模块缺失
      var wants = window.__bgm.wantsOn ? window.__bgm.wantsOn()
        : !!(window.__bgm.isOn && window.__bgm.isOn());
      var playingNow = window.__bgm.isPlaying ? window.__bgm.isPlaying() : wants;
      // 意图开但没出声（多半是自动播放被拦）：点击应重试播放，而不是关掉
      var wantOn = !(wants && playingNow);
      // 同步到模块自己的存储键，刷新后保持一致（音量 UI 已精简，固定 60）
      var s = readState(); s.on = wantOn;
      try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) { /* ignore */ }
      try { window.__bgm.set(wantOn); } catch (e) { /* ignore */ }   // 点击即手势，满足自动播放策略
      paint();
    });
    paint();
    c.insertBefore(b, c.firstChild);   // BGM 放在"显示"左边
    normalizeTopBar();
  }

  function installSlotRenderer() {
    try {
      if (typeof renderSlot !== 'function') return false;
      renderSlot = function (s) {
        var band = 240;
        try { band = (typeof RO === 'number' && typeof R === 'number') ? RO - R : 240; } catch (e) { /* ignore */ }
        var h = s.hpx || 30;
        var c = document.createElement('canvas');
        c.width = Math.max(8, Math.ceil(band * 2.4));
        c.height = Math.max(8, Math.ceil((h + 2) * 2.4));
        var x = c.getContext('2d');
        x.scale(2.4, 2.4);
        x.textBaseline = 'top';
        drawAiCard(x, s, band, h);
        s.c = c;
      };
      CON.slotHooked = true;
      return true;
    } catch (e) { return false; }
  }

  /** 分批把卡片标脏，让 drawRing 用新数据重画（每秒 6 张，避免一次性重画上百张） */
  function refreshSlots() {
    try {
      if (!CON.slotHooked) return;
      if (typeof slots !== 'object' || !slots || !slots.length) return;
      var n = slots.length;
      CON.slotIdx = CON.slotIdx || 0;
      for (var i = 0; i < 6; i++) slots[(CON.slotIdx + i) % n].c = null;
      CON.slotIdx = (CON.slotIdx + 6) % n;
    } catch (e) { /* ignore */ }
  }



  /* ==================================================================
     跟随鼠标的"详细解析"：鼠标停住 1 秒才弹出，移动就收起
     ================================================================== */

  var TIP = { el: null, timer: 0, shown: false, lx: -9999, ly: -9999 };

  var TIP_CSS = [
    '#aix-tip{position:fixed;left:0;top:0;z-index:2147482900;pointer-events:none;width:252px;',
    'padding:7px 10px 8px;font-family:ui-monospace,"Cascadia Mono",Consolas,monospace;',
    'background:rgba(8,10,11,.95);border:1px solid rgba(152,224,207,.38);',
    'box-shadow:0 10px 28px rgba(0,0,0,.65),0 0 0 1px rgba(0,0,0,.5);',
    'color:#cfd2d8;font-size:9px;line-height:1.5;letter-spacing:.4px;',
    'opacity:0;transition:opacity .16s ease;}',
    '#aix-tip.on{opacity:1;}',
    '#aix-tip .t-k{font-size:8px;letter-spacing:1.4px;color:#6b6f78;}',
    '#aix-tip .t-v{font-size:13px;font-weight:800;color:#f4f5f7;margin:1px 0 3px;',
    'font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
    '#aix-tip .t-s{color:#98e0cf;font-size:8.5px;margin-bottom:4px;}',
    '#aix-tip .t-b{border-top:1px solid #1c1f24;padding-top:4px;color:#8c9199;}',
    '#aix-tip .t-b div{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
    '#aix-tip .t-b b{color:#cfd2d8;font-weight:700;}',
    '#aix-tip .t-b i{color:#98e0cf;font-style:normal;}',
    '#aix-tip-dot{position:fixed;left:0;top:0;width:5px;height:5px;z-index:2147482901;',
    'pointer-events:none;background:#98e0cf;box-shadow:0 0 8px rgba(152,224,207,.9);opacity:0;}',
    '#aix-tip-dot.on{opacity:1;}'
  ].join('');

  function buildTip() {
    if (TIP.el) return;
    try {
      var st = document.getElementById('aix-tip-style');
      if (!st) {
        st = document.createElement('style');
        st.id = 'aix-tip-style';
        st.type = 'text/css';
        st.appendChild(document.createTextNode(TIP_CSS));
        (document.head || document.documentElement).appendChild(st);
      }
      var d = document.createElement('div');
      d.id = 'aix-tip';
      d.innerHTML = '<div class="t-k"></div><div class="t-v"></div><div class="t-s"></div><div class="t-b"></div>';
      (document.body || document.documentElement).appendChild(d);
      var dot = document.createElement('div');
      dot.id = 'aix-tip-dot';
      (document.body || document.documentElement).appendChild(dot);
      TIP.el = d;
      TIP.k = d.children[0];
      TIP.v = d.children[1];
      TIP.s = d.children[2];
      TIP.b = d.children[3];
      TIP.dot = dot;
    } catch (e) { /* ignore */ }
  }

  function tipHide() {
    clearTimeout(TIP.timer);
    TIP.timer = 0;
    if (!TIP.shown) return;
    TIP.shown = false;
    try {
      TIP.el.classList.remove('on');
      TIP.dot.classList.remove('on');
    } catch (e) { /* ignore */ }
  }

  function tipPlace(x, y) {
    var w = TIP.el.offsetWidth || 252;
    var h = TIP.el.offsetHeight || 120;
    var px = x + 18, py = y + 16;
    if (px + w > window.innerWidth - 12) px = x - w - 18;
    if (py + h > window.innerHeight - 12) py = y - h - 16;
    if (px < 8) px = 8;
    if (py < 8) py = 8;
    TIP.el.style.transform = 'translate(' + Math.round(px) + 'px,' + Math.round(py) + 'px)';
    TIP.dot.style.transform = 'translate(' + Math.round(x - 2) + 'px,' + Math.round(y - 2) + 'px)';
  }

  function closestCls(el, cls) {
    while (el && el !== document.body) {
      if (el.classList && el.classList.contains(cls)) return el;
      el = el.parentNode;
    }
    return null;
  }

  function panelIndex(p) {
    try {
      var all = document.querySelectorAll('.panels .p');
      for (var i = 0; i < all.length; i++) if (all[i] === p) return i;
    } catch (e) { /* ignore */ }
    return -1;
  }

  function panelDetail(p) {
    var idx = panelIndex(p);
    var ai = (CON.last && CON.last.ai) || {};
    var d = CON.last || {};
    if (idx === 0) {
      return {
        label: 'AI 事件流', value: CON.events.length + ' 条最近事件', sub: '工具 / 消息 / 令牌的变化',
        lines: CON.events.slice(-4).reverse().map(function (e) { return '<i>' + e.t + '</i> ' + esc(e.text); })
      };
    }
    if (idx === 1) {
      var mx = 0, sum = 0, n = CON.hist.tps.length;
      for (var i = 0; i < n; i++) { if (CON.hist.tps[i] > mx) mx = CON.hist.tps[i]; sum += CON.hist.tps[i]; }
      return {
        label: '令牌吞吐', value: fmtRate(ai.tokensPerSec) + ' tok/s', sub: '最近 20 秒窗口',
        lines: [
          '90 秒峰值 <b>' + fmtRate(mx) + '</b> tok/s',
          '90 秒均值 <b>' + fmtRate(n ? sum / n : 0) + '</b> tok/s',
          '输出速度 <b>' + fmtRate(ai.outputTokensPerSec) + '</b> tok/s',
          '近 90 秒调用 <b>' + fmtInt(ai.recentCalls) + '</b> 次',
          '上次生成 <b>' + fmtRate(ai.lastCallOutputTokensPerSec) + '</b> tok/s' + (isNum(ai.lastCallAgeSec) ? ' · ' + ai.lastCallAgeSec + '秒前' : ''),
          '缓存命中率 <b>' + (isNum(ai.cacheHitRate) ? fmtPct(ai.cacheHitRate) : '—') + '</b>',
          '累计令牌 <b>' + fmtCompact(ai.tokensTotal) + '</b>'
        ]
      };
    }
    if (idx === 2) {
      var list = Array.isArray(ai.streams) ? ai.streams : [];
      var lines = [];
      for (var si = 0; si < list.length && si < 3; si++) {
        var sm = list[si];
        lines.push(esc(String(sm.agent).toUpperCase()) + '：<b>' +
          esc(shortTitle(sm.text, 26)) + '</b> · ' + ssStateLabel(sm));
      }
      return {
        label: '思考过程',
        value: list.length ? esc(String(list[0].agent).toUpperCase()) + ' · ' + ssStateLabel(list[0]) : '暂无',
        sub: '各 Agent 的思考过程与流式输出',
        lines: lines.length ? lines : ['等待 Agent 输出…']
      };
    }
    if (idx === 3) {
      var cores = (d && d.cpuCores) || [];
      var mx = 0, sum = 0;
      for (var ci = 0; ci < cores.length; ci++) { if (cores[ci] > mx) mx = cores[ci]; sum += cores[ci]; }
      var showGpuH = gpuVisible();
      var lines3 = [
        '处理器：<b>' + esc(String(d.cpuName || '—').slice(0, 26)) + '</b>',
        '核心：<b>' + (cores.length || (d.server && d.server.cores) || '—') + ' 核</b> · 最高 <b>' +
          (cores.length ? mx + '%' : '—') + '</b> · 平均 <b>' + (cores.length ? Math.round(sum / cores.length) + '%' : '—') + '</b>',
        '内存：<b>' + fmtPct(d.ram) + '</b>' + (d.ramDetail ? '（' + d.ramDetail.usedGB + ' / ' + d.ramDetail.totalGB + ' GB）' : ''),
        'diskIO：<b>' + (d.disk && isNum(d.disk.utilization) ? fmtPct(d.disk.utilization) : '不可用') + '</b>' +
          (d.disk && d.disk.device ? ' · ' + esc(d.disk.device) : '') +
          (d.disk && isNum(d.disk.readMBps) ? ' · 读 ' + fmtRate(d.disk.readMBps) + ' / 写 ' + fmtRate(d.disk.writeMBps) + ' MB/s' : '')
      ];
      if (showGpuH) {
        lines3.push('显存：<b>' + (d.gpu && isNum(d.gpu.memoryUsedMB) && isNum(d.gpu.memoryTotalMB)
          ? d.gpu.memoryUsedMB + ' / ' + d.gpu.memoryTotalMB + ' MB'
          : (d.gpu ? '—（驱动未提供）' : '—')) + '</b>');
        lines3.push('显卡：<b>' + esc((d.gpu && d.gpu.name) || '未检测到') + '</b>'
          + (d.gpu && d.gpu.source === 'mali-sysfs' ? ' · <b>kbase sysfs</b>' : '')
          + (d.gpu && d.gpu.source === 'nvidia-smi' ? ' · <b>nvidia-smi</b>' : '')
          + (d.gpu && d.gpu.source === 'drm-sysfs' ? ' · <b>drm sysfs</b>' : ''));
      }
      return {
        label: 'CPU / GPU 负载',
        value: fmtPct(d.cpu) +
          (d.disk && isNum(d.disk.utilization) ? ' / ' + fmtPct(d.disk.utilization) : '') +
          (showGpuH ? ' / ' + (d.gpu ? (isNum(d.gpu.utilization) ? fmtPct(d.gpu.utilization) : '—') : '未检测到') : ''),
        sub: showGpuH ? '红 CPU · 蓝 diskIO · 紫 GPU（0% 时隐藏）' : '红 CPU · 蓝 diskIO',
        lines: lines3
      };
    }
    if (idx === 4) {
      var tp = ai.taskPlan || null;
      var tsteps = (tp && Array.isArray(tp.steps)) ? tp.steps : [];
      var done = tp && isNum(tp.done) ? tp.done : 0;
      var total = tp && isNum(tp.total) ? tp.total : tsteps.length;
      var stepLines = [];
      if (tp) {
        stepLines.push('Agent：<b>' + esc(agentShort(tp.agent) || '—') + '</b> · ' +
          (tp.sessionActive ? '会话运行中' : '会话已结束') +
          (tp.title ? ' · ' + esc(shortTitle(tp.title, 18)) : ''));
        if (tp.others) {
          var otherNames = (tp.otherAgents || []).map(function (a) { return agentShort(a); }).join(' + ');
          stepLines.push('另有 <b>' + tp.others + '</b> 个 Agent 计划正在运行' +
            (otherNames ? '：' + esc(otherNames) : ''));
        }
      }
      for (var ti = 0; ti < tsteps.length && ti < 4; ti++) {
        var ts2 = tsteps[ti];
        var mk = ts2.status === 'completed' ? '✓ ' : (ts2.status === 'in_progress' ? '▸ ' : '· ');
        stepLines.push(mk + esc(ts2.step));
      }
      return {
        label: '任务计划',
        value: tp && total ? done + '/' + total + ' 步' : '暂无',
        sub: tp && tp.agent ? agentShort(tp.agent) + (tp.title ? ' · ' + esc(shortTitle(tp.title, 16)) : '')
          : (tp && tp.title ? esc(tp.title) : 'Studio task_plans'),
        lines: stepLines.length ? stepLines : ['当前没有任务计划']
      };
    }
    if (idx === 5) {
      var rt = ai.recentTools || [];
      var nRun = 0;
      for (var ri = 0; ri < rt.length; ri++) if (rt[ri] && rt[ri].state === 'running') nRun++;
      var srcLabel = toolSourceLabel(ai) || '—';
      var mixed = rt.length && ai.toolAgents && ai.toolAgents.length > 1;
      return {
        label: '工具调用', value: rt.length ? nRun + ' 个运行中' : '暂无',
        sub: srcLabel,
        lines: rt.length ? rt.slice(0, 3).map(function (t) {
          var who = (mixed && t.agent) ? esc(agentShort(t.agent)) + ' · ' : '';
          return (t.state === 'error' ? '✕ ' : t.state === 'running' ? '▶ ' : '✓ ') +
            '<b>' + who + esc(t.name || '?') + '</b>' +
            (t.arg ? ' ' + esc(shortTitle(t.arg, 18)) : '') +
            (isNum(t.ageSec) ? ' · ' + t.ageSec + ' 秒前' : '');
        }) : [
          '当前没有工具调用',
          '会话：<b>' + esc(shortTitle(ai.sessionTitle, 20)) + '</b>',
          '累计：<b>' + fmtInt(ai.toolCalls) + '</b> 次'
        ]
      };
    }
    if (idx === 6) {
      return {
        label: '代理调度', value: fmtInt(ai.activeAgents) + ' 个活跃', sub: '本地 AI 会话',
        lines: [
          'Studio 会话：<b>' + fmtInt(ai.sessions) + '</b> 个',
          '活跃判定：<b>3 分钟内</b>有写入',
          '当前会话：<b>' + esc(shortTitle(ai.sessionTitle, 16)) + '</b>'
        ]
      };
    }
    return {
      label: '系统负载索引', value: 'CPU / 硬盘IO / 内存 / 网络', sub: '4 行 × 60 秒热力图',
      lines: [
        '<i>红</i> 第 1 行 CPU：<b>' + fmtPct(d.cpu) + '</b>',
        '<i>蓝</i> 第 2 行 ' + (d.disk && d.disk.device ? esc(d.disk.device) : 'diskIO') + '：<b>' +
          (d.disk && isNum(d.disk.utilization) ? fmtPct(d.disk.utilization) : '不可用') + '</b>' +
          (d.disk && isNum(d.disk.readMBps)
            ? ' · 读 ' + fmtRate(d.disk.readMBps) + ' / 写 ' + fmtRate(d.disk.writeMBps) + ' MB/s'
            : ''),
        '<i>绿</i> 第 3 行 内存：<b>' + fmtPct(d.ram) + '</b>',
        '<i>黄</i> 第 4 行 网络 <b>' + (d.net
          ? fmtBps((d.net.rxPerSec || 0) + (d.net.txPerSec || 0))
          : '不可用') + '</b>' + (d.net && d.net.iface ? ' · ' + esc(d.net.iface) : ''),
        d.net ? '↓ ' + fmtBps(d.net.rxPerSec || 0) + ' · ↑ ' + fmtBps(d.net.txPerSec || 0) : '',
        '每列 1 秒，越亮数值越高'
      ]
    };
  }

  function stageDetail(x, y) {
    var g = pageGeo();
    if (!g) return null;
    var ai = (CON.last && CON.last.ai) || {};
    var wx = (x - g.W / 2) / g.cam.z + g.cam.x;
    var wy = (y - g.H / 2) / g.cam.z + g.cam.y;
    var dx = wx - g.cx, dy = wy - g.cy;
    var r = Math.sqrt(dx * dx + dy * dy);
    var ang = Math.atan2(dy, dx);
    var deg = ((ang * 180 / Math.PI) + 360) % 360;

    if (r >= g.R && r <= g.RO) {
      var best = -1, bd = 99;
      if (g.slots) {
        for (var i = 0; i < g.slots.length; i++) {
          var d = Math.abs(g.normA ? g.normA(g.slots[i].a + g.ringRot - ang) : (g.slots[i].a + g.ringRot - ang));
          if (d < bd) { bd = d; best = i; }
        }
      }
      return {
        label: '圆环数据卡片',
        value: (best >= 0 ? '#' + (best + 1) : '—') + ' · ' + Math.round(deg) + '°',
        sub: '环带上一块实时数据块',
        lines: [
          '卡片宽度：<b>' + (best >= 0 && g.slots[best] ? Math.round(g.slots[best].hpx) : '—') + ' px</b>',
          '所属环带：<b>' + Math.round(g.R) + ' ~ ' + Math.round(g.RO) + ' px</b>',
          '对应吞吐：<b>' + fmtRate(ai.tokensPerSec) + '</b> tok/s',
          '缓存命中率：<b>' + (isNum(ai.cacheHitRate) ? fmtPct(ai.cacheHitRate) : '—') + '</b>',
          '数据线：<b>白=命中</b> · <b>红=未命中</b>',
          '双击可放大看清内容'
        ]
      };
    }
    if (r < g.R) {
      return {
        label: '圈内数据网', value: fmtRate(ai.tokensPerSec) + ' tok/s', sub: '令牌吞吐驱动网线速度',
        lines: [
          '令牌总量：<b>' + fmtCompact(ai.tokensTotal) + '</b>',
          '上下文：<b>' + fmtCtx(ai) + '</b> 令牌',
          '命中率：<b>' + (isNum(ai.cacheHitRate) ? fmtPct(ai.cacheHitRate) : '—') + '</b>',
          '模型：<b>' + esc(ai.model || '—') + '</b>'
        ]
      };
    }
    return {
      label: '环外光束', value: fmtInt(ai.toolCalls) + ' 次工具调用', sub: '光束亮度跟随命中率',
      lines: [
        '最近事件：<b>' + esc(zhEvent(ai.lastEvent)) + '</b>',
        '消息：<b>' + fmtInt(ai.messages) + '</b> 条',
        '代理 / 会话：<b>' + fmtInt(ai.activeAgents) + ' / ' + fmtInt(ai.sessions) + '</b>',
        '服务运行：<b>' + fmtUptime(CON.last && CON.last.uptimeSec) + '</b>'
      ]
    };
  }

  function kpiDetail(kpi) {
    var k = kpi.querySelector('.k');
    var v = kpi.querySelector('.v');
    var ai = (CON.last && CON.last.ai) || {};
    var label = k ? k.textContent : '指标';
    var map = {
      '令牌总量': ['所有 Agent 累计令牌（含缓存读）', '上下文：' + fmtCtx(ai)],
      '活跃代理': ['3 分钟内有活动的代理数', 'Studio 会话共 ' + fmtInt(ai.sessions) + ' 个'],
      '工具调用': ['所有 Agent 工具调用累计', '最近：' + zhEvent(ai.lastEvent)],
      '消息数': ['用户消息 + 助手消息', '轮次：' + fmtInt(ai.turns)],
      '会话数': ['Ekko Studio 会话总数', '模型：' + (ai.model || '—')]
    };
    var extra = map[label] || ['实时指标', ''];
    return {
      label: label, value: v ? v.textContent : '—', sub: extra[0],
      lines: extra[1] ? [extra[1]] : []
    };
  }

  function tipContent(x, y) {
    var ai = (CON.last && CON.last.ai) || {};
    var el = null;
    try { el = document.elementFromPoint(x, y); } catch (e) { el = null; }

    var p = el ? closestCls(el, 'p') : null;
    if (p) return panelDetail(p);

    var kpi = el ? closestCls(el, 'kpi') : null;
    if (kpi) return kpiDetail(kpi);

    var stage = document.getElementById('stageWrap');
    if (stage && el && stage.contains && stage.contains(el)) return stageDetail(x, y);

    return {
      label: 'AI 链路', value: online ? '已连接' : '未连接', sub: '本地 AI 数据联动',
      lines: [
        '会话：<b>' + esc(shortTitle(ai.sessionTitle, 18)) + '</b>',
        '令牌：<b>' + fmtCompact(ai.tokensTotal) + '</b> · 工具 <b>' + fmtInt(ai.toolCalls) + '</b>',
        '移动鼠标到光环 / 面板上可看对应解析'
      ]
    };
  }

  function tipShow(x, y) {
    if (!TIP.el) return;
    var c = tipContent(x, y);
    if (!c) return;
    try {
      TIP.k.textContent = c.label || '';
      TIP.v.textContent = c.value || '';
      TIP.s.textContent = c.sub || '';
      TIP.b.innerHTML = (c.lines || []).filter(Boolean).map(function (l) { return '<div>' + l + '</div>'; }).join('');
      TIP.el.classList.add('on');
      TIP.dot.classList.add('on');
      TIP.shown = true;
      tipPlace(x, y);
    } catch (e) { /* ignore */ }
  }

  function bindHover() {
    buildTip();
    if (!TIP.el) return;

    document.addEventListener('pointermove', function (e) {
      if (e.pointerType === 'touch') return;
      if (e.buttons) { tipHide(); TIP.lx = e.clientX; TIP.ly = e.clientY; return; }  // 按住鼠标时不算停顿
      var moved = Math.abs(e.clientX - TIP.lx) + Math.abs(e.clientY - TIP.ly);
      if (moved < 4) return;                 // 手抖不重置
      TIP.lx = e.clientX;
      TIP.ly = e.clientY;
      tipHide();
      clearTimeout(TIP.timer);
      TIP.timer = setTimeout(function () { tipShow(TIP.lx, TIP.ly); }, CONFIG.hoverDelayMs);
    }, true);

    document.addEventListener('pointerdown', tipHide, true);
    document.addEventListener('wheel', tipHide, { capture: true, passive: true });
    window.addEventListener('blur', tipHide);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') tipHide(); });
  }


  /* ---- 鼠标指针：桌面壁纸里隐藏（原版行为），浏览器里显示 ---- */
  function fixCursor() {
    var ua = '';
    try { ua = navigator.userAgent || ''; } catch (e) { /* ignore */ }
    // Wallpaper Engine 的 CEF UA 里带 WallpaperEngine，另外它会注入音频接口
    var inWE = /wallpaper\s*engine/i.test(ua) ||
      (typeof window.wallpaperRegisterAudioListener === 'function');

    try {
      var qc = new URLSearchParams(location.search).get('cursor');
      if (qc === 'on' || qc === 'show') inWE = false;
      else if (qc === 'off' || qc === 'hide') inWE = true;
      var qd = new URLSearchParams(location.search).get('linedebug');
      if (qd === '1' || qd === 'on') CONFIG.lineDebug = true;
    } catch (e) { /* ignore */ }

    var st = document.getElementById('aix-cursor-style');
    if (inWE) {
      if (st) st.parentNode.removeChild(st);
      CON.cursor = 'hidden';
      return;
    }
    if (!st) {
      st = document.createElement('style');
      st.id = 'aix-cursor-style';
      st.type = 'text/css';
      st.appendChild(document.createTextNode(
        'html,body,.stage,.p,#stageWrap,#stage,#aix-hud{cursor:default !important;}'));
      (document.head || document.documentElement).appendChild(st);
    }
    CON.cursor = 'default';
  }

  function bindInteractions() {
    var wrap = document.getElementById('stageWrap');

    // 滚轮挂在 document 上：CEF 里事件不一定落在画布上
    var onWheel = function (e) {
      try { e.preventDefault(); } catch (err) { /* ignore */ }
      var dy = e.deltaY;
      if (!isNum(dy) && isNum(e.detail)) dy = e.detail;
      spinBy((dy > 0 ? 1 : -1) * 0.14);
      touchIdle();
    };
    document.addEventListener('wheel', onWheel, { passive: false, capture: true });
    document.addEventListener('mousewheel', onWheel, { passive: false, capture: true });

    // 统一指针手势：按住拖动 = 平移视角；原地点击 = 缩放档位
    var PTR = { down: false, btn: 0, sx: 0, sy: 0, lx: 0, ly: 0, dragging: false, timer: 0 };

    function pDown(e) {
      if (e.button !== 0 && e.button !== 2) return;
      PTR.down = true;
      PTR.btn = e.button;
      PTR.sx = PTR.lx = e.clientX;
      PTR.sy = PTR.ly = e.clientY;
      PTR.dragging = false;
      clearTimeout(PTR.timer);
      if (e.button === 2) {
        try { e.preventDefault(); } catch (err) { /* ignore */ }
        PTR.dragging = true;               // 右键按下即进入拖动
        beginDrag(e);
      }
    }

    function pMove(e) {
      if (!PTR.down) return;
      if (!PTR.dragging) {
        // 移动超过 6px 才算拖动，顺便取消掉待触发的“单击放大”
        if (Math.abs(e.clientX - PTR.sx) < 6 && Math.abs(e.clientY - PTR.sy) < 6) return;
        PTR.dragging = true;
        clearTimeout(PTR.timer);
        PTR.lx = e.clientX;
        PTR.ly = e.clientY;
        beginDrag({ clientX: e.clientX, clientY: e.clientY });
        return;
      }
      panBy(e.clientX - PTR.lx, e.clientY - PTR.ly);
      PTR.lx = e.clientX;
      PTR.ly = e.clientY;
    }

    function pUp(e) {
      if (!PTR.down) return;
      PTR.down = false;
      clearTimeout(PTR.timer);
      if (PTR.dragging) { PTR.dragging = false; endDrag(); return; }
      if (PTR.btn !== 0) return;           // 右键轻点不缩放
      if (!wrap) return;
      var r = wrap.getBoundingClientRect();
      var x = e.clientX - r.left, y = e.clientY - r.top;
      // 原地点击：延迟一点，给双击留出判定时间
      PTR.timer = setTimeout(function () { clickStep(x, y); }, 220);
    }

    // 挂在 window 上，拖出画布也能继续
    window.addEventListener('pointermove', pMove, true);
    window.addEventListener('pointerup', pUp, true);
    window.addEventListener('pointercancel', function () {
      PTR.down = false;
      PTR.dragging = false;
      clearTimeout(PTR.timer);
      endDrag();
    }, true);

    if (!wrap) return;

    wrap.addEventListener('contextmenu', function (e) { e.preventDefault(); }, true);
    wrap.addEventListener('pointerdown', pDown, true);

    wrap.addEventListener('dblclick', function (e) {
      clearTimeout(PTR.timer);
      e.stopPropagation();                    // 别让页面把双击当成全屏切换
      var r = wrap.getBoundingClientRect();
      var x = e.clientX - r.left, y = e.clientY - r.top;
      if (e.ctrlKey && focusSlot(x, y)) return;   // Ctrl + 双击 = 聚焦到那张卡片
      dblStep(x, y);
    }, true);

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') resetView();
      else if (e.key === 'z' || e.key === 'Z') {
        var st = document.getElementById('stage');
        clickStep((st && st.clientWidth || 800) / 2, (st && st.clientHeight || 450) / 2);
      }
    });
  }

  /** 接管底部面板的原有绘制，省掉 4 个画布 + 72 个格子的每帧开销 */
  function muteOriginalPanels() {
    try {
      // 必须写 window.xxx：本文件是 strict mode，裸赋值不会改到页面的全局函数
      if (typeof window.drawAdv === 'function') window.drawAdv = function () { };
      if (typeof window.drawDiff === 'function') window.drawDiff = function () { };
      if (typeof window.drawVal === 'function') window.drawVal = function () { };
      if (typeof window.drawIdx === 'function') window.drawIdx = function () { };
      if (typeof window.agentsTick === 'function') window.agentsTick = function () { };
      // 停掉原生演示面板的模拟数据定时器（feed / 代码打字 / 路由 / 按钮）
      var legacy = window.__aixLegacyTimers;
      if (legacy && legacy.length) {
        for (var i = 0; i < legacy.length; i++) clearInterval(legacy[i]);
        window.__aixLegacyTimers = [];
      }
      // 把壁纸自带的英文演示内容从 DOM 移除，只留标题和 AI-LINK 面板：
      // 彻底消除被盖住仍每帧绘制 / 刷新瞬间闪出第二套的问题。
      var ps = document.querySelectorAll('.panels .p');
      for (var j = 0; j < ps.length; j++) {
        var kids = ps[j].children;
        for (var k = kids.length - 1; k >= 0; k--) {
          var c = kids[k];
          if (c.tagName === 'H3' || (c.classList && c.classList.contains('aix-pane'))) continue;
          ps[j].removeChild(c);
        }
      }
      CON.muted = true;
    } catch (e) { /* ignore */ }
  }

  /* ---- Wallpaper Engine 属性面板（桌面壁纸上鼠标事件常常到不了页面） ---- */

  function setRingAngle(deg) {
    try {
      if (!installRingHook()) return;
      installBeatHook();
      ringRot = ((Number(deg) || 0) % 360) * Math.PI / 180;
      if (rot) { rot.from = ringRot; rot.to = ringRot; rot.t = 1; rot.dur = 1; rot.hold = 1; }
    } catch (e) { /* ignore */ }
  }

  function setManualZoom(z) {
    var g = pageGeo();
    if (!g || !installCameraHook()) return;
    z = clamp(Number(z) || 1, 0.6, 6);
    if (z <= 1.02 && CONFIG.autoCamera) { releaseCamera(); return; }
    CAM.active = true;
    CAM.tx = g.cam.x;
    CAM.ty = g.cam.y;
    CAM.tz = z;
    CON.zoomed = z > 1.02;
    scheduleVisual();
  }

  /** 「界面」关掉时，壁纸端自己的 header/panels 由 wp.js 隐藏；
      这里同步收起 AI LINK 的右上角控制条，避免“纯净模式”还留着按钮。 */
  function applyShowUI(show) {
    var bar = document.getElementById('aix-topbar');
    if (bar) bar.style.display = show ? '' : 'none';
  }

  function hookWallpaperProps() {
    try {
      var orig = window.wallpaperPropertyListener || {};
      window.wallpaperPropertyListener = {
        applyUserProperties: function (props) {
          if (!props) return;
          try { if (orig.applyUserProperties) orig.applyUserProperties(props); } catch (e) { /* ignore */ }
          try {
            if (props.showui) applyShowUI(props.showui.value !== false);
            if (props.aicamera) CONFIG.autoCamera = props.aicamera.value !== false;
            if (props.aispin) CONFIG.autoSpin = props.aispin.value !== false;
            if (props.ringangle && isNum(props.ringangle.value)) setRingAngle(props.ringangle.value);
            if (props.aizoom && isNum(props.aizoom.value)) setManualZoom(props.aizoom.value);
          } catch (e) { /* ignore */ }
        },
        setPaused: function (p) { try { if (orig.setPaused) orig.setPaused(p); } catch (e) { /* ignore */ } },
        setAudioMuted: function (m) { try { if (orig.setAudioMuted) orig.setAudioMuted(m); } catch (e) { /* ignore */ } }
      };
    } catch (e) { /* ignore */ }
  }

  function readCamZoom() {
    var c = pageParams();
    if (c && isNum(c.camZoom)) CON.camZoomBase = c.camZoom;
  }



  function boot() {
    try { document.documentElement.setAttribute('data-ai-build', BUILD); } catch (e) { /* ignore */ }
    if (CONFIG.position !== 'off') {
      buildHud();
      try {
        var hudEl = document.getElementById('aix-hud');
        if (hudEl) hudEl.title = 'AI-LINK ' + BUILD;
      } catch (e) { /* ignore */ }
      try { initHudDrag(); } catch (e) { /* ignore */ }
    }
    if (CONFIG.screenFx) buildFx();
    try { buildConsole(); } catch (e) { /* 控制台失败不影响壁纸 */ }
    try { if (CON.built) muteOriginalPanels(); } catch (e) { /* ignore */ }
    // 环带卡片：默认交给页面自己渲染。
    // ai-link.js 是独立作用域，拿不到 index.html 里用 let 声明的 R/RO/slots/rot，
    // 接管 buildCards 会抛 ReferenceError，接管 renderSlot 又因为进程数有限而把
    // 大多数格子画成空白 —— 表现为加载后圆环上的图标整体消失。
    if (CONFIG.aiRingCards) {
      try { installSlotRenderer(); } catch (e) { /* ignore */ }
      try { installCardGeometry(); } catch (e) { /* ignore */ }
    }
    try { CON.showAll = localStorage.getItem('ail.proc.all') === '1'; } catch (e) { /* ignore */ }
    try { buildBgmToggle(); } catch (e) { /* ignore */ }
    try { bindInteractions(); readCamZoom(); installBeatHook(); installCameraHook(); installRingHook(); hookWallpaperProps(); fixCursor(); } catch (e) { /* ignore */ }
    try { bindHover(); } catch (e) { /* ignore */ }
    // wait for the wallpaper's setParam / config to exist, then go
    var tries = 0;
    (function waitForApp() {
      if (hasSetParam() || tries++ > 40) { tick(); return; }
      setTimeout(waitForApp, 150);
    })();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  // expose a tiny handle for debugging from the CEF console
  window.__aiLink = {
    config: CONFIG,
    refresh: function () { pollOnce().then(render).catch(renderOffline); },
    hide: function () { if (hud) hud.classList.add('aix-hidden'); },
    show: function () { if (hud) hud.classList.remove('aix-hidden'); },
    pulse: function (n) { vd.pulse = Math.min(1.2, vd.pulse + (n || 0.8)); vd.forceFrames = 3; scheduleVisual(); },
    zoom: function (x, y) { clickStep(isNum(x) ? x : 400, isNum(y) ? y : 300); },
    setZoom: function (lvl, x, y) { setZoomLevel(isNum(lvl) ? lvl : 0, x, y); },
    focusCard: function (x, y) { return focusSlot(isNum(x) ? x : 400, isNum(y) ? y : 300); },
    pan: function (dx, dy) { panBy(isNum(dx) ? dx : 0, isNum(dy) ? dy : 0); },
    tip: function (x, y) { tipShow(isNum(x) ? x : 400, isNum(y) ? y : 300); },
    resetHud: function () { resetHudPos(); },
    release: function () { resetView(); },
    cursor: function (on) {
      if (on === false) {
        var st = document.getElementById('aix-cursor-style');
        if (st && st.parentNode) st.parentNode.removeChild(st);
        CON.cursor = 'hidden';
        return;
      }
      fixCursor();
    },
    spin: function (d) { spinBy(isNum(d) ? d : 0.2); },
    console: function () { buildConsole(); return CON.panes.length; },
    state: function () {
      return { build: BUILD, online: online, preferred: preferred, energy: vd.energy, pulse: vd.pulse,
        base: vd.base, writes: vd.writes, running: vd.running, hit: vd.hit,
        panes: CON.panes.length, zoomed: CON.zoomed, camera: CAM.active,
        level: CAM.level, tz: CAM.tz, tx: CAM.tx, ty: CAM.ty, dragging: !!CAM.drag,
        spinActive: CAM.spinActive, spinWhenIdle: CONFIG.spinWhenIdle, lastAge: CAM.lastAge,
        rate: CAM.rate, rateTarget: CAM.rateTarget, tps: CAM.tps, idleHome: CAM.idleHome,
        pendingSec: CAM.pendingSec, planBusy: CAM.planBusy,
        events: CON.events.length, muted: !!CON.muted, cursor: CON.cursor, showAll: CON.showAll, apps: CON.appCount, compact: CON.compact };
    }
  };
})();
