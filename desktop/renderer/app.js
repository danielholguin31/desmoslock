/* DesmosLock renderer ------------------------------------------------------
   Two roles in one window: the teacher console and the student calculator.
   The main process owns the actual lock; this file decides when to ask for it.
-------------------------------------------------------------------------- */

const DESMOS_API_KEY = 'dcb31709b452b1cf9dc26972add0fda6' // Desmos public demo key
const DESMOS_SRC = `https://www.desmos.com/api/v1.11/calculator.js?apiKey=${DESMOS_API_KEY}`
const DEFAULT_SERVER = CONFIG.defaultServer

const $ = (sel) => document.querySelector(sel)
const $$ = (sel) => [...document.querySelectorAll(sel)]

const state = {
  mode: CONFIG.defaultMode,   // 'cloud' | 'local'
  serverUrl: DEFAULT_SERVER,
  backend: null,
  view: 'landing',
  teacher: null,        // { profile }
  sessions: [],
  current: null,        // selected test
  students: [],
  alerts: [],
  student: null,        // { id, name, testId, title }
  locked: false,
  unsubscribe: null,
  calc: null,
  lastContact: 0
}

function backendLabel () {
  return state.mode === 'cloud' ? 'DesmosLock cloud' : state.serverUrl
}

// Rebuilds the backend and tells the main process which origin may be reached.
async function useBackend (mode, serverUrl) {
  if (state.unsubscribe) { try { state.unsubscribe() } catch {} ; state.unsubscribe = null }
  state.mode = mode === 'cloud' ? 'cloud' : 'local'
  if (serverUrl) state.serverUrl = normalizeServer(serverUrl)
  state.backend = createBackend(state.mode, state.serverUrl)
  await desk.allowServer(state.mode === 'cloud' ? CONFIG.cloud.url : state.serverUrl)
  await desk.storeSet('backend', { mode: state.mode, serverUrl: state.serverUrl })
  for (const id of ['#landing-server', '#auth-server', '#join-server']) {
    const el = $(id)
    if (!el) continue
    if (el.tagName === 'INPUT') el.value = backendLabel(); else el.textContent = backendLabel()
  }
  return state.backend
}

const OFFLINE_ESCAPE_MS = 90_000  // after this long with no server, offer a logged force-exit

/* ───────────────────────────────────────────────────── plumbing */

function show (view) {
  state.view = view
  $$('.view').forEach(v => v.classList.toggle('on', v.id === `view-${view}`))
}

function toast (msg, ms = 2600) {
  const el = $('#toast')
  el.textContent = msg
  el.classList.remove('hidden')
  clearTimeout(toast._t)
  toast._t = setTimeout(() => el.classList.add('hidden'), ms)
}

function showError (el, msg) {
  el.textContent = msg
  el.classList.toggle('hidden', !msg)
}

/* In-app dialogs. Electron has no window.prompt(), and native modals behave
   badly over a kiosk-locked window, so both live inside the page. */

function ask ({ title, body = '', value = '', ok = 'OK', input = true }) {
  return new Promise((resolve) => {
    const box = $('#ask')
    $('#ask-title').textContent = title
    $('#ask-body').textContent = body
    $('#ask-body').classList.toggle('hidden', !body)
    $('#ask-input').value = value
    $('#ask-input').classList.toggle('hidden', !input)
    $('#ask-ok').textContent = ok
    box.classList.remove('hidden')
    if (input) { $('#ask-input').focus(); $('#ask-input').select() }

    const done = (result) => {
      box.classList.add('hidden')
      $('#ask-ok').removeEventListener('click', accept)
      $('#ask-cancel').removeEventListener('click', cancel)
      $('#ask-input').removeEventListener('keydown', onKey)
      resolve(result)
    }
    const accept = () => done(input ? $('#ask-input').value.trim() : true)
    const cancel = () => done(null)
    const onKey = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); accept() }
      if (e.key === 'Escape') { e.preventDefault(); cancel() }
    }
    $('#ask-ok').addEventListener('click', accept)
    $('#ask-cancel').addEventListener('click', cancel)
    $('#ask-input').addEventListener('keydown', onKey)
  })
}

async function sure (title, body, ok = 'Confirm') {
  return (await ask({ title, body, ok, input: false })) === true
}

function normalizeServer (raw) {
  let url = String(raw || '').trim()
  if (!url) return DEFAULT_SERVER
  if (!/^https?:\/\//i.test(url)) url = 'http://' + url
  return url.replace(/\/+$/, '')
}


function when (ts) {
  const d = new Date(ts)
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function ago (ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return new Date(ts).toLocaleDateString()
}

/* ───────────────────────────────────────────────── navigation */

$$('[data-goto]').forEach(btn => btn.addEventListener('click', () => {
  const target = btn.dataset.goto
  $('#auth-server').value = backendLabel()
  $('#join-server').value = backendLabel()
  show(target === 'landing' ? 'landing' : target === 'teacher-auth' ? 'teacher-auth' : 'student-join')
}))

$('#landing-change-server').addEventListener('click', async () => {
  const next = await ask({
    title: 'Which backend?',
    body: 'Type "cloud" for the hosted DesmosLock backend, or the address of a DesmosLock server on your network (e.g. http://192.168.1.20:4000). A local server keeps working when the internet is down.',
    value: state.mode === 'cloud' ? 'cloud' : state.serverUrl,
    ok: 'Save'
  })
  if (next === null) return
  const wantsCloud = /^(cloud|supabase)$/i.test(next.trim())
  await useBackend(wantsCloud ? 'cloud' : 'local', wantsCloud ? null : next)
  toast(`Using ${backendLabel()}`)
})

/* ─────────────────────────────────────────────── teacher auth */

let authMode = 'login'

function setAuthMode (mode) {
  authMode = mode
  const signup = mode === 'signup'
  $('#auth-title').textContent = signup ? 'Create your account' : 'Sign in'
  $('#auth-sub').textContent = signup
    ? 'Teachers only. Students join with a code — no account needed.'
    : 'Teachers only. Students never make an account.'
  $('#auth-submit').textContent = signup ? 'Create account' : 'Sign in'
  $('#field-name').classList.toggle('hidden', !signup)
  $('#auth-swap-label').textContent = signup ? 'Already have an account?' : 'No account yet?'
  $('#auth-swap').textContent = signup ? 'Sign in' : 'Create one'
  showError($('#auth-error'), '')
}

$('#auth-swap').addEventListener('click', () => setAuthMode(authMode === 'login' ? 'signup' : 'login'))

$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const btn = $('#auth-submit')
  btn.disabled = true
  showError($('#auth-error'), '')

  try {
    const creds = {
      email: $('#auth-email').value,
      password: $('#auth-password').value,
      name: $('#auth-name').value
    }
    const { profile, credential } = authMode === 'signup'
      ? await state.backend.register(creds)
      : await state.backend.login(creds)
    state.teacher = { profile }
    await desk.storeSet('teacher', { ...credential, mode: state.mode, serverUrl: state.serverUrl })
    $('#auth-password').value = ''
    await enterConsole()
  } catch (err) {
    showError($('#auth-error'), err.message)
  } finally {
    btn.disabled = false
  }
})

$('#sign-out').addEventListener('click', async () => {
  if (state.unsubscribe) { state.unsubscribe(); state.unsubscribe = null }
  try { await state.backend.logout() } catch {}
  state.teacher = null
  state.current = null
  await desk.storeSet('teacher', null)
  show('landing')
})

/* ───────────────────────────────────────────── teacher console */

async function enterConsole () {
  const p = state.teacher.profile
  $('#t-name').textContent = p.name || 'Teacher'
  $('#t-email').textContent = p.email
  $('#t-avatar').textContent = (p.name || p.email).trim()[0].toUpperCase()

  // Show which school's licence this teacher is teaching under.
  const badge = $('#t-school')
  if (badge) {
    if (p.school) {
      badge.textContent = p.school.name +
        (p.school.status === 'trial' ? ` · trial, ${Math.max(0, p.school.daysLeft)}d left` : '')
      badge.className = 'side-school' + (p.school.status === 'trial' ? ' trial' : '')
      badge.classList.remove('hidden')
    } else {
      badge.classList.add('hidden')
    }
  }
  await desk.setWindowMode('console')
  show('console')
  await loadSessions()
}

async function loadSessions () {
  const sessions = await state.backend.listTests()
  state.sessions = sessions
  renderSessionList()
  if (!state.current && sessions.length) selectSession(sessions[0].id)
  else if (state.current) {
    const fresh = sessions.find(s => s.id === state.current.id)
    if (fresh) { state.current = fresh; renderSession() }
  }
}

function renderSessionList () {
  const list = $('#session-list')
  list.innerHTML = ''
  for (const s of state.sessions) {
    const btn = document.createElement('button')
    btn.className = 'side-item'
    if (state.current && s.id === state.current.id) btn.classList.add('on')
    if (s.locked) btn.classList.add('locked')
    else if (s.active) btn.classList.add('live')
    btn.innerHTML = `<span class="dot"></span><span class="t"></span><span class="c"></span>`
    btn.querySelector('.t').textContent = s.title
    btn.querySelector('.c').textContent = s.active ? s.code : 'ended'
    btn.addEventListener('click', () => selectSession(s.id))
    list.appendChild(btn)
  }
}

$('#new-session').addEventListener('click', async () => {
  const title = await ask({ title: 'Name this test', value: 'Unit 4 Test', ok: 'Create' })
  if (title === null) return
  try {
    const test = await state.backend.createTest(title)
    state.sessions.unshift(test)
    selectSession(test.id)
    toast(`Class code ${test.code}`)
  } catch (err) { toast(err.message) }
})

function selectSession (id) {
  state.current = state.sessions.find(s => s.id === id) || null
  state.students = []
  state.alerts = []
  $('#console-empty').classList.add('hidden')
  $('#console-body').classList.remove('hidden')
  renderSessionList()
  renderSession()
  renderRoster()
  renderFeed()

  if (state.unsubscribe) { state.unsubscribe(); state.unsubscribe = null }
  state.unsubscribe = state.backend.subscribeTeacher(id, {
    onSnapshot ({ test, students, alerts }) {
      state.current = { ...test, unlockCode: test.unlockCode ?? state.current?.unlockCode }
      state.students = students
      state.alerts = alerts
      renderSession(); renderRoster(); renderFeed(); renderSessionList()
    },
    onTest (test) {
      // Realtime rows carry no joined override code; keep the one we have.
      state.current = { ...test, unlockCode: state.current?.unlockCode ?? test.unlockCode }
      const i = state.sessions.findIndex(s => s.id === test.id)
      if (i >= 0) state.sessions[i] = { ...state.sessions[i], ...state.current }
      renderSession(); renderSessionList()
    },
    onRoster (students) { state.students = students; renderRoster(); renderSession() },
    onAlert (alert) {
      state.alerts.unshift(alert)
      renderFeed()
      if (alert.severe) toast(`⚠ ${alert.studentName} ${alert.label}`)
    }
  })
}

function renderSession () {
  const s = state.current
  if (!s) return
  $('#s-title').value = s.title
  $('#s-code').textContent = s.code
  $('#s-unlock').textContent = s.unlockCode
  $('#s-created').textContent = 'Created ' + ago(s.createdAt)

  const online = state.students.filter(x => x.online).length
  $('#s-count').textContent = state.students.length
  $('#s-online').textContent = online
  $('#s-flags').textContent = state.students.reduce((n, x) => n + (x.flags || 0), 0)

  const pill = $('#s-state')
  pill.classList.remove('locked', 'ended')
  if (!s.active) { pill.textContent = 'Ended'; pill.classList.add('ended') }
  else if (s.locked) { pill.textContent = 'Locked'; pill.classList.add('locked') }
  else pill.textContent = 'Unlocked'

  const ended = !s.active
  $('#btn-lock').classList.toggle('hidden', s.locked || ended)
  $('#btn-unlock').classList.toggle('hidden', !s.locked || ended)
  $('#btn-end').classList.toggle('hidden', ended)
  $('#lock-note').textContent = ended
    ? 'This test has ended. Every device was released.'
    : s.locked
      ? `Locked ${ago(s.lockedAt)} — ${online} device${online === 1 ? '' : 's'} held on the calculator.`
      : 'Locking freezes every joined device onto the calculator.'
}

function renderRoster () {
  const el = $('#roster')
  $('#roster-count').textContent = state.students.length
  if (!state.students.length) { el.innerHTML = '<div class="none">Nobody has joined yet.</div>'; return }

  el.innerHTML = ''
  for (const s of state.students) {
    const row = document.createElement('div')
    row.className = 'row' + (s.forfeited ? ' forfeited' : '')
    row.innerHTML = `
      <span class="status ${s.online ? 'on' : ''}"></span>
      <span class="who"></span>
      ${s.forfeited ? '<span class="flag bad">forfeited</span>' : ''}
      ${s.flags ? `<span class="flag">${s.flags} flag${s.flags === 1 ? '' : 's'}</span>` : ''}
      <span class="dim">${s.forfeited ? 'left ' + ago(s.exitedAt) : s.online ? 'online' : ago(s.lastSeen)}</span>
      <span class="row-act">
        <button class="btn tiny ghost" data-act="release">Release</button>
        <button class="btn tiny ghost danger" data-act="remove">Remove</button>
      </span>`
    row.querySelector('.who').textContent = s.name
    row.querySelector('[data-act="release"]').addEventListener('click', async () => {
      await state.backend.releaseStudent(state.current.id, s.id)
      toast(`${s.name} released`)
    })
    row.querySelector('[data-act="remove"]').addEventListener('click', async () => {
      if (!await sure('Remove student?', `${s.name} will be dropped from this test and unlocked.`, 'Remove')) return
      await state.backend.removeStudent(state.current.id, s.id)
    })
    el.appendChild(row)
  }
}

function renderFeed () {
  const el = $('#feed')
  if (!state.alerts.length) { el.innerHTML = '<div class="none">No activity yet.</div>'; return }
  el.innerHTML = ''
  for (const a of state.alerts.slice(0, 200)) {
    const div = document.createElement('div')
    div.className = 'event' + (a.severe ? ' severe' : '')
    div.innerHTML = `<span class="e-time">${when(a.at)}</span><span class="e-who"></span> <span class="e-what"></span>`
    div.querySelector('.e-who').textContent = a.studentName
    div.querySelector('.e-what').textContent = a.label + (a.detail ? ` · ${a.detail}` : '')
    el.appendChild(div)
  }
}

$('#btn-lock').addEventListener('click', async () => {
  const online = state.students.filter(s => s.online).length
  if (!await sure('Lock all devices?', `${online} device${online === 1 ? '' : 's'} will be frozen onto the calculator until you unlock.`, 'Lock')) return
  try { await state.backend.setLock(state.current.id, true); toast('Locked') } catch (err) { toast(err.message) }
})

$('#btn-unlock').addEventListener('click', async () => {
  try { await state.backend.setLock(state.current.id, false); toast('Unlocked') } catch (err) { toast(err.message) }
})

$('#btn-end').addEventListener('click', async () => {
  if (!await sure('End this test?', 'Every device is released and the class code stops working.', 'End test')) return
  try { await state.backend.endTest(state.current.id); await loadSessions() } catch (err) { toast(err.message) }
})

/* ─────────────────────────────────────────────── student join */

$('#join-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  showError($('#join-error'), '')

  // Nothing else may be running before a test starts.
  const code = $('#join-code').value
  const name = $('#join-name').value
  if (!await ensureNothingElseRunning()) return

  try {
    const { student, test, credential } = await state.backend.join({ code, name })
    state.student = { id: student.id, name: student.name, testId: test.id, title: test.title }
    state.backend.setStudentName && state.backend.setStudentName(student.name)
    await desk.storeSet('student', { ...state.student, ...credential, mode: state.mode, serverUrl: state.serverUrl })
    await enterCalculator(test.locked)
  } catch (err) {
    showError($('#join-error'), err.message)
  }
})

$('#join-code').addEventListener('input', (e) => {
  e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '')
})

$('#leave-btn').addEventListener('click', async () => {
  if (state.locked) return toast('You cannot leave while the test is locked.')
  if (!state.student) return show('landing')
  if (!await sure('Leave this test?', 'Your teacher is told that you left. You can rejoin with the same code.', 'Leave')) return
  try { await state.backend.forfeit('Left before the lock') } catch {}
  await leaveSession()
})

// The X. The only way a student gets themselves out of a live lock, and it
// costs them the test.
$('#exit-btn').addEventListener('click', async () => {
  const confirmed = await sure(
    'Exit and forfeit the test?',
    'Your test ends here. The calculator closes, your teacher is told immediately that you left early, and you cannot rejoin this test without them letting you back in.',
    'Forfeit and exit'
  )
  if (!confirmed) return
  try {
    await state.backend.forfeit('Student pressed exit')
  } catch (err) {
    return toast(err.message)
  }
  await applyLock(false)
  toast('You exited the test. Your teacher was notified.')
  await leaveSession()
})

/* ────────────────────────────────── close-everything-else gate */

let gateResolve = null

function renderAppList (apps) {
  const el = $('#applist')
  el.classList.toggle('clear', apps.length === 0)
  if (!apps.length) { el.innerHTML = '<div class="all-clear">✓ Nothing else is running. You are good to go.</div>'; return }
  el.innerHTML = ''
  for (const a of apps) {
    const row = document.createElement('div')
    row.className = 'app-row'
    row.innerHTML = '<span class="badge"></span><span class="nm"></span>' + (a.pid ? `<span class="pid">pid ${a.pid}</span>` : '')
    row.querySelector('.nm').textContent = a.name
    el.appendChild(row)
  }
}

// Resolves true only once nothing else is running. There is no way past this
// screen with an app open — that is the point of it.
async function ensureNothingElseRunning () {
  const apps = await desk.scanApps()
  if (!apps.length) return true
  showError($('#appcheck-error'), '')
  renderAppList(apps)
  show('appcheck')
  return new Promise((resolve) => { gateResolve = resolve })
}

$('#appcheck-recheck').addEventListener('click', async () => {
  const btn = $('#appcheck-recheck')
  btn.disabled = true
  const apps = await desk.scanApps()
  renderAppList(apps)
  btn.disabled = false
  if (!apps.length) {
    showError($('#appcheck-error'), '')
    const done = gateResolve; gateResolve = null
    if (done) done(true)
    return
  }
  showError($('#appcheck-error'), `Still ${apps.length} app${apps.length === 1 ? '' : 's'} open. Quit ${apps.length === 1 ? 'it' : 'them all'} to continue.`)
  const el = $('#applist')
  el.classList.remove('nudge'); void el.offsetWidth; el.classList.add('nudge')
})

$('#appcheck-cancel').addEventListener('click', () => {
  const done = gateResolve; gateResolve = null
  if (done) done(false)
  show('student-join')
})

/* ──────────────────────────────────────────────── calculator */

function loadDesmos () {
  if (window.Desmos) return Promise.resolve()
  if (loadDesmos._p) return loadDesmos._p
  loadDesmos._p = new Promise((resolve, reject) => {
    const el = document.createElement('script')
    el.src = DESMOS_SRC
    el.onload = resolve
    el.onerror = () => reject(new Error('Could not reach desmos.com. Check the internet connection.'))
    document.head.appendChild(el)
  })
  return loadDesmos._p
}

async function enterCalculator (lockedNow) {
  $('#calc-student').textContent = state.student.name
  $('#calc-test').textContent = state.student.title || ''
  show('calc')

  // Re-engage a persisted lock before loading any remote calculator code. A
  // slow/offline Desmos request must never leave a recovered student able to
  // quit or switch away.
  await applyLock(!!lockedNow)

  try {
    await loadDesmos()
  } catch (err) {
    $('#calculator').innerHTML = `<div class="empty"><div class="empty-mark">⚠</div><p>${err.message}</p></div>`
  }

  if (window.Desmos && !state.calc) {
    // The stock calculator, no option overrides — exactly what desmos.com gives.
    state.calc = Desmos.GraphingCalculator($('#calculator'))
    const saved = await desk.storeGet('graph:' + state.student.testId)
    if (saved) { try { state.calc.setState(saved) } catch {} }

    // Autosave the student's work: settle quickly after a pause, but never go
    // more than 3s without a write while they're editing continuously.
    let dirty = false
    let lastSave = 0
    let t = null
    const save = () => {
      dirty = false
      lastSave = Date.now()
      clearTimeout(t)
      desk.storeSet('graph:' + state.student.testId, state.calc.getState())
    }
    state.calc.observeEvent('change', () => {
      dirty = true
      if (Date.now() - lastSave > 3000) return save()
      clearTimeout(t)
      t = setTimeout(save, 600)
    })
    clearInterval(enterCalculator._save)
    enterCalculator._save = setInterval(() => { if (dirty) save() }, 3000)
  }

  if (state.unsubscribe) { state.unsubscribe(); state.unsubscribe = null }
  state.unsubscribe = state.backend.subscribeStudent(state.student, {
    onLock (locked, test) {
      state.lastContact = Date.now()
      if (test && test.title) $('#calc-test').textContent = test.title
      applyLock(locked)
    },
    onEnded () { applyLock(false); toast('Your teacher ended the test.'); leaveSession() },
    onKicked () { applyLock(false); toast('You were removed from this test.'); leaveSession() },
    onError (msg) { toast(msg) },
    onConn (up) {
      if (up) { state.lastContact = Date.now(); setConn('ok', 'connected'); flushPendingAlerts() }
      else setConn('off', 'reconnecting')
    }
  })

  clearInterval(enterCalculator._hb)
  enterCalculator._hb = setInterval(() => {
    Promise.resolve(state.backend.heartbeat()).then(() => { state.lastContact = Date.now() }).catch(() => {})
  }, state.backend.heartbeatInterval || 5000)
}

async function leaveSession () {
  if (state.unsubscribe) { try { state.unsubscribe() } catch {} ; state.unsubscribe = null }
  try { await state.backend.leave() } catch {}
  clearInterval(enterCalculator._hb)
  clearInterval(enterCalculator._save)
  state.student = null
  await desk.storeSet('student', null)
  // Delayed so the student reads the toast first — but only if they are still
  // sitting on the calculator and have not started joining something else.
  clearTimeout(leaveSession._t)
  leaveSession._t = setTimeout(() => {
    if (!state.student && state.view === 'calc') show('landing')
  }, 1200)
}

function setConn (cls, label) {
  const el = $('#conn')
  el.className = 'conn ' + cls
  el.innerHTML = '<i></i>' + label
}

async function applyLock (on, { persist = true } = {}) {
  if (state.locked === on) return
  state.locked = on
  document.body.classList.toggle('is-locked', on)

  // Remembered so a force-quit during a locked test comes back locked.
  if (persist) {
    const saved = await desk.storeGet('student')
    if (saved) await desk.storeSet('student', { ...saved, wasLocked: on })
  }

  $('#lock-chip').classList.toggle('hidden', !on)
  $('#leave-btn').classList.toggle('hidden', on)
  $('#exit-btn').classList.toggle('hidden', !on)

  if (on) {
    await desk.engageLock()
    const splash = $('#lock-splash')
    splash.classList.remove('hidden')
    setTimeout(() => splash.classList.add('hidden'), 2200)
  } else {
    await desk.releaseLock()
    $('#override').classList.add('hidden')
    $('#lock-splash').classList.add('hidden')
  }
}

/* ───────────────────────────────────────── integrity reporting */

async function queueAlert (kind, detail = '') {
  if (await Promise.resolve(state.backend.reportAlert(kind, detail)).catch(() => false)) return
  const pending = (await desk.storeGet('pendingAlerts')) || []
  pending.push({ kind, detail: `${detail}${detail ? ' · ' : ''}offline at ${new Date().toLocaleTimeString()}` })
  await desk.storeSet('pendingAlerts', pending.slice(-50))
}

async function flushPendingAlerts () {
  const pending = (await desk.storeGet('pendingAlerts')) || []
  if (!pending.length) return
  for (const a of pending) await Promise.resolve(state.backend.reportAlert(a.kind, a.detail)).catch(() => {})
  await desk.storeSet('pendingAlerts', null)
}

function offlineFor () {
  return state.lastContact ? Date.now() - state.lastContact : Infinity
}

desk.onLockEvent(({ kind, detail }) => {
  if (kind === 'override_prompt') {
    if (state.locked) {
      showError($('#override-error'), '')
      $('#override-code').value = ''
      $('#override-escape').classList.toggle('hidden', offlineFor() < OFFLINE_ESCAPE_MS)
      $('#override').classList.remove('hidden')
      $('#override-code').focus()
    }
    return
  }
  if (!state.locked) return
  queueAlert(kind, detail)
  if (kind === 'left_app') toast('Stay on the calculator — your teacher was notified.')
  if (kind === 'quit_attempt') toast('You cannot quit while the test is locked.')
})

$('#override-cancel').addEventListener('click', () => $('#override').classList.add('hidden'))

$('#override-code').addEventListener('input', (e) => {
  e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '')
})

$('#override-submit').addEventListener('click', async () => {
  showError($('#override-error'), '')
  try {
    await state.backend.override($('#override-code').value)
    $('#override').classList.add('hidden')
  } catch (err) {
    showError($('#override-error'), err.message)
  }
})

$('#override-force').addEventListener('click', async () => {
  if (offlineFor() < OFFLINE_ESCAPE_MS) return
  if (!await sure('Force-exit the lock?', 'Your teacher receives a flagged report as soon as the connection is back.', 'Force exit')) return
  await queueAlert('forced_exit', 'Server unreachable')
  await applyLock(false)
  $('#override').classList.add('hidden')
  toast('Lock released. This was recorded.')
})

// Renderer-level hardening: no menus, no drag-and-drop, no stray shortcuts.
window.addEventListener('contextmenu', (e) => { if (state.locked) e.preventDefault() })
window.addEventListener('dragover', (e) => e.preventDefault())
window.addEventListener('drop', (e) => e.preventDefault())
window.addEventListener('keydown', (e) => {
  if (!state.locked) return
  const mod = e.metaKey || e.ctrlKey
  const blocked = (mod && ['q', 'w', 'r', 'n', 't', 'p', 'o', 's', 'm', 'h'].includes(e.key.toLowerCase())) ||
                  /^F\d{1,2}$/.test(e.key) ||
                  (e.altKey && e.key === 'Tab')
  if (blocked) { e.preventDefault(); e.stopPropagation() }
})
window.addEventListener('blur', () => {
  if (state.locked) queueAlert('left_app', 'Renderer lost focus')
})

/* ──────────────────────────────────────────────────── boot */

;(async function boot () {
  const saved = await desk.storeGet('student')
  // This flag was persisted before the earlier lock engaged. Re-engage from it
  // before creating a backend or awaiting any network-dependent work.
  if (saved?.wasLocked) await applyLock(true, { persist: false })

  const savedBackend = (await desk.storeGet('backend')) || {}
  await useBackend(savedBackend.mode || CONFIG.defaultMode, savedBackend.serverUrl || DEFAULT_SERVER)
  setAuthMode('login')
  show('landing')

  // A locked student who force-quit lands straight back in the locked test.
  if (saved && (saved.token || saved.mode === 'cloud')) {
    if (saved.mode && saved.mode !== state.mode) await useBackend(saved.mode, saved.serverUrl)

    let restored = null
    let reachable = true
    try {
      restored = await state.backend.restoreStudent(saved)
    } catch {
      reachable = false
    }

    if (restored) {
      state.student = { id: restored.student.id, name: restored.student.name, testId: restored.test.id, title: restored.test.title }
      state.backend.setStudentName && state.backend.setStudentName(restored.student.name)
      // The backend response is authoritative. In particular, clear a stale
      // persisted lock when the teacher unlocked or released this student while
      // the app was not running.
      await desk.storeSet('student', { ...saved, ...state.student, wasLocked: !!restored.test.locked })
      // Outside the try: a rendering fault here must not be mistaken for the
      // backend being unreachable.
      await enterCalculator(restored.test.locked)
      return
    }

    // Backend unreachable and they were locked when the app died: stay locked
    // and keep retrying, rather than handing back an unlocked machine. The
    // credential still goes to the backend so the socket can authenticate the
    // moment the server answers again.
    if (!reachable && saved.wasLocked) {
      state.student = { id: saved.id, name: saved.name, testId: saved.testId, title: saved.title }
      state.backend.resumeStudent && state.backend.resumeStudent(saved)
      state.backend.setStudentName && state.backend.setStudentName(saved.name)
      await enterCalculator(true)
      return
    }

    // A successful no-student/inactive response is authoritative and may
    // release the provisional startup lock before removing stale credentials.
    if (saved.wasLocked) await applyLock(false)
    await desk.storeSet('student', null)
    state.student = null
  }

  const savedTeacher = await desk.storeGet('teacher')
  if (savedTeacher && (savedTeacher.token || savedTeacher.mode === 'cloud')) {
    if (savedTeacher.mode && savedTeacher.mode !== state.mode) await useBackend(savedTeacher.mode, savedTeacher.serverUrl)
    try {
      const restored = await state.backend.restoreTeacher(savedTeacher)
      if (restored) {
        state.teacher = { profile: restored.profile }
        await enterConsole()
      } else {
        await desk.storeSet('teacher', null)
      }
    } catch {
      await desk.storeSet('teacher', null)
    }
  }
})()
