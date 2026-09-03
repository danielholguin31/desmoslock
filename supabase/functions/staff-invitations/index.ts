import {
  codeResponse,
  handlePreflight,
  isExactRecord,
  methodNotAllowedResponse,
  parseBearerJwt,
  parseCanonicalEmail,
  parseCanonicalUuid,
  parseEmail,
  parseExactOrigin,
  parseExactRootCallback,
  parseUuid,
  readStrictJson,
  validateRequestOrigin,
} from "../_shared/http.ts";
import {
  createSupabaseHttpClient,
  parseAuthActionLinkOrigin,
  readBoundedJsonResponse,
  readExactSingleRow,
  type ServiceFetch,
  type SupabaseHttpClient,
} from "../_shared/supabase-http.ts";

const MAXIMUM_INVITATION_LIFETIME_SECONDS = 86_400;
const MINIMUM_INVITATION_LIFETIME_SECONDS = 60;
const BEGIN_ATTEMPTS = 2;
const FAILURE_ATTEMPTS = 2;
const PREPARE_ATTEMPTS = 2;
const PUBLISH_ATTEMPTS = 2;

type StaffRole = "administrator" | "teacher";

type PublicInvitationErrorCode =
  | "authentication_required"
  | "authorization_denied"
  | "existing_confirmed_user_unsupported"
  | "invalid_request"
  | "invitation_expired"
  | "invitation_not_found"
  | "rate_limited"
  | "service_unavailable"
  | "session_expired"
  | "session_revoked"
  | "step_up_required";

interface PublicInvitationFailure {
  readonly code: PublicInvitationErrorCode;
  readonly status: number;
}

interface GeneratedInvitationFailure extends PublicInvitationFailure {
  readonly cleanupReason: "dependency_unavailable" | "invalid_request";
}

interface StaffInvitationInput {
  readonly email: string;
  readonly role: StaffRole;
  readonly schoolId: string;
}

export interface InvitationAuthorizationResult {
  readonly code: string;
  readonly invitationId?: string;
}

export interface GeneratedInvitationResult {
  readonly callbackUrl?: string;
  readonly code:
    | "dependency_unavailable"
    | "existing_user_conflict"
    | "link_generated"
    | "rate_limited";
  readonly userId?: string;
}

export interface InvitationDeliveryMessage {
  readonly callbackUrl: string;
  readonly expiresAt: string;
  readonly recipientEmail: string;
}

export type InvitationDeliveryResult = "delivered" | "dependency_unavailable";

export interface StaffInvitationDeliveryTransport {
  deliver(
    message: InvitationDeliveryMessage,
  ): Promise<InvitationDeliveryResult>;
}

export interface StaffInvitationDependencies {
  readonly allowedOrigin: string;
  readonly inviteLifetimeSeconds: number;
  authorizeInvitation(
    jwt: string,
    input: StaffInvitationInput,
    requestKey: string,
  ): Promise<InvitationAuthorizationResult>;
  prepareInvitation(
    invitationId: string,
    userId: string,
    expiresAt: string,
  ): Promise<string>;
  deliverInvitation(
    message: InvitationDeliveryMessage,
  ): Promise<InvitationDeliveryResult>;
  failInvitation(invitationId: string, reasonCode: string): Promise<string>;
  generateInviteLink(email: string): Promise<GeneratedInvitationResult>;
  newRequestKey(): string;
  now(): number;
  publishInvitation(invitationId: string): Promise<string>;
}

function parseInput(value: unknown): StaffInvitationInput | null {
  if (!isExactRecord(value, ["email", "role", "schoolId"])) {
    return null;
  }
  const email = parseCanonicalEmail(value.email);
  const schoolId = parseCanonicalUuid(value.schoolId);
  const role =
    value.role === "administrator" || value.role === "teacher"
      ? value.role
      : null;
  return email !== null && schoolId !== null && role !== null
    ? { email, role, schoolId }
    : null;
}

function parseInvitationLifetimeSeconds(value: unknown): number | null {
  if (typeof value !== "string" || !/^[1-9][0-9]{1,5}$/u.test(value)) {
    return null;
  }
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) &&
    seconds >= MINIMUM_INVITATION_LIFETIME_SECONDS &&
    seconds <= MAXIMUM_INVITATION_LIFETIME_SECONDS
    ? seconds
    : null;
}

function mapAuthorizationFailure(code: string): PublicInvitationFailure {
  switch (code) {
    case "invalid_request":
      return { code, status: 400 };
    case "unauthenticated":
      return { code: "authentication_required", status: 401 };
    case "session_expired":
    case "session_revoked":
      return { code, status: 401 };
    case "email_unverified":
    case "forbidden":
    case "membership_inactive":
      return { code: "authorization_denied", status: 403 };
    case "step_up_required":
      return { code, status: 403 };
    case "invitation_not_found":
    case "invitation_consumed":
      return { code: "invitation_not_found", status: 404 };
    case "invitation_expired":
      return { code, status: 409 };
    case "rate_limited":
      return { code, status: 429 };
    default:
      return { code: "service_unavailable", status: 503 };
  }
}

function mapGeneratedInvitationFailure(
  code: GeneratedInvitationResult["code"],
): GeneratedInvitationFailure {
  if (code === "existing_user_conflict") {
    return {
      cleanupReason: "invalid_request",
      code: "existing_confirmed_user_unsupported",
      status: 409,
    };
  }
  if (code === "rate_limited") {
    return {
      cleanupReason: "dependency_unavailable",
      code: "rate_limited",
      status: 429,
    };
  }
  return {
    cleanupReason: "dependency_unavailable",
    code: "service_unavailable",
    status: 503,
  };
}

function mapHttpFailure(status: number): string {
  if (status === 401) return "unauthenticated";
  if (status === 403) return "forbidden";
  if (status === 409 || status === 422) return "conflict";
  if (status === 429) return "rate_limited";
  return "dependency_unavailable";
}

async function callRpc(
  client: SupabaseHttpClient,
  functionName: string,
  body: Record<string, unknown>,
  authorization: string,
  apikey: string,
): Promise<{ readonly code: string; readonly row?: Record<string, unknown> }> {
  const response = await client.request(`/rest/v1/rpc/${functionName}`, {
    body: JSON.stringify(body),
    headers: {
      "accept-profile": "desmoslock_v2",
      apikey,
      authorization,
      "content-profile": "desmoslock_v2",
      "content-type": "application/json",
    },
    method: "POST",
  });
  if (!response.ok) {
    return { code: mapHttpFailure(response.status) };
  }
  const value = await readBoundedJsonResponse(response);
  const expectedKeys =
    functionName === "begin_staff_invitation"
      ? ["code", "invitation_id"]
      : ["code"];
  const row = readExactSingleRow(value, expectedKeys);
  return row !== null && typeof row.code === "string"
    ? { code: row.code, row }
    : { code: "dependency_unavailable" };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function hasUnverifiedEmailIdentity(user: Record<string, unknown>): boolean {
  if (!Array.isArray(user.identities) || user.identities.length === 0) {
    return false;
  }
  return user.identities.some((identityValue) => {
    const identity = asRecord(identityValue);
    const identityData = asRecord(identity?.identity_data);
    return (
      identity?.provider === "email" && identityData?.email_verified === false
    );
  });
}

function isUnconfirmedInvitedUser(
  user: Record<string, unknown>,
  requestedEmail: string,
): boolean {
  const id = parseUuid(user.id);
  const email = parseEmail(user.email);
  const confirmed =
    typeof user.email_confirmed_at === "string" ||
    typeof user.confirmed_at === "string";
  return (
    id !== null &&
    email === requestedEmail &&
    !confirmed &&
    user.is_anonymous === false &&
    typeof user.invited_at === "string" &&
    Number.isFinite(Date.parse(user.invited_at)) &&
    hasUnverifiedEmailIdentity(user)
  );
}

function isConfirmedExistingUser(
  user: Record<string, unknown>,
  requestedEmail: string,
): boolean {
  const id = parseUuid(user.id);
  const email = parseEmail(user.email);
  const confirmationTimestamp =
    typeof user.email_confirmed_at === "string"
      ? user.email_confirmed_at
      : typeof user.confirmed_at === "string"
        ? user.confirmed_at
        : null;
  return (
    id !== null &&
    email === requestedEmail &&
    confirmationTimestamp !== null &&
    Number.isFinite(Date.parse(confirmationTimestamp))
  );
}

function parseProviderTokenHash(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-f]{56}$/u.test(value)
    ? value
    : null;
}

function validateGeneratedActionLink(
  value: unknown,
  backendOrigin: string,
  callback: string,
  tokenHash: string,
): boolean {
  if (typeof value !== "string" || value.length === 0 || value.length > 8_192) {
    return false;
  }
  let actionLink: URL;
  try {
    actionLink = new URL(value);
  } catch {
    return false;
  }
  if (
    actionLink.origin !== backendOrigin ||
    actionLink.pathname !== "/auth/v1/verify" ||
    actionLink.username !== "" ||
    actionLink.password !== "" ||
    actionLink.hash !== ""
  ) {
    return false;
  }
  const queryKeys = [...actionLink.searchParams.keys()];
  const allowedKeys = new Set(["redirect_to", "token", "type"]);
  if (
    queryKeys.length !== 3 ||
    queryKeys.some((key) => !allowedKeys.has(key)) ||
    new Set(queryKeys).size !== queryKeys.length ||
    actionLink.searchParams.get("type") !== "invite" ||
    actionLink.searchParams.get("redirect_to") !== callback ||
    actionLink.searchParams.get("token") !== tokenHash
  ) {
    return false;
  }
  return true;
}

function createInviteCallback(callback: string, tokenHash: string): string {
  const callbackUrl = new URL(callback);
  callbackUrl.searchParams.append("auth", "invite");
  callbackUrl.searchParams.append("token_hash", tokenHash);
  return callbackUrl.href;
}

function parseInviteCallback(
  value: unknown,
  expectedOrigin: string,
): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 8_192) {
    return null;
  }
  let callback: URL;
  try {
    callback = new URL(value);
  } catch {
    return null;
  }
  const queryKeys = [...callback.searchParams.keys()];
  return callback.origin === expectedOrigin &&
    callback.username === "" &&
    callback.password === "" &&
    callback.pathname === "/" &&
    callback.hash === "" &&
    callback.href === value &&
    queryKeys.length === 2 &&
    new Set(queryKeys).size === queryKeys.length &&
    queryKeys.every((key) => key === "auth" || key === "token_hash") &&
    callback.searchParams.get("auth") === "invite" &&
    parseProviderTokenHash(callback.searchParams.get("token_hash")) !== null
    ? callback.href
    : null;
}

function parseGeneratedInvitation(
  value: unknown,
  requestedEmail: string,
  backendOrigin: string,
  callback: string,
): GeneratedInvitationResult {
  const response = asRecord(value);
  if (response === null) {
    return { code: "dependency_unavailable" };
  }
  const properties = asRecord(response.properties);
  if (
    response.properties !== undefined &&
    (properties === null ||
      !isExactRecord(properties, [
        "action_link",
        "email_otp",
        "hashed_token",
        "redirect_to",
        "verification_type",
      ]))
  ) {
    return { code: "dependency_unavailable" };
  }
  const wrappedUser = asRecord(response.user);
  const user = wrappedUser ?? response;
  if (isConfirmedExistingUser(user, requestedEmail)) {
    return { code: "existing_user_conflict" };
  }
  const material = properties ?? response;
  const tokenHash = parseProviderTokenHash(material.hashed_token);
  const userId = parseUuid(user.id);
  return tokenHash !== null &&
    typeof material.email_otp === "string" &&
    material.email_otp.length > 0 &&
    material.email_otp.length <= 64 &&
    material.verification_type === "invite" &&
    material.redirect_to === callback &&
    validateGeneratedActionLink(
      material.action_link,
      backendOrigin,
      callback,
      tokenHash,
    ) &&
    userId !== null &&
    isUnconfirmedInvitedUser(user, requestedEmail)
    ? {
        callbackUrl: createInviteCallback(callback, tokenHash),
        code: "link_generated",
        userId,
      }
    : { code: "dependency_unavailable" };
}

export function createStaffInvitationDependencies(
  configuration: unknown,
  serviceFetch: ServiceFetch = globalThis.fetch,
  now: () => number = Date.now,
  deliveryTransport?: StaffInvitationDeliveryTransport,
): StaffInvitationDependencies {
  if (
    !isExactRecord(configuration, [
      "DESMOSLOCK_ALLOWED_WEB_ORIGIN",
      "DESMOSLOCK_EXPECTED_AUTH_ACTION_LINK_ORIGIN",
      "DESMOSLOCK_EXPECTED_SUPABASE_ORIGIN",
      "DESMOSLOCK_STAFF_INVITATION_CALLBACK",
      "DESMOSLOCK_STAFF_INVITATION_LIFETIME_SECONDS",
      "SUPABASE_ANON_KEY",
      "SUPABASE_SERVICE_ROLE_KEY",
      "SUPABASE_URL",
    ])
  ) {
    throw new Error("Staff invitation configuration is invalid");
  }
  const allowedOrigin = parseExactOrigin(
    configuration.DESMOSLOCK_ALLOWED_WEB_ORIGIN,
  );
  const actionLinkOrigin = parseAuthActionLinkOrigin(
    configuration.DESMOSLOCK_EXPECTED_AUTH_ACTION_LINK_ORIGIN,
  );
  const callback =
    allowedOrigin === null
      ? null
      : parseExactRootCallback(
          configuration.DESMOSLOCK_STAFF_INVITATION_CALLBACK,
          allowedOrigin,
        );
  const inviteLifetimeSeconds = parseInvitationLifetimeSeconds(
    configuration.DESMOSLOCK_STAFF_INVITATION_LIFETIME_SECONDS,
  );
  const expectedSupabaseOrigin =
    configuration.DESMOSLOCK_EXPECTED_SUPABASE_ORIGIN;
  const supabaseUrl = configuration.SUPABASE_URL;
  // This explicit value must exactly match the hosted
  // `auth.email.otp_expiry`; there is intentionally no inferred default.
  if (
    allowedOrigin === null ||
    actionLinkOrigin === null ||
    callback === null ||
    inviteLifetimeSeconds === null ||
    typeof supabaseUrl !== "string" ||
    (expectedSupabaseOrigin !== undefined &&
      typeof expectedSupabaseOrigin !== "string")
  ) {
    throw new Error("Staff invitation configuration is invalid");
  }
  const client = createSupabaseHttpClient(
    {
      expectedOrigin: expectedSupabaseOrigin,
      publishableKey: String(configuration.SUPABASE_ANON_KEY),
      serviceRoleKey: String(configuration.SUPABASE_SERVICE_ROLE_KEY),
      supabaseUrl,
    },
    serviceFetch,
  );
  const serviceRoleKey = client.serviceRoleKey;
  if (serviceRoleKey === undefined) {
    throw new Error("Staff invitation configuration is invalid");
  }
  const serviceAuthorization = `Bearer ${serviceRoleKey}`;

  return {
    allowedOrigin,
    inviteLifetimeSeconds,
    newRequestKey: () => crypto.randomUUID(),
    now,
    async authorizeInvitation(jwt, input, requestKey) {
      const result = await callRpc(
        client,
        "begin_staff_invitation",
        {
          email: input.email,
          request_key: requestKey,
          role: input.role === "administrator" ? "admin" : "teacher",
          workspace_id: input.schoolId,
        },
        `Bearer ${jwt}`,
        client.publishableKey,
      );
      if (result.code !== "invitation_pending") {
        return { code: result.code };
      }
      const invitationId = parseUuid(result.row?.invitation_id);
      return invitationId === null
        ? { code: "dependency_unavailable" }
        : { code: "invitation_pending", invitationId };
    },
    async prepareInvitation(invitationId, userId, expiresAt) {
      const result = await callRpc(
        client,
        "internal_prepare_staff_invitation",
        {
          expires_at: expiresAt,
          invitation_id: invitationId,
          invited_user_id: userId,
        },
        serviceAuthorization,
        serviceRoleKey,
      );
      return result.code;
    },
    async publishInvitation(invitationId) {
      const result = await callRpc(
        client,
        "internal_publish_staff_invitation",
        { invitation_id: invitationId },
        serviceAuthorization,
        serviceRoleKey,
      );
      return result.code;
    },
    async deliverInvitation(message) {
      if (deliveryTransport === undefined) {
        return "dependency_unavailable";
      }
      return await deliveryTransport.deliver(message);
    },
    async failInvitation(invitationId, reasonCode) {
      const result = await callRpc(
        client,
        "internal_fail_staff_invitation",
        {
          invitation_id: invitationId,
          reason_code: reasonCode,
        },
        serviceAuthorization,
        serviceRoleKey,
      );
      return result.code;
    },
    async generateInviteLink(email) {
      const providerUrl = new URL(
        "/auth/v1/admin/generate_link",
        `${client.origin}/`,
      );
      providerUrl.searchParams.set("redirect_to", callback);
      const response = await client.request(providerUrl.href, {
        body: JSON.stringify({ email, type: "invite" }),
        headers: {
          apikey: serviceRoleKey,
          authorization: serviceAuthorization,
          "content-type": "application/json",
        },
        method: "POST",
      });
      if (response.status === 429) {
        return { code: "rate_limited" };
      }
      if (!response.ok) {
        return { code: "dependency_unavailable" };
      }
      return parseGeneratedInvitation(
        await readBoundedJsonResponse(response),
        email,
        actionLinkOrigin,
        callback,
      );
    },
  };
}

function runtimeDependencies(): StaffInvitationDependencies {
  // Delivery is deliberately unavailable until an approved server-only
  // transport is wired; runtime configuration must never imply a vendor.
  return createStaffInvitationDependencies({
    DESMOSLOCK_ALLOWED_WEB_ORIGIN: Deno.env.get(
      "DESMOSLOCK_ALLOWED_WEB_ORIGIN",
    ),
    DESMOSLOCK_EXPECTED_AUTH_ACTION_LINK_ORIGIN: Deno.env.get(
      "DESMOSLOCK_EXPECTED_AUTH_ACTION_LINK_ORIGIN",
    ),
    DESMOSLOCK_EXPECTED_SUPABASE_ORIGIN: Deno.env.get(
      "DESMOSLOCK_EXPECTED_SUPABASE_ORIGIN",
    ),
    DESMOSLOCK_STAFF_INVITATION_CALLBACK: Deno.env.get(
      "DESMOSLOCK_STAFF_INVITATION_CALLBACK",
    ),
    DESMOSLOCK_STAFF_INVITATION_LIFETIME_SECONDS: Deno.env.get(
      "DESMOSLOCK_STAFF_INVITATION_LIFETIME_SECONDS",
    ),
    SUPABASE_ANON_KEY: Deno.env.get("SUPABASE_ANON_KEY"),
    SUPABASE_SERVICE_ROLE_KEY: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
    SUPABASE_URL: Deno.env.get("SUPABASE_URL"),
  });
}

async function recordFailedDelivery(
  dependencies: StaffInvitationDependencies,
  invitationId: string,
  reasonCode: string,
): Promise<boolean> {
  for (let attempt = 0; attempt < FAILURE_ATTEMPTS; attempt += 1) {
    try {
      const code = await dependencies.failInvitation(invitationId, reasonCode);
      if (code === "invitation_delivery_failed") {
        return true;
      }
      if (code !== "conflict" && code !== "dependency_unavailable") {
        return false;
      }
    } catch {
      // The failure transition is idempotent. Retry the same tuple after an
      // ambiguous response so a committed terminal state can be reconciled.
    }
  }
  return false;
}

async function beginStaffInvitation(
  dependencies: StaffInvitationDependencies,
  jwt: string,
  input: StaffInvitationInput,
  requestKey: string,
): Promise<InvitationAuthorizationResult> {
  for (let attempt = 0; attempt < BEGIN_ATTEMPTS; attempt += 1) {
    try {
      const result = await dependencies.authorizeInvitation(
        jwt,
        input,
        requestKey,
      );
      if (result.code !== "dependency_unavailable") {
        return result;
      }
    } catch {
      // The DB request key makes begin idempotent. Reusing it reconciles a
      // possibly committed insert without allowing a second delivery owner.
    }
  }
  return { code: "dependency_unavailable" };
}

async function confirmInvitationDeliveryReady(
  dependencies: StaffInvitationDependencies,
  invitationId: string,
  userId: string,
  expiresAt: string,
): Promise<"failed" | "ready" | "terminal"> {
  for (let attempt = 0; attempt < PREPARE_ATTEMPTS; attempt += 1) {
    try {
      const code = await dependencies.prepareInvitation(
        invitationId,
        userId,
        expiresAt,
      );
      if (code === "invitation_delivery_ready") {
        return "ready";
      }
      if (
        code === "invitation_expired" ||
        code === "invitation_delivery_failed"
      ) {
        return "terminal";
      }
      if (code !== "dependency_unavailable") {
        return "failed";
      }
    } catch {
      // A lost response is ambiguous. Retry the same idempotency tuple once;
      // delivery remains forbidden until an exact ready result is observed.
    }
  }
  return "failed";
}

async function confirmInvitationPublished(
  dependencies: StaffInvitationDependencies,
  invitationId: string,
): Promise<boolean> {
  for (let attempt = 0; attempt < PUBLISH_ATTEMPTS; attempt += 1) {
    try {
      const code = await dependencies.publishInvitation(invitationId);
      if (code === "invitation_usable") {
        return true;
      }
      if (code !== "dependency_unavailable") {
        return false;
      }
    } catch {
      // SMTP has already reported exact delivery. Reconcile only by repeating
      // the idempotent publish transition; never retry the delivery itself.
    }
  }
  return false;
}

function invitationExpiration(
  dependencies: StaffInvitationDependencies,
): string | null {
  try {
    const now = dependencies.now();
    const lifetimeMilliseconds = dependencies.inviteLifetimeSeconds * 1_000;
    if (
      !Number.isSafeInteger(now) ||
      now < 0 ||
      !Number.isSafeInteger(lifetimeMilliseconds) ||
      dependencies.inviteLifetimeSeconds <
        MINIMUM_INVITATION_LIFETIME_SECONDS ||
      dependencies.inviteLifetimeSeconds >
        MAXIMUM_INVITATION_LIFETIME_SECONDS ||
      now > 8_640_000_000_000_000 - lifetimeMilliseconds
    ) {
      return null;
    }
    return new Date(now + lifetimeMilliseconds).toISOString();
  } catch {
    return null;
  }
}

export async function handleRequest(
  request: Request,
  injectedDependencies?: StaffInvitationDependencies,
): Promise<Response> {
  let dependencies: StaffInvitationDependencies;
  try {
    dependencies = injectedDependencies ?? runtimeDependencies();
  } catch {
    return codeResponse("service_unavailable", 503);
  }
  const corsPolicy = {
    allowedHeaders: [
      "apikey",
      "authorization",
      "content-type",
      "x-client-info",
    ],
    allowedOrigin: dependencies.allowedOrigin,
  } as const;
  if (request.method === "OPTIONS") {
    return handlePreflight(request, corsPolicy);
  }
  if (!validateRequestOrigin(request, dependencies.allowedOrigin)) {
    return codeResponse("invalid_request", 403);
  }
  if (request.method !== "POST") {
    return methodNotAllowedResponse(dependencies.allowedOrigin);
  }
  const jwt = parseBearerJwt(request.headers.get("authorization"));
  if (jwt === null) {
    return codeResponse(
      "authentication_required",
      401,
      dependencies.allowedOrigin,
    );
  }
  const input = parseInput(await readStrictJson(request));
  if (input === null) {
    return codeResponse("invalid_request", 400, dependencies.allowedOrigin);
  }

  let requestKey: string | null = null;
  try {
    requestKey = parseCanonicalUuid(dependencies.newRequestKey());
  } catch {
    // A runtime entropy failure is an internal dependency failure.
  }
  if (requestKey === null) {
    return codeResponse("service_unavailable", 503, dependencies.allowedOrigin);
  }

  const authorization = await beginStaffInvitation(
    dependencies,
    jwt,
    input,
    requestKey,
  );
  if (authorization.code !== "invitation_pending") {
    const failure = mapAuthorizationFailure(authorization.code);
    return codeResponse(
      failure.code,
      failure.status,
      dependencies.allowedOrigin,
    );
  }
  const invitationId = parseUuid(authorization.invitationId);
  if (invitationId === null) {
    return codeResponse("service_unavailable", 503, dependencies.allowedOrigin);
  }

  let generated: GeneratedInvitationResult;
  try {
    generated = await dependencies.generateInviteLink(input.email);
  } catch {
    generated = { code: "dependency_unavailable" };
  }
  const generatedUserId =
    generated.code === "link_generated" ? parseUuid(generated.userId) : null;
  const callbackUrl =
    generated.code === "link_generated" &&
    typeof generated.callbackUrl === "string"
      ? parseInviteCallback(generated.callbackUrl, dependencies.allowedOrigin)
      : null;
  if (generatedUserId === null || callbackUrl === null) {
    const failure = mapGeneratedInvitationFailure(generated.code);
    const recorded = await recordFailedDelivery(
      dependencies,
      invitationId,
      failure.cleanupReason,
    );
    if (!recorded) {
      return codeResponse(
        "service_unavailable",
        503,
        dependencies.allowedOrigin,
      );
    }
    return codeResponse(
      failure.code,
      failure.status,
      dependencies.allowedOrigin,
    );
  }

  const expiresAt = invitationExpiration(dependencies);
  if (expiresAt === null) {
    await recordFailedDelivery(
      dependencies,
      invitationId,
      "dependency_unavailable",
    );
    return codeResponse("service_unavailable", 503, dependencies.allowedOrigin);
  }
  const preparation = await confirmInvitationDeliveryReady(
    dependencies,
    invitationId,
    generatedUserId,
    expiresAt,
  );
  if (preparation !== "ready") {
    // Expiry terminalization is already audited by the database. Do not issue
    // a second lifecycle mutation after an exact terminal prepare result.
    if (preparation !== "terminal") {
      await recordFailedDelivery(
        dependencies,
        invitationId,
        "dependency_unavailable",
      );
    }
    return codeResponse("service_unavailable", 503, dependencies.allowedOrigin);
  }

  let delivery: InvitationDeliveryResult = "dependency_unavailable";
  try {
    delivery = await dependencies.deliverInvitation({
      callbackUrl,
      expiresAt,
      recipientEmail: input.email,
    });
  } catch {
    // A sent-then-failed SMTP outcome is ambiguous. The delivery-ready state is
    // non-consumable, so safety does not depend on the failure write succeeding.
  }
  if (delivery !== "delivered") {
    await recordFailedDelivery(
      dependencies,
      invitationId,
      "dependency_unavailable",
    );
    return codeResponse("service_unavailable", 503, dependencies.allowedOrigin);
  }
  const published = await confirmInvitationPublished(
    dependencies,
    invitationId,
  );
  if (!published) {
    return codeResponse("service_unavailable", 503, dependencies.allowedOrigin);
  }
  return codeResponse("invitation_created", 201, dependencies.allowedOrigin);
}

if (import.meta.main) {
  Deno.serve((request) => handleRequest(request));
}
