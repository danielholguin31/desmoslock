import {
  decodeEdgeStudentSecretBytes,
  type EdgeStudentForfeitRequest,
  type EdgeStudentJoinRequest,
  edgeStudentKeyThumbprint,
  edgeStudentLogicalOperationDigest,
  edgeStudentMaterialDigest,
  type EdgeStudentReadRequest,
  type EdgeStudentReconnectRequest,
  type EdgeStudentSessionScope,
  encodeEdgeStudentLogicalOperation,
  encodeEdgeStudentMaterialDigestInput,
  encodeEdgeStudentProofBytes,
  encodeEdgeStudentProofEnvelope,
  parseEdgeExactArray,
  parseEdgeExactRecord,
  parseEdgeStudentApiOrigin,
  parseEdgeStudentChallengeRequest,
  parseEdgeStudentCounter,
  parseEdgeStudentDigest,
  parseEdgeStudentForfeitRequest,
  parseEdgeStudentJoinCode,
  parseEdgeStudentJoinRequest,
  parseEdgeStudentPublicKey,
  parseEdgeStudentReadRequest,
  parseEdgeStudentReconnectRequest,
  parseEdgeStudentScope,
  parseEdgeStudentSecret,
  parseEdgeStudentSignature,
  parseEdgeStudentUuid,
  verifyEdgeStudentBootstrapProof,
  verifyEdgeStudentMaintenanceProof,
} from './student-session-proof.ts'

function assertEquals(actual: unknown, expected: unknown): void {
  if (Object.is(actual, expected)) return
  if (
    typeof actual === 'object' && actual !== null &&
    typeof expected === 'object' && expected !== null &&
    JSON.stringify(actual) === JSON.stringify(expected)
  ) {
    return
  }
  throw new Error(
    `Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
  )
}

function required<T>(value: T | null): T {
  if (value === null) throw new Error('Expected valid synthetic fixture')
  return value
}

const cryptoFailureDiagnostic = 'SYNTHETIC_CRYPTO_DIAGNOSTIC_MUST_NOT_ESCAPE'

async function assertCryptoUnavailable(
  action: () => Promise<unknown>,
  originalError: unknown,
): Promise<void> {
  try {
    await action()
  } catch (error) {
    if (!(error instanceof Error)) throw new Error('Expected sanitized crypto error')
    assertEquals(error.message, 'Student proof cryptography is unavailable')
    assertEquals(error === originalError, false)
    assertEquals(Object.hasOwn(error, 'cause'), false)
    assertEquals(String(error).includes(cryptoFailureDiagnostic), false)
    assertEquals(JSON.stringify(error).includes(cryptoFailureDiagnostic), false)
    assertEquals(error.stack?.includes(cryptoFailureDiagnostic) ?? false, false)
    return
  }
  throw new Error('Expected crypto dependency failure to reject')
}

async function withSubtleFailure(
  method: 'digest' | 'importKey' | 'verify',
  failure: unknown,
  action: () => Promise<void>,
): Promise<number> {
  const subtle = crypto.subtle
  const descriptor = Object.getOwnPropertyDescriptor(subtle, method)
  const original = subtle[method]
  let calls = 0
  Object.defineProperty(subtle, method, {
    configurable: true,
    enumerable: descriptor?.enumerable ?? false,
    writable: true,
    value: () => {
      calls += 1
      return Promise.reject(failure)
    },
  })
  try {
    await action()
  } finally {
    if (descriptor === undefined) {
      assertEquals(Reflect.deleteProperty(subtle, method), true)
    } else {
      Object.defineProperty(subtle, method, descriptor)
    }
    assertEquals(subtle[method], original)
  }
  return calls
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const apiOrigin = 'https://example.com'
const requestId = '10000000-0000-4000-8000-000000000001'
const deviceSessionId = '20000000-0000-4000-8000-000000000001'
const challengeId = '60000000-0000-4000-8000-000000000001'
const otherId = '70000000-0000-4000-8000-000000000001'
const secret = 'A'.repeat(43)
const signature = 'A'.repeat(86)
const scope: EdgeStudentSessionScope = {
  schoolId: '30000000-0000-4000-8000-000000000001',
  testId: '40000000-0000-4000-8000-000000000001',
  studentSessionId: '50000000-0000-4000-8000-000000000001',
  deviceSessionId,
  epoch: 3,
}
const challengeRequest = {
  requestId,
  deviceSessionId,
  publicKey: secret,
  logicalOperationDigest: 'b'.repeat(64),
}
const joinRequest: EdgeStudentJoinRequest = {
  admissionMode: 'initial',
  requestId,
  deviceSessionId,
  joinCode: '0123456789AB',
  capabilityDigest: 'b'.repeat(64),
  reconnectDigest: 'c'.repeat(64),
  deviceProof: {
    challengeId,
    expiresAtMs: 123456789,
    publicKey: secret,
    signature,
  },
}
const readRequest: EdgeStudentReadRequest = {
  requestId,
  scope,
  capabilityToken: secret,
  deviceProof: { counter: 7, signature },
}
const reconnectRequest: EdgeStudentReconnectRequest = {
  requestId,
  scope,
  expectedSessionRevision: 7,
  reconnectGrant: secret,
  nextCapabilityDigest: 'd'.repeat(64),
  nextReconnectDigest: 'e'.repeat(64),
  deviceProof: { counter: 7, signature },
}
const forfeitRequest: EdgeStudentForfeitRequest = {
  ...readRequest,
  expectedSessionRevision: 7,
}
const logicalJoin = {
  kind: 'join',
  admissionMode: 'initial',
  requestId,
  deviceSessionId,
  joinMaterialDigest: 'a'.repeat(64),
  capabilityDigest: 'b'.repeat(64),
  reconnectDigest: 'c'.repeat(64),
}
const logicalRead = {
  kind: 'read',
  requestId,
  scope,
  capabilityDigest: 'b'.repeat(64),
}
const maintenanceEnvelope = {
  kind: 'maintenance',
  apiOrigin,
  operation: 'read',
  requestId,
  scope,
  keyThumbprint: secret,
  logicalOperationDigest: 'b'.repeat(64),
  counter: 7,
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

// These helpers deliberately do not call the implementation's byte encoders.
function base64Url(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')
}

function rawSecret(value: string): Uint8Array {
  return Uint8Array.from(
    atob(`${value.replaceAll('-', '+').replaceAll('_', '/')}=`),
    (character) => character.charCodeAt(0),
  )
}

async function materialDigest(
  domain: string,
  bytes: Uint8Array,
): Promise<string> {
  const prefix = encoder.encode(`${domain}\0`)
  const input = new Uint8Array(prefix.length + bytes.length)
  input.set(prefix)
  input.set(bytes, prefix.length)
  return await sha256(input)
}

async function logicalDigest(array: readonly unknown[]): Promise<string> {
  return await materialDigest(
    'desmoslock/student-logical-operation-digest/v1',
    encoder.encode(JSON.stringify(array)),
  )
}

function scopeArray(value: EdgeStudentSessionScope): readonly unknown[] {
  return [
    value.schoolId,
    value.testId,
    value.studentSessionId,
    value.deviceSessionId,
    value.epoch,
  ]
}

async function joinDigest(value: EdgeStudentJoinRequest): Promise<string> {
  return await logicalDigest([
    'join',
    value.admissionMode,
    value.requestId,
    value.deviceSessionId,
    await materialDigest(
      'desmoslock/student-join-material-digest/v1',
      encoder.encode(value.joinCode),
    ),
    value.capabilityDigest,
    value.reconnectDigest,
  ])
}

type MaintenanceOperation = 'read' | 'reconnect' | 'forfeit'
type MaintenanceRequest =
  | EdgeStudentReadRequest
  | EdgeStudentReconnectRequest
  | EdgeStudentForfeitRequest

async function maintenanceDigest(
  operation: MaintenanceOperation,
  value: MaintenanceRequest,
): Promise<string> {
  if (operation === 'reconnect') {
    if (!('reconnectGrant' in value)) throw new Error('Expected reconnect fixture')
    return await logicalDigest([
      'reconnect',
      value.requestId,
      scopeArray(value.scope),
      value.expectedSessionRevision,
      await materialDigest(
        'desmoslock/student-reconnect-grant-digest/v1',
        rawSecret(value.reconnectGrant),
      ),
      value.nextCapabilityDigest,
      value.nextReconnectDigest,
    ])
  }
  if (!('capabilityToken' in value)) throw new Error('Expected capability fixture')
  const capabilityDigest = await materialDigest(
    'desmoslock/student-capability-digest/v1',
    rawSecret(value.capabilityToken),
  )
  if (operation === 'forfeit') {
    if (!('expectedSessionRevision' in value)) {
      throw new Error('Expected forfeit fixture')
    }
    return await logicalDigest([
      'forfeit',
      value.requestId,
      scopeArray(value.scope),
      value.expectedSessionRevision,
      capabilityDigest,
    ])
  }
  return await logicalDigest([
    'read',
    value.requestId,
    scopeArray(value.scope),
    capabilityDigest,
  ])
}

async function signingKey() {
  const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
  if (!('publicKey' in pair)) throw new Error('Expected Ed25519 key pair')
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
  const thumbprint = base64Url(
    new Uint8Array(await crypto.subtle.digest('SHA-256', raw)),
  )
  return { pair, publicKey: base64Url(raw), thumbprint }
}

type SigningKey = Awaited<ReturnType<typeof signingKey>>

async function signArray(key: SigningKey, array: readonly unknown[]): Promise<string> {
  return base64Url(
    new Uint8Array(
      await crypto.subtle.sign(
        'Ed25519',
        key.pair.privateKey,
        encoder.encode(JSON.stringify(array)),
      ),
    ),
  )
}

async function signedJoin(key: SigningKey, value = joinRequest) {
  const digest = await joinDigest(value)
  const signed = await signArray(key, [
    'desmoslock/student-device-proof/v1',
    apiOrigin,
    'join',
    value.requestId,
    value.deviceSessionId,
    key.thumbprint,
    digest,
    value.deviceProof.challengeId,
    value.deviceProof.expiresAtMs,
  ])
  return {
    digest,
    request: {
      ...value,
      deviceProof: { ...value.deviceProof, publicKey: key.publicKey, signature: signed },
    },
  }
}

async function signedMaintenance(
  key: SigningKey,
  operation: MaintenanceOperation,
  value: MaintenanceRequest,
) {
  const digest = await maintenanceDigest(operation, value)
  const signed = await signArray(key, [
    'desmoslock/student-maintenance-proof/v1',
    apiOrigin,
    operation,
    value.requestId,
    scopeArray(value.scope),
    key.thumbprint,
    digest,
    value.deviceProof.counter,
  ])
  return {
    digest,
    request: { ...value, deviceProof: { ...value.deviceProof, signature: signed } },
  }
}

Deno.test('student exact containers return detached snapshots and reject accessors', () => {
  const input = { value: 1 }
  const snapshot = required(parseEdgeExactRecord(input, ['value']))
  input.value = 2
  assertEquals(snapshot.value, 1)
  assertEquals(parseEdgeExactRecord(Object.assign(Object.create(null), { value: 1 }), ['value']), {
    value: 1,
  })
  for (
    const invalid of [
      null,
      [],
      {},
      { value: 1, extra: true },
      Object.create({ value: 1 }),
      Object.assign({ value: 1 }, { [Symbol('extra')]: true }),
      Object.defineProperty({}, 'value', { value: 1, enumerable: false }),
      new Proxy({}, {
        ownKeys() {
          throw new Error('unreadable')
        },
      }),
    ]
  ) {
    assertEquals(parseEdgeExactRecord(invalid, ['value']), null)
  }
  let getterCalls = 0
  const accessor = Object.defineProperty({}, 'value', {
    enumerable: true,
    get() {
      getterCalls += 1
      return 1
    },
  })
  assertEquals(parseEdgeExactRecord(accessor, ['value']), null)
  const values = [1, 2]
  const arraySnapshot = required(parseEdgeExactArray(values, 2))
  values[0] = 3
  assertEquals(arraySnapshot, [1, 2])
  assertEquals(parseEdgeExactArray([], 0), [])
  const arrayAccessor = Object.defineProperty([1], '0', {
    enumerable: true,
    get() {
      getterCalls += 1
      return 1
    },
  })
  for (
    const invalid of [
      {},
      null,
      [1, 2, 3],
      new Array(1),
      arrayAccessor,
      Object.assign([1], { extra: true }),
      Object.assign([1], { [Symbol('extra')]: true }),
      Object.defineProperty([1], '0', { enumerable: false }),
    ]
  ) {
    assertEquals(parseEdgeExactArray(invalid, 2), null)
  }
  assertEquals(getterCalls, 0)
})

Deno.test('student scalar parsing preserves canonical representations and safe integers', () => {
  assertEquals(parseEdgeStudentUuid(requestId), requestId)
  for (
    const value of [
      null,
      1,
      'ABCDEFAB-0000-4000-8000-000000000001',
      `${requestId} `,
      '00000000-0000-0000-0000-000000000000',
    ]
  ) {
    assertEquals(parseEdgeStudentUuid(value), null)
  }
  for (const value of [1, Number.MAX_SAFE_INTEGER]) {
    assertEquals(parseEdgeStudentCounter(value), value)
  }
  for (const value of [0, -1, -0, 1.5, '7', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null]) {
    assertEquals(parseEdgeStudentCounter(value), null)
  }
  for (const parse of [parseEdgeStudentPublicKey, parseEdgeStudentSecret]) {
    assertEquals(parse(secret), secret)
    for (
      const value of [
        '',
        'A'.repeat(42),
        `${secret}=`,
        'A'.repeat(42) + 'B',
        '+' + 'A'.repeat(42),
        null,
      ]
    ) {
      assertEquals(parse(value), null)
    }
  }
  assertEquals(parseEdgeStudentDigest('b'.repeat(64)), 'b'.repeat(64))
  for (const value of ['B'.repeat(64), 'b'.repeat(63), 'g'.repeat(64), null]) {
    assertEquals(parseEdgeStudentDigest(value), null)
  }
  assertEquals(parseEdgeStudentSignature(signature), signature)
  for (const value of ['A'.repeat(85), `${signature}=`, 'A'.repeat(85) + 'B', null]) {
    assertEquals(parseEdgeStudentSignature(value), null)
  }
  assertEquals(parseEdgeStudentJoinCode('0123456789AB'), '0123456789AB')
  for (
    const value of [
      '0123456789ab',
      '0123456789AI',
      '0123456789AL',
      '0123456789AO',
      '0123456789AU',
      '0123456789A',
      ' 0123456789AB',
    ]
  ) {
    assertEquals(parseEdgeStudentJoinCode(value), null)
  }
})

Deno.test('student API origins allow exact numeric local loopback and canonical staging HTTPS', () => {
  for (const origin of ['http://127.0.0.1:54321', 'http://[::1]:54321']) {
    assertEquals(parseEdgeStudentApiOrigin('local', origin), origin)
    assertEquals(parseEdgeStudentApiOrigin('staging', origin), null)
  }
  assertEquals(parseEdgeStudentApiOrigin('staging', apiOrigin), apiOrigin)
  for (
    const origin of [
      'http://localhost:54321',
      'http://kong:8000',
      'http://host.docker.internal:54321',
      'http://example.com',
      'https://example.com/',
      'https://example.com:443',
      'https://EXAMPLE.com',
      'https://example.com/path',
      'https://example.com?query=value',
      'https://example.com#fragment',
      'https://user:password@example.com',
    ]
  ) {
    assertEquals(parseEdgeStudentApiOrigin('staging', origin), null)
    assertEquals(parseEdgeStudentApiOrigin('local', origin), null)
  }
  assertEquals(parseEdgeStudentApiOrigin('production', apiOrigin), null)
})

const requestCases: ReadonlyArray<{
  name: string
  parse: (value: unknown) => unknown
  value: object
}> = [
  { name: 'challenge', parse: parseEdgeStudentChallengeRequest, value: challengeRequest },
  { name: 'join', parse: parseEdgeStudentJoinRequest, value: joinRequest },
  { name: 'read', parse: parseEdgeStudentReadRequest, value: readRequest },
  { name: 'reconnect', parse: parseEdgeStudentReconnectRequest, value: reconnectRequest },
  { name: 'forfeit', parse: parseEdgeStudentForfeitRequest, value: forfeitRequest },
  { name: 'scope', parse: parseEdgeStudentScope, value: scope },
]

for (const { name, parse, value } of requestCases) {
  Deno.test(`student ${name} request rejects extra, missing, hidden and accessor fields`, () => {
    assertEquals(parse(value), value)
    assertEquals(parse({ ...value, extra: true }), null)
    assertEquals(parse(Object.assign(Object.create({ inherited: true }), value)), null)
    assertEquals(parse(Object.assign({ ...value }, { [Symbol('extra')]: true })), null)
    let getterCalls = 0
    for (const key of Object.keys(value)) {
      const missing: Record<string, unknown> = { ...value }
      delete missing[key]
      assertEquals(parse(missing), null)
      const accessor = Object.defineProperty({ ...value }, key, {
        enumerable: true,
        get() {
          getterCalls += 1
          return undefined
        },
      })
      assertEquals(parse(accessor), null)
      assertEquals(parse(Object.defineProperty({ ...value }, key, { enumerable: false })), null)
    }
    assertEquals(getterCalls, 0)
  })
}

Deno.test('student request parsers reject nested accessor proofs and scope without invoking getters', () => {
  let getterCalls = 0
  for (const { parse, value } of requestCases) {
    for (const nestedKey of ['scope', 'deviceProof']) {
      const nested: unknown = Object.getOwnPropertyDescriptor(value, nestedKey)?.value
      if (typeof nested !== 'object' || nested === null) continue
      for (const key of Object.keys(nested)) {
        const poisoned = Object.defineProperty({ ...nested }, key, {
          enumerable: true,
          get() {
            getterCalls += 1
            return undefined
          },
        })
        assertEquals(parse({ ...value, [nestedKey]: poisoned }), null)
      }
    }
  }
  assertEquals(getterCalls, 0)
})

Deno.test('student requests enforce admission mode, proof kind and counter bounds', () => {
  assertEquals(parseEdgeStudentJoinRequest({ ...joinRequest, admissionMode: 'readmission' }), {
    ...joinRequest,
    admissionMode: 'readmission',
  })
  for (const mode of [undefined, null, 'automatic', 'INITIAL']) {
    assertEquals(parseEdgeStudentJoinRequest({ ...joinRequest, admissionMode: mode }), null)
  }
  assertEquals(
    parseEdgeStudentJoinRequest({ ...joinRequest, deviceProof: readRequest.deviceProof }),
    null,
  )
  assertEquals(
    parseEdgeStudentReadRequest({ ...readRequest, deviceProof: joinRequest.deviceProof }),
    null,
  )
  assertEquals(
    parseEdgeStudentChallengeRequest({ ...challengeRequest, publicKey: 'A'.repeat(42) + 'B' }),
    null,
  )
  for (const counter of [0, '7', 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assertEquals(
      parseEdgeStudentReadRequest({ ...readRequest, deviceProof: { counter, signature } }),
      null,
    )
    assertEquals(parseEdgeStudentScope({ ...scope, epoch: counter }), null)
    assertEquals(
      parseEdgeStudentReconnectRequest({ ...reconnectRequest, expectedSessionRevision: counter }),
      null,
    )
    assertEquals(
      parseEdgeStudentForfeitRequest({ ...forfeitRequest, expectedSessionRevision: counter }),
      null,
    )
  }
})

Deno.test('student Edge logical commitments preserve all five independent canonical SHA-256 vectors', async () => {
  // Frozen independently generated Python hashlib/compact-JSON vectors shared
  // with the Node contract tests; expectations are never calculated by Edge.
  const vectors = [
    [logicalJoin, '0575f8cd2bd0c017b343feafe38d4b08289b9e7838cdc5c15839cd197779ea6f'],
    [
      { ...logicalJoin, admissionMode: 'readmission' },
      '56734a3511fd17ec5fcd5c87238c6b53cf1d748f62cae9669c0c14760f81466d',
    ],
    [logicalRead, '7578c34f88b34cbb9087e91194532b4d5dbd10fcf609e625c0851f09b5760e8b'],
    [{
      kind: 'reconnect',
      requestId,
      scope,
      expectedSessionRevision: 7,
      reconnectDigest: 'c'.repeat(64),
      nextCapabilityDigest: 'd'.repeat(64),
      nextReconnectDigest: 'e'.repeat(64),
    }, '2915db38f8e19596b7b4caef8d39c13bac4ee99e0628e22ee819203e8ac4e8e4'],
    [
      { ...logicalRead, kind: 'forfeit', expectedSessionRevision: 7 },
      'b7d90cb1f489775e2d53509c7fc0a460cd9fe42b0c81757f2d5a567c7e946b84',
    ],
  ] as const
  for (const [value, expected] of vectors) {
    assertEquals(await sha256(required(encodeEdgeStudentLogicalOperation(value))), expected)
    assertEquals(await edgeStudentLogicalOperationDigest(value), expected)
  }
})

Deno.test('student Edge material digests use raw secret bytes and distinct frozen domains', async () => {
  const vectors = [
    ['capability', secret, 'f03707f0b808210c4ed2d14af5de53727f6bcf7f57bccc773fd6d33c244ac883'],
    ['reconnectGrant', secret, '450182271829acb83b7f2d94fa4b785050be6e845f28bc21afbda0cdd1f6e243'],
    [
      'joinMaterial',
      '0123456789AB',
      '5c4b9f4b01ced1ab28a3e7971770f230c4c959b103e07120c9537c54c47f205e',
    ],
  ] as const
  for (const [purpose, value, expected] of vectors) {
    assertEquals(
      await sha256(required(encodeEdgeStudentMaterialDigestInput(purpose, value))),
      expected,
    )
    assertEquals(await edgeStudentMaterialDigest(purpose, value), expected)
    assertEquals(await edgeStudentMaterialDigest(purpose, `${value}=`), null)
  }
})

Deno.test('student logical commitment encoders reject attempt fields, malformed scope and getters', async () => {
  for (
    const value of [
      { ...logicalJoin, counter: 1 },
      { ...logicalJoin, deviceProof: {} },
      { ...logicalJoin, admissionMode: undefined },
      { ...logicalJoin, admissionMode: 'automatic' },
      { ...logicalJoin, joinMaterialDigest: 'A'.repeat(64) },
      { ...logicalRead, scope: { ...scope, epoch: 0 } },
      { ...logicalRead, scope: { ...scope, extra: true } },
      { ...logicalRead, kind: 'forfeit', expectedSessionRevision: Number.MAX_SAFE_INTEGER + 1 },
    ]
  ) {
    assertEquals(encodeEdgeStudentLogicalOperation(value), null)
    assertEquals(await edgeStudentLogicalOperationDigest(value), null)
  }
  let getterCalls = 0
  const poisoned = Object.defineProperty({ ...logicalJoin }, 'admissionMode', {
    enumerable: true,
    get() {
      getterCalls += 1
      return 'initial'
    },
  })
  assertEquals(encodeEdgeStudentLogicalOperation(poisoned), null)
  assertEquals(await edgeStudentLogicalOperationDigest(poisoned), null)
  assertEquals(getterCalls, 0)
})

Deno.test('student proof byte codecs reject padding and nonzero trailing bits', () => {
  const bytes = Uint8Array.from({ length: 32 }, (_, index) => index)
  const text = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8'
  assertEquals(encodeEdgeStudentProofBytes(bytes), text)
  assertEquals(Array.from(required(decodeEdgeStudentSecretBytes(text))), Array.from(bytes))
  assertEquals(encodeEdgeStudentProofBytes(new Uint8Array(64)), signature)
  assertEquals(decodeEdgeStudentSecretBytes(`${text}=`), null)
  assertEquals(decodeEdgeStudentSecretBytes('A'.repeat(42) + 'B'), null)
  assertEquals(encodeEdgeStudentProofBytes(new Uint8Array(31)), null)
  assertEquals(encodeEdgeStudentProofBytes(new Uint8Array(65)), null)
})

Deno.test('student proof envelopes preserve literal frozen arrays and full safe-integer counters', () => {
  assertEquals(
    decoder.decode(
      required(
        encodeEdgeStudentProofEnvelope({
          ...maintenanceEnvelope,
          counter: Number.MAX_SAFE_INTEGER,
        }),
      ),
    ),
    '["desmoslock/student-maintenance-proof/v1","https://example.com","read",' +
      '"10000000-0000-4000-8000-000000000001",["30000000-0000-4000-8000-000000000001",' +
      '"40000000-0000-4000-8000-000000000001","50000000-0000-4000-8000-000000000001",' +
      '"20000000-0000-4000-8000-000000000001",3],"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",' +
      '"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",9007199254740991]',
  )
  const bootstrap = {
    kind: 'bootstrap',
    apiOrigin,
    requestId,
    deviceSessionId,
    keyThumbprint: secret,
    logicalOperationDigest: 'b'.repeat(64),
    challengeId,
    expiresAtMs: 123456789,
  }
  assertEquals(
    decoder.decode(required(encodeEdgeStudentProofEnvelope(bootstrap))),
    '["desmoslock/student-device-proof/v1","https://example.com","join",' +
      '"10000000-0000-4000-8000-000000000001","20000000-0000-4000-8000-000000000001",' +
      '"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",' +
      '"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",' +
      '"60000000-0000-4000-8000-000000000001",123456789]',
  )
  assertEquals(encodeEdgeStudentProofEnvelope({ ...bootstrap, scope }), null)
  for (
    const value of [
      { ...maintenanceEnvelope, counter: 0 },
      { ...maintenanceEnvelope, counter: '7' },
      { ...maintenanceEnvelope, counter: 1.5 },
      { ...maintenanceEnvelope, counter: Number.MAX_SAFE_INTEGER + 1 },
      { ...maintenanceEnvelope, operation: 'release' },
      { ...maintenanceEnvelope, keyThumbprint: 'A'.repeat(42) + 'B' },
      { ...maintenanceEnvelope, challengeId },
      { ...maintenanceEnvelope, apiOrigin: `${apiOrigin}/` },
      { ...maintenanceEnvelope, apiOrigin: 'http://example.com' },
    ]
  ) assertEquals(encodeEdgeStudentProofEnvelope(value), null)
})

Deno.test('student key thumbprints hash decoded raw Ed25519 keys, not encoded text or JWK', async () => {
  const key = await signingKey()
  assertEquals(await edgeStudentKeyThumbprint(key.publicKey), key.thumbprint)
  const textHash = base64Url(
    new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(key.publicKey))),
  )
  assertEquals(key.thumbprint === textHash, false)
  for (const value of [null, `${key.publicKey}=`, 'A'.repeat(42) + 'B', 'A'.repeat(86)]) {
    assertEquals(await edgeStudentKeyThumbprint(value), null)
  }
})

Deno.test('student bootstrap verifies real Ed25519 signatures for both explicit admission modes', async () => {
  const key = await signingKey()
  for (const admissionMode of ['initial', 'readmission'] as const) {
    const { request, digest } = await signedJoin(key, { ...joinRequest, admissionMode })
    assertEquals(await verifyEdgeStudentBootstrapProof(apiOrigin, request, digest), true)
  }
})

Deno.test('student bootstrap rejects changed mode, origin, request, device, commitment, challenge, expiry, key and signature', async () => {
  const key = await signingKey()
  const otherKey = await signingKey()
  const { request, digest } = await signedJoin(key)
  assertEquals(await verifyEdgeStudentBootstrapProof(apiOrigin, request, digest), true)
  assertEquals(
    await verifyEdgeStudentBootstrapProof('https://other.example.com', request, digest),
    false,
  )
  assertEquals(await verifyEdgeStudentBootstrapProof(apiOrigin, request, 'd'.repeat(64)), false)
  const changedRequests: EdgeStudentJoinRequest[] = [
    { ...request, admissionMode: 'readmission' },
    { ...request, requestId: otherId },
    { ...request, deviceSessionId: otherId },
    { ...request, joinCode: '0123456789AC' },
    { ...request, capabilityDigest: 'd'.repeat(64) },
    { ...request, reconnectDigest: 'd'.repeat(64) },
    { ...request, deviceProof: { ...request.deviceProof, challengeId: otherId } },
    {
      ...request,
      deviceProof: { ...request.deviceProof, expiresAtMs: request.deviceProof.expiresAtMs + 1 },
    },
    { ...request, deviceProof: { ...request.deviceProof, publicKey: otherKey.publicKey } },
    { ...request, deviceProof: { ...request.deviceProof, signature } },
  ]
  for (const changed of changedRequests) {
    assertEquals(
      await verifyEdgeStudentBootstrapProof(apiOrigin, changed, await joinDigest(changed)),
      false,
    )
  }
})

for (
  const [operation, value] of [
    ['read', readRequest],
    ['reconnect', reconnectRequest],
    ['forfeit', forfeitRequest],
  ] as const
) {
  Deno.test(`student ${operation} verifies a literal-array Ed25519 proof and rejects changed authority`, async () => {
    const key = await signingKey()
    const otherKey = await signingKey()
    const { request, digest } = await signedMaintenance(key, operation, value)
    assertEquals(
      await verifyEdgeStudentMaintenanceProof(apiOrigin, operation, request, key.publicKey, digest),
      true,
    )
    assertEquals(
      await verifyEdgeStudentMaintenanceProof(
        'https://other.example.com',
        operation,
        request,
        key.publicKey,
        digest,
      ),
      false,
    )
    assertEquals(
      await verifyEdgeStudentMaintenanceProof(
        apiOrigin,
        operation,
        request,
        otherKey.publicKey,
        digest,
      ),
      false,
    )
    assertEquals(
      await verifyEdgeStudentMaintenanceProof(
        apiOrigin,
        operation,
        request,
        key.publicKey,
        'a'.repeat(64),
      ),
      false,
    )
    for (const changedOperation of ['read', 'reconnect', 'forfeit'] as const) {
      if (changedOperation === operation) continue
      assertEquals(
        await verifyEdgeStudentMaintenanceProof(
          apiOrigin,
          changedOperation,
          request,
          key.publicKey,
          digest,
        ),
        false,
      )
      const wrongOperationSignature = await signArray(key, [
        'desmoslock/student-maintenance-proof/v1',
        apiOrigin,
        changedOperation,
        request.requestId,
        scopeArray(request.scope),
        key.thumbprint,
        digest,
        request.deviceProof.counter,
      ])
      assertEquals(
        await verifyEdgeStudentMaintenanceProof(
          apiOrigin,
          operation,
          {
            ...request,
            deviceProof: { ...request.deviceProof, signature: wrongOperationSignature },
          },
          key.publicKey,
          digest,
        ),
        false,
      )
    }
    const changedRequests: MaintenanceRequest[] = [
      { ...request, requestId: otherId },
      { ...request, deviceProof: { ...request.deviceProof, counter: 8 } },
      { ...request, deviceProof: { ...request.deviceProof, signature } },
      ...['schoolId', 'testId', 'studentSessionId', 'deviceSessionId'].map((field) => ({
        ...request,
        scope: { ...request.scope, [field]: otherId },
      })),
      { ...request, scope: { ...request.scope, epoch: request.scope.epoch + 1 } },
    ]
    for (const changed of changedRequests) {
      assertEquals(
        await verifyEdgeStudentMaintenanceProof(
          apiOrigin,
          operation,
          changed,
          key.publicKey,
          digest,
        ),
        false,
      )
      assertEquals(
        await verifyEdgeStudentMaintenanceProof(
          apiOrigin,
          operation,
          changed,
          key.publicKey,
          await maintenanceDigest(operation, changed),
        ),
        false,
      )
    }
  })
}

Deno.test('student maintenance rejects changed logical material and expected revision', async () => {
  const key = await signingKey()
  for (
    const [operation, value] of [
      ['read', readRequest],
      ['reconnect', reconnectRequest],
      ['forfeit', forfeitRequest],
    ] as const
  ) {
    const { request } = await signedMaintenance(key, operation, value)
    const changes: MaintenanceRequest[] = []
    if ('capabilityToken' in request) {
      changes.push({ ...request, capabilityToken: base64Url(new Uint8Array(32).fill(1)) })
    }
    if ('expectedSessionRevision' in request) {
      changes.push({ ...request, expectedSessionRevision: request.expectedSessionRevision + 1 })
    }
    if ('reconnectGrant' in request) {
      changes.push(
        { ...request, reconnectGrant: base64Url(new Uint8Array(32).fill(1)) },
        { ...request, nextCapabilityDigest: 'f'.repeat(64) },
        { ...request, nextReconnectDigest: 'f'.repeat(64) },
      )
    }
    for (const changed of changes) {
      assertEquals(
        await verifyEdgeStudentMaintenanceProof(
          apiOrigin,
          operation,
          changed,
          key.publicKey,
          await maintenanceDigest(operation, changed),
        ),
        false,
      )
    }
  }
})

Deno.test('student maintenance signs the exact maximum safe counter and rejects overflow', async () => {
  const key = await signingKey()
  const { request, digest } = await signedMaintenance(key, 'read', {
    ...readRequest,
    deviceProof: { counter: Number.MAX_SAFE_INTEGER, signature },
  })
  assertEquals(
    await verifyEdgeStudentMaintenanceProof(apiOrigin, 'read', request, key.publicKey, digest),
    true,
  )
  for (const counter of [0, 1.5, Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER + 1]) {
    assertEquals(
      await verifyEdgeStudentMaintenanceProof(
        apiOrigin,
        'read',
        {
          ...request,
          deviceProof: { ...request.deviceProof, counter },
        },
        key.publicKey,
        digest,
      ),
      false,
    )
  }
})

Deno.test('student bootstrap rejects a valid signature over the wrong domain, operation or thumbprint', async () => {
  const key = await signingKey()
  const { request, digest } = await signedJoin(key)
  for (
    const [domain, operation, thumbprint] of [
      ['desmoslock/student-maintenance-proof/v1', 'join', key.thumbprint],
      ['desmoslock/student-device-proof/v1', 'read', key.thumbprint],
      ['desmoslock/student-device-proof/v1', 'join', secret],
    ]
  ) {
    const wrongSignature = await signArray(key, [
      domain,
      apiOrigin,
      operation,
      request.requestId,
      request.deviceSessionId,
      thumbprint,
      digest,
      request.deviceProof.challengeId,
      request.deviceProof.expiresAtMs,
    ])
    assertEquals(
      await verifyEdgeStudentBootstrapProof(apiOrigin, {
        ...request,
        deviceProof: { ...request.deviceProof, signature: wrongSignature },
      }, digest),
      false,
    )
  }
})

Deno.test('student verifiers reject malformed inputs and nested getters without invoking them', async () => {
  const key = await signingKey()
  const join = await signedJoin(key)
  const read = await signedMaintenance(key, 'read', readRequest)
  for (const value of [null, [], {}, { ...join.request, extra: true }]) {
    assertEquals(await verifyEdgeStudentBootstrapProof(apiOrigin, value, join.digest), false)
  }
  for (const value of [null, [], {}, { ...read.request, extra: true }]) {
    assertEquals(
      await verifyEdgeStudentMaintenanceProof(apiOrigin, 'read', value, key.publicKey, read.digest),
      false,
    )
  }
  for (const invalidSignature of ['A'.repeat(85), 'A'.repeat(85) + 'B', `${signature}=`]) {
    assertEquals(
      await verifyEdgeStudentBootstrapProof(apiOrigin, {
        ...join.request,
        deviceProof: { ...join.request.deviceProof, signature: invalidSignature },
      }, join.digest),
      false,
    )
    assertEquals(
      await verifyEdgeStudentMaintenanceProof(
        apiOrigin,
        'read',
        {
          ...read.request,
          deviceProof: { ...read.request.deviceProof, signature: invalidSignature },
        },
        key.publicKey,
        read.digest,
      ),
      false,
    )
  }
  assertEquals(
    await verifyEdgeStudentMaintenanceProof(
      apiOrigin,
      'read',
      read.request,
      `${key.publicKey}=`,
      read.digest,
    ),
    false,
  )
  assertEquals(
    await verifyEdgeStudentBootstrapProof(`${apiOrigin}/`, join.request, join.digest),
    false,
  )
  assertEquals(
    await verifyEdgeStudentBootstrapProof(apiOrigin, join.request, 'A'.repeat(64)),
    false,
  )
  let getterCalls = 0
  const poison = (value: object, key: string) =>
    Object.defineProperty({ ...value }, key, {
      enumerable: true,
      get() {
        getterCalls += 1
        return undefined
      },
    })
  assertEquals(
    await verifyEdgeStudentBootstrapProof(
      apiOrigin,
      poison(join.request, 'admissionMode'),
      join.digest,
    ),
    false,
  )
  assertEquals(
    await verifyEdgeStudentBootstrapProof(apiOrigin, {
      ...join.request,
      deviceProof: poison(join.request.deviceProof, 'signature'),
    }, join.digest),
    false,
  )
  assertEquals(
    await verifyEdgeStudentMaintenanceProof(
      apiOrigin,
      'read',
      {
        ...read.request,
        scope: poison(read.request.scope, 'epoch'),
      },
      key.publicKey,
      read.digest,
    ),
    false,
  )
  assertEquals(
    await verifyEdgeStudentMaintenanceProof(
      apiOrigin,
      'read',
      {
        ...read.request,
        deviceProof: poison(read.request.deviceProof, 'counter'),
      },
      key.publicKey,
      read.digest,
    ),
    false,
  )
  assertEquals(getterCalls, 0)
})

Deno.test('student SHA-256 outages reject with a sanitized dependency error while malformed input stays denied', async () => {
  const key = await signingKey()
  const join = await signedJoin(key)
  const read = await signedMaintenance(key, 'read', readRequest)
  for (
    const failure of [
      new DOMException(cryptoFailureDiagnostic, 'NotSupportedError'),
      new DOMException(cryptoFailureDiagnostic, 'OperationError'),
      new DOMException(cryptoFailureDiagnostic, 'DataError'),
      new Error(cryptoFailureDiagnostic),
    ]
  ) {
    const calls = await withSubtleFailure('digest', failure, async () => {
      const actions = [
        () => edgeStudentMaterialDigest('capability', secret),
        () => edgeStudentMaterialDigest('reconnectGrant', secret),
        () => edgeStudentMaterialDigest('joinMaterial', joinRequest.joinCode),
        () => edgeStudentLogicalOperationDigest(logicalJoin),
        () => edgeStudentKeyThumbprint(key.publicKey),
        () => verifyEdgeStudentBootstrapProof(apiOrigin, join.request, join.digest),
        () =>
          verifyEdgeStudentMaintenanceProof(
            apiOrigin,
            'read',
            read.request,
            key.publicKey,
            read.digest,
          ),
      ]
      for (const action of actions) await assertCryptoUnavailable(action, failure)
      assertEquals(await edgeStudentMaterialDigest('capability', `${secret}=`), null)
      assertEquals(await edgeStudentLogicalOperationDigest({ ...logicalJoin, extra: true }), null)
      assertEquals(await edgeStudentKeyThumbprint(`${key.publicKey}=`), null)
      assertEquals(
        await verifyEdgeStudentBootstrapProof(
          apiOrigin,
          { ...join.request, extra: true },
          join.digest,
        ),
        false,
      )
      assertEquals(
        await verifyEdgeStudentMaintenanceProof(
          apiOrigin,
          'read',
          { ...read.request, extra: true },
          key.publicKey,
          read.digest,
        ),
        false,
      )
    })
    assertEquals(calls, 7)
  }
  assertEquals(await verifyEdgeStudentBootstrapProof(apiOrigin, join.request, join.digest), true)
  assertEquals(
    await verifyEdgeStudentMaintenanceProof(
      apiOrigin,
      'read',
      read.request,
      key.publicKey,
      read.digest,
    ),
    true,
  )
})

for (const method of ['importKey', 'verify'] as const) {
  Deno.test(`student Ed25519 ${method} outages reject without exposing provider diagnostics`, async () => {
    const key = await signingKey()
    const join = await signedJoin(key)
    const read = await signedMaintenance(key, 'read', readRequest)
    const failures = [
      new DOMException(cryptoFailureDiagnostic, 'NotSupportedError'),
      new DOMException(cryptoFailureDiagnostic, 'OperationError'),
      new Error(cryptoFailureDiagnostic),
    ]
    if (method === 'verify') {
      failures.push(new DOMException(cryptoFailureDiagnostic, 'DataError'))
    }
    for (const failure of failures) {
      const calls = await withSubtleFailure(method, failure, async () => {
        await assertCryptoUnavailable(
          () => verifyEdgeStudentBootstrapProof(apiOrigin, join.request, join.digest),
          failure,
        )
        await assertCryptoUnavailable(
          () =>
            verifyEdgeStudentMaintenanceProof(
              apiOrigin,
              'read',
              read.request,
              key.publicKey,
              read.digest,
            ),
          failure,
        )
      })
      assertEquals(calls, 2)
    }
    assertEquals(await verifyEdgeStudentBootstrapProof(apiOrigin, join.request, join.digest), true)
    assertEquals(
      await verifyEdgeStudentMaintenanceProof(
        apiOrigin,
        'read',
        read.request,
        key.publicKey,
        read.digest,
      ),
      true,
    )
  })
}

Deno.test('student key import DataError remains proof denial and restores actual verification', async () => {
  const key = await signingKey()
  const join = await signedJoin(key)
  const read = await signedMaintenance(key, 'read', readRequest)
  const calls = await withSubtleFailure(
    'importKey',
    new DOMException(cryptoFailureDiagnostic, 'DataError'),
    async () => {
      assertEquals(
        await verifyEdgeStudentBootstrapProof(apiOrigin, join.request, join.digest),
        false,
      )
      assertEquals(
        await verifyEdgeStudentMaintenanceProof(
          apiOrigin,
          'read',
          read.request,
          key.publicKey,
          read.digest,
        ),
        false,
      )
      assertEquals(
        await verifyEdgeStudentMaintenanceProof(
          apiOrigin,
          'read',
          read.request,
          `${key.publicKey}=`,
          read.digest,
        ),
        false,
      )
    },
  )
  assertEquals(calls, 2)
  assertEquals(await verifyEdgeStudentBootstrapProof(apiOrigin, join.request, join.digest), true)
  assertEquals(
    await verifyEdgeStudentMaintenanceProof(
      apiOrigin,
      'read',
      read.request,
      key.publicKey,
      read.digest,
    ),
    true,
  )
  assertEquals(
    await verifyEdgeStudentMaintenanceProof(
      apiOrigin,
      'read',
      {
        ...read.request,
        deviceProof: { ...read.request.deviceProof, signature },
      },
      key.publicKey,
      read.digest,
    ),
    false,
  )
})
