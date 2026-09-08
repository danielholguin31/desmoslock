/**
 * Deno mirror of packages/contracts/src/student-session{,-proof}.ts.
 * Keep canonical shapes and bytes identical; Edge cannot import Node's built
 * .js contract graph. Golden vectors independently pin this runtime boundary.
 */
export type EdgeStudentAdmissionMode = 'initial' | 'readmission'
export type EdgeStudentMaintenanceOperation = 'read' | 'reconnect' | 'forfeit'

export interface EdgeStudentSessionScope {
  readonly schoolId: string
  readonly testId: string
  readonly studentSessionId: string
  readonly deviceSessionId: string
  readonly epoch: number
}
export interface EdgeStudentBootstrapProof {
  readonly challengeId: string
  readonly expiresAtMs: number
  readonly publicKey: string
  readonly signature: string
}
export interface EdgeStudentMaintenanceProof {
  readonly counter: number
  readonly signature: string
}
export interface EdgeStudentChallengeRequest {
  readonly requestId: string
  readonly deviceSessionId: string
  readonly publicKey: string
  readonly logicalOperationDigest: string
}
export interface EdgeStudentJoinRequest {
  readonly admissionMode: EdgeStudentAdmissionMode
  readonly requestId: string
  readonly deviceSessionId: string
  readonly joinCode: string
  readonly capabilityDigest: string
  readonly reconnectDigest: string
  readonly deviceProof: EdgeStudentBootstrapProof
}
export interface EdgeStudentReadRequest {
  readonly requestId: string
  readonly scope: EdgeStudentSessionScope
  readonly capabilityToken: string
  readonly deviceProof: EdgeStudentMaintenanceProof
}
export interface EdgeStudentReconnectRequest {
  readonly requestId: string
  readonly scope: EdgeStudentSessionScope
  readonly expectedSessionRevision: number
  readonly reconnectGrant: string
  readonly nextCapabilityDigest: string
  readonly nextReconnectDigest: string
  readonly deviceProof: EdgeStudentMaintenanceProof
}
export interface EdgeStudentForfeitRequest extends EdgeStudentReadRequest {
  readonly expectedSessionRevision: number
}

export function parseEdgeExactRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> | null {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return null
    }
    const prototype = Object.getPrototypeOf(value) as unknown
    if (prototype !== Object.prototype && prototype !== null) return null
    const actualKeys = Reflect.ownKeys(value)
    if (
      actualKeys.length !== expectedKeys.length ||
      actualKeys.some(
        (key) => typeof key !== 'string' || !expectedKeys.includes(key),
      )
    ) return null
    const snapshot = Object.create(null) as Record<string, unknown>
    for (const key of expectedKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (
        descriptor === undefined ||
        !('value' in descriptor) ||
        !descriptor.enumerable
      ) return null
      snapshot[key] = descriptor.value as unknown
    }
    return snapshot
  } catch {
    return null
  }
}

export function parseEdgeExactArray(
  value: unknown,
  maximumLength: number,
): readonly unknown[] | null {
  try {
    if (!Array.isArray(value)) return null
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
    if (
      lengthDescriptor === undefined ||
      !('value' in lengthDescriptor) ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0 ||
      lengthDescriptor.value > maximumLength
    ) return null
    const length = lengthDescriptor.value as number
    const ownKeys = Reflect.ownKeys(value)
    if (
      ownKeys.length !== length + 1 ||
      !ownKeys.includes('length') ||
      ownKeys.some(
        (key) =>
          typeof key !== 'string' ||
          (key !== 'length' &&
            (!/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= length)),
      )
    ) return null
    const snapshot: unknown[] = []
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (
        descriptor === undefined ||
        !('value' in descriptor) ||
        !descriptor.enumerable
      ) return null
      snapshot.push(descriptor.value as unknown)
    }
    return snapshot
  } catch {
    return null
  }
}

export function parseEdgeStudentUuid(value: unknown): string | null {
  return typeof value === 'string' &&
      value.length === 36 &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
        .test(value)
    ? value
    : null
}
export function parseEdgeStudentDigest(value: unknown): string | null {
  return typeof value === 'string' &&
      value.length === 64 && /^[0-9a-f]{64}$/u.test(value)
    ? value
    : null
}
export function parseEdgeStudentSecret(value: unknown): string | null {
  return typeof value === 'string' &&
      value.length === 43 &&
      /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u.test(value)
    ? value
    : null
}
export function parseEdgeStudentPublicKey(value: unknown): string | null {
  return parseEdgeStudentSecret(value)
}
export function parseEdgeStudentSignature(value: unknown): string | null {
  return typeof value === 'string' &&
      value.length === 86 && /^[A-Za-z0-9_-]{85}[AQgw]$/u.test(value)
    ? value
    : null
}
export function parseEdgeStudentCounter(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : null
}
export function parseEdgeStudentJoinCode(value: unknown): string | null {
  return typeof value === 'string' &&
      value.length === 12 && /^[0-9A-HJKMNP-TV-Z]{12}$/u.test(value)
    ? value
    : null
}
function parseMilliseconds(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) &&
      value >= 0 && !Object.is(value, -0)
    ? value
    : null
}
export function parseEdgeStudentScope(
  value: unknown,
): EdgeStudentSessionScope | null {
  const row = parseEdgeExactRecord(value, [
    'schoolId',
    'testId',
    'studentSessionId',
    'deviceSessionId',
    'epoch',
  ])
  if (row === null) return null
  const schoolId = parseEdgeStudentUuid(row.schoolId)
  const testId = parseEdgeStudentUuid(row.testId)
  const studentSessionId = parseEdgeStudentUuid(row.studentSessionId)
  const deviceSessionId = parseEdgeStudentUuid(row.deviceSessionId)
  const epoch = parseEdgeStudentCounter(row.epoch)
  return schoolId !== null && testId !== null && studentSessionId !== null &&
      deviceSessionId !== null && epoch !== null
    ? { schoolId, testId, studentSessionId, deviceSessionId, epoch }
    : null
}
export function parseEdgeStudentBootstrapProof(
  value: unknown,
): EdgeStudentBootstrapProof | null {
  const row = parseEdgeExactRecord(value, [
    'challengeId',
    'expiresAtMs',
    'publicKey',
    'signature',
  ])
  if (row === null) return null
  const challengeId = parseEdgeStudentUuid(row.challengeId)
  const expiresAtMs = parseMilliseconds(row.expiresAtMs)
  const publicKey = parseEdgeStudentPublicKey(row.publicKey)
  const signature = parseEdgeStudentSignature(row.signature)
  return challengeId !== null && expiresAtMs !== null && publicKey !== null &&
      signature !== null
    ? { challengeId, expiresAtMs, publicKey, signature }
    : null
}
export function parseEdgeStudentMaintenanceProof(
  value: unknown,
): EdgeStudentMaintenanceProof | null {
  const row = parseEdgeExactRecord(value, ['counter', 'signature'])
  if (row === null) return null
  const counter = parseEdgeStudentCounter(row.counter)
  const signature = parseEdgeStudentSignature(row.signature)
  return counter !== null && signature !== null ? { counter, signature } : null
}
export function parseEdgeStudentChallengeRequest(
  value: unknown,
): EdgeStudentChallengeRequest | null {
  const row = parseEdgeExactRecord(value, [
    'requestId',
    'deviceSessionId',
    'publicKey',
    'logicalOperationDigest',
  ])
  if (row === null) return null
  const requestId = parseEdgeStudentUuid(row.requestId)
  const deviceSessionId = parseEdgeStudentUuid(row.deviceSessionId)
  const publicKey = parseEdgeStudentPublicKey(row.publicKey)
  const logicalOperationDigest = parseEdgeStudentDigest(row.logicalOperationDigest)
  return requestId !== null && deviceSessionId !== null && publicKey !== null &&
      logicalOperationDigest !== null
    ? { requestId, deviceSessionId, publicKey, logicalOperationDigest }
    : null
}
export function parseEdgeStudentJoinRequest(
  value: unknown,
): EdgeStudentJoinRequest | null {
  const row = parseEdgeExactRecord(value, [
    'admissionMode',
    'requestId',
    'deviceSessionId',
    'joinCode',
    'capabilityDigest',
    'reconnectDigest',
    'deviceProof',
  ])
  if (row === null) return null
  const admissionMode = row.admissionMode
  const requestId = parseEdgeStudentUuid(row.requestId)
  const deviceSessionId = parseEdgeStudentUuid(row.deviceSessionId)
  const joinCode = parseEdgeStudentJoinCode(row.joinCode)
  const capabilityDigest = parseEdgeStudentDigest(row.capabilityDigest)
  const reconnectDigest = parseEdgeStudentDigest(row.reconnectDigest)
  const deviceProof = parseEdgeStudentBootstrapProof(row.deviceProof)
  return (admissionMode === 'initial' || admissionMode === 'readmission') &&
      requestId !== null && deviceSessionId !== null && joinCode !== null &&
      capabilityDigest !== null && reconnectDigest !== null && deviceProof !== null
    ? {
      admissionMode,
      requestId,
      deviceSessionId,
      joinCode,
      capabilityDigest,
      reconnectDigest,
      deviceProof,
    }
    : null
}
export function parseEdgeStudentReadRequest(
  value: unknown,
): EdgeStudentReadRequest | null {
  const row = parseEdgeExactRecord(value, [
    'requestId',
    'scope',
    'capabilityToken',
    'deviceProof',
  ])
  if (row === null) return null
  const requestId = parseEdgeStudentUuid(row.requestId)
  const scope = parseEdgeStudentScope(row.scope)
  const capabilityToken = parseEdgeStudentSecret(row.capabilityToken)
  const deviceProof = parseEdgeStudentMaintenanceProof(row.deviceProof)
  return requestId !== null && scope !== null && capabilityToken !== null &&
      deviceProof !== null
    ? { requestId, scope, capabilityToken, deviceProof }
    : null
}
export function parseEdgeStudentForfeitRequest(
  value: unknown,
): EdgeStudentForfeitRequest | null {
  const row = parseEdgeExactRecord(value, [
    'requestId',
    'scope',
    'expectedSessionRevision',
    'capabilityToken',
    'deviceProof',
  ])
  if (row === null) return null
  const read = parseEdgeStudentReadRequest({
    requestId: row.requestId,
    scope: row.scope,
    capabilityToken: row.capabilityToken,
    deviceProof: row.deviceProof,
  })
  const expectedSessionRevision = parseEdgeStudentCounter(row.expectedSessionRevision)
  return read !== null && expectedSessionRevision !== null
    ? { ...read, expectedSessionRevision }
    : null
}
export function parseEdgeStudentReconnectRequest(
  value: unknown,
): EdgeStudentReconnectRequest | null {
  const row = parseEdgeExactRecord(value, [
    'requestId',
    'scope',
    'expectedSessionRevision',
    'reconnectGrant',
    'nextCapabilityDigest',
    'nextReconnectDigest',
    'deviceProof',
  ])
  if (row === null) return null
  const requestId = parseEdgeStudentUuid(row.requestId)
  const scope = parseEdgeStudentScope(row.scope)
  const expectedSessionRevision = parseEdgeStudentCounter(row.expectedSessionRevision)
  const reconnectGrant = parseEdgeStudentSecret(row.reconnectGrant)
  const nextCapabilityDigest = parseEdgeStudentDigest(row.nextCapabilityDigest)
  const nextReconnectDigest = parseEdgeStudentDigest(row.nextReconnectDigest)
  const deviceProof = parseEdgeStudentMaintenanceProof(row.deviceProof)
  return requestId !== null && scope !== null && expectedSessionRevision !== null &&
      reconnectGrant !== null && nextCapabilityDigest !== null &&
      nextReconnectDigest !== null && deviceProof !== null
    ? {
      requestId,
      scope,
      expectedSessionRevision,
      reconnectGrant,
      nextCapabilityDigest,
      nextReconnectDigest,
      deviceProof,
    }
    : null
}

/** The configured spelling itself must be canonical before it can be signed. */
export function parseEdgeStudentApiOrigin(
  environment: unknown,
  origin: unknown,
): string | null {
  if (
    (environment !== 'local' && environment !== 'staging') ||
    typeof origin !== 'string'
  ) return null
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return null
  }
  if (
    url.username !== '' || url.password !== '' || url.pathname !== '/' ||
    url.search !== '' || url.hash !== '' || url.origin !== origin
  ) return null
  const isNumericLoopback = url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  const hostname = url.hostname.endsWith('.') ? url.hostname.slice(0, -1) : url.hostname
  const isNumericOrLocalHostname = isNumericLoopback || hostname === 'localhost' ||
    hostname.endsWith('.localhost') || /^[0-9.]+$/u.test(url.hostname) ||
    url.hostname.startsWith('[')
  if (
    (environment === 'local' && (url.protocol !== 'http:' || !isNumericLoopback)) ||
    (environment === 'staging' &&
      (url.protocol !== 'https:' || isNumericOrLocalHostname ||
        (url.port !== '' && url.port !== '443')))
  ) return null
  return origin
}
function canonicalOrigin(value: unknown): string | null {
  return typeof value === 'string'
    ? parseEdgeStudentApiOrigin(value.startsWith('http:') ? 'local' : 'staging', value)
    : null
}

export const EDGE_STUDENT_AUTHORITY_DIGEST_DOMAINS = Object.freeze(
  {
    capability: 'desmoslock/student-capability-digest/v1',
    reconnectGrant: 'desmoslock/student-reconnect-grant-digest/v1',
    joinMaterial: 'desmoslock/student-join-material-digest/v1',
    logicalOperation: 'desmoslock/student-logical-operation-digest/v1',
  } as const,
)
export type EdgeStudentLogicalOperation =
  | {
    readonly kind: 'join'
    readonly admissionMode: EdgeStudentAdmissionMode
    readonly requestId: string
    readonly deviceSessionId: string
    readonly joinMaterialDigest: string
    readonly capabilityDigest: string
    readonly reconnectDigest: string
  }
  | {
    readonly kind: 'reconnect'
    readonly requestId: string
    readonly scope: EdgeStudentSessionScope
    readonly expectedSessionRevision: number
    readonly reconnectDigest: string
    readonly nextCapabilityDigest: string
    readonly nextReconnectDigest: string
  }
  | {
    readonly kind: 'read'
    readonly requestId: string
    readonly scope: EdgeStudentSessionScope
    readonly capabilityDigest: string
  }
  | {
    readonly kind: 'forfeit'
    readonly requestId: string
    readonly scope: EdgeStudentSessionScope
    readonly expectedSessionRevision: number
    readonly capabilityDigest: string
  }
const encoder = new TextEncoder()
function scopeArray(scope: EdgeStudentSessionScope): readonly (string | number)[] {
  return [
    scope.schoolId,
    scope.testId,
    scope.studentSessionId,
    scope.deviceSessionId,
    scope.epoch,
  ]
}
function prefixedBytes(domain: string, value: Uint8Array): Uint8Array {
  const prefix = encoder.encode(domain)
  const result = new Uint8Array(prefix.length + 1 + value.length)
  result.set(prefix)
  result.set(value, prefix.length + 1)
  return result
}
function logicalBytes(array: readonly unknown[]): Uint8Array {
  return prefixedBytes(
    EDGE_STUDENT_AUTHORITY_DIGEST_DOMAINS.logicalOperation,
    encoder.encode(JSON.stringify(array)),
  )
}
function decodeCanonicalBytes(value: string, length: 32 | 64): Uint8Array | null {
  try {
    const padding = length === 32 ? '=' : '=='
    const binary = atob(`${value.replaceAll('-', '+').replaceAll('_', '/')}${padding}`)
    return binary.length === length
      ? Uint8Array.from(binary, (character) => character.charCodeAt(0))
      : null
  } catch {
    return null
  }
}
export function decodeEdgeStudentSecretBytes(value: unknown): Uint8Array | null {
  const secret = parseEdgeStudentSecret(value)
  return secret === null ? null : decodeCanonicalBytes(secret, 32)
}
export function encodeEdgeStudentProofBytes(value: Uint8Array): string | null {
  if (!(value instanceof Uint8Array) || (value.length !== 32 && value.length !== 64)) {
    return null
  }
  let binary = ''
  for (const byte of value) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}
export function encodeEdgeStudentMaterialDigestInput(
  purpose: 'capability' | 'reconnectGrant' | 'joinMaterial',
  value: unknown,
): Uint8Array | null {
  if (purpose === 'joinMaterial') {
    const code = parseEdgeStudentJoinCode(value)
    return code === null ? null : prefixedBytes(
      EDGE_STUDENT_AUTHORITY_DIGEST_DOMAINS.joinMaterial,
      encoder.encode(code),
    )
  }
  if (purpose !== 'capability' && purpose !== 'reconnectGrant') return null
  const bytes = decodeEdgeStudentSecretBytes(value)
  return bytes === null
    ? null
    : prefixedBytes(EDGE_STUDENT_AUTHORITY_DIGEST_DOMAINS[purpose], bytes)
}
export function encodeEdgeStudentLogicalOperation(value: unknown): Uint8Array | null {
  const join = parseEdgeExactRecord(value, [
    'kind',
    'admissionMode',
    'requestId',
    'deviceSessionId',
    'joinMaterialDigest',
    'capabilityDigest',
    'reconnectDigest',
  ])
  if (join !== null && join.kind === 'join') {
    const requestId = parseEdgeStudentUuid(join.requestId)
    const deviceSessionId = parseEdgeStudentUuid(join.deviceSessionId)
    const material = parseEdgeStudentDigest(join.joinMaterialDigest)
    const capability = parseEdgeStudentDigest(join.capabilityDigest)
    const reconnect = parseEdgeStudentDigest(join.reconnectDigest)
    if (
      (join.admissionMode !== 'initial' && join.admissionMode !== 'readmission') ||
      requestId === null || deviceSessionId === null || material === null ||
      capability === null || reconnect === null
    ) return null
    return logicalBytes([
      'join',
      join.admissionMode,
      requestId,
      deviceSessionId,
      material,
      capability,
      reconnect,
    ])
  }
  const reconnect = parseEdgeExactRecord(value, [
    'kind',
    'requestId',
    'scope',
    'expectedSessionRevision',
    'reconnectDigest',
    'nextCapabilityDigest',
    'nextReconnectDigest',
  ])
  if (reconnect !== null && reconnect.kind === 'reconnect') {
    const requestId = parseEdgeStudentUuid(reconnect.requestId)
    const scope = parseEdgeStudentScope(reconnect.scope)
    const revision = parseEdgeStudentCounter(reconnect.expectedSessionRevision)
    const prior = parseEdgeStudentDigest(reconnect.reconnectDigest)
    const capability = parseEdgeStudentDigest(reconnect.nextCapabilityDigest)
    const successor = parseEdgeStudentDigest(reconnect.nextReconnectDigest)
    if (
      requestId === null || scope === null || revision === null || prior === null ||
      capability === null || successor === null
    ) return null
    return logicalBytes([
      'reconnect',
      requestId,
      scopeArray(scope),
      revision,
      prior,
      capability,
      successor,
    ])
  }
  const read = parseEdgeExactRecord(value, ['kind', 'requestId', 'scope', 'capabilityDigest'])
  if (read !== null && read.kind === 'read') {
    const requestId = parseEdgeStudentUuid(read.requestId)
    const scope = parseEdgeStudentScope(read.scope)
    const capability = parseEdgeStudentDigest(read.capabilityDigest)
    return requestId === null || scope === null || capability === null
      ? null
      : logicalBytes(['read', requestId, scopeArray(scope), capability])
  }
  const forfeit = parseEdgeExactRecord(value, [
    'kind',
    'requestId',
    'scope',
    'capabilityDigest',
    'expectedSessionRevision',
  ])
  if (forfeit !== null && forfeit.kind === 'forfeit') {
    const requestId = parseEdgeStudentUuid(forfeit.requestId)
    const scope = parseEdgeStudentScope(forfeit.scope)
    const revision = parseEdgeStudentCounter(forfeit.expectedSessionRevision)
    const capability = parseEdgeStudentDigest(forfeit.capabilityDigest)
    return requestId === null || scope === null || revision === null || capability === null
      ? null
      : logicalBytes(['forfeit', requestId, scopeArray(scope), revision, capability])
  }
  return null
}
export function encodeEdgeStudentProofEnvelope(value: unknown): Uint8Array | null {
  const bootstrap = parseEdgeExactRecord(value, [
    'kind',
    'apiOrigin',
    'requestId',
    'deviceSessionId',
    'keyThumbprint',
    'logicalOperationDigest',
    'challengeId',
    'expiresAtMs',
  ])
  if (bootstrap !== null && bootstrap.kind === 'bootstrap') {
    const origin = canonicalOrigin(bootstrap.apiOrigin)
    const requestId = parseEdgeStudentUuid(bootstrap.requestId)
    const deviceSessionId = parseEdgeStudentUuid(bootstrap.deviceSessionId)
    const key = parseEdgeStudentPublicKey(bootstrap.keyThumbprint)
    const digest = parseEdgeStudentDigest(bootstrap.logicalOperationDigest)
    const challengeId = parseEdgeStudentUuid(bootstrap.challengeId)
    const expiry = parseEdgeStudentCounter(bootstrap.expiresAtMs)
    if (
      origin === null || requestId === null || deviceSessionId === null || key === null ||
      digest === null || challengeId === null || expiry === null
    ) return null
    return encoder.encode(JSON.stringify([
      'desmoslock/student-device-proof/v1',
      origin,
      'join',
      requestId,
      deviceSessionId,
      key,
      digest,
      challengeId,
      expiry,
    ]))
  }
  const maintenance = parseEdgeExactRecord(value, [
    'kind',
    'apiOrigin',
    'operation',
    'requestId',
    'scope',
    'keyThumbprint',
    'logicalOperationDigest',
    'counter',
  ])
  if (
    maintenance === null || maintenance.kind !== 'maintenance' ||
    (maintenance.operation !== 'read' && maintenance.operation !== 'reconnect' &&
      maintenance.operation !== 'forfeit')
  ) return null
  const origin = canonicalOrigin(maintenance.apiOrigin)
  const requestId = parseEdgeStudentUuid(maintenance.requestId)
  const scope = parseEdgeStudentScope(maintenance.scope)
  const key = parseEdgeStudentPublicKey(maintenance.keyThumbprint)
  const digest = parseEdgeStudentDigest(maintenance.logicalOperationDigest)
  const counter = parseEdgeStudentCounter(maintenance.counter)
  if (
    origin === null || requestId === null || scope === null || key === null ||
    digest === null || counter === null
  ) return null
  return encoder.encode(JSON.stringify([
    'desmoslock/student-maintenance-proof/v1',
    origin,
    maintenance.operation,
    requestId,
    scopeArray(scope),
    key,
    digest,
    counter,
  ]))
}

async function sha256(bytes: Uint8Array | null): Promise<Uint8Array | null> {
  if (bytes === null) return null
  try {
    return new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)))
  } catch {
    throw new Error('Student proof cryptography is unavailable')
  }
}
async function hexDigest(bytes: Uint8Array | null): Promise<string | null> {
  const digest = await sha256(bytes)
  return digest === null
    ? null
    : Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
}
export function edgeStudentMaterialDigest(
  purpose: 'capability' | 'reconnectGrant' | 'joinMaterial',
  value: unknown,
): Promise<string | null> {
  return hexDigest(encodeEdgeStudentMaterialDigestInput(purpose, value))
}
export function edgeStudentLogicalOperationDigest(operation: unknown): Promise<string | null> {
  return hexDigest(encodeEdgeStudentLogicalOperation(operation))
}
/** Selected thumbprint: SHA-256 of raw Ed25519 public-key bytes, not JWK JSON. */
export async function edgeStudentKeyThumbprint(publicKey: unknown): Promise<string | null> {
  const digest = await sha256(decodeEdgeStudentSecretBytes(publicKey))
  return digest === null ? null : encodeEdgeStudentProofBytes(digest)
}
async function verifySignature(
  publicKey: string,
  signature: string,
  envelope: Uint8Array | null,
): Promise<boolean> {
  const keyBytes = decodeEdgeStudentSecretBytes(publicKey)
  const parsedSignature = parseEdgeStudentSignature(signature)
  const signatureBytes = parsedSignature === null ? null : decodeCanonicalBytes(parsedSignature, 64)
  if (keyBytes === null || signatureBytes === null || envelope === null) return false
  let key: CryptoKey
  try {
    key = await crypto.subtle.importKey(
      'raw',
      new Uint8Array(keyBytes),
      'Ed25519',
      false,
      ['verify'],
    )
  } catch (error) {
    // A malformed raw key is caller input; an unavailable algorithm or runtime
    // is a dependency failure, which the service maps to its fixed 503 body.
    if (error instanceof DOMException && error.name === 'DataError') return false
    throw new Error('Student proof cryptography is unavailable')
  }
  try {
    return await crypto.subtle.verify(
      'Ed25519',
      key,
      new Uint8Array(signatureBytes),
      new Uint8Array(envelope),
    )
  } catch {
    throw new Error('Student proof cryptography is unavailable')
  }
}

/** Crypto binds an immutable request snapshot; SQL owns expiry and consumption. */
export async function verifyEdgeStudentBootstrapProof(
  apiOrigin: unknown,
  request: unknown,
  logicalOperationDigest: unknown,
): Promise<boolean> {
  const input = parseEdgeStudentJoinRequest(request)
  const origin = canonicalOrigin(apiOrigin)
  const digest = parseEdgeStudentDigest(logicalOperationDigest)
  if (input === null || origin === null || digest === null) return false
  const material = await edgeStudentMaterialDigest('joinMaterial', input.joinCode)
  const actualDigest = await edgeStudentLogicalOperationDigest({
    kind: 'join',
    admissionMode: input.admissionMode,
    requestId: input.requestId,
    deviceSessionId: input.deviceSessionId,
    joinMaterialDigest: material,
    capabilityDigest: input.capabilityDigest,
    reconnectDigest: input.reconnectDigest,
  })
  if (actualDigest !== digest) return false
  const keyThumbprint = await edgeStudentKeyThumbprint(input.deviceProof.publicKey)
  return verifySignature(
    input.deviceProof.publicKey,
    input.deviceProof.signature,
    encodeEdgeStudentProofEnvelope({
      kind: 'bootstrap',
      apiOrigin: origin,
      requestId: input.requestId,
      deviceSessionId: input.deviceSessionId,
      keyThumbprint,
      logicalOperationDigest: digest,
      challengeId: input.deviceProof.challengeId,
      expiresAtMs: input.deviceProof.expiresAtMs,
    }),
  )
}

export async function verifyEdgeStudentMaintenanceProof(
  apiOrigin: unknown,
  operation: EdgeStudentMaintenanceOperation,
  request: unknown,
  storedPublicKey: unknown,
  logicalOperationDigest: unknown,
): Promise<boolean> {
  const origin = canonicalOrigin(apiOrigin)
  const publicKey = parseEdgeStudentPublicKey(storedPublicKey)
  const digest = parseEdgeStudentDigest(logicalOperationDigest)
  if (origin === null || publicKey === null || digest === null) return false
  let input: EdgeStudentReadRequest | EdgeStudentReconnectRequest | EdgeStudentForfeitRequest
  let logical: EdgeStudentLogicalOperation
  if (operation === 'reconnect') {
    const reconnect = parseEdgeStudentReconnectRequest(request)
    if (reconnect === null) return false
    input = reconnect
    const prior = await edgeStudentMaterialDigest('reconnectGrant', reconnect.reconnectGrant)
    if (prior === null) return false
    logical = {
      kind: 'reconnect',
      requestId: reconnect.requestId,
      scope: reconnect.scope,
      expectedSessionRevision: reconnect.expectedSessionRevision,
      reconnectDigest: prior,
      nextCapabilityDigest: reconnect.nextCapabilityDigest,
      nextReconnectDigest: reconnect.nextReconnectDigest,
    }
  } else if (operation === 'read') {
    const read = parseEdgeStudentReadRequest(request)
    if (read === null) return false
    input = read
    const capability = await edgeStudentMaterialDigest('capability', read.capabilityToken)
    if (capability === null) return false
    logical = {
      kind: 'read',
      requestId: read.requestId,
      scope: read.scope,
      capabilityDigest: capability,
    }
  } else if (operation === 'forfeit') {
    const forfeit = parseEdgeStudentForfeitRequest(request)
    if (forfeit === null) return false
    input = forfeit
    const capability = await edgeStudentMaterialDigest('capability', forfeit.capabilityToken)
    if (capability === null) return false
    logical = {
      kind: 'forfeit',
      requestId: forfeit.requestId,
      scope: forfeit.scope,
      expectedSessionRevision: forfeit.expectedSessionRevision,
      capabilityDigest: capability,
    }
  } else {
    return false
  }
  if (await edgeStudentLogicalOperationDigest(logical) !== digest) return false
  const keyThumbprint = await edgeStudentKeyThumbprint(publicKey)
  return verifySignature(
    publicKey,
    input.deviceProof.signature,
    encodeEdgeStudentProofEnvelope({
      kind: 'maintenance',
      apiOrigin: origin,
      operation,
      requestId: input.requestId,
      scope: input.scope,
      keyThumbprint,
      logicalOperationDigest: digest,
      counter: input.deviceProof.counter,
    }),
  )
}
