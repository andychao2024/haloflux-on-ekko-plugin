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

const BUSY_WINDOW_MS = 5 * 60 * 1000   // 与 applyLive() 的 workingAgents 判定一致
const SESSION_WINDOW_SEC = 180         // 与 store.ACTIVE_SEC 一致：会话仍在活动
const STANDBY_AGE_SEC = 20             // 完全没有实时信号时的温和「待命」年龄

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

  for (const slot of liveSlots) {
    if (!slot || !slot.working) continue
    working = true
    if (Number(slot.ts) > activeAt) activeAt = Number(slot.ts)
  }
  for (const rec of pendingSessions) {
    // messagesWorking() 判定「最后一条不是已完成的助手回复」，即回合未结束。
    if (!rec || !rec.working || now - Number(rec.at) >= BUSY_WINDOW_MS) continue
    working = true
    if (Number(rec.at) > activeAt) activeAt = Number(rec.at)
  }
  // 兜底：会话列表的 last_active 来自服务端 HTTP 轮询，不依赖实时事件通道
  // （宿主 business-events 订阅异常时该通道可能完全没有事件）。
  for (const meta of sessions) {
    const age = sessionAgeSec(now, meta && meta.lastActive)
    if (age === null || age > SESSION_WINDOW_SEC) continue
    working = true
    const at = now - age * 1000
    if (at > activeAt) activeAt = at
  }

  // 有实时活动就用真实年龄（tokens/s 之外的主要能量来源）；
  // 完全没有信号时给一个温和的待命值，让舞台保持低速运转而不是彻底冻结。
  // 一旦收到实时事件，下一帧就会自动接管。
  const ageSec = activeAt ? Math.max(0, Math.round((now - activeAt) / 1000)) : STANDBY_AGE_SEC

  ai.lastEventAgeSec = ageSec
  // 有实时事件时 applyLive() 已写入具体类型；这里只给「完全无信号」的待命态
  // 一个可读标签，避免 HUD 出现「空闲 · 20秒前」这种自相矛盾的文字。
  if (!ai.lastEvent) ai.lastEvent = working ? '运行中' : '待命'
  // 长回合（内部模型不写 usage、tokens/s 恒为 0）靠这三个备用信号续命；
  // 只在确实判断「仍在工作」时给，避免回合结束后又空转十分钟。
  ai.planActive = working
  ai.planAgeSec = working ? ageSec : null
  ai.pendingSec = working ? ageSec : null
  ai.jobsRunning = working ? 1 : 0
  return ai
}
