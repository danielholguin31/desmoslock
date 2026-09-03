import {
  codeResponse,
  handlePreflight,
  isExactRecord,
  methodNotAllowedResponse,
  parseBearerJwt,
  parseEmail,
  parseExactCallback,
  parseExactOrigin,
  parseUuid,
  readStrictJson,
  validateRequestOrigin,
} from "../_shared/http.ts";
import {
  createSupabaseHttpClient,
  readBoundedJsonResponse,
  readExactSingleRow,
  type ServiceFetch,
  type SupabaseHttpClient,
} from "../_shared/supabase-http.ts";

const INVITATION_LIFETIME_MILLISECONDS = 24 * 60 * 60 * 1_000;

const publicFailureCodes = new Set([
  "conflict",
  "email_unverified",
  "forbidden",
  "invalid_request",
  "invitation_consumed",
  "invitation_expired",
  "invitation_not_found",
  "membership_inactive",
  "rate_limited",
  "session_expired",
  "session_revoked",
  "step_up_required",
  "unauthenticated",
]);

type StaffRole = "admin" | "teacher";

interface StaffInvitationInput {
  readonly email: string;
  readonly role: StaffRole;
  readonly workspaceId: string;
}

export interface InvitationAuthorizationResult {
  readonly code: string;
  readonly invitationId?: string;
}

export interface InvitationDeliveryResult {
  readonly code:
    "conflict" | "dependency_unavailable" | "rate_limited" | "user_created";
  readonly userId?: string;
}

export interface StaffInvitationDependencies {
  readonly allowedOrigin: string;
  authorizeInvitation(
    jwt: string,
    input: StaffInvitationInput,
  ): Promise<InvitationAuthorizationResult>;
  completeInvitation(
    invitationId: string,
    userId: string,
    expiresAt: string,
  ): Promise<string>;
  deliverInvitation(email: string): Promise<InvitationDeliveryResult>;
  failInvitation(invitationId: string, reasonCode: string): Promise<string>;
  now(): number;
}

function parseInput(value: unknown): StaffInvitationInput | null {
  if (!isExactRecord(value, ["email", "role", "workspaceId"])) {
    return null;
  }
  const email = parseEmail(value.email);
  const workspaceId = parseUuid(value.workspaceId);
  const role =
    value.role === "admin" || value.role === "teacher" ? value.role : null;
  return email !== null && workspaceId !== null && role !== null
    ? { email, role, workspaceId }
    : null;
}

function invitationFailureStatus(code: string): number {
  switch (code) {
    case "invalid_request":
      return 400;
    case "unauthenticated":
    case "session_expired":
    case "session_revoked":
      return 401;
    case "email_unverified":
    case "forbidden":
    case "membership_inactive":
    case "step_up_required":
      return 403;
    case "invitation_not_found":
      return 404;
    case "rate_limited":
      return 429;
    default:
      return 409;
  }
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

function isUnconfirmedInvitedUser(
  value: unknown,
  requestedEmail: string,
): boolean {
  const candidate = isExactRecord(value, ["user"]) ? value.user : value;
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    Array.isArray(candidate)
  ) {
    return false;
  }
  const user = candidate as Record<string, unknown>;
  const id = parseUuid(user.id);
  const email = parseEmail(user.email);
  const emailConfirmedAt = user.email_confirmed_at;
  const confirmedAt = user.confirmed_at;
  const confirmationFieldsValid =
    (emailConfirmedAt === undefined || emailConfirmedAt === null) &&
    (confirmedAt === undefined || confirmedAt === null);
  return (
    id !== null &&
    email === requestedEmail &&
    confirmationFieldsValid &&
    user.is_anonymous === false &&
    typeof user.invited_at === "string" &&
    Number.isFinite(Date.parse(user.invited_at)) &&
    typeof user.confirmation_sent_at === "string" &&
    Number.isFinite(Date.parse(user.confirmation_sent_at))
  );
}

export function createStaffInvitationDependencies(
  configuration: unknown,
  serviceFetch: ServiceFetch = globalThis.fetch,
  now: () => number = Date.now,
): StaffInvitationDependencies {
  if (
    !isExactRecord(configuration, [
      "DESMOSLOCK_ALLOWED_WEB_ORIGIN",
      "DESMOSLOCK_EXPECTED_SUPABASE_ORIGIN",
      "DESMOSLOCK_STAFF_INVITATION_CALLBACK",
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
  const callback =
    allowedOrigin === null
      ? null
      : parseExactCallback(
          configuration.DESMOSLOCK_STAFF_INVITATION_CALLBACK,
          allowedOrigin,
        );
  if (allowedOrigin === null || callback === null) {
    throw new Error("Staff invitation configuration is invalid");
  }
  const client = createSupabaseHttpClient(
    {
      expectedOrigin: String(configuration.DESMOSLOCK_EXPECTED_SUPABASE_ORIGIN),
      publishableKey: String(configuration.SUPABASE_ANON_KEY),
      serviceRoleKey: String(configuration.SUPABASE_SERVICE_ROLE_KEY),
      supabaseUrl: String(configuration.SUPABASE_URL),
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
    now,
    async authorizeInvitation(jwt, input) {
      const result = await callRpc(
        client,
        "begin_staff_invitation",
        {
          email: input.email,
          role: input.role,
          workspace_id: input.workspaceId,
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
    async completeInvitation(invitationId, userId, expiresAt) {
      const result = await callRpc(
        client,
        "internal_complete_staff_invitation",
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
    async deliverInvitation(email) {
      const providerUrl = new URL("/auth/v1/invite", `${client.origin}/`);
      providerUrl.searchParams.set("redirect_to", callback);
      const response = await client.request(providerUrl.href, {
        body: JSON.stringify({ email }),
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
      const responseBody = await readBoundedJsonResponse(response);
      if (!isUnconfirmedInvitedUser(responseBody, email)) {
        return { code: "conflict" };
      }
      const user = isExactRecord(responseBody, ["user"])
        ? responseBody.user
        : responseBody;
      return {
        code: "user_created",
        userId: String((user as Record<string, unknown>).id).toLowerCase(),
      };
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
  };
}

function runtimeDependencies(): StaffInvitationDependencies {
  return createStaffInvitationDependencies({
    DESMOSLOCK_ALLOWED_WEB_ORIGIN: Deno.env.get(
      "DESMOSLOCK_ALLOWED_WEB_ORIGIN",
    ),
    DESMOSLOCK_EXPECTED_SUPABASE_ORIGIN: Deno.env.get(
      "DESMOSLOCK_EXPECTED_SUPABASE_ORIGIN",
    ),
    DESMOSLOCK_STAFF_INVITATION_CALLBACK: Deno.env.get(
      "DESMOSLOCK_STAFF_INVITATION_CALLBACK",
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

export async function handleRequest(
  request: Request,
  injectedDependencies?: StaffInvitationDependencies,
): Promise<Response> {
  let dependencies: StaffInvitationDependencies;
  try {
    dependencies = injectedDependencies ?? runtimeDependencies();
  } catch {
    return codeResponse("dependency_unavailable", 503);
  }
  const corsPolicy = {
    allowedHeaders: ["authorization", "content-type"],
    allowedOrigin: dependencies.allowedOrigin,
  } as const;
  if (request.method === "OPTIONS") {
    return handlePreflight(request, corsPolicy);
  }
  if (!validateRequestOrigin(request, dependencies.allowedOrigin)) {
    return codeResponse("forbidden", 403);
  }
  if (request.method !== "POST") {
    return methodNotAllowedResponse(dependencies.allowedOrigin);
  }
  const jwt = parseBearerJwt(request.headers.get("authorization"));
  if (jwt === null) {
    return codeResponse("unauthenticated", 401, dependencies.allowedOrigin);
  }
  const input = parseInput(await readStrictJson(request));
  if (input === null) {
    return codeResponse("invalid_request", 400, dependencies.allowedOrigin);
  }

  let authorization: InvitationAuthorizationResult;
  try {
    authorization = await dependencies.authorizeInvitation(jwt, {
      email: input.email,
      role: input.role,
      workspaceId: input.workspaceId,
    });
  } catch {
    return codeResponse(
      "dependency_unavailable",
      503,
      dependencies.allowedOrigin,
    );
  }
  if (authorization.code !== "invitation_pending") {
    if (!publicFailureCodes.has(authorization.code)) {
      return codeResponse(
        "dependency_unavailable",
        503,
        dependencies.allowedOrigin,
      );
    }
    return codeResponse(
      authorization.code,
      invitationFailureStatus(authorization.code),
      dependencies.allowedOrigin,
    );
  }
  const invitationId = parseUuid(authorization.invitationId);
  if (invitationId === null) {
    return codeResponse(
      "dependency_unavailable",
      503,
      dependencies.allowedOrigin,
    );
  }

  let delivery: InvitationDeliveryResult;
  try {
    delivery = await dependencies.deliverInvitation(input.email);
  } catch {
    delivery = { code: "dependency_unavailable" };
  }
  const deliveredUserId =
    delivery.code === "user_created" ? parseUuid(delivery.userId) : null;
  if (deliveredUserId === null) {
    const publicCode =
      delivery.code === "user_created"
        ? "dependency_unavailable"
        : delivery.code;
    const recorded = await recordFailedDelivery(
      dependencies,
      invitationId,
      publicCode,
    );
    if (!recorded) {
      return codeResponse(
        "dependency_unavailable",
        503,
        dependencies.allowedOrigin,
      );
    }
    return codeResponse(
      publicCode,
      publicCode === "rate_limited"
        ? 429
        : publicCode === "conflict"
          ? 409
          : 503,
      dependencies.allowedOrigin,
    );
  }

  let expiresAt: string;
  try {
    const now = dependencies.now();
    if (
      !Number.isSafeInteger(now) ||
      now < 0 ||
      now > 8_640_000_000_000_000 - INVITATION_LIFETIME_MILLISECONDS
    ) {
      throw new Error("Clock is invalid");
    }
    expiresAt = new Date(now + INVITATION_LIFETIME_MILLISECONDS).toISOString();
  } catch {
    await recordFailedDelivery(
      dependencies,
      invitationId,
      "dependency_unavailable",
    );
    return codeResponse(
      "dependency_unavailable",
      503,
      dependencies.allowedOrigin,
    );
  }
  let completeCode: string;
  try {
    completeCode = await dependencies.completeInvitation(
      invitationId,
      deliveredUserId,
      expiresAt,
    );
  } catch {
    completeCode = "dependency_unavailable";
  }
  if (completeCode !== "invitation_usable") {
    await recordFailedDelivery(
      dependencies,
      invitationId,
      "dependency_unavailable",
    );
    return codeResponse(
      "dependency_unavailable",
      503,
      dependencies.allowedOrigin,
    );
  }
  return codeResponse("invitation_created", 201, dependencies.allowedOrigin);
}

if (import.meta.main) {
  Deno.serve((request) => handleRequest(request));
}
