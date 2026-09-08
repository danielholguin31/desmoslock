import { createSupabaseHttpClient, type ServiceFetch } from './supabase-http.ts'
import {
  type EdgeStudentChallengeRequest,
  type EdgeStudentForfeitRequest,
  type EdgeStudentJoinRequest,
  edgeStudentKeyThumbprint,
  edgeStudentLogicalOperationDigest,
  edgeStudentMaterialDigest,
  type EdgeStudentReadRequest,
  type EdgeStudentReconnectRequest,
  type EdgeStudentSessionScope,
  parseEdgeExactArray,
  parseEdgeExactRecord,
  parseEdgeStudentApiOrigin,
  parseEdgeStudentChallengeRequest,
  parseEdgeStudentCounter,
  parseEdgeStudentDigest,
  parseEdgeStudentForfeitRequest,
  parseEdgeStudentJoinRequest,
  parseEdgeStudentPublicKey,
  parseEdgeStudentReadRequest,
  parseEdgeStudentReconnectRequest,
  parseEdgeStudentScope,
  parseEdgeStudentUuid,
  verifyEdgeStudentBootstrapProof,
  verifyEdgeStudentMaintenanceProof,
} from './student-session-proof.ts'

export const STUDENT_SESSION_MAX_BODY_BYTES = 8_192
export const STUDENT_SESSION_REQUEST_TIMEOUT_MS = 5_000

export interface StudentScopeRpcInput {
  readonly school_id: string
  readonly test_id: string
  readonly student_session_id: string
  readonly device_session_id: string
  readonly epoch: number
}
export interface StudentChallengeRpcInput {
  readonly request_id: string
  readonly device_session_id: string
  readonly public_key: string
  readonly key_thumbprint: string
  readonly logical_operation_digest: string
}
export interface StudentJoinAttemptRpcInput {
  readonly key_thumbprint: string
}
export interface StudentJoinRpcInput {
  readonly admission_mode: 'initial' | 'readmission'
  readonly request_id: string
  readonly device_session_id: string
  readonly verified_public_key: string
  readonly key_thumbprint: string
  readonly join_material_digest: string
  readonly capability_digest: string
  readonly reconnect_digest: string
  readonly logical_operation_digest: string
  readonly challenge_id: string
  readonly challenge_expires_at: number
}
export interface StudentMaintenanceKeyRpcInput extends StudentScopeRpcInput {
  readonly operation: 'read' | 'reconnect' | 'forfeit'
  readonly request_id: string
  readonly logical_operation_digest: string
  readonly credential_digest: string
}
export interface StudentReadRpcInput extends StudentScopeRpcInput {
  readonly request_id: string
  readonly logical_operation_digest: string
  readonly capability_digest: string
  readonly verified_public_key: string
  readonly proof_counter: number
}
export interface StudentReconnectRpcInput extends StudentScopeRpcInput {
  readonly request_id: string
  readonly logical_operation_digest: string
  readonly expected_session_revision: number
  readonly reconnect_digest: string
  readonly next_capability_digest: string
  readonly next_reconnect_digest: string
  readonly verified_public_key: string
  readonly proof_counter: number
}
export interface StudentForfeitRpcInput extends StudentReadRpcInput {
  readonly expected_session_revision: number
}
export interface StudentSessionDependencies {
  readonly apiOrigin: string
  createBootstrapChallenge(input: StudentChallengeRpcInput, signal: AbortSignal): Promise<unknown>
  chargeJoinAttempt(input: StudentJoinAttemptRpcInput, signal: AbortSignal): Promise<unknown>
  commitJoin(input: StudentJoinRpcInput, signal: AbortSignal): Promise<unknown>
  readMaintenanceKey(input: StudentMaintenanceKeyRpcInput, signal: AbortSignal): Promise<unknown>
  commitRead(input: StudentReadRpcInput, signal: AbortSignal): Promise<unknown>
  commitReconnect(input: StudentReconnectRpcInput, signal: AbortSignal): Promise<unknown>
  commitForfeit(input: StudentForfeitRpcInput, signal: AbortSignal): Promise<unknown>
}

type StudentRoute = 'challenge' | 'join' | 'read' | 'reconnect' | 'forfeit'
type MaintenanceRequest =
  | EdgeStudentReadRequest
  | EdgeStudentReconnectRequest
  | EdgeStudentForfeitRequest
interface Denied {
  readonly status: 'denied'
  readonly code: 'STUDENT_SESSION_DENIED'
}
interface Issuance {
  readonly status: 'accepted'
  readonly code: 'STUDENT_SESSION_ACCEPTED'
  readonly requestId: string
  readonly logicalOperationDigest: string
  readonly scope: EdgeStudentSessionScope
  readonly sessionRevision: number
  readonly syntheticDisplayName: string
  readonly serverNowMs: number
  readonly capabilityIssuedAtMs: number
  readonly capabilityExpiresAtMs: number
  readonly reconnectExpiresAtMs: number
  readonly allowedIntents: readonly ['state.read', 'session.forfeit']
}
interface Current {
  readonly status: 'accepted'
  readonly code: 'STUDENT_SESSION_CURRENT'
  readonly requestId: string
  readonly acceptedProofCounter: number
  readonly scope: EdgeStudentSessionScope
  readonly sessionRevision: number
  readonly syntheticDisplayName: string
  readonly testLifecycle: 'open'
  readonly state: 'active'
  readonly serverNowMs: number
  readonly capabilityExpiresAtMs: number
}
type PublicResult =
  | Denied
  | Issuance
  | Current
  | (Issuance & { readonly acceptedProofCounter: number })
  | { readonly challengeId: string; readonly expiresAtMs: number }
  | {
    readonly status: 'accepted'
    readonly code: 'STUDENT_SESSION_FORFEITED'
    readonly requestId: string
    readonly acceptedProofCounter: number
  }

const denied: Denied = Object.freeze({ status: 'denied', code: 'STUDENT_SESSION_DENIED' })
const unavailable = Object.freeze({ status: 'unavailable', code: 'STUDENT_SESSION_UNAVAILABLE' })
// A shared bounded bootstrap bucket for malformed input lacking a usable key.
// It is never used for, or allocated in, admitted maintenance accounting.
const malformedBootstrapThumbprint = 'A'.repeat(43)
const scopeKeys = [
  'school_id',
  'test_id',
  'student_session_id',
  'device_session_id',
  'epoch',
] as const
const challengeInputKeys = [
  'request_id',
  'device_session_id',
  'public_key',
  'key_thumbprint',
  'logical_operation_digest',
] as const
const joinInputKeys = [
  'admission_mode',
  'request_id',
  'device_session_id',
  'verified_public_key',
  'key_thumbprint',
  'join_material_digest',
  'capability_digest',
  'reconnect_digest',
  'logical_operation_digest',
  'challenge_id',
  'challenge_expires_at',
] as const
const keyInputKeys = [
  ...scopeKeys,
  'operation',
  'request_id',
  'logical_operation_digest',
  'credential_digest',
] as const
const readInputKeys = [
  ...scopeKeys,
  'request_id',
  'logical_operation_digest',
  'capability_digest',
  'verified_public_key',
  'proof_counter',
] as const
const reconnectInputKeys = [
  ...scopeKeys,
  'request_id',
  'logical_operation_digest',
  'expected_session_revision',
  'reconnect_digest',
  'next_capability_digest',
  'next_reconnect_digest',
  'verified_public_key',
  'proof_counter',
] as const
const forfeitInputKeys = [...readInputKeys, 'expected_session_revision'] as const
const issuanceKeys = [
  'code',
  'request_id',
  'logical_operation_digest',
  'school_id',
  'test_id',
  'student_session_id',
  'device_session_id',
  'epoch',
  'session_revision',
  'synthetic_display_name',
  'server_now_ms',
  'capability_issued_at_ms',
  'capability_expires_at_ms',
  'reconnect_expires_at_ms',
  'accepted_proof_counter',
] as const
const currentKeys = [
  'code',
  'request_id',
  'accepted_proof_counter',
  'school_id',
  'test_id',
  'student_session_id',
  'device_session_id',
  'epoch',
  'session_revision',
  'synthetic_display_name',
  'server_now_ms',
  'capability_expires_at_ms',
] as const

class InvalidBody extends Error {}
class BodyTooLarge extends Error {}
class DependencyUnavailable extends Error {}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DependencyUnavailable()
}
function parseRpcInput(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  const row = parseEdgeExactRecord(value, keys)
  if (row === null) return null
  for (const key of keys) {
    const field = row[key]
    const valid = key === 'admission_mode'
      ? field === 'initial' || field === 'readmission'
      : key === 'operation'
      ? field === 'read' || field === 'reconnect' || field === 'forfeit'
      : ['epoch', 'proof_counter', 'expected_session_revision', 'challenge_expires_at'].includes(
          key,
        )
      ? parseEdgeStudentCounter(field) !== null
      : ['public_key', 'verified_public_key', 'key_thumbprint'].includes(key)
      ? parseEdgeStudentPublicKey(field) !== null
      : key.endsWith('_digest')
      ? parseEdgeStudentDigest(field) !== null
      : parseEdgeStudentUuid(field) !== null
    if (!valid) return null
  }
  return row
}

/** One fixed purpose-specific client; neither routes nor public callers select RPC names. */
export function createStudentSessionDependencies(
  configuration: unknown,
  serviceFetch: ServiceFetch = globalThis.fetch,
): StudentSessionDependencies {
  const row = parseEdgeExactRecord(configuration, [
    'DESMOSLOCK_PUBLIC_BACKEND_ENVIRONMENT',
    'DESMOSLOCK_PUBLIC_BACKEND_URL',
    'DESMOSLOCK_EXPECTED_SUPABASE_ORIGIN',
    'SUPABASE_SERVICE_ROLE_KEY',
    'SUPABASE_URL',
  ])
  if (row === null) throw new DependencyUnavailable()
  const apiOrigin = parseEdgeStudentApiOrigin(
    row.DESMOSLOCK_PUBLIC_BACKEND_ENVIRONMENT,
    row.DESMOSLOCK_PUBLIC_BACKEND_URL,
  )
  const serviceRoleKey = row.SUPABASE_SERVICE_ROLE_KEY
  const supabaseUrl = row.SUPABASE_URL
  const expectedOrigin = row.DESMOSLOCK_EXPECTED_SUPABASE_ORIGIN
  if (
    apiOrigin === null || typeof serviceRoleKey !== 'string' || typeof supabaseUrl !== 'string' ||
    (expectedOrigin !== undefined && typeof expectedOrigin !== 'string')
  ) throw new DependencyUnavailable()
  const client = createSupabaseHttpClient({
    expectedOrigin,
    publishableKey: serviceRoleKey,
    serviceRoleKey,
    supabaseUrl,
  }, serviceFetch)
  const rpc = async (
    name: string,
    value: unknown,
    keys: readonly string[],
    signal: AbortSignal,
  ): Promise<unknown> => {
    throwIfAborted(signal)
    const input = parseRpcInput(value, keys)
    if (input === null) throw new DependencyUnavailable()
    const body = JSON.stringify(input)
    if (new TextEncoder().encode(body).byteLength > STUDENT_SESSION_MAX_BODY_BYTES) {
      throw new DependencyUnavailable()
    }
    const response = await client.request(`/rest/v1/rpc/${name}`, {
      method: 'POST',
      cache: 'no-store',
      credentials: 'omit',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'content-profile': 'desmoslock_v2',
        'accept-profile': 'desmoslock_v2',
        apikey: serviceRoleKey,
        authorization: `Bearer ${serviceRoleKey}`,
      },
      body,
      signal,
    })
    throwIfAborted(signal)
    if (response.status !== 200 || response.redirected) {
      void response.body?.cancel().catch(() => undefined)
      throw new DependencyUnavailable()
    }
    return await readBoundedJson(response, signal, false)
  }
  return {
    apiOrigin,
    createBootstrapChallenge: (input, signal) =>
      rpc('create_student_bootstrap_challenge', input, challengeInputKeys, signal),
    chargeJoinAttempt: (input, signal) =>
      rpc('charge_student_join_attempt', input, ['key_thumbprint'], signal),
    commitJoin: (input, signal) => rpc('commit_student_session_join', input, joinInputKeys, signal),
    readMaintenanceKey: (input, signal) =>
      rpc('read_student_maintenance_key', input, keyInputKeys, signal),
    commitRead: (input, signal) => rpc('commit_student_session_read', input, readInputKeys, signal),
    commitReconnect: (input, signal) =>
      rpc('commit_student_session_reconnect', input, reconnectInputKeys, signal),
    commitForfeit: (input, signal) =>
      rpc('commit_student_session_forfeit', input, forfeitInputKeys, signal),
  }
}

function configuredDependencies(): StudentSessionDependencies {
  return createStudentSessionDependencies({
    DESMOSLOCK_PUBLIC_BACKEND_ENVIRONMENT: Deno.env.get('DESMOSLOCK_PUBLIC_BACKEND_ENVIRONMENT'),
    DESMOSLOCK_PUBLIC_BACKEND_URL: Deno.env.get('DESMOSLOCK_PUBLIC_BACKEND_URL'),
    DESMOSLOCK_EXPECTED_SUPABASE_ORIGIN: Deno.env.get('DESMOSLOCK_EXPECTED_SUPABASE_ORIGIN'),
    SUPABASE_SERVICE_ROLE_KEY: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    SUPABASE_URL: Deno.env.get('SUPABASE_URL'),
  })
}

async function readBoundedJson(
  message: Request | Response,
  signal: AbortSignal,
  publicRequest: boolean,
): Promise<unknown> {
  const fail = () => publicRequest ? new InvalidBody() : new DependencyUnavailable()
  const rejectBody = (error: Error): never => {
    void message.body?.cancel().catch(() => undefined)
    throw error
  }
  const contentType = message.headers.get('content-type')
  if (
    (contentType !== 'application/json' && contentType !== 'application/json; charset=utf-8') ||
    message.headers.has('content-encoding')
  ) return rejectBody(fail())
  const announced = message.headers.get('content-length')
  if (announced !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(announced) || !Number.isSafeInteger(Number(announced))) {
      return rejectBody(fail())
    }
    if (Number(announced) > STUDENT_SESSION_MAX_BODY_BYTES) {
      return rejectBody(publicRequest ? new BodyTooLarge() : new DependencyUnavailable())
    }
  }
  throwIfAborted(signal)
  if (message.body === null) throw fail()
  const reader = message.body.getReader()
  const abort = () => {
    void reader.cancel().catch(() => undefined)
  }
  signal.addEventListener('abort', abort, { once: true })
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      throwIfAborted(signal)
      const result = await reader.read()
      throwIfAborted(signal)
      if (result.done) break
      size += result.value.byteLength
      if (size > STUDENT_SESSION_MAX_BODY_BYTES) {
        void reader.cancel().catch(() => undefined)
        throw publicRequest ? new BodyTooLarge() : new DependencyUnavailable()
      }
      chunks.push(result.value)
    }
    if (size === 0 || (announced !== null && Number(announced) !== size)) throw fail()
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    let body: unknown
    try {
      body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    } catch {
      throw fail()
    }
    return body
  } finally {
    signal.removeEventListener('abort', abort)
    reader.releaseLock()
  }
}

function oneSqlRow(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const rows = parseEdgeExactArray(value, 1)
  const row = rows !== null && rows.length === 1 ? parseEdgeExactRecord(rows[0], keys) : null
  if (row === null) throw new DependencyUnavailable()
  if (
    row.code !== 'ok' &&
    (row.code !== 'student_session_denied' ||
      !keys.every((key) => key === 'code' || row[key] === null))
  ) throw new DependencyUnavailable()
  return row
}
function milliseconds(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 &&
      !Object.is(value, -0)
    ? value
    : null
}
function displayName(value: unknown): string | null {
  return typeof value === 'string' &&
      /^Student [A-Z0-9][A-Z0-9-]{1,23}$/u.exec(value)?.[0] === value
    ? value
    : null
}
function sqlScope(row: Record<string, unknown>): EdgeStudentSessionScope | null {
  return parseEdgeStudentScope({
    schoolId: row.school_id,
    testId: row.test_id,
    studentSessionId: row.student_session_id,
    deviceSessionId: row.device_session_id,
    epoch: row.epoch,
  })
}
function scopeInput(scope: EdgeStudentSessionScope): StudentScopeRpcInput {
  return {
    school_id: scope.schoolId,
    test_id: scope.testId,
    student_session_id: scope.studentSessionId,
    device_session_id: scope.deviceSessionId,
    epoch: scope.epoch,
  }
}
function sameScope(left: EdgeStudentSessionScope, right: EdgeStudentSessionScope): boolean {
  return left.schoolId === right.schoolId && left.testId === right.testId &&
    left.studentSessionId === right.studentSessionId &&
    left.deviceSessionId === right.deviceSessionId && left.epoch === right.epoch
}
function ownDataField(value: unknown, key: string): unknown {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return undefined
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor !== undefined && 'value' in descriptor && descriptor.enumerable
      ? descriptor.value
      : undefined
  } catch {
    return undefined
  }
}
async function chargeMalformedBootstrap(
  route: 'challenge' | 'join',
  body: unknown,
  dependencies: StudentSessionDependencies,
  signal: AbortSignal,
): Promise<void> {
  const candidate = route === 'challenge'
    ? ownDataField(body, 'publicKey')
    : ownDataField(ownDataField(body, 'deviceProof'), 'publicKey')
  const publicKey = parseEdgeStudentPublicKey(candidate)
  const thumbprint = publicKey === null
    ? malformedBootstrapThumbprint
    : await edgeStudentKeyThumbprint(publicKey)
  if (thumbprint === null) throw new DependencyUnavailable()
  throwIfAborted(signal)
  oneSqlRow(await dependencies.chargeJoinAttempt({ key_thumbprint: thumbprint }, signal), ['code'])
}
function issuance(
  row: Record<string, unknown>,
  input: EdgeStudentJoinRequest | EdgeStudentReconnectRequest,
  digest: string,
): Issuance {
  const scope = sqlScope(row)
  const sessionRevision = parseEdgeStudentCounter(row.session_revision)
  const syntheticDisplayName = displayName(row.synthetic_display_name)
  const serverNowMs = milliseconds(row.server_now_ms)
  const capabilityIssuedAtMs = milliseconds(row.capability_issued_at_ms)
  const capabilityExpiresAtMs = milliseconds(row.capability_expires_at_ms)
  const reconnectExpiresAtMs = milliseconds(row.reconnect_expires_at_ms)
  if (
    row.request_id !== input.requestId || row.logical_operation_digest !== digest ||
    scope === null || sessionRevision === null || syntheticDisplayName === null ||
    serverNowMs === null || capabilityIssuedAtMs === null || capabilityExpiresAtMs === null ||
    reconnectExpiresAtMs === null
  ) throw new DependencyUnavailable()
  if (
    capabilityIssuedAtMs > serverNowMs || capabilityExpiresAtMs <= capabilityIssuedAtMs ||
    capabilityExpiresAtMs - capabilityIssuedAtMs > 300_000 ||
    reconnectExpiresAtMs < capabilityExpiresAtMs ||
    reconnectExpiresAtMs - capabilityIssuedAtMs > 900_000 || reconnectExpiresAtMs <= serverNowMs
  ) throw new DependencyUnavailable()
  if ('admissionMode' in input) {
    if (
      row.accepted_proof_counter !== null || scope.deviceSessionId !== input.deviceSessionId ||
      (input.admissionMode === 'initial'
        ? scope.epoch !== 1 || sessionRevision !== 1
        : scope.epoch < 2 || sessionRevision < 3)
    ) throw new DependencyUnavailable()
  } else if (
    !sameScope(scope, input.scope) || input.expectedSessionRevision === Number.MAX_SAFE_INTEGER ||
    sessionRevision !== input.expectedSessionRevision + 1 ||
    row.accepted_proof_counter !== input.deviceProof.counter
  ) throw new DependencyUnavailable()
  return {
    status: 'accepted',
    code: 'STUDENT_SESSION_ACCEPTED',
    requestId: input.requestId,
    logicalOperationDigest: digest,
    scope,
    sessionRevision,
    syntheticDisplayName,
    serverNowMs,
    capabilityIssuedAtMs,
    capabilityExpiresAtMs,
    reconnectExpiresAtMs,
    allowedIntents: ['state.read', 'session.forfeit'],
  }
}

async function challenge(
  input: EdgeStudentChallengeRequest,
  dependencies: StudentSessionDependencies,
  signal: AbortSignal,
): Promise<PublicResult> {
  const keyThumbprint = await edgeStudentKeyThumbprint(input.publicKey)
  if (keyThumbprint === null) return denied
  throwIfAborted(signal)
  const row = oneSqlRow(
    await dependencies.createBootstrapChallenge({
      request_id: input.requestId,
      device_session_id: input.deviceSessionId,
      public_key: input.publicKey,
      key_thumbprint: keyThumbprint,
      logical_operation_digest: input.logicalOperationDigest,
    }, signal),
    ['code', 'challenge_id', 'expires_at_ms'],
  )
  if (row.code !== 'ok') return denied
  const challengeId = parseEdgeStudentUuid(row.challenge_id)
  const expiresAtMs = parseEdgeStudentCounter(row.expires_at_ms)
  if (challengeId === null || expiresAtMs === null) throw new DependencyUnavailable()
  return { challengeId, expiresAtMs }
}
async function join(
  input: EdgeStudentJoinRequest,
  dependencies: StudentSessionDependencies,
  signal: AbortSignal,
): Promise<PublicResult> {
  const keyThumbprint = await edgeStudentKeyThumbprint(input.deviceProof.publicKey)
  if (keyThumbprint === null) return denied
  throwIfAborted(signal)
  const charged = oneSqlRow(
    await dependencies.chargeJoinAttempt({ key_thumbprint: keyThumbprint }, signal),
    ['code'],
  )
  if (charged.code !== 'ok') return denied
  const material = await edgeStudentMaterialDigest('joinMaterial', input.joinCode)
  if (material === null) return denied
  const digest = await edgeStudentLogicalOperationDigest({
    kind: 'join',
    admissionMode: input.admissionMode,
    requestId: input.requestId,
    deviceSessionId: input.deviceSessionId,
    joinMaterialDigest: material,
    capabilityDigest: input.capabilityDigest,
    reconnectDigest: input.reconnectDigest,
  })
  if (
    digest === null || !await verifyEdgeStudentBootstrapProof(dependencies.apiOrigin, input, digest)
  ) return denied
  throwIfAborted(signal)
  const row = oneSqlRow(
    await dependencies.commitJoin({
      admission_mode: input.admissionMode,
      request_id: input.requestId,
      device_session_id: input.deviceSessionId,
      verified_public_key: input.deviceProof.publicKey,
      key_thumbprint: keyThumbprint,
      join_material_digest: material,
      capability_digest: input.capabilityDigest,
      reconnect_digest: input.reconnectDigest,
      logical_operation_digest: digest,
      challenge_id: input.deviceProof.challengeId,
      challenge_expires_at: input.deviceProof.expiresAtMs,
    }, signal),
    issuanceKeys,
  )
  return row.code === 'ok' ? issuance(row, input, digest) : denied
}
async function maintenance(
  operation: 'read' | 'reconnect' | 'forfeit',
  input: MaintenanceRequest,
  dependencies: StudentSessionDependencies,
  signal: AbortSignal,
): Promise<PublicResult> {
  const reconnecting = operation === 'reconnect' && 'reconnectGrant' in input ? input : null
  const forfeiting =
    operation === 'forfeit' && 'capabilityToken' in input && 'expectedSessionRevision' in input
      ? input
      : null
  const reading = operation === 'read' && 'capabilityToken' in input ? input : null
  const credential = reconnecting !== null
    ? await edgeStudentMaterialDigest('reconnectGrant', reconnecting.reconnectGrant)
    : 'capabilityToken' in input
    ? await edgeStudentMaterialDigest('capability', input.capabilityToken)
    : null
  if (credential === null) return denied
  const logical = reconnecting !== null
    ? {
      kind: 'reconnect',
      requestId: input.requestId,
      scope: input.scope,
      expectedSessionRevision: reconnecting.expectedSessionRevision,
      reconnectDigest: credential,
      nextCapabilityDigest: reconnecting.nextCapabilityDigest,
      nextReconnectDigest: reconnecting.nextReconnectDigest,
    }
    : forfeiting !== null
    ? {
      kind: 'forfeit',
      requestId: input.requestId,
      scope: input.scope,
      expectedSessionRevision: forfeiting.expectedSessionRevision,
      capabilityDigest: credential,
    }
    : reading !== null
    ? { kind: 'read', requestId: input.requestId, scope: input.scope, capabilityDigest: credential }
    : null
  const digest = await edgeStudentLogicalOperationDigest(logical)
  if (digest === null) return denied
  throwIfAborted(signal)
  const keyRow = oneSqlRow(
    await dependencies.readMaintenanceKey({
      ...scopeInput(input.scope),
      operation,
      request_id: input.requestId,
      logical_operation_digest: digest,
      credential_digest: credential,
    }, signal),
    ['code', 'public_key'],
  )
  if (keyRow.code !== 'ok') return denied
  const storedKey = parseEdgeStudentPublicKey(keyRow.public_key)
  if (storedKey === null) throw new DependencyUnavailable()
  if (
    !await verifyEdgeStudentMaintenanceProof(
      dependencies.apiOrigin,
      operation,
      input,
      storedKey,
      digest,
    )
  ) return denied
  throwIfAborted(signal)
  const base = {
    ...scopeInput(input.scope),
    request_id: input.requestId,
    logical_operation_digest: digest,
    verified_public_key: storedKey,
    proof_counter: input.deviceProof.counter,
  }
  if (reconnecting !== null) {
    const row = oneSqlRow(
      await dependencies.commitReconnect({
        ...base,
        expected_session_revision: reconnecting.expectedSessionRevision,
        reconnect_digest: credential,
        next_capability_digest: reconnecting.nextCapabilityDigest,
        next_reconnect_digest: reconnecting.nextReconnectDigest,
      }, signal),
      issuanceKeys,
    )
    return row.code === 'ok'
      ? { ...issuance(row, reconnecting, digest), acceptedProofCounter: input.deviceProof.counter }
      : denied
  }
  if (forfeiting !== null) {
    const row = oneSqlRow(
      await dependencies.commitForfeit({
        ...base,
        expected_session_revision: forfeiting.expectedSessionRevision,
        capability_digest: credential,
      }, signal),
      ['code', 'request_id', 'accepted_proof_counter'],
    )
    if (row.code !== 'ok') return denied
    if (
      row.request_id !== input.requestId ||
      row.accepted_proof_counter !== input.deviceProof.counter ||
      input.scope.epoch === Number.MAX_SAFE_INTEGER ||
      forfeiting.expectedSessionRevision === Number.MAX_SAFE_INTEGER
    ) throw new DependencyUnavailable()
    return {
      status: 'accepted',
      code: 'STUDENT_SESSION_FORFEITED',
      requestId: input.requestId,
      acceptedProofCounter: input.deviceProof.counter,
    }
  }
  if (reading === null) return denied
  const row = oneSqlRow(
    await dependencies.commitRead({ ...base, capability_digest: credential }, signal),
    currentKeys,
  )
  if (row.code !== 'ok') return denied
  const scope = sqlScope(row)
  const sessionRevision = parseEdgeStudentCounter(row.session_revision)
  const syntheticDisplayName = displayName(row.synthetic_display_name)
  const serverNowMs = milliseconds(row.server_now_ms)
  const capabilityExpiresAtMs = milliseconds(row.capability_expires_at_ms)
  if (
    row.request_id !== input.requestId ||
    row.accepted_proof_counter !== input.deviceProof.counter || scope === null ||
    !sameScope(scope, input.scope) || sessionRevision === null || syntheticDisplayName === null ||
    serverNowMs === null || capabilityExpiresAtMs === null ||
    capabilityExpiresAtMs <= serverNowMs || capabilityExpiresAtMs - serverNowMs > 300_000
  ) throw new DependencyUnavailable()
  return {
    status: 'accepted',
    code: 'STUDENT_SESSION_CURRENT',
    requestId: input.requestId,
    acceptedProofCounter: input.deviceProof.counter,
    scope,
    sessionRevision,
    syntheticDisplayName,
    testLifecycle: 'open',
    state: 'active',
    serverNowMs,
    capabilityExpiresAtMs,
  }
}

function response(body: PublicResult | typeof unavailable, status: number): Response {
  const json = JSON.stringify(body)
  if (new TextEncoder().encode(json).byteLength > STUDENT_SESSION_MAX_BODY_BYTES) {
    return response(unavailable, 503)
  }
  return new Response(json, {
    status,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
      'x-content-type-options': 'nosniff',
      ...(status === 405 ? { allow: 'POST' } : {}),
    },
  })
}

async function handle(
  route: StudentRoute,
  request: Request,
  supplied?: StudentSessionDependencies,
): Promise<Response> {
  if (request.method !== 'POST') return response(denied, 405)
  let url: URL
  try {
    url = new URL(request.url)
  } catch {
    return response(denied, 403)
  }
  if (url.search !== '' || url.hash !== '' || url.username !== '' || url.password !== '') {
    return response(denied, 403)
  }
  const controller = new AbortController()
  const abort = () => controller.abort()
  const timer = setTimeout(abort, STUDENT_SESSION_REQUEST_TIMEOUT_MS)
  request.signal.addEventListener('abort', abort, { once: true })
  if (request.signal.aborted) abort()
  let rejectDeadline: (() => void) | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = () => reject(new DependencyUnavailable())
    controller.signal.addEventListener('abort', rejectDeadline, { once: true })
    if (controller.signal.aborted) rejectDeadline()
  })
  const work = async (): Promise<Response> => {
    throwIfAborted(controller.signal)
    const dependencies = supplied ?? configuredDependencies()
    const environment = dependencies.apiOrigin.startsWith('http:') ? 'local' : 'staging'
    if (parseEdgeStudentApiOrigin(environment, dependencies.apiOrigin) === null) {
      throw new DependencyUnavailable()
    }
    let body: unknown
    try {
      body = await readBoundedJson(request, controller.signal, true)
    } catch (error) {
      if (
        (route === 'challenge' || route === 'join') &&
        (error instanceof InvalidBody || error instanceof BodyTooLarge)
      ) await chargeMalformedBootstrap(route, undefined, dependencies, controller.signal)
      throw error
    }
    let result: PublicResult
    if (route === 'challenge') {
      const input = parseEdgeStudentChallengeRequest(body)
      if (input === null) {
        await chargeMalformedBootstrap(route, body, dependencies, controller.signal)
      }
      result = input === null ? denied : await challenge(input, dependencies, controller.signal)
    } else if (route === 'join') {
      const input = parseEdgeStudentJoinRequest(body)
      if (input === null) {
        await chargeMalformedBootstrap(route, body, dependencies, controller.signal)
      }
      result = input === null ? denied : await join(input, dependencies, controller.signal)
    } else {
      const input = route === 'read'
        ? parseEdgeStudentReadRequest(body)
        : route === 'reconnect'
        ? parseEdgeStudentReconnectRequest(body)
        : parseEdgeStudentForfeitRequest(body)
      result = input === null
        ? denied
        : await maintenance(route, input, dependencies, controller.signal)
    }
    throwIfAborted(controller.signal)
    return response(result, 'status' in result && result.status === 'denied' ? 403 : 200)
  }
  try {
    return await Promise.race([work(), deadline])
  } catch (error) {
    return error instanceof BodyTooLarge
      ? response(denied, 413)
      : error instanceof InvalidBody
      ? response(denied, 403)
      : response(unavailable, 503)
  } finally {
    clearTimeout(timer)
    request.signal.removeEventListener('abort', abort)
    if (rejectDeadline !== undefined) controller.signal.removeEventListener('abort', rejectDeadline)
    controller.abort()
  }
}

export function handleStudentChallengeRequest(
  request: Request,
  dependencies?: StudentSessionDependencies,
): Promise<Response> {
  return handle('challenge', request, dependencies)
}
export function handleStudentJoinRequest(
  request: Request,
  dependencies?: StudentSessionDependencies,
): Promise<Response> {
  return handle('join', request, dependencies)
}
export function handleStudentReadRequest(
  request: Request,
  dependencies?: StudentSessionDependencies,
): Promise<Response> {
  return handle('read', request, dependencies)
}
export function handleStudentReconnectRequest(
  request: Request,
  dependencies?: StudentSessionDependencies,
): Promise<Response> {
  return handle('reconnect', request, dependencies)
}
export function handleStudentForfeitRequest(
  request: Request,
  dependencies?: StudentSessionDependencies,
): Promise<Response> {
  return handle('forfeit', request, dependencies)
}
