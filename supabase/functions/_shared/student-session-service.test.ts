// deno-lint-ignore-file require-await

import { handleRequest as challengeHandler } from '../student-session-challenge/index.ts'
import { handleRequest as joinHandler } from '../student-session-join/index.ts'
import { handleRequest as readHandler } from '../student-session-read/index.ts'
import { handleRequest as reconnectHandler } from '../student-session-reconnect/index.ts'
import { handleRequest as forfeitHandler } from '../student-session-forfeit/index.ts'
import {
  createStudentSessionDependencies,
  STUDENT_SESSION_MAX_BODY_BYTES,
  STUDENT_SESSION_REQUEST_TIMEOUT_MS,
  type StudentSessionDependencies,
} from './student-session-service.ts'
import {
  type EdgeStudentForfeitRequest,
  type EdgeStudentJoinRequest,
  edgeStudentKeyThumbprint,
  edgeStudentLogicalOperationDigest,
  edgeStudentMaterialDigest,
  type EdgeStudentReadRequest,
  type EdgeStudentReconnectRequest,
  type EdgeStudentSessionScope,
  encodeEdgeStudentProofBytes,
  encodeEdgeStudentProofEnvelope,
} from './student-session-proof.ts'

const apiOrigin = 'https://abcdefghijklmnopqrst.supabase.co'
const internalOrigin = 'http://127.0.0.1:54321'
const serviceKey = 'synthetic-server-only-service-role-key'
const uuid = (index: number) => `10000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`
const scope: EdgeStudentSessionScope = {
  schoolId: uuid(1),
  testId: uuid(2),
  studentSessionId: uuid(3),
  deviceSessionId: uuid(4),
  epoch: 1,
}
const requestId = uuid(5)
const challengeId = uuid(6)
const code = '0123456789AB'
const token = 'A'.repeat(43)
const refresh = 'B'.repeat(42) + 'A'
const capabilityDigest = 'a'.repeat(64)
const reconnectDigest = 'b'.repeat(64)
const denied = { status: 'denied', code: 'STUDENT_SESSION_DENIED' }
const unavailable = { status: 'unavailable', code: 'STUDENT_SESSION_UNAVAILABLE' }
const configuration = {
  DESMOSLOCK_PUBLIC_BACKEND_ENVIRONMENT: 'staging',
  DESMOSLOCK_PUBLIC_BACKEND_URL: apiOrigin,
  DESMOSLOCK_EXPECTED_SUPABASE_ORIGIN: internalOrigin,
  SUPABASE_SERVICE_ROLE_KEY: serviceKey,
  SUPABASE_URL: internalOrigin,
}
type Handler = (request: Request, dependencies?: StudentSessionDependencies) => Promise<Response>
const handlers: Record<string, Handler> = {
  challenge: challengeHandler,
  join: joinHandler,
  read: readHandler,
  reconnect: reconnectHandler,
  forfeit: forfeitHandler,
}

function assert(condition: unknown, message = 'Assertion failed'): asserts condition {
  if (!condition) throw new Error(message)
}
function equal(actual: unknown, expected: unknown): void {
  assert(JSON.stringify(actual) === JSON.stringify(expected), 'Unexpected synthetic test value')
}
async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = performance.now() + 4_000
  while (!condition()) {
    assert(performance.now() < deadline, 'Expected bounded test event')
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}
function post(route: string, body: unknown, init: RequestInit = {}): Request {
  return new Request(`${apiOrigin}/functions/v1/student-session-${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...init,
  })
}
async function checkResponse(response: Response, status: number, body: unknown): Promise<void> {
  equal(response.status, status)
  equal(await response.json(), body)
  equal(response.headers.get('cache-control'), 'no-store')
  equal(response.headers.get('content-type'), 'application/json; charset=utf-8')
  equal(response.headers.get('access-control-allow-origin'), null)
}
interface SigningIdentity {
  readonly privateKey: CryptoKey
  readonly publicKey: string
  readonly thumbprint: string
}
async function identity(): Promise<SigningIdentity> {
  const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
  assert('privateKey' in pair && 'publicKey' in pair)
  const publicKey = encodeEdgeStudentProofBytes(
    new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)),
  )
  assert(publicKey !== null)
  const thumbprint = await edgeStudentKeyThumbprint(publicKey)
  assert(thumbprint !== null)
  return { privateKey: pair.privateKey, publicKey, thumbprint }
}
async function sign(key: SigningIdentity, envelope: unknown): Promise<string> {
  const bytes = encodeEdgeStudentProofEnvelope(envelope)
  assert(bytes !== null)
  const signature = encodeEdgeStudentProofBytes(
    new Uint8Array(await crypto.subtle.sign('Ed25519', key.privateKey, new Uint8Array(bytes))),
  )
  assert(signature !== null)
  return signature
}
async function signedJoin(
  key: SigningIdentity,
  admissionMode: 'initial' | 'readmission' = 'initial',
): Promise<EdgeStudentJoinRequest> {
  const joinMaterialDigest = await edgeStudentMaterialDigest('joinMaterial', code)
  const logicalOperationDigest = await edgeStudentLogicalOperationDigest({
    kind: 'join',
    admissionMode,
    requestId,
    deviceSessionId: scope.deviceSessionId,
    joinMaterialDigest,
    capabilityDigest,
    reconnectDigest,
  })
  assert(logicalOperationDigest !== null)
  const signature = await sign(key, {
    kind: 'bootstrap',
    apiOrigin,
    requestId,
    deviceSessionId: scope.deviceSessionId,
    keyThumbprint: key.thumbprint,
    logicalOperationDigest,
    challengeId,
    expiresAtMs: 15_000,
  })
  return {
    admissionMode,
    requestId,
    deviceSessionId: scope.deviceSessionId,
    joinCode: code,
    capabilityDigest,
    reconnectDigest,
    deviceProof: { challengeId, expiresAtMs: 15_000, publicKey: key.publicKey, signature },
  }
}
async function signedMaintenance(
  key: SigningIdentity,
  operation: 'read' | 'reconnect' | 'forfeit',
  counter = 1,
): Promise<EdgeStudentReadRequest | EdgeStudentReconnectRequest | EdgeStudentForfeitRequest> {
  const credentialDigest = await edgeStudentMaterialDigest(
    operation === 'reconnect' ? 'reconnectGrant' : 'capability',
    operation === 'reconnect' ? refresh : token,
  )
  const logical = operation === 'read'
    ? { kind: operation, requestId, scope, capabilityDigest: credentialDigest }
    : operation === 'forfeit'
    ? {
      kind: operation,
      requestId,
      scope,
      expectedSessionRevision: 1,
      capabilityDigest: credentialDigest,
    }
    : {
      kind: operation,
      requestId,
      scope,
      expectedSessionRevision: 1,
      reconnectDigest: credentialDigest,
      nextCapabilityDigest: capabilityDigest,
      nextReconnectDigest: reconnectDigest,
    }
  const logicalOperationDigest = await edgeStudentLogicalOperationDigest(logical)
  assert(logicalOperationDigest !== null)
  const signature = await sign(key, {
    kind: 'maintenance',
    apiOrigin,
    operation,
    requestId,
    scope,
    keyThumbprint: key.thumbprint,
    logicalOperationDigest,
    counter,
  })
  const base = { requestId, scope, deviceProof: { counter, signature } }
  return operation === 'read'
    ? { ...base, capabilityToken: token }
    : operation === 'forfeit'
    ? { ...base, capabilityToken: token, expectedSessionRevision: 1 }
    : {
      ...base,
      reconnectGrant: refresh,
      expectedSessionRevision: 1,
      nextCapabilityDigest: capabilityDigest,
      nextReconnectDigest: reconnectDigest,
    }
}

interface RpcCall {
  readonly name: string
  readonly input: Record<string, unknown>
  readonly init: RequestInit
  readonly url: URL
}
type Override = (call: RpcCall, normal: Record<string, unknown>[]) => Response | Promise<Response>
function fixture(
  publicKey: string,
  override?: Override,
): { dependencies: StudentSessionDependencies; calls: RpcCall[] } {
  const calls: RpcCall[] = []
  const dependencies = createStudentSessionDependencies(configuration, async (url, init) => {
    assert(init !== undefined && typeof init.body === 'string')
    const target = new URL(String(url))
    const input = JSON.parse(init.body) as Record<string, unknown>
    const call = { name: target.pathname.split('/').at(-1) ?? '', input, init, url: target }
    calls.push(call)
    const shared = {
      school_id: scope.schoolId,
      test_id: scope.testId,
      student_session_id: scope.studentSessionId,
      device_session_id: scope.deviceSessionId,
      epoch: 1,
    }
    let row: Record<string, unknown>
    if (call.name === 'charge_student_join_attempt') row = { code: 'ok' }
    else if (call.name === 'create_student_bootstrap_challenge') {
      row = { code: 'ok', challenge_id: challengeId, expires_at_ms: 15_000 }
    } else if (call.name === 'read_student_maintenance_key') {
      row = { code: 'ok', public_key: publicKey }
    } else if (
      call.name === 'commit_student_session_join' ||
      call.name === 'commit_student_session_reconnect'
    ) {
      row = {
        code: 'ok',
        request_id: input.request_id,
        logical_operation_digest: input.logical_operation_digest,
        ...shared,
        session_revision: call.name.endsWith('join') ? 1 : 2,
        synthetic_display_name: 'Student A1',
        server_now_ms: 1_000,
        capability_issued_at_ms: 1_000,
        capability_expires_at_ms: 301_000,
        reconnect_expires_at_ms: 901_000,
        accepted_proof_counter: call.name.endsWith('join') ? null : input.proof_counter,
      }
    } else if (call.name === 'commit_student_session_read') {
      row = {
        code: 'ok',
        request_id: input.request_id,
        accepted_proof_counter: input.proof_counter,
        ...shared,
        session_revision: 1,
        synthetic_display_name: 'Student A1',
        server_now_ms: 1_000,
        capability_expires_at_ms: 301_000,
      }
    } else if (call.name === 'commit_student_session_forfeit') {
      row = {
        code: 'ok',
        request_id: input.request_id,
        accepted_proof_counter: input.proof_counter,
      }
    } else throw new Error('Unexpected fixed RPC')
    return override === undefined ? Response.json([row]) : await override(call, [row])
  })
  return { dependencies, calls }
}

Deno.test('five actual entrypoints verify real Ed25519 and expose exact own-session results', async () => {
  const key = await identity()
  const join = await signedJoin(key)
  const material = await edgeStudentMaterialDigest('joinMaterial', code)
  const digest = await edgeStudentLogicalOperationDigest({
    kind: 'join',
    admissionMode: 'initial',
    requestId,
    deviceSessionId: scope.deviceSessionId,
    joinMaterialDigest: material,
    capabilityDigest,
    reconnectDigest,
  })
  const challengeFixture = fixture(key.publicKey)
  await checkResponse(
    await challengeHandler(
      post('challenge', {
        requestId,
        deviceSessionId: scope.deviceSessionId,
        publicKey: key.publicKey,
        logicalOperationDigest: digest,
      }),
      challengeFixture.dependencies,
    ),
    200,
    { challengeId, expiresAtMs: 15_000 },
  )
  equal(challengeFixture.calls.map((call) => call.name), ['create_student_bootstrap_challenge'])
  equal(challengeFixture.calls[0].input.key_thumbprint, key.thumbprint)

  for (const route of ['join', 'read', 'reconnect', 'forfeit'] as const) {
    const body = route === 'join' ? join : await signedMaintenance(key, route)
    const harness = fixture(key.publicKey)
    const response = await handlers[route](post(route, body), harness.dependencies)
    equal(response.status, 200)
    const result = await response.json()
    equal(result.requestId, requestId)
    if (route === 'join' || route === 'reconnect') {
      equal(
        Object.keys(result).sort(),
        [
          'status',
          'code',
          'requestId',
          'logicalOperationDigest',
          'scope',
          'sessionRevision',
          'syntheticDisplayName',
          'serverNowMs',
          'capabilityIssuedAtMs',
          'capabilityExpiresAtMs',
          'reconnectExpiresAtMs',
          'allowedIntents',
          ...(route === 'reconnect' ? ['acceptedProofCounter'] : []),
        ].sort(),
      )
      equal(result.allowedIntents, ['state.read', 'session.forfeit'])
      equal(result.scope, scope)
    } else if (route === 'read') {
      equal(
        Object.keys(result).sort(),
        [
          'status',
          'code',
          'requestId',
          'acceptedProofCounter',
          'scope',
          'sessionRevision',
          'syntheticDisplayName',
          'testLifecycle',
          'state',
          'serverNowMs',
          'capabilityExpiresAtMs',
        ].sort(),
      )
      equal(result.testLifecycle, 'open')
      equal(result.state, 'active')
    } else {equal(result, {
        status: 'accepted',
        code: 'STUDENT_SESSION_FORFEITED',
        requestId,
        acceptedProofCounter: 1,
      })}
    equal(
      harness.calls.map((call) => call.name),
      route === 'join'
        ? ['charge_student_join_attempt', 'commit_student_session_join']
        : ['read_student_maintenance_key', `commit_student_session_${route}`],
    )
    const commit = harness.calls.at(-1)
    assert(commit !== undefined)
    equal(commit.input.verified_public_key, key.publicKey)
    if (route === 'join') equal(commit.input.challenge_expires_at, 15_000)
    for (const call of harness.calls) {
      equal(call.url.origin, internalOrigin)
      equal(call.url.search, '')
      equal(call.init.method, 'POST')
      equal(call.init.redirect, 'error')
      equal(call.init.credentials, 'omit')
      equal(new Headers(call.init.headers).get('content-profile'), 'desmoslock_v2')
      assert(call.init.signal instanceof AbortSignal)
      const serialized = JSON.stringify(call.input)
      assert(
        !serialized.includes(code) && !serialized.includes(token) && !serialized.includes(refresh),
      )
    }
  }
})

Deno.test('copied credentials and every bound maintenance mutation cannot reach commit', async () => {
  const key = await identity()
  const attacker = await identity()
  for (const route of ['read', 'reconnect', 'forfeit'] as const) {
    const signed = await signedMaintenance(key, route)
    const copiedCredential = await signedMaintenance(attacker, route)
    const variants = [
      copiedCredential,
      { ...signed, requestId: uuid(9) },
      { ...signed, scope: { ...scope, epoch: 2 } },
      { ...signed, scope: { ...scope, testId: uuid(9) } },
      { ...signed, deviceProof: { ...signed.deviceProof, counter: 2 } },
      { ...signed, deviceProof: { ...signed.deviceProof, signature: 'A'.repeat(86) } },
      { ...signed, deviceProof: { ...signed.deviceProof, publicKey: attacker.publicKey } },
    ]
    for (const body of variants) {
      const harness = fixture(key.publicKey)
      await checkResponse(
        await handlers[route](post(route, body), harness.dependencies),
        403,
        denied,
      )
      assert(!harness.calls.some((call) => call.name.startsWith('commit_')))
      assert(!harness.calls.some((call) => call.name === 'charge_student_join_attempt'))
    }
    const wrongOrigin = fixture(key.publicKey)
    await checkResponse(
      await handlers[route](post(route, signed), {
        ...wrongOrigin.dependencies,
        apiOrigin: 'https://another-project.supabase.co',
      }),
      403,
      denied,
    )
    assert(!wrongOrigin.calls.some((call) => call.name.startsWith('commit_')))
  }
})

Deno.test('join debit precedes signature verification and altered mode/candidates never commit', async () => {
  const key = await identity()
  const original = await signedJoin(key)
  for (
    const body of [
      { ...original, admissionMode: 'readmission' },
      { ...original, capabilityDigest: reconnectDigest },
      { ...original, reconnectDigest: capabilityDigest },
      { ...original, deviceSessionId: uuid(9) },
      { ...original, joinCode: 'ABCDEFGHJKMN' },
      { ...original, deviceProof: { ...original.deviceProof, signature: 'A'.repeat(86) } },
    ]
  ) {
    const harness = fixture(key.publicKey)
    await checkResponse(await joinHandler(post('join', body), harness.dependencies), 403, denied)
    equal(harness.calls.map((call) => call.name), ['charge_student_join_attempt'])
    equal(harness.calls[0].input, { key_thumbprint: key.thumbprint })
  }
  const throttled = fixture(
    key.publicKey,
    (call, rows) =>
      Response.json(
        call.name === 'charge_student_join_attempt' ? [{ code: 'student_session_denied' }] : rows,
      ),
  )
  await checkResponse(
    await joinHandler(post('join', original), throttled.dependencies),
    403,
    denied,
  )
  equal(throttled.calls.map((call) => call.name), ['charge_student_join_attempt'])
})

Deno.test('explicit targeted admission preserves server identity and prepared epoch without a mode fallback', async () => {
  const key = await identity()
  const body = await signedJoin(key, 'readmission')
  const harness = fixture(
    key.publicKey,
    (call, rows) =>
      Response.json(
        call.name === 'commit_student_session_join'
          ? [{ ...rows[0], epoch: 2, session_revision: 3 }]
          : rows,
      ),
  )
  const response = await joinHandler(post('join', body), harness.dependencies)
  equal(response.status, 200)
  const result = await response.json()
  equal(result.scope, { ...scope, epoch: 2 })
  equal(result.sessionRevision, 3)
  equal(harness.calls.at(-1)?.input.admission_mode, 'readmission')
  const mismatchedMaterial = fixture(
    key.publicKey,
    (call, rows) =>
      Response.json(
        call.name === 'commit_student_session_join'
          ? [
            Object.fromEntries(
              Object.keys(rows[0]).map((
                key,
              ) => [key, key === 'code' ? 'student_session_denied' : null]),
            ),
          ]
          : rows,
      ),
  )
  await checkResponse(
    await joinHandler(post('join', body), mismatchedMaterial.dependencies),
    403,
    denied,
  )
  equal(mismatchedMaterial.calls.map((call) => call.name), [
    'charge_student_join_attempt',
    'commit_student_session_join',
  ])
  equal(mismatchedMaterial.calls.at(-1)?.input.admission_mode, 'readmission')
})

Deno.test('malformed bootstrap requests debit only their actual-key or shared malformed bucket before any target lookup', async () => {
  const key = await identity()
  const original = await signedJoin(key)
  let malformedAttempts = 0
  const harness = fixture(key.publicKey, (call, rows) => {
    if (
      call.name === 'charge_student_join_attempt' && call.input.key_thumbprint === 'A'.repeat(43)
    ) {
      malformedAttempts += 1
      if (malformedAttempts > 12) return Response.json([{ code: 'student_session_denied' }])
    }
    return Response.json(rows)
  })
  for (
    const [route, body] of [['join', { ...original, admissionMode: 'unknown' }], ['challenge', {
      publicKey: key.publicKey,
    }]] as const
  ) {
    await checkResponse(await handlers[route](post(route, body), harness.dependencies), 403, denied)
    equal(harness.calls.at(-1)?.input, { key_thumbprint: key.thumbprint })
  }
  for (let index = 0; index < 14; index += 1) {
    await checkResponse(await joinHandler(post('join', {}), harness.dependencies), 403, denied)
    equal(harness.calls.at(-1)?.input, { key_thumbprint: 'A'.repeat(43) })
  }
  await checkResponse(
    await challengeHandler(post('challenge', null, { body: '{' }), harness.dependencies),
    403,
    denied,
  )
  equal(harness.calls.at(-1)?.input, { key_thumbprint: 'A'.repeat(43) })
  equal(malformedAttempts, 15)
  assert(harness.calls.every((call) => call.name === 'charge_student_join_attempt'))
})

Deno.test('original issuance expiry may have expired access but protected reads cannot', async () => {
  const key = await identity()
  for (const route of ['join', 'reconnect'] as const) {
    const body = route === 'join' ? await signedJoin(key) : await signedMaintenance(key, route)
    const recovered = fixture(
      key.publicKey,
      (call, rows) =>
        Response.json(
          call.name.startsWith('commit_') ? [{ ...rows[0], server_now_ms: 400_000 }] : rows,
        ),
    )
    const response = await handlers[route](post(route, body), recovered.dependencies)
    equal(response.status, 200)
    const result = await response.json()
    equal(result.capabilityIssuedAtMs, 1_000)
    equal(result.capabilityExpiresAtMs, 301_000)
    equal(result.reconnectExpiresAtMs, 901_000)
    for (
      const mutation of [
        { server_now_ms: 901_000 },
        { capability_expires_at_ms: 301_001 },
        { reconnect_expires_at_ms: 901_001 },
        { request_id: uuid(9) },
        { logical_operation_digest: 'c'.repeat(64) },
        { device_session_id: uuid(9) },
      ]
    ) {
      const incompatible = fixture(
        key.publicKey,
        (call, rows) =>
          Response.json(call.name.startsWith('commit_') ? [{ ...rows[0], ...mutation }] : rows),
      )
      await checkResponse(
        await handlers[route](post(route, body), incompatible.dependencies),
        503,
        unavailable,
      )
    }
  }
  const read = await signedMaintenance(key, 'read')
  const expired = fixture(
    key.publicKey,
    (call, rows) =>
      Response.json(
        call.name === 'commit_student_session_read'
          ? [{ ...rows[0], server_now_ms: 301_000 }]
          : rows,
      ),
  )
  await checkResponse(await readHandler(post('read', read), expired.dependencies), 503, unavailable)
})

Deno.test('malformed, leaked, mixed and foreign SQL results never become a public roster or success', async () => {
  const key = await identity()
  const read = await signedMaintenance(key, 'read')
  for (
    const mutation of [
      { school_id: uuid(9) },
      { accepted_proof_counter: 2 },
      { session_revision: Number.MAX_SAFE_INTEGER + 1 },
      { synthetic_display_name: 'Real student name' },
      { roster: ['private'] },
      { public_key: key.publicKey },
      { capability_token: token },
    ]
  ) {
    const harness = fixture(
      key.publicKey,
      (call, rows) =>
        Response.json(
          call.name === 'commit_student_session_read' ? [{ ...rows[0], ...mutation }] : rows,
        ),
    )
    await checkResponse(
      await readHandler(post('read', read), harness.dependencies),
      503,
      unavailable,
    )
  }
  for (
    const rows of [[], [{ code: 'unknown', public_key: null }], [{
      code: 'student_session_denied',
      public_key: key.publicKey,
    }], [{ code: 'student_session_denied', public_key: null }, {
      code: 'ok',
      public_key: key.publicKey,
    }], [{ code: 'ok', public_key: 'invalid' }]]
  ) {
    const harness = fixture(key.publicKey, () => Response.json(rows))
    await checkResponse(
      await readHandler(post('read', read), harness.dependencies),
      503,
      unavailable,
    )
    equal(harness.calls.length, 1)
  }
  const validDenial = fixture(
    key.publicKey,
    () => Response.json([{ code: 'student_session_denied', public_key: null }]),
  )
  await checkResponse(await readHandler(post('read', read), validDenial.dependencies), 403, denied)
  equal(validDenial.calls.length, 1)
})

Deno.test('method, URL, byte/content-type and response bounds fail closed without reflecting input', async () => {
  equal(STUDENT_SESSION_MAX_BODY_BYTES, 8_192)
  equal(STUDENT_SESSION_REQUEST_TIMEOUT_MS, 5_000)
  const key = await identity()
  const read = await signedMaintenance(key, 'read')
  const harness = fixture(key.publicKey)
  await checkResponse(
    await readHandler(
      new Request(`${apiOrigin}/functions/v1/student-session-read`, { method: 'GET' }),
      harness.dependencies,
    ),
    405,
    denied,
  )
  await checkResponse(
    await readHandler(
      new Request(`${apiOrigin}/functions/v1/student-session-read?capability=${token}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(read),
      }),
      harness.dependencies,
    ),
    403,
    denied,
  )
  const invalidRequestHeaders: HeadersInit[] = [{ 'content-type': 'text/plain' }, {
    'content-type': 'application/json',
    'content-encoding': 'gzip',
  }, { 'content-type': 'application/json', 'content-length': '01' }]
  for (const headers of invalidRequestHeaders) {
    await checkResponse(
      await readHandler(post('read', read, { headers }), harness.dependencies),
      403,
      denied,
    )
  }
  await checkResponse(
    await readHandler(
      post('read', read, {
        headers: { 'content-type': 'application/json', 'content-length': '8193' },
      }),
      harness.dependencies,
    ),
    413,
    denied,
  )
  await checkResponse(
    await readHandler(post('read', null, { body: `"${'x'.repeat(8192)}"` }), harness.dependencies),
    413,
    denied,
  )
  await checkResponse(
    await readHandler(post('read', null, { body: '{' }), harness.dependencies),
    403,
    denied,
  )
  equal(harness.calls.length, 0)
  for (
    const response of [
      Response.redirect('https://foreign.invalid', 307),
      new Response('private diagnostic', { status: 500 }),
      new Response('[]', { status: 200, headers: { 'content-type': 'text/html' } }),
      new Response(`"${'x'.repeat(8192)}"`, { headers: { 'content-type': 'application/json' } }),
    ]
  ) {
    const invalid = fixture(key.publicKey, () => response)
    await checkResponse(
      await readHandler(post('read', read), invalid.dependencies),
      503,
      unavailable,
    )
    equal(invalid.calls.length, 1)
  }
})

Deno.test('one total deadline aborts body/backend streams and prevents a late key from authorizing commit', async () => {
  const key = await identity()
  const read = await signedMaintenance(key, 'read')
  const controller = new AbortController()
  let canceled = false
  const body = new ReadableStream<Uint8Array>({
    pull() {},
    cancel() {
      canceled = true
    },
  })
  const harness = fixture(key.publicKey)
  const request = post('read', null, { body, signal: controller.signal })
  const pending = readHandler(request, harness.dependencies)
  controller.abort()
  await checkResponse(await pending, 503, unavailable)
  equal(harness.calls.length, 0)
  // Cancellation before reader acquisition is also a valid zero-egress outcome.
  assert(canceled || request.signal.aborted)

  let resolveKey: ((response: Response) => void) | undefined
  const late = fixture(key.publicKey, () =>
    new Promise<Response>((resolve) => {
      resolveKey = resolve
    }))
  const abort = new AbortController()
  const waiting = readHandler(post('read', read, { signal: abort.signal }), late.dependencies)
  await waitFor(() => resolveKey !== undefined)
  abort.abort()
  await checkResponse(await waiting, 503, unavailable)
  assert(resolveKey !== undefined)
  resolveKey(Response.json([{ code: 'ok', public_key: key.publicKey }]))
  await new Promise((resolve) => setTimeout(resolve, 0))
  equal(late.calls.map((call) => call.name), ['read_student_maintenance_key'])
  assert(late.calls[0].init.signal?.aborted)

  let cancelBackend = false
  const streaming = fixture(
    key.publicKey,
    () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull() {},
          cancel() {
            cancelBackend = true
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
  )
  const backendAbort = new AbortController()
  const streamResult = readHandler(
    post('read', read, { signal: backendAbort.signal }),
    streaming.dependencies,
  )
  await waitFor(() => streaming.calls.length !== 0)
  await new Promise((resolve) => setTimeout(resolve, 0))
  backendAbort.abort()
  await checkResponse(await streamResult, 503, unavailable)
  assert(cancelBackend)
  equal(streaming.calls.length, 1)
})

Deno.test('early response metadata rejection cancels the stream and terminates its request signal', async () => {
  const key = await identity()
  const read = await signedMaintenance(key, 'read')
  const invalidResponseHeaders: HeadersInit[] = [{ 'content-type': 'text/html' }, {
    'content-type': 'application/json',
    'content-length': '8193',
  }, { 'content-type': 'application/json', 'content-length': '01' }]
  for (const headers of invalidResponseHeaders) {
    let canceled = false
    const harness = fixture(
      key.publicKey,
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull() {},
            cancel() {
              canceled = true
            },
          }),
          { headers },
        ),
    )
    await checkResponse(
      await readHandler(post('read', read), harness.dependencies),
      503,
      unavailable,
    )
    assert(canceled)
    equal(harness.calls.length, 1)
    assert(harness.calls[0].init.signal?.aborted)
  }
})

Deno.test('the production five-second timer bounds a stalled body without relying on a caller abort', async () => {
  const key = await identity()
  const harness = fixture(key.publicKey)
  let canceled = false
  const started = performance.now()
  const response = await readHandler(
    post('read', null, {
      body: new ReadableStream<Uint8Array>({
        pull() {},
        cancel() {
          canceled = true
        },
      }),
    }),
    harness.dependencies,
  )
  const elapsed = performance.now() - started
  await checkResponse(response, 503, unavailable)
  assert(elapsed >= 4_900 && elapsed < 7_000, 'Five-second deadline did not bound the request')
  assert(canceled)
  equal(harness.calls.length, 0)
})

Deno.test('configuration and typed DTOs are exact snapshots with one pinned service destination', async () => {
  const key = await identity()
  let fetches = 0
  const fakeFetch = async () => {
    fetches += 1
    return Response.json([])
  }
  for (
    const fields of [
      { DESMOSLOCK_PUBLIC_BACKEND_URL: `${apiOrigin}/` },
      { DESMOSLOCK_PUBLIC_BACKEND_URL: 'https://127.0.0.1' },
      {
        DESMOSLOCK_PUBLIC_BACKEND_URL: 'http://localhost:54321',
        DESMOSLOCK_PUBLIC_BACKEND_ENVIRONMENT: 'local',
      },
      { DESMOSLOCK_PUBLIC_BACKEND_URL: 'http://127.0.0.1:54321' },
      { DESMOSLOCK_EXPECTED_SUPABASE_ORIGIN: 'http://127.0.0.1:54322' },
      { extra: true },
    ]
  ) {
    let rejected = false
    try {
      createStudentSessionDependencies({ ...configuration, ...fields }, fakeFetch)
    } catch {
      rejected = true
    }
    assert(rejected)
  }
  const local = createStudentSessionDependencies({
    ...configuration,
    DESMOSLOCK_PUBLIC_BACKEND_ENVIRONMENT: 'local',
    DESMOSLOCK_PUBLIC_BACKEND_URL: internalOrigin,
  }, fakeFetch)
  equal(local.apiOrigin, internalOrigin)
  let getterCalls = 0
  let rejected = false
  try {
    createStudentSessionDependencies(
      Object.defineProperty({ ...configuration }, 'SUPABASE_SERVICE_ROLE_KEY', {
        get() {
          getterCalls += 1
          return serviceKey
        },
        enumerable: true,
      }),
      fakeFetch,
    )
  } catch {
    rejected = true
  }
  assert(rejected)
  equal(getterCalls, 0)
  const input = {
    request_id: requestId,
    device_session_id: scope.deviceSessionId,
    public_key: key.publicKey,
    key_thumbprint: key.thumbprint,
    logical_operation_digest: capabilityDigest,
  }
  for (
    const invalid of [
      { ...input, verified: true },
      Object.defineProperty({ ...input }, 'public_key', {
        get() {
          getterCalls += 1
          return key.publicKey
        },
        enumerable: true,
      }),
    ]
  ) {
    let failed = false
    try {
      await local.createBootstrapChallenge(invalid, new AbortController().signal)
    } catch {
      failed = true
    }
    assert(failed)
  }
  equal(fetches, 0)
  equal(getterCalls, 0)
})
