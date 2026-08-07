import http from 'http'
import os from 'os'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import crypto from 'crypto'
import express from 'express'
import cors from 'cors'
import bcrypt from 'bcryptjs'
import { WebSocketServer } from 'ws'
import { db, save } from './db.js'

const PORT = Number(process.env.PORT || 4000)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const WEB_DIR = path.join(__dirname, '..', '..', 'web')
const DOWNLOAD_DIR = path.join(WEB_DIR, 'downloads')

const app = express()
app.use(cors())
app.use(express.json({ limit: '256kb' }))

/* ------------------------------------------------------------------ utils */

const id = () => crypto.randomUUID()
const now = () => Date.now()

// Ambiguity-free alphabet: no O/0, no I/1, no S/5.
const ALPHABET = 'ABCDEFGHJKLMNPQRTUVWXYZ234679'
function randomCode (len = 6) {
  const bytes = crypto.randomBytes(len)
  let out = ''
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length]
  return out
}

function uniqueJoinCode () {
  let code
  do { code = randomCode(6) } while (db.sessions.some(s => s.active && s.code === code))
  return code
}

function issueToken (kind, subjectId) {
  const token = crypto.randomBytes(24).toString('hex')
  db.tokens[token] = { kind, id: subjectId, at: now() }
  save()
  return token
}

function resolveToken (token) {
  if (!token) return null
  return db.tokens[token] || null
}

function teacherFromReq (req) {
  const header = req.get('authorization') || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : null
  const claim = resolveToken(token)
  if (!claim || claim.kind !== 'teacher') return null
  return db.teachers.find(t => t.id === claim.id) || null
}

function requireTeacher (req, res, next) {
  const teacher = teacherFromReq(req)
  if (!teacher) return res.status(401).json({ error: 'Not signed in' })
  req.teacher = teacher
  next()
}

function publicTeacher (t) {
  return { id: t.id, email: t.email, name: t.name }
}

function publicStudent (s) {
  return {
    id: s.id,
    name: s.name,
    joinedAt: s.joinedAt,
    lastSeen: s.lastSeen,
    online: onlineStudentIds.has(s.id),
    flags: s.flags || 0,
    removed: !!s.removed,
    forfeited: !!s.forfeited,
    exitedAt: s.exitedAt || null
  }
}

function publicSession (s) {
  return {
    id: s.id,
    code: s.code,
    unlockCode: s.unlockCode,
    title: s.title,
    locked: !!s.locked,
    active: !!s.active,
    createdAt: s.createdAt,
    lockedAt: s.lockedAt || null,
    endedAt: s.endedAt || null,
    studentCount: db.students.filter(st => st.sessionId === s.id && !st.removed).length
  }
}

function sessionStudents (sessionId) {
  return db.students
    .filter(s => s.sessionId === sessionId && !s.removed)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(publicStudent)
}

function sessionAlerts (sessionId, limit = 200) {
  return db.alerts.filter(a => a.sessionId === sessionId).slice(-limit).reverse()
}

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
  left_session: 'left the test'
}

const SEVERE = new Set([
  'left_app', 'quit_attempt', 'screen_locked', 'override_used',
  'override_failed', 'display_changed', 'forced_exit', 'forfeited'
])

function recordAlert (sessionId, studentId, kind, detail = '') {
  const student = db.students.find(s => s.id === studentId)
  const alert = {
    id: id(),
    sessionId,
    studentId,
    studentName: student ? student.name : 'Unknown',
    kind,
    label: ALERT_LABELS[kind] || kind,
    detail,
    severe: SEVERE.has(kind),
    at: now()
  }
  db.alerts.push(alert)
  if (student && SEVERE.has(kind)) {
    student.flags = (student.flags || 0) + 1
  }
  if (db.alerts.length > 5000) db.alerts.splice(0, db.alerts.length - 5000)
  save()
  broadcastToTeachers(sessionId, { type: 'alert', alert })
  broadcastRoster(sessionId)
  return alert
}

/* ----------------------------------------------------------- HTTP: teacher */

app.post('/api/teacher/register', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase()
  const password = String(req.body.password || '')
  const name = String(req.body.name || '').trim() || email.split('@')[0]

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address' })
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' })
  if (db.teachers.some(t => t.email === email)) return res.status(409).json({ error: 'An account with that email already exists' })

  const teacher = {
    id: id(),
    email,
    name,
    passwordHash: bcrypt.hashSync(password, 10),
    createdAt: now()
  }
  db.teachers.push(teacher)
  save()
  res.json({ token: issueToken('teacher', teacher.id), teacher: publicTeacher(teacher) })
})

app.post('/api/teacher/login', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase()
  const password = String(req.body.password || '')
  const teacher = db.teachers.find(t => t.email === email)
  if (!teacher || !bcrypt.compareSync(password, teacher.passwordHash)) {
    return res.status(401).json({ error: 'Wrong email or password' })
  }
  res.json({ token: issueToken('teacher', teacher.id), teacher: publicTeacher(teacher) })
})

app.get('/api/teacher/me', requireTeacher, (req, res) => {
  res.json({ teacher: publicTeacher(req.teacher) })
})

app.post('/api/teacher/logout', requireTeacher, (req, res) => {
  const header = req.get('authorization') || ''
  delete db.tokens[header.slice(7)]
  save()
  res.json({ ok: true })
})

/* ---------------------------------------------------------- HTTP: sessions */

app.get('/api/sessions', requireTeacher, (req, res) => {
  const sessions = db.sessions
    .filter(s => s.teacherId === req.teacher.id)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(publicSession)
  res.json({ sessions })
})

app.post('/api/sessions', requireTeacher, (req, res) => {
  const title = String(req.body.title || '').trim() || 'Untitled test'
  const session = {
    id: id(),
    teacherId: req.teacher.id,
    title,
    code: uniqueJoinCode(),
    unlockCode: randomCode(6),
    locked: false,
    active: true,
    createdAt: now(),
    lockedAt: null,
    endedAt: null
  }
  db.sessions.push(session)
  save()
  res.json({ session: publicSession(session) })
})

function ownedSession (req, res) {
  const session = db.sessions.find(s => s.id === req.params.id)
  if (!session || session.teacherId !== req.teacher.id) {
    res.status(404).json({ error: 'Session not found' })
    return null
  }
  return session
}

app.get('/api/sessions/:id', requireTeacher, (req, res) => {
  const session = ownedSession(req, res); if (!session) return
  res.json({
    session: publicSession(session),
    students: sessionStudents(session.id),
    alerts: sessionAlerts(session.id)
  })
})

app.post('/api/sessions/:id/lock', requireTeacher, (req, res) => {
  const session = ownedSession(req, res); if (!session) return
  if (!session.active) return res.status(400).json({ error: 'Session has ended' })
  session.locked = true
  session.lockedAt = now()
  // A new lock clears any individual releases from the previous one.
  for (const s of db.students) if (s.sessionId === session.id) s.released = false
  save()
  broadcastLockState(session)
  res.json({ session: publicSession(session) })
})

app.post('/api/sessions/:id/unlock', requireTeacher, (req, res) => {
  const session = ownedSession(req, res); if (!session) return
  session.locked = false
  save()
  broadcastLockState(session)
  res.json({ session: publicSession(session) })
})

app.post('/api/sessions/:id/end', requireTeacher, (req, res) => {
  const session = ownedSession(req, res); if (!session) return
  session.locked = false
  session.active = false
  session.endedAt = now()
  save()
  broadcastLockState(session)
  broadcastToStudents(session.id, { type: 'ended' })
  res.json({ session: publicSession(session) })
})

app.post('/api/sessions/:id/students/:studentId/release', requireTeacher, (req, res) => {
  const session = ownedSession(req, res); if (!session) return
  const student = db.students.find(s => s.id === req.params.studentId && s.sessionId === session.id)
  if (!student) return res.status(404).json({ error: 'Student not found' })
  student.released = true
  save()
  sendToStudent(student.id, { type: 'lock', locked: false, reason: 'released' })
  res.json({ ok: true })
})

app.post('/api/sessions/:id/students/:studentId/remove', requireTeacher, (req, res) => {
  const session = ownedSession(req, res); if (!session) return
  const student = db.students.find(s => s.id === req.params.studentId && s.sessionId === session.id)
  if (!student) return res.status(404).json({ error: 'Student not found' })
  student.removed = true
  student.released = true
  save()
  sendToStudent(student.id, { type: 'kicked' })
  broadcastRoster(session.id)
  res.json({ ok: true })
})

/* ----------------------------------------------------------- HTTP: student */

app.post('/api/join', (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase()
  const name = String(req.body.name || '').trim()
  if (!code) return res.status(400).json({ error: 'Enter the class code' })
  if (name.length < 2) return res.status(400).json({ error: 'Enter your full name' })

  const session = db.sessions.find(s => s.code === code && s.active)
  if (!session) return res.status(404).json({ error: 'That code is not active. Check with your teacher.' })

  let student = db.students.find(s => s.sessionId === session.id && s.name.toLowerCase() === name.toLowerCase() && !s.removed)
  if (!student) {
    student = {
      id: id(),
      sessionId: session.id,
      name,
      joinedAt: now(),
      lastSeen: now(),
      flags: 0,
      released: false,
      removed: false
    }
    db.students.push(student)
  }
  student.released = false
  save()

  const token = issueToken('student', student.id)
  recordAlert(session.id, student.id, 'joined')

  res.json({
    token,
    student: publicStudent(student),
    session: { id: session.id, title: session.title, code: session.code, locked: !!session.locked, active: true }
  })
})

app.get('/api/student/state', (req, res) => {
  const header = req.get('authorization') || ''
  const claim = resolveToken(header.startsWith('Bearer ') ? header.slice(7) : null)
  if (!claim || claim.kind !== 'student') return res.status(401).json({ error: 'Not joined' })
  const student = db.students.find(s => s.id === claim.id)
  if (!student || student.removed) return res.status(401).json({ error: 'Removed from session' })
  const session = db.sessions.find(s => s.id === student.sessionId)
  if (!session || !session.active) return res.status(410).json({ error: 'Session ended' })
  res.json({
    student: publicStudent(student),
    session: { id: session.id, title: session.title, code: session.code, locked: !!session.locked && !student.released, active: true }
  })
})

// Deliberate early exit. This is the only student-initiated way out of a live
// lock, and it costs them the test — the teacher sees it immediately.
app.post('/api/student/forfeit', (req, res) => {
  const header = req.get('authorization') || ''
  const claim = resolveToken(header.startsWith('Bearer ') ? header.slice(7) : null)
  if (!claim || claim.kind !== 'student') return res.status(401).json({ error: 'Not joined' })
  const student = db.students.find(s => s.id === claim.id)
  const session = student && db.sessions.find(s => s.id === student.sessionId)
  if (!student || !session) return res.status(404).json({ error: 'Session not found' })

  const wasLocked = !!session.locked && !student.released
  student.released = true
  student.exitedAt = now()
  if (wasLocked) student.forfeited = true
  save()

  recordAlert(session.id, student.id, wasLocked ? 'forfeited' : 'left_session',
    String(req.body.reason || '').slice(0, 200))
  sendToStudent(student.id, { type: 'lock', locked: false, reason: 'forfeit' })
  res.json({ ok: true, forfeited: wasLocked })
})

// Emergency override. The teacher's console shows a per-session override code;
// entering it here releases exactly one student, and the teacher is told.
app.post('/api/student/override', (req, res) => {
  const header = req.get('authorization') || ''
  const claim = resolveToken(header.startsWith('Bearer ') ? header.slice(7) : null)
  if (!claim || claim.kind !== 'student') return res.status(401).json({ error: 'Not joined' })
  const student = db.students.find(s => s.id === claim.id)
  const session = student && db.sessions.find(s => s.id === student.sessionId)
  if (!student || !session) return res.status(404).json({ error: 'Session not found' })

  const code = String(req.body.code || '').trim().toUpperCase()
  if (code !== session.unlockCode) {
    recordAlert(session.id, student.id, 'override_failed', `Tried "${code.slice(0, 12)}"`)
    return res.status(403).json({ error: 'That override code is not correct' })
  }

  student.released = true
  save()
  recordAlert(session.id, student.id, 'override_used')
  sendToStudent(student.id, { type: 'lock', locked: false, reason: 'override' })
  res.json({ ok: true })
})

app.get('/health', (_req, res) => res.json({ ok: true, service: 'desmoslock', time: now() }))

/* ------------------------------------------------------- desmoslock.com */

// Installer downloads. Drop the electron-builder output into web/downloads/
// and these routes find the newest matching file.
const PLATFORM_PATTERNS = {
  mac: /\.(dmg|pkg)$/i,
  windows: /\.(exe|msi)$/i,
  linux: /\.(AppImage|deb|rpm)$/i
}

function newestInstaller (platform) {
  const pattern = PLATFORM_PATTERNS[platform]
  if (!pattern) return null
  let files
  try { files = fs.readdirSync(DOWNLOAD_DIR) } catch { return null }
  const matches = files
    .filter(f => pattern.test(f))
    .map(f => ({ f, mtime: fs.statSync(path.join(DOWNLOAD_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  return matches.length ? matches[0].f : null
}

app.get('/api/downloads', (_req, res) => {
  const out = {}
  for (const p of Object.keys(PLATFORM_PATTERNS)) out[p] = newestInstaller(p)
  res.json({ downloads: out })
})

app.get('/download/:platform', (req, res) => {
  const file = newestInstaller(req.params.platform)
  if (!file) {
    return res.status(404).type('html').send(`<!doctype html><meta charset="utf-8">
      <title>Build not published yet</title>
      <style>body{font:16px/1.6 ui-sans-serif,-apple-system,'Segoe UI',sans-serif;color:#37352f;
      max-width:34rem;margin:16vh auto;padding:0 24px}code{background:#f1f1ef;padding:2px 6px;border-radius:4px}
      a{color:#2383e2}</style>
      <h1>No ${String(req.params.platform).replace(/[^a-z]/gi, '')} build published yet</h1>
      <p>Build one with <code>npm --prefix desktop run dist</code>, then copy the installer
      into <code>web/downloads/</code>. This link picks up the newest file automatically.</p>
      <p><a href="/">← Back to desmoslock.com</a></p>`)
  }
  res.download(path.join(DOWNLOAD_DIR, file))
})

app.use(express.static(WEB_DIR, { extensions: ['html'] }))

app.get('/server-info', (_req, res) => {
  res.type('html').send(`<!doctype html><meta charset="utf-8">
  <title>DesmosLock server</title>
  <style>body{font:15px/1.6 ui-sans-serif,-apple-system,'Segoe UI',sans-serif;color:#37352f;
  max-width:36rem;margin:12vh auto;padding:0 24px}code{background:#f1f1ef;padding:2px 6px;border-radius:4px}</style>
  <h1>DesmosLock server</h1>
  <p>Running. Point the desktop app at this address:</p>
  <p>${addresses().map(a => `<code>http://${a}:${PORT}</code>`).join('<br>')}</p>`)
})

/* -------------------------------------------------------------- WebSocket */

const server = http.createServer(app)
const wss = new WebSocketServer({ server, path: '/ws' })

/** ws -> { role, subjectId, sessionId } */
const clients = new Map()
const onlineStudentIds = new Set()

function send (ws, payload) {
  if (ws.readyState === 1) ws.send(JSON.stringify(payload))
}

function broadcastToTeachers (sessionId, payload) {
  for (const [ws, meta] of clients) {
    if (meta.role === 'teacher' && meta.sessionId === sessionId) send(ws, payload)
  }
}

function broadcastToStudents (sessionId, payload) {
  for (const [ws, meta] of clients) {
    if (meta.role === 'student' && meta.sessionId === sessionId) send(ws, payload)
  }
}

function sendToStudent (studentId, payload) {
  for (const [ws, meta] of clients) {
    if (meta.role === 'student' && meta.subjectId === studentId) send(ws, payload)
  }
}

function broadcastRoster (sessionId) {
  broadcastToTeachers(sessionId, { type: 'roster', students: sessionStudents(sessionId) })
}

function broadcastLockState (session) {
  for (const [ws, meta] of clients) {
    if (meta.role !== 'student' || meta.sessionId !== session.id) continue
    const student = db.students.find(s => s.id === meta.subjectId)
    const locked = !!session.locked && !(student && student.released) && session.active
    send(ws, { type: 'lock', locked, session: { title: session.title, active: !!session.active } })
  }
  broadcastToTeachers(session.id, { type: 'session', session: publicSession(session) })
}

wss.on('connection', (ws) => {
  ws.isAlive = true
  ws.on('pong', () => { ws.isAlive = true })

  ws.on('message', (raw) => {
    let msg
    try { msg = JSON.parse(raw.toString()) } catch { return }

    if (msg.type === 'auth') {
      const claim = resolveToken(msg.token)
      if (!claim) return send(ws, { type: 'error', error: 'Bad token' })

      if (claim.kind === 'teacher') {
        const session = db.sessions.find(s => s.id === msg.sessionId)
        if (!session || session.teacherId !== claim.id) return send(ws, { type: 'error', error: 'No such session' })
        clients.set(ws, { role: 'teacher', subjectId: claim.id, sessionId: session.id })
        send(ws, {
          type: 'state',
          session: publicSession(session),
          students: sessionStudents(session.id),
          alerts: sessionAlerts(session.id)
        })
        return
      }

      const student = db.students.find(s => s.id === claim.id)
      if (!student || student.removed) return send(ws, { type: 'error', error: 'Removed from session' })
      const session = db.sessions.find(s => s.id === student.sessionId)
      if (!session || !session.active) return send(ws, { type: 'ended' })

      const wasOffline = !onlineStudentIds.has(student.id)
      clients.set(ws, { role: 'student', subjectId: student.id, sessionId: session.id })
      onlineStudentIds.add(student.id)
      student.lastSeen = now()
      save()

      send(ws, {
        type: 'lock',
        locked: !!session.locked && !student.released,
        session: { title: session.title, active: true }
      })
      if (wasOffline && now() - student.joinedAt > 3000) recordAlert(session.id, student.id, 'reconnected')
      broadcastRoster(session.id)
      return
    }

    const meta = clients.get(ws)
    if (!meta) return

    if (msg.type === 'heartbeat' && meta.role === 'student') {
      const student = db.students.find(s => s.id === meta.subjectId)
      if (student) { student.lastSeen = now(); save() }
      return
    }

    if (msg.type === 'alert' && meta.role === 'student') {
      recordAlert(meta.sessionId, meta.subjectId, String(msg.kind || 'unknown'), String(msg.detail || '').slice(0, 300))
    }
  })

  ws.on('close', () => {
    const meta = clients.get(ws)
    clients.delete(ws)
    if (!meta || meta.role !== 'student') return

    const stillOpen = [...clients.values()].some(m => m.role === 'student' && m.subjectId === meta.subjectId)
    if (stillOpen) return

    onlineStudentIds.delete(meta.subjectId)
    const session = db.sessions.find(s => s.id === meta.sessionId)
    const student = db.students.find(s => s.id === meta.subjectId)
    if (session && session.locked && session.active && student && !student.released && !student.removed) {
      recordAlert(meta.sessionId, meta.subjectId, 'disconnected', 'Connection dropped while locked')
    }
    broadcastRoster(meta.sessionId)
  })
})

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue }
    ws.isAlive = false
    ws.ping()
  }
}, 15000)

/* ------------------------------------------------------------------- boot */

function addresses () {
  const out = ['localhost']
  for (const iface of Object.values(os.networkInterfaces())) {
    for (const net of iface || []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address)
    }
  }
  return out
}

server.listen(PORT, () => {
  console.log('')
  console.log('  DesmosLock server running')
  for (const a of addresses()) console.log(`    http://${a}:${PORT}`)
  console.log('')
  console.log('  Students on other machines use the LAN address above.')
  console.log('')
})
