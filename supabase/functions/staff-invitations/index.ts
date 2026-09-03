import {
  codeResponse,
  handlePreflight,
  isExactRecord,
  methodNotAllowedResponse,
  parseBearerJwt,
  parseCanonicalEmail,
  parseCanonicalUuid,
  parseEmail,
  parseExactCallback,
  parseExactOrigin,
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
  readonly actionLink?: string;
  readonly code:
    "conflict" | "dependency_unavailable" | "link_generated" | "rate_limited";
  readonly userId?: string;
}

export interface InvitationDeliveryMessage {
  readonly actionLink: string;
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
  if (code === "conflict") {
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

function parseGeneratedActionLink(
  value: unknown,
  backendOrigin: string,
  callback: string,
): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 8_192) {
    return null;
  }
  let actionLink: URL;
  try {
    actionLink = new URL(value);
  } catch {
    return null;
  }
  if (
    actionLink.origin !== backendOrigin ||
    actionLink.pathname !== "/auth/v1/verify" ||
    actionLink.username !== "" ||
    actionLink.password !== "" ||
    actionLink.hash !== ""
  ) {
    return null;
  }
  const queryKeys = [...actionLink.searchParams.keys()];
  const allowedKeys = new Set(["redirect_to", "token", "token_hash", "type"]);
  if (
    queryKeys.some((key) => !allowedKeys.has(key)) ||
    new Set(queryKeys).size !== queryKeys.length ||
    actionLink.searchParams.get("type") !== "invite" ||
    actionLink.searchParams.get("redirect_to") !== callback
  ) {
    return null;
  }
  const token = actionLink.searchParams.get("token");
  const tokenHash = actionLink.searchParams.get("token_hash");
  const hasToken = token !== null && token.length > 0 && token.length <= 4_096;
  const hasTokenHash =
    tokenHash !== null && tokenHash.length > 0 && tokenHash.length <= 4_096;
  if (hasToken === hasTokenHash || queryKeys.length !== 3) {
    return null;
  }
  return actionLink.href;
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
  const wrappedUser = asRecord(response.user);
  const user = wrappedUser ?? response;
  if (isConfirmedExistingUser(user, requestedEmail)) {
    return { code: "conflict" };
  }
  const actionLink = parseGeneratedActionLink(
    properties?.action_link ?? response.action_link,
    backendOrigin,
    callback,
  );
  const userId = parseUuid(user.id);
  return actionLink !== null &&
    userId !== null &&
    isUnconfirmedInvitedUser(user, requestedEmail)
    ? { actionLink, code: "link_generated", userId }
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
      : parseExactCallback(
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
    now,
    async authorizeInvitation(jwt, input) {
      const result = await callRpc(
        client,
        "begin_staff_invitation",
        {
          email: input.email,
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
      if ([400, 404, 409, 422].includes(response.status)) {
        return { code: "conflict" };
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
  try {
    return (
      (await dependencies.failInvitation(invitationId, reasonCode)) ===
      "invitation_delivery_failed"
    );
  } catch {
    return false;
  }
}

async function confirmInvitationDeliveryReady(
  dependencies: StaffInvitationDependencies,
  invitationId: string,
  userId: string,
  expiresAt: string,
): Promise<boolean> {
  for (let attempt = 0; attempt < PREPARE_ATTEMPTS; attempt += 1) {
    try {
      const code = await dependencies.prepareInvitation(
        invitationId,
        userId,
        expiresAt,
      );
      if (code === "invitation_delivery_ready") {
        return true;
      }
      if (code !== "dependency_unavailable") {
        return false;
      }
    } catch {
      // A lost response is ambiguous. Retry the same idempotency tuple once;
      // delivery remains forbidden until an exact ready result is observed.
    }
  }
  return false;
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
    allowedHeaders: ["authorization", "content-type"],
    allowedOrigin: dependencies.allowedOrigin,
  } as const;
  if (request.method === "OPTIONS") {
    return handlePreflight(request, corsPolicy);
  }
  if (!validateRequestOrigin(request, dependencies.allowedOrigin)) {
    return codeResponse("authorization_denied", 403);
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

  let authorization: InvitationAuthorizationResult;
  try {
    authorization = await dependencies.authorizeInvitation(jwt, input);
  } catch {
    return codeResponse("service_unavailable", 503, dependencies.allowedOrigin);
  }
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
  const actionLink =
    generated.code === "link_generated" &&
    typeof generated.actionLink === "string" &&
    generated.actionLink.length > 0 &&
    generated.actionLink.length <= 8_192
      ? generated.actionLink
      : null;
  if (generatedUserId === null || actionLink === null) {
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
  const ready = await confirmInvitationDeliveryReady(
    dependencies,
    invitationId,
    generatedUserId,
    expiresAt,
  );
  if (!ready) {
    await recordFailedDelivery(
      dependencies,
      invitationId,
      "dependency_unavailable",
    );
    return codeResponse("service_unavailable", 503, dependencies.allowedOrigin);
  }

  let delivery: InvitationDeliveryResult = "dependency_unavailable";
  try {
    delivery = await dependencies.deliverInvitation({
      actionLink,
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
