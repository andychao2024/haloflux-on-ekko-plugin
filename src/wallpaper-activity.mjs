/**
 * 壁纸服务没有页面端的实时订阅，用会话轮询结果补上「思考过程」的激活状态。
 * 插件页会由 live slot 把正在工作的 Agent 标成 live；这里用 activeSessions
 * 和 messagesWorking 的结果做同等标记，避免壁纸页看不到另一会话在活动。
 */
export function applyWallpaperActivity(snap, workingSessions, now = Date.now()) {
  if (!snap || !Array.isArray(snap.streams)) return snap
  const working = workingSessions instanceof Set ? workingSessions : new Set(workingSessions || [])
  const recentWorkIds = new Set()
  for (const meta of (Array.isArray(snap.recentSessions) ? snap.recentSessions : [])) {
    const raw = Number(meta && meta.lastActive)
    if (!raw) continue
    const at = raw > 1e12 ? raw : raw * 1000
    if (now - at <= 600000) recentWorkIds.add(meta.id)
  }
  const activeIds = new Set((Array.isArray(snap.activeSessions) ? snap.activeSessions : [])
    .map((item) => item && item.id).filter(Boolean))
  const recentById = new Map((Array.isArray(snap.recentSessions) ? snap.recentSessions : [])
    .filter((item) => item && item.id).map((item) => [item.id, item]))
  const seen = new Set()

  for (const stream of snap.streams) {
    if (!stream || !stream.sessionId) continue
    seen.add(stream.sessionId)
    var isActive = activeIds.has(stream.sessionId) || stream.state === 'active' || recentWorkIds.has(stream.sessionId)
    if (working.has(stream.sessionId) && isActive) {
      stream.working = 1
      stream.state = 'live'
      if (!stream.workKind) stream.workKind = 'model'
    } else if (activeIds.has(stream.sessionId) && stream.state === 'idle') {
      stream.state = 'active'
    }
  }

  for (const meta of (Array.isArray(snap.activeSessions) ? snap.activeSessions : [])) {
    if (!meta || !meta.id || seen.has(meta.id)) continue
    seen.add(meta.id)
    snap.streams.push({
      agent: meta.agent || 'unknown',
      profile: meta.profile || 'default',
      sessionId: meta.id,
      title: meta.title || '',
      text: '',
      kind: 'think',
      state: working.has(meta.id) ? 'live' : 'active',
      working: working.has(meta.id) ? 1 : 0,
      ageSec: 0,
      ts: now
    })
  }

  for (const id of working) {
    if (seen.has(id) || !recentWorkIds.has(id)) continue
    const meta = recentById.get(id) || {}
    seen.add(id)
    snap.streams.push({
      agent: meta.agent || 'unknown',
      profile: meta.profile || 'default',
      sessionId: id,
      title: meta.title || '',
      text: '',
      kind: 'think',
      state: 'live',
      working: 1,
      ageSec: 0,
      ts: now
    })
  }
  return snap
}
