import { createClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createSupabaseStaffAuthPort,
  type SupabaseStaffAuthClient,
} from "../src/auth/supabase-staff-auth-port.js";

const backend = "https://test-workspace-sdk.example.test";
const publishableKey = "sb_publishable_rrrrrrrrrrrrrrrrrrrrrr_cccccccc";
const storageKey = "synthetic-test-workspace-sdk-session";
const accounts = {
  A: "a1000000-0000-4000-8000-000000000001",
  B: "a1000000-0000-4000-8000-000000000002",
} as const;
type Account = keyof typeof accounts;
const providerSessionIds: Record<Account, string> = {
  A: "b1000000-0000-4000-8000-000000000001",
  B: "b1000000-0000-4000-8000-000000000002",
};
const replacementSessionId = "b1000000-0000-4000-8000-000000000003";
type SessionVariant = Account | "A2" | "AR";
type Port = ReturnType<typeof createSupabaseStaffAuthPort>;
type Method =
  | "readSchoolTests"
  | "readSchoolTest"
  | "createSchoolTest"
  | "updateTestTitle"
  | "openTest"
  | "endTest";
const schoolId = "11000000-0000-4000-8000-000000000001";
const testId = "31000000-0000-4000-8000-000000000001";
const creationRequestId = "91000000-0000-4000-8000-000000000001";
const cursor = { createdAt: "2026-09-08T12:34:56.123457Z", testId };
const title = "Équations — Test 1";
const target = { schoolId, testId, expectedTestRevision: 7 };
const row = {
  code: "ok",
  test_id: testId,
  school_id: schoolId,
  created_by_profile_id: "21000000-0000-4000-8000-000000000001",
  title,
  lifecycle: "draft",
  test_revision: 7,
  created_at: "2026-09-08T12:34:56.123456Z",
  opened_at: null,
  ended_at: null,
};
interface Operation {
  readonly name: string;
  readonly method: Method;
  readonly path: string;
  readonly request: unknown;
  readonly body: Readonly<Record<string, unknown>>;
  readonly response: unknown;
  readonly invoke: (port: Port, handle: string) => Promise<unknown>;
}
const operations = [
  {
    name: "first Test page",
    method: "readSchoolTests",
    path: "/rest/v1/rpc/current_school_tests",
    request: { schoolId, before: null },
    body: {
      workspace_id: schoolId,
      before_created_at: null,
      before_test_id: null,
    },
    response: [row],
    invoke: (port, handle) =>
      port.readSchoolTests({ schoolId, before: null }, handle),
  },
  {
    name: "microsecond Test page",
    method: "readSchoolTests",
    path: "/rest/v1/rpc/current_school_tests",
    request: { schoolId, before: cursor },
    body: {
      workspace_id: schoolId,
      before_created_at: "2026-09-08T12:34:56.123457Z",
      before_test_id: testId,
    },
    response: [row],
    invoke: (port, handle) =>
      port.readSchoolTests({ schoolId, before: cursor }, handle),
  },
  {
    name: "Test detail",
    method: "readSchoolTest",
    path: "/rest/v1/rpc/current_school_test",
    request: { schoolId, testId },
    body: { workspace_id: schoolId, test_id: testId },
    response: [row],
    invoke: (port, handle) => port.readSchoolTest({ schoolId, testId }, handle),
  },
  {
    name: "Test creation",
    method: "createSchoolTest",
    path: "/rest/v1/rpc/create_school_test",
    request: { schoolId, creationRequestId, title },
    body: {
      workspace_id: schoolId,
      creation_request_id: creationRequestId,
      title,
    },
    response: [{ code: "test_created", test_id: testId }],
    invoke: (port, handle) =>
      port.createSchoolTest({ schoolId, creationRequestId, title }, handle),
  },
  {
    name: "Test title update",
    method: "updateTestTitle",
    path: "/rest/v1/rpc/update_test_title",
    request: { ...target, title },
    body: {
      workspace_id: schoolId,
      test_id: testId,
      title,
      expected_test_revision: 7,
    },
    response: [{ code: "test_title_updated" }],
    invoke: (port, handle) =>
      port.updateTestTitle({ ...target, title }, handle),
  },
  {
    name: "Test opening",
    method: "openTest",
    path: "/rest/v1/rpc/open_test",
    request: target,
    body: {
      workspace_id: schoolId,
      test_id: testId,
      expected_test_revision: 7,
    },
    response: [{ code: "test_opened" }],
    invoke: (port, handle) => port.openTest(target, handle),
  },
  {
    name: "Test ending",
    method: "endTest",
    path: "/rest/v1/rpc/end_test",
    request: target,
    body: {
      workspace_id: schoolId,
      test_id: testId,
      expected_test_revision: 7,
    },
    response: [{ code: "test_ended" }],
    invoke: (port, handle) => port.endTest(target, handle),
  },
] as const satisfies readonly Operation[];

function session(
  account: Account,
  providerSessionId = providerSessionIds[account],
  tokenVersion = 0,
) {
  const accessToken = [
    { alg: "HS256", typ: "JWT" },
    {
      exp: Math.floor(Date.now() / 1_000) + 3_600,
      sub: accounts[account],
      session_id: providerSessionId,
      jti: String(tokenVersion),
    },
    "synthetic-signature",
  ]
    .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url"))
    .join(".");
  return {
    access_token: accessToken,
    expires_at: Math.floor(Date.now() / 1_000) + 3_600,
    expires_in: 3_600,
    refresh_token: `synthetic-test-workspace-${account}-refresh`,
    token_type: "bearer",
    user: { id: accounts[account] },
  };
}

function readyHandle(value: unknown): string {
  expect(value).toEqual({
    status: "ready",
    authorityHandle: expect.any(String),
  });
  if (
    typeof value !== "object" ||
    value === null ||
    !("authorityHandle" in value) ||
    typeof value.authorityHandle !== "string"
  ) {
    throw new Error("Missing synthetic authority handle");
  }
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

// Installed SDK plus real port, with every HTTP request intercepted. These are
// transport/account-binding checks, not live SQL, pagination or lifecycle proof.
async function harness() {
  const sessions = {
    A: session("A"),
    B: session("B"),
    A2: session("A", replacementSessionId),
    AR: session("A", providerSessionIds.A, 1),
  };
  const storage = new Map([[storageKey, JSON.stringify(sessions.A)]]);
  const requests: Array<{ account: Account; request: Request; body: unknown }> =
    [];
  const unexpectedRequests: string[] = [];
  let verification: { body: unknown; status: number } | undefined;
  let outcome: "normal" | "lost" | "bad_json" | "http_error" | "unknown" =
    "normal";
  const unknownResponse = [
    { code: "unknown_test_result", detail: "synthetic diagnostic" },
  ];
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
  let hold: Gate | undefined;
  const intercepted: typeof fetch = async (input, init) => {
    const fetched = new Request(input, init);
    const url = new URL(fetched.url);
    const variant = (Object.keys(sessions) as SessionVariant[]).find(
      (key) =>
        fetched.headers.get("authorization") ===
        `Bearer ${sessions[key].access_token}`,
    );
    const account = variant === undefined ? null : variant === "B" ? "B" : "A";
    const isVerification =
      url.pathname === "/auth/v1/user" && fetched.method === "GET";
    const operation = operations.find(
      (candidate) => candidate.path === url.pathname,
    );
    if (
      url.origin !== backend ||
      account === null ||
      !(
        isVerification ||
        (operation !== undefined && fetched.method === "POST")
      )
    ) {
      unexpectedRequests.push(url.href);
      throw new Error("Unexpected synthetic Test workspace request");
    }
    requests.push({
      account,
      request: fetched,
      body: fetched.method === "GET" ? null : await fetched.json(),
    });
    const gate = hold?.path === url.pathname ? hold : undefined;
    if (gate !== undefined) {
      hold = undefined;
      if (gate.stage === "headers") {
        gate.entered.resolve(fetched.signal);
        // Ignore abort, forcing the caller to reject a late HTTP response.
        await gate.released.promise;
      } else {
        // The body gets only the remainder of the same five-second deadline.
        await new Promise<void>((resolve) => setTimeout(resolve, 4_000));
      }
    }
    if (!isVerification && outcome === "lost")
      throw new Error("Synthetic Test response lost");
    const raw = isVerification
      ? (verification?.body ?? sessions[account].user)
      : outcome === "unknown"
        ? unknownResponse
        : operation!.response;
    const body =
      !isVerification && outcome === "bad_json" ? "{" : JSON.stringify(raw);
    const status = isVerification
      ? (verification?.status ?? 200)
      : outcome === "http_error"
        ? 503
        : 200;
    let responseBody: BodyInit = body;
    if (gate?.stage === "body") {
      let cancelled = false;
      responseBody = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(body.slice(0, 1)));
          gate.finishBody = () => {
            if (cancelled) return;
            controller.enqueue(new TextEncoder().encode(body.slice(1)));
            controller.close();
          };
        },
        cancel() {
          cancelled = true;
          gate.cancelled();
        },
      });
      gate.entered.resolve(fetched.signal);
    }
    const response = new Response(responseBody, {
      status,
      headers: { "content-type": "application/json" },
    });
    Object.defineProperty(response, "url", { value: url.href });
    return response;
  };
  const client = createClient(backend, publishableKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: true,
      storageKey,
      storage: {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => {
          storage.set(key, value);
        },
        removeItem: (key) => {
          storage.delete(key);
        },
      },
    },
    global: { fetch: intercepted },
  });
  await client.auth.getSession();
  const getSession = vi.spyOn(client.auth, "getSession");
  const getUser = vi.spyOn(client.auth, "getUser");
  const database = client.schema("desmoslock_v2");
  const sdkRpc = vi.spyOn(database, "rpc");
  const schema = vi.spyOn(client, "schema").mockReturnValue(database);
  const invoke = vi.spyOn(client.functions, "invoke");
  const port = createSupabaseStaffAuthPort({
    client: client as unknown as SupabaseStaffAuthClient,
    fetch: intercepted,
    origin: "https://app.example.test",
    publishableKey,
    url: backend,
  });
  cleanups.push(() => {
    port.clearPrivateAuthContinuations();
    client.auth.stopAutoRefresh();
    for (const gate of gates) gate.release();
    expect(unexpectedRequests).toEqual([]);
    expect(getUser).not.toHaveBeenCalled();
    expect(sdkRpc).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    expect(schema).toHaveBeenCalledOnce();
  });
  return {
    getSession,
    sessions,
    replaceSession(variant: SessionVariant) {
      storage.set(storageKey, JSON.stringify(sessions[variant]));
    },
    sessionUnchanged: (variant: SessionVariant) =>
      storage.get(storageKey) === JSON.stringify(sessions[variant]),
    port,
    requests,
    unknownResponse,
    async capture() {
      return readyHandle(
        await port.captureTestWorkspaceAuthority(
          accounts.A,
          providerSessionIds.A,
        ),
      );
    },
    setVerification(body: unknown, status: number) {
      verification = { body, status };
    },
    setOutcome(value: typeof outcome) {
      outcome = value;
    },
    replaceAccount(account: Account) {
      storage.set(storageKey, JSON.stringify(sessions[account]));
    },
    replacementUnchanged: () =>
      storage.get(storageKey) === JSON.stringify(sessions.B),
    rpcRequests: () =>
      requests.filter(({ request }) =>
        new URL(request.url).pathname.startsWith("/rest/"),
      ),
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
      hold = gate;
      return gate;
    },
  };
}

describe("installed SDK Test workspace authority", () => {
  it("refuses same-account replacement S2 before capture with no read or write egress and recovers with fresh expected S2", async () => {
    const h = await harness();
    h.replaceSession("A2");
    await expect(
      h.port.captureTestWorkspaceAuthority(accounts.A, providerSessionIds.A),
    ).resolves.toEqual({ status: "unavailable" });
    expect(h.rpcRequests()).toEqual([]);
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]?.request.headers.get("authorization")).toBe(
      `Bearer ${h.sessions.A2.access_token}`,
    );
    expect(h.sessionUnchanged("A2")).toBe(true);
    const handle = readyHandle(
      await h.port.captureTestWorkspaceAuthority(
        accounts.A,
        replacementSessionId,
      ),
    );
    await expect(operations[0].invoke(h.port, handle)).resolves.toEqual(
      operations[0].response,
    );
    expect(h.rpcRequests()).toHaveLength(1);
    expect(h.rpcRequests()[0]?.request.headers.get("authorization")).toBe(
      `Bearer ${h.sessions.A2.access_token}`,
    );
  });

  it.each(operations)(
    "accepts renewed S1 for $name and sends only that token after storage becomes S2",
    async (operation) => {
      const h = await harness();
      h.replaceSession("AR");
      const handle = await h.capture();
      h.replaceSession("A2");
      await expect(operation.invoke(h.port, handle)).resolves.toEqual(
        operation.response,
      );
      expect(h.requests).toHaveLength(2);
      expect(
        h.requests.every(
          ({ request }) =>
            request.headers.get("authorization") ===
            `Bearer ${h.sessions.AR.access_token}`,
        ),
      ).toBe(true);
      expect(h.rpcRequests()[0]?.body).toEqual(operation.body);
      expect(h.sessionUnchanged("A2")).toBe(true);
    },
  );

  describe.each(["during verification", "after capture"] as const)(
    "same-account S2 replaces storage %s",
    (timing) => {
      it.each(operations)("keeps original S1 for $name", async (operation) => {
        const h = await harness();
        const gate =
          timing === "during verification"
            ? h.hold("/auth/v1/user")
            : undefined;
        const capture = h.capture();
        let handle: string;
        if (gate !== undefined) {
          await gate.entered.promise;
          h.replaceSession("A2");
          gate.release();
          handle = await capture;
        } else {
          handle = await capture;
          h.replaceSession("A2");
        }
        await expect(operation.invoke(h.port, handle)).resolves.toEqual(
          operation.response,
        );
        expect(h.requests).toHaveLength(2);
        expect(
          h.requests.every(
            ({ request }) =>
              request.headers.get("authorization") ===
              `Bearer ${h.sessions.A.access_token}`,
          ),
        ).toBe(true);
        expect(h.rpcRequests()[0]?.body).toEqual(operation.body);
        expect(h.sessionUnchanged("A2")).toBe(true);
      });
    },
  );

  it("refuses replacement B before capture without any verification, read or write egress", async () => {
    const h = await harness();
    h.replaceAccount("B");
    await expect(
      h.port.captureTestWorkspaceAuthority(accounts.A, providerSessionIds.A),
    ).resolves.toEqual({ status: "unavailable" });
    expect(h.requests).toEqual([]);
    expect(h.getSession).toHaveBeenCalledOnce();
    expect(h.replacementUnchanged()).toBe(true);
  });

  describe.each(["during verification", "after capture"] as const)(
    "SDK storage becomes B %s",
    (timing) => {
      it.each(operations)(
        "sends the exact $name request using only captured token A",
        async (operation) => {
          const h = await harness();
          let handle: string;
          if (timing === "during verification") {
            const gate = h.hold("/auth/v1/user");
            const capture = h.capture();
            await gate.entered.promise;
            h.replaceAccount("B");
            gate.release();
            handle = await capture;
          } else {
            handle = await h.capture();
            h.replaceAccount("B");
          }
          await expect(operation.invoke(h.port, handle)).resolves.toEqual(
            operation.response,
          );
          expect(h.requests.map(({ account }) => account)).toEqual(["A", "A"]);
          const sent = h.rpcRequests()[0]!;
          expect(sent.request.url).toBe(`${backend}${operation.path}`);
          expect(sent.body).toEqual(operation.body);
          expect(Object.fromEntries(sent.request.headers)).toEqual({
            apikey: publishableKey,
            authorization: `Bearer ${h.sessions.A.access_token}`,
            "content-profile": "desmoslock_v2",
            "content-type": "application/json",
          });
          expect(sent.request.method).toBe("POST");
          expect(sent.request.credentials).toBe("omit");
          expect(sent.request.redirect).toBe("error");
          expect(sent.request.referrerPolicy).toBe("no-referrer");
          expect(h.getSession).toHaveBeenCalledOnce();
          expect(h.replacementUnchanged()).toBe(true);
        },
      );
    },
  );

  it.each([
    "missing",
    "unknown",
    "expired",
    "released",
    "reset",
    "password",
    "logout",
    "staff_management",
    "school_settings",
  ] as const)(
    "rejects %s handles for every Test reader and writer without fallback",
    async (kind) => {
      const h = await harness();
      vi.useFakeTimers();
      const handle =
        kind === "password"
          ? await h.port.capturePasswordAuthority(
              accounts.A,
              providerSessionIds.A,
            )
          : kind === "logout"
            ? readyHandle(
                await h.port.captureSignOutAuthority(
                  accounts.A,
                  providerSessionIds.A,
                ),
              )
            : kind === "staff_management"
              ? readyHandle(
                  await h.port.captureStaffManagementAuthority(
                    accounts.A,
                    providerSessionIds.A,
                  ),
                )
              : kind === "school_settings"
                ? readyHandle(
                    await h.port.captureSchoolSettingsAuthority(
                      accounts.A,
                      providerSessionIds.A,
                    ),
                  )
                : await h.capture();
      if (handle === null)
        throw new Error("Missing synthetic authority handle");
      if (kind === "expired") await vi.advanceTimersByTimeAsync(60_000);
      if (kind === "released") h.port.releaseTestWorkspaceAuthority(handle);
      if (kind === "reset") h.port.clearPrivateAuthContinuations();
      h.replaceAccount("B");
      const args =
        kind === "missing"
          ? []
          : [kind === "unknown" ? "unknown-test-handle" : handle];
      for (const operation of operations) {
        await expect(
          Reflect.apply(h.port[operation.method], h.port, [
            operation.request,
            ...args,
          ]),
        ).resolves.toBeNull();
      }
      expect(h.requests).toHaveLength(1);
      expect(h.rpcRequests()).toEqual([]);
      expect(h.getSession).toHaveBeenCalledOnce();
      expect(h.replacementUnchanged()).toBe(true);
    },
  );

  it.each([
    [{ code: "session_not_found", message: "Synthetic ended session" }, 403],
    [{ code: "session_expired", message: "Synthetic expired session" }, 401],
    [{ id: accounts.B }, 200],
    [{}, 200],
    [{ code: "session_expired", message: "Synthetic dependency failure" }, 503],
  ] as const)(
    "reduces capture verification %j at HTTP %s to unavailable",
    async (body, status) => {
      const h = await harness();
      h.setVerification(body, status);
      await expect(
        h.port.captureTestWorkspaceAuthority(accounts.A, providerSessionIds.A),
      ).resolves.toEqual({ status: "unavailable" });
      expect(h.requests).toHaveLength(1);
      expect(h.rpcRequests()).toEqual([]);
    },
  );

  it("cannot return a pending Test capability after private continuations are reset", async () => {
    const h = await harness();
    const gate = h.hold("/auth/v1/user");
    const capture = h.port.captureTestWorkspaceAuthority(
      accounts.A,
      providerSessionIds.A,
    );
    await gate.entered.promise;
    h.port.clearPrivateAuthContinuations();
    gate.release();
    await expect(capture).resolves.toEqual({ status: "unavailable" });
    expect(h.rpcRequests()).toEqual([]);
  });

  describe.each(["lost", "bad_json", "http_error", "unknown"] as const)(
    "untrusted %s response",
    (outcome) => {
      it.each([operations[0], operations[3], operations[6]])(
        "does not fabricate success or retry $name with replacement B",
        async (operation) => {
          const h = await harness();
          const handle = await h.capture();
          h.replaceAccount("B");
          h.setOutcome(outcome);
          // Valid JSON with unknown fields/codes stays raw for the contract parser.
          await expect(operation.invoke(h.port, handle)).resolves.toEqual(
            outcome === "unknown" ? h.unknownResponse : null,
          );
          expect(h.rpcRequests()).toHaveLength(1);
          expect(h.rpcRequests()[0]?.account).toBe("A");
          expect(h.getSession).toHaveBeenCalledOnce();
          expect(h.replacementUnchanged()).toBe(true);
        },
      );
    },
  );

  describe.each(["headers", "body"] as const)("stalled %s", (stage) => {
    it.each([
      { name: "capture", path: "/auth/v1/user", operation: null },
      {
        name: "Test list read",
        path: operations[0].path,
        operation: operations[0],
      },
      {
        name: "Test ending write",
        path: operations[6].path,
        operation: operations[6],
      },
    ])(
      "bounds $name by one five-second deadline and permits fresh recovery",
      async ({ path, operation }) => {
        const h = await harness();
        vi.useFakeTimers();
        const handle = operation === null ? null : await h.capture();
        const gate = h.hold(path, stage);
        const pending =
          operation === null
            ? h.port.captureTestWorkspaceAuthority(
                accounts.A,
                providerSessionIds.A,
              )
            : operation.invoke(h.port, handle!);
        const settled = vi.fn();
        void pending.then(settled);
        if (stage === "body") await vi.advanceTimersByTimeAsync(4_000);
        const signal = await gate.entered.promise;
        h.replaceAccount("B");
        await vi.advanceTimersByTimeAsync(stage === "body" ? 999 : 4_999);
        expect(settled).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        const expected = operation === null ? { status: "unavailable" } : null;
        await expect(pending).resolves.toEqual(expected);
        expect(signal.aborted).toBe(true);
        expect(settled).toHaveBeenCalledExactlyOnceWith(expected);
        if (stage === "body") expect(gate.cancelled).toHaveBeenCalledOnce();
        gate.release();
        await vi.advanceTimersByTimeAsync(0);
        expect(settled).toHaveBeenCalledOnce();
        expect(h.rpcRequests()).toHaveLength(operation === null ? 0 : 1);
        expect(h.getSession).toHaveBeenCalledOnce();
        expect(h.replacementUnchanged()).toBe(true);

        // Recovery is a new explicitly captured read, never a mutation replay.
        if (handle !== null) h.port.releaseTestWorkspaceAuthority(handle);
        h.replaceAccount("A");
        const fresh = await h.capture();
        await expect(
          h.port.readSchoolTests({ schoolId, before: null }, fresh),
        ).resolves.toEqual([row]);
        expect(h.getSession).toHaveBeenCalledTimes(2);
        expect(h.rpcRequests()).toHaveLength(operation === null ? 1 : 2);
        expect(h.requests.every(({ account }) => account === "A")).toBe(true);
        expect(
          h
            .rpcRequests()
            .filter(
              ({ request }) =>
                new URL(request.url).pathname === "/rest/v1/rpc/end_test",
            ),
        ).toHaveLength(operation?.method === "endTest" ? 1 : 0);
      },
    );
  });
});
