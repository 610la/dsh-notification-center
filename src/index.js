// DSH host half: completion notifications for conversation / task events.
// Provides a JSON poll endpoint under /dsh-notification-center/ that the
// browser client fetches. Install as a host composition plugin (cordis.yml).
export default {
  name: 'dsh-notification-center',
  inject: ['webServer'],
  apply(ctx) {
    // ---- in-memory completion queue (JSON-safe records only) ----
    let seq = 0
    const queue = []
    const MAX_QUEUE = 100
    const push = (sessionId, kind, title, body, extra) => {
      seq += 1
      const rec = { id: seq, sessionId: sessionId || '', kind, title, body, at: Date.now() }
      if (extra && typeof extra === 'object') {
        for (const k of Object.keys(extra)) rec[k] = extra[k]
      }
      queue.push(rec)
      if (queue.length > MAX_QUEUE) queue.shift()
    }

    let ourRunning = false

    // Track agent running state (used to attribute subagent completions).
    ctx.on('agent/status', (payload) => {
      if (!payload) return
      const agent = payload.agent
      const sid = agent && agent.id ? String(agent.id) : ''
      if (payload.status === 'running') ourRunning = true
      else if (payload.status === 'idle') ourRunning = false
    })

    // Turn ended: carry the durable stop reason so the client can decide
    // whether to notify (manual stop / interrupt are silent by default;
    // completion / error / max-tokens / blocked notify).
    const TURN_TITLES = {
      completed: '对话完成',
      error: '对话因错误停止',
      'max-tokens': '对话超长截断',
      blocked: '对话被阻塞',
      aborted: '对话已停止',
      interrupted: '对话已停止'
    }
    ctx.on('session/event', (session, event) => {
      if (!session || !event) return
      if (event.type !== 'turn/end') return
      const sid = session.id ? String(session.id) : ''
      const data = event.data || {}
      const reason = data.reason || {}
      const rk = reason.kind ? String(reason.kind) : 'other'
      let abortCause = ''
      if (rk === 'aborted') {
        abortCause = reason.reason && reason.reason.kind ? String(reason.reason.kind) : ''
      }
      const title = TURN_TITLES[rk] || '对话已停止'
      let body = sid
      try {
        const st = ctx.get('sessionTitle')
        if (st && session) {
          const snap = st.get(session)
          if (snap && typeof snap.title === 'string' && snap.title) body = String(snap.title)
        }
      } catch (_) { /* keep session id fallback */ }
      push(sid, 'turn', title, body, { reason: rk, abortCause })
    })

    // The model asks for permission / approval — the user needs to act now.
    // Waterfall: observe, record, and ALWAYS continue the chain.
    ctx.on('approval/request', (req, next) => {
      try {
        let sid = ''
        let body = '模型正在等待你的批准'
        if (req) {
          if (req.agent && req.agent.id) sid = String(req.agent.id)
          const parts = []
          if (req.toolName) parts.push(String(req.toolName))
          if (req.reason) parts.push(String(req.reason))
          if (parts.length) body = '等待批准: ' + parts.join(' · ')
        }
        push(sid, 'approval', '需要你的批准', body)
      } catch (_) { /* never break the approval chain */ }
      return next()
    })

    // Subagent (subtask) settled — attribute to its parent session.
    ctx.on('subagent/end', (info) => {
      if (!info) return
      let sid = ''
      try {
        const agents = ctx.get('agents')
        if (agents && typeof agents.get === 'function' && info.id) {
          const child = agents.get(info.id)
          if (child && child.session && child.session.meta && child.session.meta.parentSession) {
            sid = String(child.session.meta.parentSession)
          }
        }
      } catch (_) { /* keep fallback */ }
      if (!sid && !ourRunning) return
      const reason = info.stopReason || 'settled'
      push(sid, 'subagent', '子任务完成', '子代理 ' + String(info.provider || 'subagent') + ' · ' + String(reason))
    })

    // Background job settled.
    const jobs = ctx.get('jobs')
    if (jobs && typeof jobs.onJobDone === 'function') {
      ctx.effect(() => jobs.onJobDone((snapshot, owner) => {
        if (!snapshot) return
        const ownerSid = owner && owner.id ? String(owner.id) : ''
        const snapSid = snapshot.ownerSession ? String(snapshot.ownerSession) : ''
        push(ownerSid || snapSid, 'job', '后台任务完成', snapshot.label || String(snapshot.id))
      }))
    }

    // JSON poll endpoint the browser client fetches every ~1.5s.
    // GET /dsh-notification-center/poll?session=<sessionId>&after=<lastId>
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: '/dsh-notification-center/',
      handler: (req, res) => {
        try {
          const url = new URL(req.url || '/', 'http://localhost')
          const session = url.searchParams.get('session') || ''
          const after = Number(url.searchParams.get('after')) || 0
          const items = []
          for (const q of queue) {
            if (q.id > after && (!session || q.sessionId === session)) items.push(q)
          }
          const lastId = items.length ? items[items.length - 1].id : after
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ items, lastId }))
        } catch (e) {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: String(e && e.message ? e.message : e) }))
        }
      }
    }))

    // Note: workflow/end is not recorded here — the payload carries no session
    // identity, and the foreground workflow tool's completion is covered by the
    // following turn/end ('completed') notification.
  }
}
