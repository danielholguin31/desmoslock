/* One interface, two implementations.

   `local`  — the Node server in server/. Works on a classroom LAN with the
              internet down, which is the whole reason it still exists.
   `cloud`  — Supabase. Auth, Postgres + row-level security, realtime.

   Everything above this line (the UI, and all of main.js) is backend-agnostic:
   the lock does not care where the signal came from.

   Shapes both implementations return:
     test    { id, title, code, unlockCode, locked, active, createdAt, lockedAt, studentCount }
     student { id, name, online, flags, lastSeen, forfeited, exitedAt }
     alert   { id, studentName, kind, label, detail, severe, at }
*/

const ALERT_LABELS = {
  joined: 'joined the session',
  left_app: 'switched away from the calculator',
  returned: 'returned to the calculator',
  quit_attempt: 'tried to quit or close the app',
  blocked_key: 'pressed a blocked shortcut',
  screen_locked: 'locked or slept the screen',
  disconnected: 'lost connection',
  reconnected: 'reconnected',
  override_used: 'unlocked with the override code',
  override_failed: 'entered a wrong override code',
  display_changed: 'changed displays or resolution',
  forced_exit: 'force-exited the lock while offline',
  forfeited: 'exited early and forfeited the test',
  left_session: 'left the test',
  other_app_opened: 'opened another app during the test'
}

const SEVERE_KINDS = new Set([
  'left_app', 'quit_attempt', 'screen_locked', 'override_used',
  'override_failed', 'display_changed', 'forced_exit', 'forfeited', 'other_app_opened'
])

const labelFor = (kind) => ALERT_LABELS[kind] || kind

// A student counts as online if we heard from them inside this window.
const ONLINE_WINDOW_MS = 45000
const HEARTBEAT_MS = 15000

/* ══════════════════════════════════════════════════════════ local server */

function createLocalBackend (serverUrl) {
  const state = { url: serverUrl, teacherToken: null, studentToken: null, ws: null, intent: null, backoff: 500 }

  async function req (path, { method = 'GET', body, token } = {}) {
    const res = await fetch(state.url + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: body ? JSON.stringify(body) : undefined
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`)
    return data
  }

  const asTest = (s) => ({
    id: s.id, title: s.title, code: s.code, unlockCode: s.unlockCode,
    locked: !!s.locked, active: !!s.active, createdAt: s.createdAt,
    lockedAt: s.lockedAt, studentCount: s.studentCount || 0
  })
  const asAlert = (a) => ({ ...a, label: a.label || labelFor(a.kind), at: a.at })

  function closeSocket () {
    state.intent = null
    if (state.ws) { state.ws.onclose = null; try { state.ws.close() } catch {} }
    state.ws = null
  }

  function connect (intent, auth, onMessage, onConn) {
    closeSocket()
    state.intent = intent
    const open = () => {
      if (state.intent !== intent) return
      let ws
      try { ws = new WebSocket(state.url.replace(/^http/i, 'ws') + '/ws') } catch { return retry() }
      state.ws = ws
      // auth is resolved at open time, not at subscribe time — a reconnect must
      // send whatever credential we hold now, not a stale snapshot of it.
      ws.onopen = () => { state.backoff = 500; onConn && onConn(true); ws.send(JSON.stringify({ type: 'auth', ...(typeof auth === 'function' ? auth() : auth) })) }
      ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data) } catch { return } ; onMessage(m) }
      ws.onclose = () => { onConn && onConn(false); retry() }
      ws.onerror = () => { try { ws.close() } catch {} }
    }
    const retry = () => {
      if (state.intent !== intent) return
      state.backoff = Math.min(state.backoff * 1.6, 8000)
      setTimeout(open, state.backoff)
    }
    open()
    return closeSocket
  }

  const send = (payload) => {
    if (!state.ws || state.ws.readyState !== 1) return false
    state.ws.send(JSON.stringify(payload))
    return true
  }

  return {
    kind: 'local',
    get label () { return state.url },
    get socket () { return state.ws },

    async register ({ email, password, name }) {
      const d = await req('/api/teacher/register', { method: 'POST', body: { email, password, name } })
      state.teacherToken = d.token
      return { profile: d.teacher, credential: { token: d.token, url: state.url } }
    },
    async login ({ email, password }) {
      const d = await req('/api/teacher/login', { method: 'POST', body: { email, password } })
      state.teacherToken = d.token
      return { profile: d.teacher, credential: { token: d.token, url: state.url } }
    },
    async restoreTeacher (credential) {
      if (!credential?.token) return null
      const d = await req('/api/teacher/me', { token: credential.token })
      state.teacherToken = credential.token
      return { profile: d.teacher }
    },
    async logout () {
      closeSocket()
      try { await req('/api/teacher/logout', { method: 'POST', token: state.teacherToken }) } catch {}
      state.teacherToken = null
    },

    async listTests () {
      const d = await req('/api/sessions', { token: state.teacherToken })
      return d.sessions.map(asTest)
    },
    async createTest (title) {
      const d = await req('/api/sessions', { method: 'POST', token: state.teacherToken, body: { title } })
      return asTest(d.session)
    },
    async loadTest (id) {
      const d = await req(`/api/sessions/${id}`, { token: state.teacherToken })
      return { test: asTest(d.session), students: d.students, alerts: d.alerts.map(asAlert) }
    },
    setLock: (id, locked) => req(`/api/sessions/${id}/${locked ? 'lock' : 'unlock'}`, { method: 'POST', token: state.teacherToken }),
    endTest: (id) => req(`/api/sessions/${id}/end`, { method: 'POST', token: state.teacherToken }),
    releaseStudent: (id, sid) => req(`/api/sessions/${id}/students/${sid}/release`, { method: 'POST', token: state.teacherToken }),
    removeStudent: (id, sid) => req(`/api/sessions/${id}/students/${sid}/remove`, { method: 'POST', token: state.teacherToken }),

    subscribeTeacher (testId, h) {
      return connect('teacher', () => ({ token: state.teacherToken, sessionId: testId }), (m) => {
        if (m.type === 'state') h.onSnapshot({ test: asTest(m.session), students: m.students, alerts: m.alerts.map(asAlert) })
        else if (m.type === 'session') h.onTest(asTest(m.session))
        else if (m.type === 'roster') h.onRoster(m.students)
        else if (m.type === 'alert') h.onAlert(asAlert(m.alert))
      })
    },

    async join ({ code, name }) {
      const d = await req('/api/join', { method: 'POST', body: { code, name } })
      state.studentToken = d.token
      return {
        student: { id: d.student.id, name: d.student.name },
        test: { id: d.session.id, title: d.session.title, code: d.session.code, locked: !!d.session.locked, active: true },
        credential: { token: d.token, url: state.url }
      }
    },
    async restoreStudent (credential) {
      if (!credential?.token) return null
      const d = await req('/api/student/state', { token: credential.token })
      state.studentToken = credential.token
      return {
        student: { id: d.student.id, name: d.student.name },
        test: { id: d.session.id, title: d.session.title, code: d.session.code, locked: !!d.session.locked, active: true }
      }
    },
    // Used when the backend was unreachable at boot but the student was locked:
    // we still know their token, so the socket can authenticate the moment the
    // server comes back.
    resumeStudent (credential) { if (credential?.token) state.studentToken = credential.token },

    subscribeStudent (_ctx, h) {
      return connect('student', () => ({ token: state.studentToken }), (m) => {
        if (m.type === 'lock') h.onLock(!!m.locked, m.session)
        else if (m.type === 'ended') h.onEnded()
        else if (m.type === 'kicked') h.onKicked()
        else if (m.type === 'error') h.onError(m.error)
      }, h.onConn)
    },
    heartbeat: () => send({ type: 'heartbeat' }),
    reportAlert: (kind, detail) => send({ type: 'alert', kind, detail }),
    forfeit: (reason) => req('/api/student/forfeit', { method: 'POST', token: state.studentToken, body: { reason } }).then(r => !!r.forfeited),
    override: (code) => req('/api/student/override', { method: 'POST', token: state.studentToken, body: { code } }).then(() => true),
    leave () { closeSocket(); state.studentToken = null },
    heartbeatInterval: 5000
  }
}

/* ═════════════════════════════════════════════════════════════ supabase */

function createCloudBackend () {
  // supabase-js keeps its session in our own userData store rather than
  // localStorage, which is not dependable on a file:// origin — and this is
  // what puts a force-quit student straight back into the locked test.
  const storage = {
    getItem: (k) => desk.storeGet('sb:' + k),
    setItem: (k, v) => desk.storeSet('sb:' + k, v),
    removeItem: (k) => desk.storeSet('sb:' + k, null)
  }

  const sb = SupabaseSDK.createClient(CONFIG.cloud.url, CONFIG.cloud.publishableKey, {
    auth: { storage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, flowType: 'implicit' },
    realtime: { params: { eventsPerSecond: 20 } }
  })

  const ctx = { testId: null, studentId: null, test: null, student: null }

  // The realtime socket authenticates separately from the REST client. If a
  // second user signs in on the same client, the socket keeps the OLD token and
  // silently drops rows the new user is allowed to see, so push it every time.
  async function syncRealtimeAuth () {
    const { data } = await sb.auth.getSession()
    try { await sb.realtime.setAuth(data?.session?.access_token ?? null) } catch {}
  }

  function friendly (err) {
    const msg = String(err?.message || err || 'Something went wrong')
    if (/anonymous.*disabled/i.test(msg) || /anonymous_provider_disabled/i.test(msg)) {
      return new Error('Student sign-in is switched off for this project. The teacher needs to enable Anonymous sign-ins in Supabase → Authentication → Providers.')
    }
    if (/email not confirmed/i.test(msg)) {
      return new Error('This account still needs email confirmation. Confirm it, or turn off "Confirm email" in Supabase → Authentication → Providers → Email.')
    }
    if (/invalid login credentials/i.test(msg)) return new Error('Wrong email or password')
    if (/already registered|already been registered/i.test(msg)) return new Error('An account with that email already exists')
    if (/failed to fetch|network/i.test(msg)) return new Error('Cannot reach the DesmosLock cloud. Check the internet connection.')
    return new Error(msg)
  }

  const asTest = (row, overrideCode) => ({
    id: row.id,
    title: row.title,
    code: row.join_code,
    unlockCode: overrideCode ?? row.test_secrets?.[0]?.override_code ?? row.test_secrets?.override_code ?? '——————',
    locked: !!row.locked,
    active: !!row.active,
    createdAt: Date.parse(row.created_at),
    lockedAt: row.locked_at ? Date.parse(row.locked_at) : null,
    studentCount: row.students?.[0]?.count ?? 0
  })

  const asStudent = (row) => ({
    id: row.id,
    name: row.name,
    online: !row.forfeited && !row.removed && Date.now() - Date.parse(row.last_seen) < ONLINE_WINDOW_MS,
    flags: row.flags || 0,
    lastSeen: Date.parse(row.last_seen),
    forfeited: !!row.forfeited,
    exitedAt: row.exited_at ? Date.parse(row.exited_at) : null
  })

  const asAlert = (row) => ({
    id: row.id,
    studentName: row.student_name,
    kind: row.kind,
    label: labelFor(row.kind),
    detail: row.detail || '',
    severe: row.severe ?? SEVERE_KINDS.has(row.kind),
    at: Date.parse(row.created_at)
  })

  async function profileFor (user) {
    const { data } = await sb.from('teachers').select('id,email,name').eq('id', user.id).maybeSingle()
    return data || { id: user.id, email: user.email, name: (user.user_metadata || {}).name || user.email.split('@')[0] }
  }

  async function fetchStudents (testId) {
    const { data, error } = await sb.from('students').select('*').eq('test_id', testId).eq('removed', false).order('name')
    if (error) throw friendly(error)
    return data.map(asStudent)
  }

  async function fetchAlerts (testId) {
    const { data, error } = await sb.from('alerts').select('*').eq('test_id', testId).order('created_at', { ascending: false }).limit(200)
    if (error) throw friendly(error)
    return data.map(asAlert)
  }

  async function fetchTest (id) {
    const { data, error } = await sb.from('tests').select('*, test_secrets(override_code), students(count)').eq('id', id).single()
    if (error) throw friendly(error)
    return asTest(data)
  }

  return {
    kind: 'cloud',
    label: 'DesmosLock cloud',
    client: sb,
    get socket () { return null },
    heartbeatInterval: HEARTBEAT_MS,

    async register ({ email, password, name }) {
      const { data, error } = await sb.auth.signUp({ email, password, options: { data: { name } } })
      if (error) throw friendly(error)
      if (data.session) await syncRealtimeAuth()
      if (!data.session) {
        throw new Error('Account created — now confirm it from the email Supabase just sent, then sign in. (To skip this step, turn off "Confirm email" in Supabase → Authentication → Providers → Email.)')
      }
      return { profile: await profileFor(data.user), credential: { mode: 'cloud' } }
    },

    async login ({ email, password }) {
      const { data, error } = await sb.auth.signInWithPassword({ email, password })
      if (error) throw friendly(error)
      await syncRealtimeAuth()
      return { profile: await profileFor(data.user), credential: { mode: 'cloud' } }
    },

    async restoreTeacher () {
      const { data } = await sb.auth.getSession()
      const user = data?.session?.user
      if (!user || user.is_anonymous) return null
      await syncRealtimeAuth()
      return { profile: await profileFor(user) }
    },

    async logout () { await sb.auth.signOut() },

    async listTests () {
      const { data, error } = await sb
        .from('tests').select('*, test_secrets(override_code), students(count)')
        .order('created_at', { ascending: false })
      if (error) throw friendly(error)
      return data.map(r => asTest(r))
    },

    async createTest (title) {
      const { data, error } = await sb.rpc('create_test', { p_title: title })
      if (error) throw friendly(error)
      const row = Array.isArray(data) ? data[0] : data
      const test = await fetchTest(row.id)
      return { ...test, unlockCode: row.override_code }
    },

    async loadTest (id) {
      const [test, students, alerts] = await Promise.all([fetchTest(id), fetchStudents(id), fetchAlerts(id)])
      return { test, students, alerts }
    },

    async setLock (id, locked) {
      const { error } = await sb.rpc('set_lock', { p_test: id, p_locked: locked })
      if (error) throw friendly(error)
    },
    async endTest (id) {
      const { error } = await sb.rpc('end_test', { p_test: id })
      if (error) throw friendly(error)
    },
    async releaseStudent (_id, sid) {
      const { error } = await sb.from('students').update({ released: true }).eq('id', sid)
      if (error) throw friendly(error)
    },
    async removeStudent (_id, sid) {
      const { error } = await sb.from('students').update({ removed: true, released: true }).eq('id', sid)
      if (error) throw friendly(error)
    },

    subscribeTeacher (testId, h) {
      let stopped = false
      const refreshRoster = async () => { if (!stopped) h.onRoster(await fetchStudents(testId)) }

      const channel = sb.channel(`teacher:${testId}`)
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'tests', filter: `id=eq.${testId}` },
          (p) => h.onTest(asTest({ ...p.new, test_secrets: [], students: [] })))
        .on('postgres_changes', { event: '*', schema: 'public', table: 'students', filter: `test_id=eq.${testId}` },
          refreshRoster)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'alerts', filter: `test_id=eq.${testId}` },
          (p) => {
            h.onAlert(asAlert(p.new))
            // A join always writes this alert, so it doubles as a safety net if
            // the students INSERT event was missed.
            if (p.new.kind === 'joined') refreshRoster()
          })
        .subscribe()

      // last_seen only moves the "online" dot, so recompute it on a timer
      // rather than pushing a realtime event per student per heartbeat.
      const tick = setInterval(refreshRoster, ONLINE_WINDOW_MS / 2)
      this.loadTest(testId).then(h.onSnapshot).catch(() => {})

      return () => { stopped = true; clearInterval(tick); sb.removeChannel(channel) }
    },

    async join ({ code, name }) {
      const { data: sess } = await sb.auth.getSession()
      if (!sess?.session || !sess.session.user.is_anonymous) {
        const { error } = await sb.auth.signInAnonymously()
        if (error) throw friendly(error)
      }
      await syncRealtimeAuth()
      const { data, error } = await sb.rpc('join_test', { p_code: code, p_name: name })
      if (error) throw friendly(error)
      const row = Array.isArray(data) ? data[0] : data
      ctx.testId = row.test_id
      ctx.studentId = row.student_id
      return {
        student: { id: row.student_id, name },
        test: { id: row.test_id, title: row.title, code: String(code).toUpperCase(), locked: !!row.locked, active: true },
        credential: { mode: 'cloud' }
      }
    },

    async restoreStudent () {
      const { data, error: sessionError } = await sb.auth.getSession()
      if (sessionError) throw friendly(sessionError)
      const user = data?.session?.user
      if (!user || !user.is_anonymous) return null
      await syncRealtimeAuth()
      const { data: rows, error: studentError } = await sb.from('students').select('*').eq('user_id', user.id).eq('removed', false).order('joined_at', { ascending: false }).limit(1)
      if (studentError) throw friendly(studentError)
      const row = rows && rows[0]
      if (!row) return null
      const { data: test, error: testError } = await sb.from('tests').select('*').eq('id', row.test_id).maybeSingle()
      if (testError) throw friendly(testError)
      if (!test || !test.active) return null
      ctx.testId = row.test_id
      ctx.studentId = row.id
      return {
        student: { id: row.id, name: row.name },
        test: { id: test.id, title: test.title, code: test.join_code, locked: !!test.locked && !row.released, active: true }
      }
    },

    subscribeStudent (_c, h) {
      const testId = ctx.testId
      const studentId = ctx.studentId
      // Relaunched into a lock we could not re-authenticate: hold the lock and
      // report the connection as down rather than subscribing to nothing.
      if (!testId || !studentId) {
        h.onConn && h.onConn(false)
        return () => {}
      }
      let locked = false
      let released = false

      const push = () => h.onLock(locked && !released, ctx.test ? { title: ctx.test.title } : null)

      const channel = sb.channel(`student:${studentId}`)
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'tests', filter: `id=eq.${testId}` }, (p) => {
          ctx.test = p.new
          if (!p.new.active) return h.onEnded()
          locked = !!p.new.locked
          push()
        })
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'students', filter: `id=eq.${studentId}` }, (p) => {
          if (p.new.removed) return h.onKicked()
          released = !!p.new.released
          push()
        })
        .subscribe((status) => h.onConn && h.onConn(status === 'SUBSCRIBED'))

      // Pick up anything that changed while we were offline.
      ;(async () => {
        const { data: t } = await sb.from('tests').select('*').eq('id', testId).single()
        const { data: s } = await sb.from('students').select('released,removed').eq('id', studentId).single()
        if (!t) return
        ctx.test = t
        if (!t.active) return h.onEnded()
        if (s?.removed) return h.onKicked()
        locked = !!t.locked
        released = !!s?.released
        push()
      })()

      return () => sb.removeChannel(channel)
    },

    async heartbeat () { await sb.rpc('heartbeat') },

    async reportAlert (kind, detail) {
      if (!ctx.testId || !ctx.studentId) return false
      const { error } = await sb.from('alerts').insert({
        test_id: ctx.testId, student_id: ctx.studentId,
        student_name: ctx.student?.name || 'Student', kind, detail: detail || ''
      })
      return !error
    },

    async forfeit (reason) {
      const { data, error } = await sb.rpc('forfeit_test', { p_reason: reason || '' })
      if (error) throw friendly(error)
      return !!data
    },

    async override (code) {
      const { data, error } = await sb.rpc('use_override', { p_code: code })
      if (error) throw friendly(error)
      if (!data) throw new Error('That override code is not correct')
      return true
    },

    async leave () {
      ctx.testId = null; ctx.studentId = null; ctx.test = null
      await sb.auth.signOut()
    },

    setStudentName (name) { ctx.student = { name } },

    resumeStudent (credential) {
      if (credential?.testId) ctx.testId = credential.testId
      if (credential?.id) ctx.studentId = credential.id
      if (credential?.name) ctx.student = { name: credential.name }
    }
  }
}

/* ══════════════════════════════════════════════════════════════ factory */

function createBackend (mode, serverUrl) {
  return mode === 'cloud' ? createCloudBackend() : createLocalBackend(serverUrl)
}
