/**
 * 把 Studio 页面端的实时会话状态映射成 ai-link.js 需要的「忙碌信号」。
 *
 * 背景：docker 原版的 /stats 服务端会把事件流、未完成回合、运行中的任务计划
 * 填进 ai.lastEventAgeSec / pendingSec / planActive / jobsRunning，舞台据此
 * 决定圆环、节拍、运镜与飞出物是否运转。而本插件的 buildLegacyStats() 没有
 * 会话事件源，这些字段一律是 null/false，于是页面明明连着数据、HUD 在刷新，
 * updateMotion() 却算出 busy=false、CAM.rateTarget=0，三个钩子全部停摆，
 * updateVisuals() 也把 FLOW 压到 idle≈0 —— 表现就是「agent 在工作，动效不会动」。
 *
 * 这里在页面端用已经拿到的实时事件与会话历史重建信号（纯函数，便于单测）。
 * 与 src/session-state.mjs、src/tool-history.mjs 一样，构建时会被内联进 client.mjs。
 */

const PENDING_TTL_MS = 60 * 1000       // 历史轮询每 10 秒一次；60 秒没刷新就当作结束
const LIVE_TTL_MS = 10 * 60 * 1000     // 实时 slot 没有结束事件时的兜底上限
const SESSION_GRACE_SEC = 60           // 仅用于 last_active 的短活动窗口
const IDLE_AGE_SEC = 999               // 没有任何信号：明确告诉舞台“空闲”

/** 会话列表里的 last_active 是 Unix 秒（见 docs/HOST_API.md）。 */
function sessionAgeSec(now, raw) {
  const v = Number(raw)
  if (!isFinite(v) || v <= 0) return null
  // 兼容毫秒时间戳（部分宿主版本可能直接给毫秒）
  const atMs = v > 1e12 ? v : v * 1000
  return Math.max(0, Math.round((now - atMs) / 1000))
}

/**
 * @param {object} ai              /stats.ai（会被就地修改并返回）
 * @param {object} opts
 * @param {number} opts.now        Date.now()
 * @param {object|null} opts.liveEvent  最近一条实时事件 { type, at }
 * @param {Iterable<object>} opts.liveSlots  实时会话 slot（含 working/ts）
 * @param {Iterable<object>} opts.pendingSessions  会话历史判定结果 { working, at }
 * @param {Iterable<object>} opts.sessions  /stats 会话列表（含 lastActive，Unix 秒）
 * @returns {object} 同一个 ai 对象
 */
export function applyMotionSignals(ai, opts) {
  if (!ai || typeof ai !== 'object') return ai
  const now = Number(opts && opts.now) || Date.now()
  const liveEvent = (opts && opts.liveEvent) || null
  const liveSlots = (opts && opts.liveSlots) || []
  const pendingSessions = (opts && opts.pendingSessions) || []
  const sessions = (opts && opts.sessions) || []

  let activeAt = liveEvent && Number(liveEvent.at) ? Number(liveEvent.at) : 0
  let working = false
  let lastPendingAt = 0

  for (const slot of liveSlots) {
    if (!slot || !slot.working) continue
    // 没收到 run.completed / tool.completed 时，slot 可能一直停在 working；
    // 超过 10 分钟没有新事件就不再当作正在工作。
    if (slot.ts && now - Number(slot.ts) > LIVE_TTL_MS) continue
    working = true
    const ts = Number(slot.ts) || now
    if (ts > activeAt) activeAt = ts
  }
  for (const rec of pendingSessions) {
    // messagesWorking() 判定「最后一条不是已完成的助手回复」，即回合未结束。
    // rec.at 是最近一次历史轮询时间；60 秒没刷新说明轮询已停，不能再续命。
    if (!rec || !rec.working || now - Number(rec.at) >= PENDING_TTL_MS) continue
    working = true
    lastPendingAt = Math.max(lastPendingAt, Number(rec.at) || 0)
    if (Number(rec.at) > activeAt) activeAt = Number(rec.at)
  }
  // 兜底：会话列表的 last_active 只用来给一个很短的“刚活动过”宽限期，
  // 不再当成未完成回合。否则回合结束后它还会让画面继续转好几分钟。
  for (const meta of sessions) {
    const age = sessionAgeSec(now, meta && meta.lastActive)
    if (age === null || age > SESSION_GRACE_SEC) continue
    const at = now - age * 1000
    if (at > activeAt) activeAt = at
  }

  const ageSec = activeAt ? Math.max(0, Math.round((now - activeAt) / 1000)) : IDLE_AGE_SEC
  ai.lastEventAgeSec = ageSec
  if (!ai.lastEvent) ai.lastEvent = working ? '运行中' : '待命'
  ai.pendingSec = working ? Math.max(0, Math.round((now - (lastPendingAt || activeAt)) / 1000)) : null
  ai.jobsRunning = working ? 1 : 0

  // 任务计划只有在“有真实 running 计划且仍有工作信号（或刚开始 60 秒内）”时才续命；
  // 不再把 working 直接写成 planActive，避免没有计划时也空转。
  const plans = ai.taskPlan && Array.isArray(ai.taskPlan.plans) ? ai.taskPlan.plans : []
  const running = plans.find((plan) => plan && plan.state === 'running')
  if (running) {
    const planAge = typeof running.ageSec === 'number' ? running.ageSec : null
    const fresh = planAge === null || planAge <= SESSION_GRACE_SEC ||
      (working && planAge <= 600)
    ai.planActive = fresh
    ai.planAgeSec = fresh ? (planAge === null ? ageSec : planAge) : null
  } else if (plans.length) {
    ai.planActive = false
    ai.planAgeSec = null
  }
  return ai
}
