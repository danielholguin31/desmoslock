import { createClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSupabaseStaffAuthPort,
  type SupabaseStaffAuthClient,
} from "../src/auth/supabase-staff-auth-port.js";
import { createStaffAuthSessionStorageFixture } from "./helpers/staff-auth-session-storage-fixture.js";

const backend = "https://student-session-sdk.example.test";
const publishableKey = "sb_publishable_rrrrrrrrrrrrrrrrrrrrrr_cccccccc";
const storageKey = "synthetic-student-session-transactional-session";
const accountA = "a1000000-0000-4000-8000-000000000001";
const accountB = "a1000000-0000-4000-8000-000000000002";
const sessionA = "b1000000-0000-4000-8000-000000000001";
const sessionA2 = "b1000000-0000-4000-8000-000000000003";
const sessionB = "b1000000-0000-4000-8000-000000000002";
const scope = {
  schoolId: "11000000-0000-4000-8000-000000000001",
  testId: "31000000-0000-4000-8000-000000000001",
};
const studentSessionId = "51000000-0000-4000-8000-000000000001";
const material = {
  issuanceRequestId: "41000000-0000-4000-8000-000000000001",
  joinMaterialDigest: "a".repeat(64),
};
const rawTarget = { workspace_id: scope.schoolId, test_id: scope.testId };
const rawMaterial = {
  issuance_request_id: material.issuanceRequestId,
  join_material_digest: material.joinMaterialDigest,
};
const cursor = {
  createdAt: "2026-09-08T12:34:56.123457Z",
  sessionId: studentSessionId,
};
type Port = ReturnType<typeof createSupabaseStaffAuthPort>;
interface Operation {
  readonly name: string;
  readonly path: string;
  readonly body: object;
  readonly invoke: (port: Port, handle: string) => Promise<unknown>;
}
const operations = [
  {
    name: "targeted Test read",
    path: "/rest/v1/rpc/current_school_test",
    body: rawTarget,
    invoke: (port, handle) => port.readStudentTarget(scope, handle),
  },
  {
    name: "first Student page",
    path: "/rest/v1/rpc/current_test_student_sessions",
    body: { ...rawTarget, before_created_at: null, before_session_id: null },
    invoke: (port, handle) =>
      port.readStudentSessions({ ...scope, before: null }, handle),
  },
  {
    name: "microsecond Student page",
    path: "/rest/v1/rpc/current_test_student_sessions",
    body: {
      ...rawTarget,
      before_created_at: cursor.createdAt,
      before_session_id: studentSessionId,
    },
    invoke: (port, handle) =>
      port.readStudentSessions({ ...scope, before: cursor }, handle),
  },
  {
    name: "first client report page",
    path: "/rest/v1/rpc/current_student_protection_events",
    body: {
      ...rawTarget,
      student_session_id: studentSessionId,
      before_received_at: null,
      before_event_id: null,
    },
    invoke: (port, handle) =>
      port.readStudentProtectionEvents(
        { ...scope, studentSessionId, before: null },
        handle,
      ),
  },
  {
    name: "microsecond client report page",
    path: "/rest/v1/rpc/current_student_protection_events",
    body: {
      ...rawTarget,
      student_session_id: studentSessionId,
      before_received_at: cursor.createdAt,
      before_event_id: "71000000-0000-4000-8000-000000000001",
    },
    invoke: (port, handle) =>
      port.readStudentProtectionEvents(
        {
          ...scope,
          studentSessionId,
          before: {
            receivedAt: cursor.createdAt,
            eventId: "71000000-0000-4000-8000-000000000001",
          },
        },
        handle,
      ),
  },
  {
    name: "join code issuance",
    path: "/rest/v1/rpc/issue_test_join_code",
    body: { ...rawTarget, ...rawMaterial, expected_test_revision: 7 },
    invoke: (port, handle) =>
      port.issueTestJoinCode(
        { ...scope, ...material, expectedTestRevision: 7 },
        handle,
      ),
  },
  {
    name: "Student removal",
    path: "/rest/v1/rpc/remove_student_session",
    body: {
      ...rawTarget,
      student_session_id: studentSessionId,
      expected_session_revision: 3,
    },
    invoke: (port, handle) =>
      port.removeStudentSession(
        { ...scope, studentSessionId, expectedSessionRevision: 3 },
        handle,
      ),
  },
  {
    name: "targeted readmission",
    path: "/rest/v1/rpc/prepare_student_readmission",
    body: {
      ...rawTarget,
      ...rawMaterial,
      student_session_id: studentSessionId,
      expected_session_revision: 3,
    },
    invoke: (port, handle) =>
      port.prepareStudentReadmission(
        { ...scope, ...material, studentSessionId, expectedSessionRevision: 3 },
        handle,
      ),
  },
] as const satisfies readonly Operation[];
const userPath = "/auth/v1/user";
const reply = [{ code: "synthetic_transport_receipt" }];

function syntheticSession(
  accountId: string,
  providerSessionId: string,
  version: string,
) {
  const now = Math.floor(Date.now() / 1000);
  const accessToken = [
    { alg: "HS256", typ: "JWT" },
    {
      aal: "aal2",
      aud: "authenticated",
      exp: now + 3600,
      iat: now,
      jti: version,
      amr: [
        { method: "password", timestamp: now },
        { method: "totp", timestamp: now },
      ],
      role: "authenticated",
      session_id: providerSessionId,
      sub: accountId,
    },
    "synthetic-signature",
  ]
    .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url"))
    .join(".");
  return {
    access_token: accessToken,
    refresh_token: `synthetic-refresh-${version}`,
    expires_at: now + 3600,
    expires_in: 3600,
    token_type: "bearer",
    user: {
      id: accountId,
      aud: "authenticated",
      app_metadata: {},
      user_metadata: {},
      created_at: "2026-09-01T00:00:00.000Z",
      email:
        accountId === accountA
          ? "teacher-a@example.test"
          : "teacher-b@example.test",
      email_confirmed_at: "2026-09-01T00:00:00.000Z",
    },
  };
}
function handleOf(value: unknown, exact = true): string {
  if (exact)
    expect(value).toEqual({
      status: "ready",
      authorityHandle: expect.any(String),
    });
  if (
    value === null ||
    typeof value !== "object" ||
    !("authorityHandle" in value) ||
    typeof value.authorityHandle !== "string"
  )
    throw new Error("Missing synthetic authority handle");
  return value.authorityHandle;
}
const cleanups: Array<() => void> = [];
afterEach(() => {
  try {
    for (const cleanup of cleanups.splice(0)) cleanup();
  } finally {
    vi.useRealTimers();
  }
});

// Installed SDK + production port. Every HTTP request is intercepted. The
// accepted transactional fixture proves version fencing; native IndexedDB,
// provider authorization and SQL effects have their own acceptance gates.
async function harness() {
  const sessions = {
    A: syntheticSession(accountA, sessionA, "A"),
    B: syntheticSession(accountB, sessionB, "B"),
    A2: syntheticSession(accountA, sessionA2, "A2"),
    AR: syntheticSession(accountA, sessionA, "AR"),
  };
  type Variant = keyof typeof sessions;
  const values = new Map([[storageKey, JSON.stringify(sessions.A)]]);
  const storage = createStaffAuthSessionStorageFixture(storageKey, values);
  const requests: Array<{
    path: string;
    request: Request;
    body: unknown;
    variant: Variant;
  }> = [];
  const unexpected: string[] = [];
  type Outcome =
    | "normal"
    | "lost"
    | "http_error"
    | "bad_json"
    | "oversize"
    | "wrong_type"
    | "redirected"
    | "wrong_url";
  let outcome: Outcome = "normal";
  let userOverride: { body: unknown; status: number } | null = null;
  interface Gate {
    readonly path: string;
    readonly stage: "headers" | "body";
    readonly entered: ReturnType<typeof Promise.withResolvers<AbortSignal>>;
    readonly released: ReturnType<typeof Promise.withResolvers<void>>;
    readonly cancelled: ReturnType<typeof vi.fn<() => void>>;
    finishBody?: () => void;
    release(): void;
  }
  const gates: Gate[] = [];
  let held: Gate | null = null;
  const intercepted: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const variant = (Object.keys(sessions) as Variant[]).find(
      (key) =>
        request.headers.get("authorization") ===
        `Bearer ${sessions[key].access_token}`,
    );
    const isUser = url.pathname === userPath && request.method === "GET";
    const isRpc =
      operations.some((operation) => operation.path === url.pathname) &&
      request.method === "POST";
    if (
      url.origin !== backend ||
      url.search !== "" ||
      variant === undefined ||
      (!isUser && !isRpc)
    ) {
      unexpected.push(`${request.method} ${url.href}`);
      throw new Error("Unexpected synthetic Student request");
    }
    requests.push({
      path: url.pathname,
      request,
      body: isUser ? null : await request.json(),
      variant,
    });
    const gate = held?.path === url.pathname ? held : null;
    if (gate !== null) {
      held = null;
      if (gate.stage === "headers") {
        gate.entered.resolve(request.signal);
        await gate.released.promise;
      } else await new Promise<void>((resolve) => setTimeout(resolve, 4000));
    }
    if (isRpc && outcome === "lost") throw new Error("Synthetic lost response");
    const body = isUser
      ? (userOverride?.body ?? sessions[variant].user)
      : reply;
    const text =
      isRpc && outcome === "bad_json"
        ? "{"
        : isRpc && outcome === "oversize"
          ? `"${"x".repeat(65536)}"`
          : JSON.stringify(body);
    let responseBody: BodyInit = text;
    if (gate?.stage === "body") {
      let cancelled = false;
      responseBody = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(text.slice(0, 1)));
          gate.finishBody = () => {
            if (!cancelled) {
              cancelled = true;
              controller.enqueue(new TextEncoder().encode(text.slice(1)));
              controller.close();
            }
          };
        },
        cancel() {
          cancelled = true;
          gate.cancelled();
        },
      });
      gate.entered.resolve(request.signal);
    }
    const response = new Response(responseBody, {
      status: isUser
        ? (userOverride?.status ?? 200)
        : outcome === "http_error"
          ? 503
          : 200,
      headers: {
        "content-type":
          isRpc && outcome === "wrong_type" ? "text/plain" : "application/json",
      },
    });
    Object.defineProperty(response, "url", {
      value:
        isRpc && outcome === "wrong_url" ? `${backend}/unexpected` : url.href,
    });
    if (isRpc && outcome === "redirected")
      Object.defineProperty(response, "redirected", { value: true });
    return response;
  };
  const client = createClient(backend, publishableKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: true,
      storageKey,
      storage,
    },
    global: { fetch: intercepted },
  });
  await client.auth.getSession();
  const getSession = vi.spyOn(client.auth, "getSession");
  const getUser = vi.spyOn(client.auth, "getUser");
  const schema = vi.spyOn(client, "schema");
  const sdkRpc = vi.spyOn(client, "rpc");
  const invoke = vi.spyOn(client.functions, "invoke");
  const port = createSupabaseStaffAuthPort({
    client: client as unknown as SupabaseStaffAuthClient,
    sessionStorage: storage,
    fetch: intercepted,
    origin: "https://app.example.test",
    url: backend,
    publishableKey,
  });
  cleanups.push(() => {
    port.dispose?.();
    client.auth.stopAutoRefresh();
    for (const gate of gates) gate.release();
    storage.dispose();
    expect(unexpected).toEqual([]);
    expect(getUser).not.toHaveBeenCalled();
    expect(schema).not.toHaveBeenCalled();
    expect(sdkRpc).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });
  return {
    port,
    storage,
    sessions,
    requests,
    getSession,
    rpcRequests: () => requests.filter(({ path }) => path.startsWith("/rest/")),
    async replace(variant: Variant) {
      await storage.setItem(storageKey, JSON.stringify(sessions[variant]));
    },
    unchanged: (variant: Variant) =>
      values.get(storageKey) === JSON.stringify(sessions[variant]),
    async capture() {
      return handleOf(
        await port.captureStudentSessionAuthority(accountA, sessionA),
      );
    },
    setOutcome(value: Outcome) {
      outcome = value;
    },
    setUser(body: unknown, status = 200) {
      userOverride = { body, status };
    },
    hold(path: string, stage: Gate["stage"] = "headers") {
      const gate: Gate = {
        path,
        stage,
        entered: Promise.withResolvers<AbortSignal>(),
        released: Promise.withResolvers<void>(),
        cancelled: vi.fn(),
        release() {
          this.released.resolve();
          this.finishBody?.();
        },
      };
      gates.push(gate);
      held = gate;
      return gate;
    },
  };
}

describe("installed SDK StudentSession authority", () => {
  it.each(operations)(
    "sends the exact fixed $name request with captured authority and no SDK RPC",
    async (operation) => {
      const h = await harness();
      const handle = await h.capture();
      await expect(operation.invoke(h.port, handle)).resolves.toEqual(reply);
      expect(h.getSession).toHaveBeenCalledTimes(1);
      expect(h.requests).toHaveLength(2);
      const sent = h.rpcRequests()[0]!;
      expect(sent.path).toBe(operation.path);
      expect(sent.body).toEqual(operation.body);
      expect(sent.request.headers.get("authorization")).toBe(
        `Bearer ${h.sessions.A.access_token}`,
      );
      expect(sent.request.headers.get("content-profile")).toBe("desmoslock_v2");
      expect(sent.request.headers.get("apikey")).toBe(publishableKey);
      expect(sent.request.redirect).toBe("error");
      expect(sent.request.credentials).toBe("omit");
      expect(sent.request.referrerPolicy).toBe("no-referrer");
      expect(h.unchanged("A")).toBe(true);
    },
  );

  it.each(operations)(
    "blocks $name before egress after stored authority changes",
    async (operation) => {
      const h = await harness();
      const handle = await h.capture();
      await h.replace("A2");
      await expect(operation.invoke(h.port, handle)).resolves.toBeNull();
      expect(h.rpcRequests()).toEqual([]);
      expect(h.unchanged("A2")).toBe(true);
      const fresh = handleOf(
        await h.port.captureStudentSessionAuthority(accountA, sessionA2),
      );
      await expect(operation.invoke(h.port, fresh)).resolves.toEqual(reply);
      expect(h.rpcRequests()[0]?.variant).toBe("A2");
    },
  );

  it.each(["B", "A2", "AR"] as const)(
    "rejects capture if %s replaces storage during provider verification",
    async (variant) => {
      const h = await harness();
      const gate = h.hold(userPath);
      const capture = h.port.captureStudentSessionAuthority(accountA, sessionA);
      await gate.entered.promise;
      await h.replace(variant);
      gate.release();
      await expect(capture).resolves.toEqual({ status: "unavailable" });
      expect(h.rpcRequests()).toEqual([]);
      expect(h.unchanged(variant)).toBe(true);
    },
  );

  it("rejects stale expected SID, provider identity mismatch and missing transactional storage", async () => {
    const h = await harness();
    await h.replace("A2");
    await expect(
      h.port.captureStudentSessionAuthority(accountA, sessionA),
    ).resolves.toEqual({ status: "unavailable" });
    h.setUser(h.sessions.B.user);
    await expect(
      h.port.captureStudentSessionAuthority(accountA, sessionA2),
    ).resolves.toEqual({ status: "unavailable" });
    expect(h.rpcRequests()).toEqual([]);
    const client = { auth: { getSession: vi.fn() } };
    const unbound = createSupabaseStaffAuthPort({
      client: client as unknown as SupabaseStaffAuthClient,
      fetch: vi.fn(),
      origin: backend,
      publishableKey,
      url: backend,
    });
    await expect(
      unbound.captureStudentSessionAuthority(accountA, sessionA),
    ).resolves.toEqual({ status: "unavailable" });
    expect(client.auth.getSession).not.toHaveBeenCalled();
    unbound.dispose?.();
  });

  it("rejects an A-to-B-to-A storage ABA even when the original bytes return", async () => {
    const h = await harness();
    const handle = await h.capture();
    await h.replace("B");
    await h.replace("A");
    await expect(operations[3].invoke(h.port, handle)).resolves.toBeNull();
    expect(h.rpcRequests()).toEqual([]);
    expect(h.unchanged("A")).toBe(true);
    await expect(
      operations[3].invoke(h.port, await h.capture()),
    ).resolves.toEqual(reply);
  });

  it.each(operations)(
    "discards late $name results under a replacement account",
    async (operation) => {
      const h = await harness();
      const handle = await h.capture();
      const gate = h.hold(operation.path);
      const request = operation.invoke(h.port, handle);
      await gate.entered.promise;
      await h.replace("B");
      gate.release();
      await expect(request).resolves.toBeNull();
      expect(h.rpcRequests()).toHaveLength(1);
      expect(h.rpcRequests()[0]?.variant).toBe("A");
      expect(h.unchanged("B")).toBe(true);
    },
  );

  it("keeps Student, Test, MFA, auth-read and password handles disjoint, including release", async () => {
    const h = await harness();
    const student = await h.capture();
    const test = handleOf(
      await h.port.captureTestWorkspaceAuthority(accountA, sessionA),
    );
    const mfa = await h.port.captureMfaAuthority(accountA, sessionA);
    const auth = handleOf(await h.port.captureAuthReadAuthority(), false);
    const password = await h.port.capturePasswordAuthority(accountA, sessionA);
    expect(typeof mfa).toBe("string");
    expect(typeof password).toBe("string");
    for (const foreign of [test, mfa!, auth, password!]) {
      for (const operation of operations)
        await expect(operation.invoke(h.port, foreign)).resolves.toBeNull();
    }
    await expect(h.port.readSchoolTest(scope, student)).resolves.toBeNull();
    await expect(h.port.readCurrentContext(student)).resolves.toBeNull();
    expect(h.rpcRequests()).toEqual([]);
    h.port.releaseTestWorkspaceAuthority(student);
    h.port.releaseStudentSessionAuthority(test);
    await expect(operations[0].invoke(h.port, student)).resolves.toEqual(reply);
    await expect(h.port.readSchoolTest(scope, test)).resolves.toEqual(reply);
    h.port.releaseStudentSessionAuthority(student);
    await expect(operations[0].invoke(h.port, student)).resolves.toBeNull();
    expect(h.rpcRequests()).toHaveLength(2);
  });

  it("invalidates the handle at 60 seconds and on private-generation or disposal changes", async () => {
    vi.useFakeTimers();
    const h = await harness();
    const handle = await h.capture();
    await vi.advanceTimersByTimeAsync(59999);
    await expect(operations[1].invoke(h.port, handle)).resolves.toEqual(reply);
    await vi.advanceTimersByTimeAsync(1);
    await expect(operations[1].invoke(h.port, handle)).resolves.toBeNull();
    const next = await h.capture();
    h.port.clearPrivateAuthContinuations();
    await expect(operations[1].invoke(h.port, next)).resolves.toBeNull();
    const final = await h.capture();
    h.port.dispose?.();
    await expect(operations[1].invoke(h.port, final)).resolves.toBeNull();
    expect(h.rpcRequests()).toHaveLength(1);
  });

  it("rechecks handle generation after an awaited storage-current check", async () => {
    const h = await harness();
    const handle = await h.capture();
    const entered = Promise.withResolvers<void>();
    const released = Promise.withResolvers<boolean>();
    vi.spyOn(h.storage, "isCurrentSession").mockImplementationOnce(async () => {
      entered.resolve();
      return released.promise;
    });
    const request = operations[3].invoke(h.port, handle);
    await entered.promise;
    h.port.clearPrivateAuthContinuations();
    released.resolve(true);
    await expect(request).resolves.toBeNull();
    expect(h.rpcRequests()).toEqual([]);
  });

  it("requires fresh capture after a same-SID token renewal", async () => {
    const h = await harness();
    const handle = await h.capture();
    await h.replace("AR");
    await expect(operations[3].invoke(h.port, handle)).resolves.toBeNull();
    await expect(
      operations[3].invoke(h.port, await h.capture()),
    ).resolves.toEqual(reply);
    expect(h.rpcRequests()).toHaveLength(1);
    expect(h.rpcRequests()[0]?.variant).toBe("AR");
  });

  it.each([
    "lost",
    "http_error",
    "bad_json",
    "oversize",
    "wrong_type",
    "redirected",
    "wrong_url",
  ] as const)(
    "rejects %s without another request or SDK fallback",
    async (outcome) => {
      const h = await harness();
      const handle = await h.capture();
      h.setOutcome(outcome);
      await expect(operations[3].invoke(h.port, handle)).resolves.toBeNull();
      expect(h.rpcRequests()).toHaveLength(1);
    },
  );

  it("bounds headers and body by one five-second request deadline", async () => {
    vi.useFakeTimers();
    const h = await harness();
    const handle = await h.capture();
    const gate = h.hold(operations[3].path, "body");
    const request = operations[3].invoke(h.port, handle);
    await vi.advanceTimersByTimeAsync(4000);
    const signal = await gate.entered.promise;
    await vi.advanceTimersByTimeAsync(1000);
    await expect(request).resolves.toBeNull();
    expect(signal.aborted).toBe(true);
    expect(gate.cancelled).toHaveBeenCalled();
    gate.release();
    expect(h.rpcRequests()).toHaveLength(1);
  });

  it("rejects authority replacement while a partial response body is pending", async () => {
    vi.useFakeTimers();
    const h = await harness();
    const handle = await h.capture();
    const gate = h.hold(operations[3].path, "body");
    const request = operations[3].invoke(h.port, handle);
    await vi.advanceTimersByTimeAsync(4000);
    await gate.entered.promise;
    await h.replace("A2");
    gate.release();
    await expect(request).resolves.toBeNull();
    expect(h.unchanged("A2")).toBe(true);
  });
});
