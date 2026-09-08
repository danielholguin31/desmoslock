import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  StudentChallengeRequest,
  StudentForfeitRequest,
  StudentJoinRequest,
  StudentReadRequest,
  StudentReconnectRequest,
  StudentEvidenceRequest,
  NativeProtectionFact,
} from "@desmoslock/contracts";
import { createStudentSessionCrypto } from "../src/main/student-session-crypto.js";
import {
  createStudentSessionTransport,
  type StudentSessionFetch,
} from "../src/main/student-session-transport.js";

const configuration = {
  environment: "local",
  url: "http://127.0.0.1:54321",
} as const;
const denied = { status: "denied", code: "STUDENT_SESSION_DENIED" } as const;
const unavailable = {
  status: "unavailable",
  code: "STUDENT_SESSION_UNAVAILABLE",
} as const;
const requestId = "10000000-0000-4000-8000-000000000001";
const deviceSessionId = "20000000-0000-4000-8000-000000000001";
const challengeId = "60000000-0000-4000-8000-000000000001";
const digest = "a".repeat(64);
const scope = {
  schoolId: "30000000-0000-4000-8000-000000000001",
  testId: "40000000-0000-4000-8000-000000000001",
  studentSessionId: "50000000-0000-4000-8000-000000000001",
  deviceSessionId,
  epoch: 1,
};
const challenge: StudentChallengeRequest = {
  requestId,
  deviceSessionId,
  publicKey: "A".repeat(43),
  logicalOperationDigest: digest,
};
const join: StudentJoinRequest = {
  admissionMode: "initial",
  requestId,
  deviceSessionId,
  joinCode: "0123456789AB",
  capabilityDigest: "b".repeat(64),
  reconnectDigest: "c".repeat(64),
  deviceProof: {
    challengeId,
    expiresAtMs: 1_015_000,
    publicKey: challenge.publicKey,
    signature: "A".repeat(86),
  },
};
const read: StudentReadRequest = {
  requestId,
  scope,
  capabilityToken: "A".repeat(43),
  deviceProof: { counter: 1, signature: "A".repeat(86) },
};
const reconnect: StudentReconnectRequest = {
  requestId,
  scope,
  expectedSessionRevision: 1,
  reconnectGrant: "A".repeat(43),
  nextCapabilityDigest: "d".repeat(64),
  nextReconnectDigest: "e".repeat(64),
  deviceProof: read.deviceProof,
};
const forfeit: StudentForfeitRequest = { ...read, expectedSessionRevision: 1 };
const acceptedJoin = {
  status: "accepted",
  code: "STUDENT_SESSION_ACCEPTED",
  requestId,
  logicalOperationDigest: digest,
  scope,
  sessionRevision: 1,
  syntheticDisplayName: "Student A1",
  serverNowMs: 1_000_000,
  capabilityIssuedAtMs: 1_000_000,
  capabilityExpiresAtMs: 1_300_000,
  reconnectExpiresAtMs: 1_900_000,
  allowedIntents: ["state.read", "session.forfeit"],
};
const acceptedRead = {
  status: "accepted",
  code: "STUDENT_SESSION_CURRENT",
  requestId,
  acceptedProofCounter: 1,
  scope,
  sessionRevision: 1,
  syntheticDisplayName: "Student A1",
  testLifecycle: "open",
  state: "active",
  serverNowMs: 1_000_000,
  capabilityExpiresAtMs: 1_300_000,
};
function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function evidenceFixture() {
  const crypto = createStudentSessionCrypto(configuration);
  const device = crypto.createEnrollment();
  const fact: NativeProtectionFact = {
    sequence: 1,
    eventId: "80000000-0000-4000-8000-000000000001",
    attemptId: "90000000-0000-4000-8000-000000000001",
    scope: { ...scope, deviceSessionId: device.deviceSessionId },
    policyVersion: 1,
    slot: "engaging",
    phase: "engaging",
    nativeEvent: null,
    nativeSequence: null,
    categories: {
      aac: { status: "pending", code: "awaiting_native_begin" },
      shortcuts: { status: "confirmed", code: "none" },
      applications: { status: "confirmed", code: "none" },
      persistence: { status: "confirmed", code: "none" },
      windowNetwork: { status: "confirmed", code: "none" },
    },
    cause: "none",
  };
  const originBuild = { kind: "unverified_build" } as const;
  const content = crypto.digestEvidence(device, {
    scope: fact.scope,
    originBuild,
    facts: [fact],
  });
  const request: StudentEvidenceRequest = {
    version: 1,
    scope: fact.scope,
    originBuild,
    facts: [fact],
    publicKey: device.publicKey,
    batchDigest: content.batchDigest,
    deviceProof: crypto.signEvidence(device, {
      scope: fact.scope,
      batchDigest: content.batchDigest,
      counter: 11,
    }),
  };
  const accepted = {
    status: "accepted",
    code: "STUDENT_EVIDENCE_ACCEPTED",
    scope: fact.scope,
    batchDigest: content.batchDigest,
    acceptedProofCounter: 11,
    acknowledged: [
      {
        eventId: fact.eventId,
        contentDigest: content.contentDigests[0]!,
        receivedAt: "2026-09-08T12:34:56.123456Z",
      },
    ],
  } as const;
  return { request, digests: content.contentDigests, accepted };
}

describe("historical evidence fixed transport", () => {
  it("posts the exact original prefix to its one endpoint with no admission credential or header", async () => {
    const fixture = evidenceFixture();
    const fetchRequest = vi
      .fn<StudentSessionFetch>()
      .mockResolvedValue(json(fixture.accepted));
    const transport = createStudentSessionTransport(
      configuration,
      fetchRequest,
    );
    expect(await transport.evidence(fixture.request, fixture.digests)).toEqual(
      fixture.accepted,
    );
    expect(fetchRequest).toHaveBeenCalledWith(
      `${configuration.url}/functions/v1/student-session-evidence`,
      expect.objectContaining({
        method: "POST",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        cache: "no-store",
        keepalive: false,
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
      }),
    );
    expect(JSON.parse(String(fetchRequest.mock.calls[0]?.[1]?.body))).toEqual(
      fixture.request,
    );
    expect(transport.isIdle()).toBe(true);
  });

  it("requires exact complete content-bound acknowledgments and never accepts absence or generic denial", async () => {
    const fixture = evidenceFixture();
    for (const body of [
      { ...fixture.accepted, scope: { ...fixture.accepted.scope, epoch: 2 } },
      { ...fixture.accepted, batchDigest: "f".repeat(64) },
      { ...fixture.accepted, acceptedProofCounter: 10 },
      { ...fixture.accepted, acknowledged: [] },
      {
        ...fixture.accepted,
        acknowledged: [
          ...fixture.accepted.acknowledged,
          ...fixture.accepted.acknowledged,
        ],
      },
      {
        ...fixture.accepted,
        acknowledged: [
          {
            ...fixture.accepted.acknowledged[0],
            contentDigest: "f".repeat(64),
          },
        ],
      },
      {
        ...fixture.accepted,
        acknowledged: [
          {
            ...fixture.accepted.acknowledged[0],
            receivedAt: "2026-09-08T12:34:56.123Z",
          },
        ],
      },
      { ...fixture.accepted, reason: "provider details" },
      denied,
    ]) {
      const fetchRequest = vi
        .fn<StudentSessionFetch>()
        .mockResolvedValue(json(body));
      expect(
        await createStudentSessionTransport(
          configuration,
          fetchRequest,
        ).evidence(fixture.request, fixture.digests),
      ).toEqual(unavailable);
    }
    const fetchRequest = vi
      .fn<StudentSessionFetch>()
      .mockResolvedValue(json(denied, 403));
    expect(
      await createStudentSessionTransport(configuration, fetchRequest).evidence(
        fixture.request,
        fixture.digests,
      ),
    ).toEqual(denied);
  });

  it("snapshots digest expectations before an await and rejects malformed expectation lists without egress", async () => {
    const fixture = evidenceFixture();
    const digests = [...fixture.digests];
    let resolve!: (response: Response) => void;
    const fetchRequest = vi.fn<StudentSessionFetch>(
      () =>
        new Promise((yes) => {
          resolve = yes;
        }),
    );
    const transport = createStudentSessionTransport(
      configuration,
      fetchRequest,
    );
    const pending = transport.evidence(fixture.request, digests);
    await Promise.resolve();
    digests[0] = "f".repeat(64);
    resolve(json(fixture.accepted));
    expect(await pending).toEqual(fixture.accepted);
    for (const wrong of [
      [],
      ["bad"],
      [...fixture.digests, ...fixture.digests],
    ]) {
      fetchRequest.mockClear();
      expect(await transport.evidence(fixture.request, wrong)).toEqual(
        unavailable,
      );
      expect(fetchRequest).not.toHaveBeenCalled();
    }
  });

  it("keeps the shared transport occupied after the five-second evidence deadline until real settlement", async () => {
    vi.useFakeTimers();
    const fixture = evidenceFixture();
    let resolve!: (response: Response) => void;
    const fetchRequest = vi.fn<StudentSessionFetch>(
      () =>
        new Promise((yes) => {
          resolve = yes;
        }),
    );
    const transport = createStudentSessionTransport(
      configuration,
      fetchRequest,
    );
    const result = transport.evidence(fixture.request, fixture.digests);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await result).toEqual(unavailable);
    expect(transport.isIdle()).toBe(false);
    expect(await transport.read(read, 1_300_000)).toEqual(unavailable);
    expect(await transport.evidence(fixture.request, fixture.digests)).toEqual(
      unavailable,
    );
    expect(fetchRequest).toHaveBeenCalledOnce();
    let drained = false;
    const drain = transport.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    resolve(json(fixture.accepted));
    await drain;
    expect(drained).toBe(true);
    expect(transport.isIdle()).toBe(true);
    expect(await transport.evidence(fixture.request, fixture.digests)).toEqual(
      unavailable,
    );
    expect(fetchRequest).toHaveBeenCalledOnce();
  });

  it("retains the eight-KiB response ceiling and rejects redirected and wrong-route responses", async () => {
    const fixture = evidenceFixture();
    const large = new Response(" ".repeat(8193), {
      headers: { "content-type": "application/json" },
    });
    const redirected = json(fixture.accepted);
    Object.defineProperty(redirected, "redirected", { value: true });
    const foreign = json(fixture.accepted);
    Object.defineProperty(foreign, "url", {
      value: `${configuration.url}/functions/v1/student-session-read`,
    });
    for (const response of [large, redirected, foreign]) {
      const fetchRequest = vi
        .fn<StudentSessionFetch>()
        .mockResolvedValue(response);
      expect(
        await createStudentSessionTransport(
          configuration,
          fetchRequest,
        ).evidence(fixture.request, fixture.digests),
      ).toEqual(unavailable);
    }
  });
});
afterEach(() => vi.useRealTimers());

describe("StudentSession fixed main transport", () => {
  it("posts each exact retained request to its sole named route without credentials in the URL", async () => {
    const fetchRequest = vi
      .fn<StudentSessionFetch>()
      .mockResolvedValueOnce(json({ challengeId, expiresAtMs: 1_015_000 }))
      .mockResolvedValueOnce(json(acceptedJoin))
      .mockResolvedValueOnce(json(acceptedRead))
      .mockResolvedValueOnce(
        json({ ...acceptedJoin, sessionRevision: 2, acceptedProofCounter: 1 }),
      )
      .mockResolvedValueOnce(
        json({
          status: "accepted",
          code: "STUDENT_SESSION_FORFEITED",
          requestId,
          acceptedProofCounter: 1,
        }),
      );
    const transport = createStudentSessionTransport(
      configuration,
      fetchRequest,
    );
    expect(await transport.challenge(challenge)).toEqual({
      challengeId,
      expiresAtMs: 1_015_000,
    });
    expect(await transport.join(join, digest)).toEqual(acceptedJoin);
    expect(await transport.read(read, 1_300_000)).toEqual(acceptedRead);
    expect(await transport.reconnect(reconnect, digest)).toMatchObject({
      status: "accepted",
      sessionRevision: 2,
    });
    expect(await transport.forfeit(forfeit)).toMatchObject({
      code: "STUDENT_SESSION_FORFEITED",
    });
    const requests = [challenge, join, read, reconnect, forfeit];
    for (const [index, operation] of [
      "challenge",
      "join",
      "read",
      "reconnect",
      "forfeit",
    ].entries()) {
      const call = fetchRequest.mock.calls[index];
      expect(call?.[0]).toBe(
        `${configuration.url}/functions/v1/student-session-${operation}`,
      );
      expect(call?.[1]).toMatchObject({
        method: "POST",
        body: JSON.stringify(requests[index]),
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        keepalive: false,
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
      });
      expect(call?.[1]?.signal).toBeInstanceOf(AbortSignal);
      expect(Object.keys(call?.[1]?.headers ?? {})).toHaveLength(2);
    }
  });

  it("retains generic denial only at HTTP403 and never manufactures an acknowledgment", async () => {
    for (const [status, body, expected] of [
      [403, denied, denied],
      [503, unavailable, unavailable],
      [200, denied, unavailable],
      [403, { ...denied, reason: "removed" }, unavailable],
      [401, denied, unavailable],
      [
        403,
        {
          status: "accepted",
          code: "STUDENT_SESSION_FORFEITED",
          requestId,
          acceptedProofCounter: 1,
        },
        unavailable,
      ],
      [
        200,
        {
          status: "accepted",
          code: "STUDENT_SESSION_FORFEITED",
          requestId,
          acceptedProofCounter: 2,
        },
        unavailable,
      ],
    ] as const) {
      const fetchRequest = vi
        .fn<StudentSessionFetch>()
        .mockResolvedValue(json(body, status));
      expect(
        await createStudentSessionTransport(
          configuration,
          fetchRequest,
        ).forfeit(forfeit),
      ).toEqual(expected);
      expect(fetchRequest).toHaveBeenCalledOnce();
    }
  });

  it("binds accepted results to original intent, device, scope, counter, revision and expiry", async () => {
    const invalidJoins = [
      { ...acceptedJoin, requestId: challengeId },
      { ...acceptedJoin, logicalOperationDigest: "b".repeat(64) },
      { ...acceptedJoin, scope: { ...scope, deviceSessionId: challengeId } },
      {
        ...acceptedJoin,
        allowedIntents: ["state.read", "session.forfeit", "calculator.write"],
      },
      { ...acceptedJoin, capabilityToken: "A".repeat(43) },
    ];
    for (const body of invalidJoins)
      expect(
        await createStudentSessionTransport(configuration, async () =>
          json(body),
        ).join(join, digest),
      ).toEqual(unavailable);
    for (const body of [
      { ...acceptedRead, acceptedProofCounter: 2 },
      { ...acceptedRead, scope: { ...scope, epoch: 2 } },
      { ...acceptedRead, capabilityExpiresAtMs: 1_299_999 },
      { ...acceptedRead, state: "removed" },
    ])
      expect(
        await createStudentSessionTransport(configuration, async () =>
          json(body),
        ).read(read, 1_300_000),
      ).toEqual(unavailable);
    expect(
      await createStudentSessionTransport(configuration, async () =>
        json({ ...acceptedJoin, sessionRevision: 3, acceptedProofCounter: 1 }),
      ).reconnect(reconnect, digest),
    ).toEqual(unavailable);
  });

  it("rejects invalid or oversized request material and invalid expected bindings before any egress", async () => {
    const fetchRequest = vi.fn<StudentSessionFetch>();
    const transport = createStudentSessionTransport(
      configuration,
      fetchRequest,
    );
    expect(
      await transport.challenge({
        ...challenge,
        url: "https://other.invalid",
      } as StudentChallengeRequest),
    ).toEqual(unavailable);
    expect(
      await transport.join({ ...join, joinCode: "A".repeat(9_000) }, digest),
    ).toEqual(unavailable);
    expect(await transport.join(join, "wrong")).toEqual(unavailable);
    expect(await transport.read(read, Number.NaN)).toEqual(unavailable);
    expect(
      await transport.read(
        { ...read, deviceProof: { ...read.deviceProof, counter: 0 } },
        1_300_000,
      ),
    ).toEqual(unavailable);
    let getterCalls = 0;
    const accessor = { ...challenge };
    Object.defineProperty(accessor, "publicKey", {
      get() {
        getterCalls += 1;
        return challenge.publicKey;
      },
    });
    expect(await transport.challenge(accessor)).toEqual(unavailable);
    expect(getterCalls).toBe(0);
    expect(fetchRequest).not.toHaveBeenCalled();
  });

  it("snapshots input/config before awaits and cannot follow a changed caller origin", async () => {
    const mutableConfig: { environment: "local"; url: string } = {
      ...configuration,
    };
    let resolve: ((response: Response) => void) | undefined;
    const fetchRequest = vi.fn<StudentSessionFetch>(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const transport = createStudentSessionTransport(
      mutableConfig,
      fetchRequest,
    );
    const mutable = {
      ...read,
      scope: { ...scope },
      deviceProof: { ...read.deviceProof },
    };
    const pending = transport.read(mutable, 1_300_000);
    mutable.scope.epoch = 2;
    mutable.deviceProof.counter = 2;
    mutableConfig.url = "http://127.0.0.1:1";
    await Promise.resolve();
    resolve?.(json(acceptedRead));
    expect(await pending).toEqual(acceptedRead);
    expect(fetchRequest.mock.calls[0]?.[0]).toBe(
      `${configuration.url}/functions/v1/student-session-read`,
    );
    expect(fetchRequest.mock.calls[0]?.[1]?.body).toBe(JSON.stringify(read));
  });

  it("rejects redirects, foreign final URLs and non-JSON bodies without retry or fallback", async () => {
    const redirected = json({ challengeId, expiresAtMs: 1_015_000 });
    Object.defineProperty(redirected, "redirected", { value: true });
    const foreign = json({ challengeId, expiresAtMs: 1_015_000 });
    Object.defineProperty(foreign, "url", {
      value: "https://other.invalid/functions/v1/student-session-challenge",
    });
    for (const response of [
      redirected,
      foreign,
      new Response("go", {
        status: 307,
        headers: { location: "https://other.invalid" },
      }),
      new Response("{}", { headers: { "content-type": "text/html" } }),
      new Response("{", { headers: { "content-type": "application/json" } }),
    ]) {
      const fetchRequest = vi
        .fn<StudentSessionFetch>()
        .mockResolvedValue(response);
      expect(
        await createStudentSessionTransport(
          configuration,
          fetchRequest,
        ).challenge(challenge),
      ).toEqual(unavailable);
      expect(fetchRequest).toHaveBeenCalledOnce();
    }
    const thrown = vi
      .fn<StudentSessionFetch>()
      .mockRejectedValue(new Error("private transport detail"));
    expect(
      await createStudentSessionTransport(configuration, thrown).challenge(
        challenge,
      ),
    ).toEqual(unavailable);
    expect(thrown).toHaveBeenCalledOnce();
  });

  it("enforces the actual streamed UTF-8 response budget, including missing or deceptive lengths", async () => {
    const body = JSON.stringify({ challengeId, expiresAtMs: 1_015_000 });
    const exact = `${body}${" ".repeat(8_192 - Buffer.byteLength(body))}`;
    expect(
      await createStudentSessionTransport(
        configuration,
        async () =>
          new Response(exact, {
            headers: { "content-type": "application/json" },
          }),
      ).challenge(challenge),
    ).toEqual({ challengeId, expiresAtMs: 1_015_000 });
    for (const headers of [
      { "content-type": "application/json" },
      { "content-type": "application/json", "content-length": "1" },
    ]) {
      const cancel = vi.fn();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(exact));
          controller.enqueue(new Uint8Array([32]));
        },
        cancel,
      });
      expect(
        await createStudentSessionTransport(
          configuration,
          async () => new Response(stream, { headers }),
        ).challenge(challenge),
      ).toEqual(unavailable);
      expect(cancel).toHaveBeenCalledOnce();
    }
    for (const length of ["8193", "-1", "8e3"])
      expect(
        await createStudentSessionTransport(
          configuration,
          async () =>
            new Response(body, {
              headers: {
                "content-type": "application/json",
                "content-length": length,
              },
            }),
        ).challenge(challenge),
      ).toEqual(unavailable);
    expect(
      await createStudentSessionTransport(
        configuration,
        async () =>
          new Response(new Uint8Array([0xff]), {
            headers: { "content-type": "application/json" },
          }),
      ).challenge(challenge),
    ).toEqual(unavailable);
  });

  it("bounds fetch and body together at five seconds and cancels a stalled body", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const fetchRequest = vi.fn<StudentSessionFetch>(async () => {
      await new Promise((resolve) => setTimeout(resolve, 4_000));
      return new Response(new ReadableStream<Uint8Array>({ cancel }), {
        headers: { "content-type": "application/json" },
      });
    });
    const pending = createStudentSessionTransport(
      configuration,
      fetchRequest,
    ).challenge(challenge);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(cancel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual(unavailable);
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetchRequest.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds a stalled fetch and supports coordinator cancellation without dispatching an already-aborted attempt", async () => {
    vi.useFakeTimers();
    const fetchRequest = vi.fn<StudentSessionFetch>(
      () => new Promise(() => undefined),
    );
    const transport = createStudentSessionTransport(
      configuration,
      fetchRequest,
    );
    const timeout = transport.challenge(challenge);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await timeout).toEqual(unavailable);
    const controller = new AbortController();
    const interrupted = transport.challenge(challenge, controller.signal);
    controller.abort();
    expect(await interrupted).toEqual(unavailable);
    expect(await transport.challenge(challenge, controller.signal)).toEqual(
      unavailable,
    );
    // The first abort-ignoring exchange still owns transport; another caller
    // cannot dispatch merely because its UI timeout has already resolved.
    expect(fetchRequest).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects alternate routing and downgrade configuration at construction", () => {
    for (const config of [
      { environment: "local", url: "http://localhost:54321" },
      { environment: "local", url: "http://127.0.0.1:54321/" },
      { environment: "staging", url: "http://api.example.invalid" },
      {
        environment: "staging",
        url: "https://api.example.invalid/?token=value",
      },
    ] as const)
      expect(() => createStudentSessionTransport(config)).toThrow(
        "configuration is invalid",
      );
  });
});
