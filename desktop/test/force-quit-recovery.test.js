const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

const desktopRoot = path.resolve(__dirname, '..')
const backendSource = fs.readFileSync(path.join(desktopRoot, 'renderer', 'backend.js'), 'utf8')
const appSource = fs.readFileSync(path.join(desktopRoot, 'renderer', 'app.js'), 'utf8')

const anonymousSession = {
  data: {
    session: {
      access_token: 'controlled-test-token',
      user: { id: 'student-user', is_anonymous: true }
    }
  },
  error: null
}

function queryResult (result) {
  const query = {
    select () { return query },
    eq () { return query },
    order () { return query },
    limit () { return query },
    single () { throw new Error('restore test lookup must use maybeSingle()') },
    maybeSingle () { return query },
    then (resolve, reject) { return Promise.resolve(result).then(resolve, reject) }
  }
  return query
}

function createCloudBackend ({ auth = anonymousSession, students, tests }) {
  const client = {
    auth: { getSession: async () => auth },
    realtime: { setAuth: async () => {} },
    from: (table) => queryResult(table === 'students' ? students : tests),
    channel: () => ({ on () { return this }, subscribe () { return this } }),
    removeChannel: () => {},
    rpc: async () => ({ data: null, error: null })
  }
  const context = {
    CONFIG: { cloud: { url: 'https://example.invalid', publishableKey: 'public-test-key' } },
    SupabaseSDK: { createClient: () => client },
    WebSocket: function () {},
    clearInterval,
    clearTimeout,
    console,
    desk: { storeGet: async () => null, storeSet: async () => true },
    fetch: async () => { throw new Error('unexpected fetch') },
    setInterval,
    setTimeout
  }
  vm.createContext(context)
  vm.runInContext(`${backendSource}\n;globalThis.__createCloudBackend = createCloudBackend`, context, {
    filename: 'renderer/backend.js'
  })
  return context.__createCloudBackend()
}

test('cloud restore rejects every Supabase lookup error', async (t) => {
  const error = new Error('controlled unavailable')
  const row = { id: 'student-row', user_id: 'student-user', test_id: 'test-row', name: 'Student', released: false }

  const cases = [
    {
      name: 'auth',
      options: { auth: { data: { session: null }, error }, students: { data: [], error: null }, tests: { data: null, error: null } }
    },
    {
      name: 'student row',
      options: { students: { data: null, error }, tests: { data: null, error: null } }
    },
    {
      name: 'test row',
      options: { students: { data: [row], error: null }, tests: { data: null, error } }
    }
  ]

  for (const item of cases) {
    await t.test(item.name, async () => {
      const backend = createCloudBackend(item.options)
      await assert.rejects(backend.restoreStudent({ mode: 'cloud' }), /controlled unavailable/)
    })
  }
})

test('cloud restore reserves null for authoritative absent or inactive state', async () => {
  const noStudent = createCloudBackend({
    students: { data: [], error: null },
    tests: { data: null, error: null }
  })
  assert.equal(await noStudent.restoreStudent({ mode: 'cloud' }), null)

  const noTest = createCloudBackend({
    students: { data: [{ id: 'student-row', test_id: 'test-row', name: 'Student', released: false }], error: null },
    tests: { data: null, error: null }
  })
  assert.equal(await noTest.restoreStudent({ mode: 'cloud' }), null)

  const inactive = createCloudBackend({
    students: { data: [{ id: 'student-row', test_id: 'test-row', name: 'Student', released: false }], error: null },
    tests: { data: { id: 'test-row', active: false }, error: null }
  })
  assert.equal(await inactive.restoreStudent({ mode: 'cloud' }), null)
})

function elementStub (tagName = 'DIV') {
  const element = {
    tagName,
    classList: { add () {}, remove () {}, toggle () {} },
    addEventListener () {},
    removeEventListener () {},
    appendChild () {},
    focus () {},
    querySelector: () => elementStub(),
    select () {},
    style: {},
    value: ''
  }
  return element
}

async function runBoot ({ saved, restoreStudent }) {
  const events = []
  const store = new Map([
    ['backend', { mode: 'cloud', serverUrl: 'http://127.0.0.1:4000' }],
    ['student', { ...saved }]
  ])
  const elements = new Map()
  const getElement = (selector) => {
    if (!elements.has(selector)) elements.set(selector, elementStub())
    return elements.get(selector)
  }
  const backend = {
    heartbeat: async () => {},
    heartbeatInterval: 15000,
    reportAlert: async () => false,
    restoreStudent,
    resumeStudent: () => events.push('resume'),
    setStudentName: () => {},
    subscribeStudent: () => () => {}
  }
  const document = {
    body: elementStub('BODY'),
    createElement: (tag) => elementStub(String(tag).toUpperCase()),
    head: {
      appendChild () {
        events.push('remote-desmos-load')
        // Deliberately never resolve the script. Recovery must already be locked.
      }
    },
    querySelector: getElement,
    querySelectorAll: () => []
  }
  const desk = {
    allowServer: async () => true,
    engageLock: async () => { events.push('engage-lock') },
    onLockEvent: () => () => {},
    platform: 'darwin',
    releaseLock: async () => { events.push('release-lock') },
    scanApps: async () => [],
    storeGet: async (key) => store.get(key) ?? null,
    storeSet: async (key, value) => {
      events.push(`store:${key}:${value === null ? 'null' : 'value'}`)
      if (value === null || value === undefined) store.delete(key)
      else store.set(key, value)
      return true
    }
  }
  const context = {
    CONFIG: {
      cloud: { url: 'https://example.invalid' },
      defaultMode: 'cloud',
      defaultServer: 'http://127.0.0.1:4000'
    },
    clearInterval: () => {},
    clearTimeout: () => {},
    console,
    createBackend: () => backend,
    desk,
    document,
    setInterval: () => 0,
    setTimeout: () => 0,
    window: { addEventListener () {}, Desmos: null }
  }
  vm.createContext(context)
  vm.runInContext(appSource, context, { filename: 'renderer/app.js' })
  for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve))
  return { events, store }
}

test('persisted locked recovery engages before a stalled remote Desmos load', async () => {
  const result = await runBoot({
    saved: { id: 'student-row', name: 'Student', testId: 'test-row', title: 'Exam', mode: 'cloud', wasLocked: true },
    restoreStudent: async () => { throw new Error('controlled unavailable') }
  })

  const engaged = result.events.indexOf('engage-lock')
  const remoteLoad = result.events.indexOf('remote-desmos-load')
  assert.notEqual(engaged, -1)
  assert.notEqual(remoteLoad, -1)
  assert.ok(engaged < remoteLoad, result.events.join(' -> '))
  assert.equal(result.store.get('student').wasLocked, true)
  assert.equal(result.events.includes('store:student:null'), false)
  assert.equal(result.events.includes('resume'), true)
})

test('persisted lock engages before a never-resolving backend restore', async () => {
  const result = await runBoot({
    saved: { id: 'student-row', name: 'Student', testId: 'test-row', title: 'Exam', mode: 'cloud', wasLocked: true },
    restoreStudent: async () => await new Promise(() => {})
  })

  assert.notEqual(result.events.indexOf('engage-lock'), -1)
  assert.equal(result.events.includes('remote-desmos-load'), false)
  assert.equal(result.events.includes('store:student:null'), false)
  assert.equal(result.store.get('student').wasLocked, true)
})

test('authoritative unlocked restore clears stale wasLocked before remote load', async () => {
  const result = await runBoot({
    saved: { id: 'student-row', name: 'Student', testId: 'test-row', title: 'Exam', mode: 'cloud', wasLocked: true },
    restoreStudent: async () => ({
      student: { id: 'student-row', name: 'Student' },
      test: { id: 'test-row', title: 'Exam', locked: false, active: true }
    })
  })

  assert.equal(result.store.get('student').wasLocked, false)
  const engaged = result.events.indexOf('engage-lock')
  const released = result.events.indexOf('release-lock')
  const remoteLoad = result.events.indexOf('remote-desmos-load')
  assert.ok(engaged < released && released < remoteLoad, result.events.join(' -> '))
})

test('authoritative null releases recovery lock and deletes stale student', async () => {
  const result = await runBoot({
    saved: { id: 'student-row', name: 'Student', testId: 'test-row', title: 'Exam', mode: 'cloud', wasLocked: true },
    restoreStudent: async () => null
  })

  const engaged = result.events.indexOf('engage-lock')
  const released = result.events.indexOf('release-lock')
  const deleted = result.events.indexOf('store:student:null')
  assert.ok(engaged < released && released < deleted, result.events.join(' -> '))
  assert.equal(result.store.has('student'), false)
  assert.equal(result.events.includes('remote-desmos-load'), false)
})
