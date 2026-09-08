import {
  createResendInvitationTransport,
  type PreparedResendInvitationDelivery,
  RESEND_AUTOMATIC_RETRY_MAXIMUM_AGE_MILLISECONDS,
  type ResendInvitationMaterial,
} from "./resend-invitation-transport.ts";

const INVITATION_ID = "11111111-1111-4111-8111-111111111111";
const ATTEMPT_ID = "22222222-2222-4222-8222-222222222222";
const PROVIDER_MESSAGE_ID = "33333333-3333-4333-8333-333333333333";
const ATTEMPT_STARTED_AT = "2026-09-04T12:00:00.000Z";
const EXPIRES_AT = "2026-09-04T13:00:00.000Z";
const RECIPIENT = "teacher@example.invalid";
const CALLBACK_ORIGIN = "https://staff.desmoslock.invalid";
const TOKEN_HASH = "a".repeat(56);
const CALLBACK = `${CALLBACK_ORIGIN}/?auth=invite#token_hash=${TOKEN_HASH}`;
const FROM = "DesmosLock <mail@example.invalid>";
const REPLY_TO = "support@example.invalid";
const PROVIDER_CREDENTIAL = ["synthetic", "provider", "credential"].join("-");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test(
  "Resend invitation transport freezes and sends one exact text-only request",
  async () => {
    let capturedInput: RequestInfo | URL | undefined;
    let capturedInit: RequestInit | undefined;
    const transport = createResendInvitationTransport(
      {
        apiKey: PROVIDER_CREDENTIAL,
        callbackOrigin: CALLBACK_ORIGIN,
        from: FROM,
        replyTo: REPLY_TO,
      },
      {
        clearTimeout: () => undefined,
        fetch: (input, init) => {
          capturedInput = input;
          capturedInit = init;
          return Promise.resolve(
            new Response(JSON.stringify({ id: PROVIDER_MESSAGE_ID }), {
              headers: { "content-type": "application/json" },
              status: 200,
            }),
          );
        },
        now: () => Date.parse(ATTEMPT_STARTED_AT) + 1_000,
        setTimeout: () => 1,
      },
    );
    const prepared = transport.prepare({
      attemptId: ATTEMPT_ID,
      attemptStartedAt: ATTEMPT_STARTED_AT,
      callbackUrl: CALLBACK,
      expiresAt: EXPIRES_AT,
      invitationId: INVITATION_ID,
      recipientEmail: RECIPIENT,
    });

    assert(prepared !== null, "expected a prepared delivery attempt");
    const result = await transport.deliver(prepared);
    assert(result.kind === "provider_accepted", "expected provider acceptance");
    assert(
      result.providerMessageId === PROVIDER_MESSAGE_ID,
      "provider message identity changed",
    );
    assert(
      String(capturedInput) === "https://api.resend.com/emails",
      "provider endpoint changed",
    );
    assert(capturedInit?.method === "POST", "provider method changed");
    assert(capturedInit?.redirect === "error", "redirects must be rejected");
    const headers = new Headers(capturedInit?.headers);
    assert(
      headers.get("authorization") === `Bearer ${PROVIDER_CREDENTIAL}`,
      "provider authorization header changed",
    );
    assert(
      headers.get("idempotency-key") ===
        `desmoslock.staff-invitation.${INVITATION_ID}.${ATTEMPT_ID}`,
      "provider idempotency key changed",
    );
    assert(
      headers.has("user-agent"),
      "direct HTTPS requests require User-Agent",
    );
    assert(
      capturedInit?.body === prepared.providerRequestBody,
      "frozen provider bytes were not reused",
    );
    const payload = JSON.parse(String(capturedInit?.body)) as Record<
      string,
      unknown
    >;
    assert(
      JSON.stringify(Object.keys(payload)) ===
        JSON.stringify(["from", "to", "reply_to", "subject", "text"]),
      "provider payload fields changed",
    );
    assert(payload.from === FROM, "configured sender changed");
    assert(payload.reply_to === REPLY_TO, "configured reply-to changed");
    assert(
      payload.subject === "You're invited to DesmosLock",
      "invitation subject changed",
    );
    assert(
      JSON.stringify(payload.to) === JSON.stringify([RECIPIENT]),
      "recipient envelope changed",
    );
    assert(typeof payload.text === "string", "plain-text copy is required");
    assert(
      payload.text ===
        [
          "You have been invited to join a school in DesmosLock.",
          "",
          "Open this direct link, then confirm the invitation in your browser:",
          CALLBACK,
          "",
          `This invitation expires at ${EXPIRES_AT}.`,
          "If you were not expecting this invitation, you can ignore this email.",
        ].join("\n"),
      "plain-text invitation copy changed",
    );
    const emittedCallback = new URL(payload.text.split("\n")[3]);
    const httpRequestTarget = `${emittedCallback.pathname}${emittedCallback.search}`;
    assert(
      httpRequestTarget === "/?auth=invite",
      "callback HTTP request target changed",
    );
    assert(
      !httpRequestTarget.includes(TOKEN_HASH),
      "bearer escaped into the HTTP request target",
    );
    assert(
      emittedCallback.hash === `#token_hash=${TOKEN_HASH}`,
      "fragment bearer changed",
    );
    assert(!("html" in payload), "HTML tracking surface must remain absent");
    assert(
      !("tracking" in payload),
      "unsupported tracking fields are forbidden",
    );
  },
);

Deno.test(
  "Resend invitation transport fails closed when timeout setup is unavailable",
  async () => {
    let fetchCalls = 0;
    const transport = createResendInvitationTransport(
      {
        apiKey: PROVIDER_CREDENTIAL,
        callbackOrigin: CALLBACK_ORIGIN,
        from: FROM,
        replyTo: REPLY_TO,
      },
      {
        clearTimeout: () => undefined,
        fetch: () => {
          fetchCalls += 1;
          return Promise.reject(new Error("fetch must not run"));
        },
        now: () => Date.parse(ATTEMPT_STARTED_AT) + 1_000,
        setTimeout: () => {
          throw new Error("SENTINEL-timer-detail");
        },
      },
    );
    const prepared = transport.prepare({
      attemptId: ATTEMPT_ID,
      attemptStartedAt: ATTEMPT_STARTED_AT,
      callbackUrl: CALLBACK,
      expiresAt: EXPIRES_AT,
      invitationId: INVITATION_ID,
      recipientEmail: RECIPIENT,
    });
    assert(prepared !== null, "expected a prepared delivery attempt");

    const result = await transport.deliver(prepared);

    assert(
      result.kind === "provider_rejected",
      "timer failure was not sanitized",
    );
    assert(fetchCalls === 0, "request escaped without a timeout");
  },
);

Deno.test(
  "Resend invitation transport rejects noncanonical callbacks before preparation or egress",
  async () => {
    let fetchCalls = 0;
    const transport = createResendInvitationTransport(
      {
        apiKey: PROVIDER_CREDENTIAL,
        callbackOrigin: CALLBACK_ORIGIN,
        from: FROM,
        replyTo: REPLY_TO,
      },
      {
        clearTimeout: () => undefined,
        fetch: () => {
          fetchCalls += 1;
          return Promise.reject(
            new Error("invalid callback must not reach provider"),
          );
        },
        now: () => Date.parse(ATTEMPT_STARTED_AT) + 1_000,
        setTimeout: () => 1,
      },
    );
    const material = {
      attemptId: ATTEMPT_ID,
      attemptStartedAt: ATTEMPT_STARTED_AT,
      callbackUrl: CALLBACK,
      expiresAt: EXPIRES_AT,
      invitationId: INVITATION_ID,
      recipientEmail: RECIPIENT,
    };
    const prepared = transport.prepare(material);
    assert(prepared !== null, "canonical fragment callback was rejected");
    const payload = JSON.parse(prepared.providerRequestBody);
    const invalidCallbacks = [
      [
        "legacy query token",
        `${CALLBACK_ORIGIN}/?auth=invite&token_hash=${TOKEN_HASH}`,
      ],
      [
        "legacy reversed query",
        `${CALLBACK_ORIGIN}/?token_hash=${TOKEN_HASH}&auth=invite`,
      ],
      [
        "mixed query and fragment",
        `${CALLBACK_ORIGIN}/?auth=invite&token_hash=${TOKEN_HASH}#token_hash=${TOKEN_HASH}`,
      ],
      [
        "query extra",
        CALLBACK.replace("?auth=invite", "?auth=invite&extra=value"),
      ],
      [
        "query duplicate",
        CALLBACK.replace("?auth=invite", "?auth=invite&auth=invite"),
      ],
      ["query encoded key", CALLBACK.replace("?auth=", "?%61uth=")],
      [
        "query encoded value",
        CALLBACK.replace("?auth=invite", "?auth=%69nvite"),
      ],
      [
        "query trailing separator",
        CALLBACK.replace("?auth=invite", "?auth=invite&"),
      ],
      ["missing discriminator", `${CALLBACK_ORIGIN}/#token_hash=${TOKEN_HASH}`],
      [
        "wrong discriminator",
        CALLBACK.replace("?auth=invite", "?auth=recovery"),
      ],
      ["missing fragment", `${CALLBACK_ORIGIN}/?auth=invite`],
      ["empty fragment", `${CALLBACK_ORIGIN}/?auth=invite#`],
      ["empty token", `${CALLBACK_ORIGIN}/?auth=invite#token_hash=`],
      ["short token", CALLBACK.slice(0, -1)],
      ["long token", `${CALLBACK}a`],
      [
        "uppercase token",
        CALLBACK.replace(TOKEN_HASH, TOKEN_HASH.toUpperCase()),
      ],
      ["nonhex token", `${CALLBACK.slice(0, -1)}g`],
      ["fragment extra", `${CALLBACK}&extra=value`],
      ["fragment duplicate", `${CALLBACK}&token_hash=${TOKEN_HASH}`],
      ["fragment discriminator", `${CALLBACK}&auth=invite`],
      [
        "fragment encoded key",
        CALLBACK.replace("#token_hash=", "#%74oken_hash="),
      ],
      [
        "fragment encoded separator",
        CALLBACK.replace("#token_hash=", "#token_hash%3D"),
      ],
      [
        "fragment encoded token",
        CALLBACK.replace(TOKEN_HASH, `%61${TOKEN_HASH.slice(1)}`),
      ],
      [
        "fragment double encoded token",
        CALLBACK.replace(TOKEN_HASH, `%2561${TOKEN_HASH.slice(1)}`),
      ],
      ["fragment encoded field delimiter", `${CALLBACK}%26extra=value`],
      ["fragment trailing separator", `${CALLBACK}&`],
      [
        "fragment prefix separator",
        CALLBACK.replace("#token_hash=", "#&token_hash="),
      ],
      [
        "fragment question mark",
        CALLBACK.replace("#token_hash=", "#?token_hash="),
      ],
      ["fragment second hash", `${CALLBACK}#`],
      ["fragment whitespace", `${CALLBACK}%20`],
      ["fragment plus", `${CALLBACK}+`],
      ["fragment encoded newline", `${CALLBACK}%0A`],
      [
        "wrong origin",
        CALLBACK.replace(CALLBACK_ORIGIN, "https://other.invalid"),
      ],
      [
        "wrong port",
        CALLBACK.replace(CALLBACK_ORIGIN, `${CALLBACK_ORIGIN}:8443`),
      ],
      ["wrong scheme", CALLBACK.replace("https:", "http:")],
      ["userinfo", CALLBACK.replace("https://", "https://user@")],
      ["wrong path", CALLBACK.replace("/?auth=", "/invitation?auth=")],
      ["double root slash", CALLBACK.replace("/?auth=", "//?auth=")],
      ["backslash root", CALLBACK.replace("/?auth=", "\\?auth=")],
      ["missing root slash", CALLBACK.replace("/?auth=", "?auth=")],
      ["dot path", CALLBACK.replace("/?auth=", "/./?auth=")],
      ["encoded dot path", CALLBACK.replace("/?auth=", "/%2e/?auth=")],
      [
        "default port alias",
        CALLBACK.replace(CALLBACK_ORIGIN, `${CALLBACK_ORIGIN}:443`),
      ],
      [
        "uppercase host",
        CALLBACK.replace(
          "staff.desmoslock.invalid",
          "STAFF.DESMOSLOCK.INVALID",
        ),
      ],
      ["uppercase scheme", CALLBACK.replace("https:", "HTTPS:")],
      ["leading whitespace", ` ${CALLBACK}`],
      ["trailing newline", `${CALLBACK}\n`],
      ["embedded tab", CALLBACK.replace("#token_hash=", "#token_\thash=")],
    ];
    for (const [label, callbackUrl] of invalidCallbacks) {
      assert(
        transport.prepare({ ...material, callbackUrl }) === null,
        `${label} was prepared`,
      );
      const result = await transport.deliver({
        ...prepared,
        callbackUrl,
        providerRequestBody: JSON.stringify({
          ...payload,
          text: payload.text.replace(CALLBACK, callbackUrl),
        }),
      });
      assert(
        result.kind === "provider_rejected",
        `${label} was not rejected before egress`,
      );
    }
    assert(fetchCalls === 0, "invalid callback escaped to the provider");
  },
);

Deno.test(
  "Resend invitation transport pins callback origin and freezes prepared delivery",
  () => {
    const transport = createResendInvitationTransport({
      apiKey: PROVIDER_CREDENTIAL,
      callbackOrigin: CALLBACK_ORIGIN,
      from: FROM,
      replyTo: REPLY_TO,
    });
    const wrongOrigin = transport.prepare({
      attemptId: ATTEMPT_ID,
      attemptStartedAt: ATTEMPT_STARTED_AT,
      callbackUrl: `https://other.invalid/?auth=invite#token_hash=${"a".repeat(56)}`,
      expiresAt: EXPIRES_AT,
      invitationId: INVITATION_ID,
      recipientEmail: RECIPIENT,
    });
    const prepared = transport.prepare({
      attemptId: ATTEMPT_ID,
      attemptStartedAt: ATTEMPT_STARTED_AT,
      callbackUrl: CALLBACK,
      expiresAt: EXPIRES_AT,
      invitationId: INVITATION_ID,
      recipientEmail: RECIPIENT,
    });

    assert(wrongOrigin === null, "unconfigured callback origin was accepted");
    assert(prepared !== null, "configured callback origin was rejected");
    assert(Object.isFrozen(prepared), "prepared delivery remained mutable");
  },
);

Deno.test(
  "Resend invitation transport repeats the exact frozen key and payload",
  async () => {
    const requests: string[] = [];
    const transport = createResendInvitationTransport(
      {
        apiKey: PROVIDER_CREDENTIAL,
        callbackOrigin: CALLBACK_ORIGIN,
        from: FROM,
        replyTo: REPLY_TO,
      },
      {
        clearTimeout: () => undefined,
        fetch: (input, init) => {
          requests.push(
            JSON.stringify({
              body: init?.body,
              endpoint: String(input),
              headers: [...new Headers(init?.headers).entries()],
              method: init?.method,
              redirect: init?.redirect,
            }),
          );
          return Promise.resolve(Response.json({ id: PROVIDER_MESSAGE_ID }));
        },
        now: () => Date.parse(ATTEMPT_STARTED_AT) + 1_000,
        setTimeout: () => 1,
      },
    );
    const material = {
      attemptId: ATTEMPT_ID,
      attemptStartedAt: ATTEMPT_STARTED_AT,
      callbackUrl: CALLBACK,
      expiresAt: EXPIRES_AT,
      invitationId: INVITATION_ID,
      recipientEmail: RECIPIENT,
    };
    const first = transport.prepare(material);
    const replay = transport.prepare(material);
    assert(first !== null && replay !== null, "delivery preparation failed");
    assert(
      JSON.stringify(first) === JSON.stringify(replay),
      "same attempt did not freeze identically",
    );

    const firstResult = await transport.deliver(first);
    const replayResult = await transport.deliver(replay);

    assert(
      firstResult.kind === "provider_accepted" &&
        replayResult.kind === "provider_accepted",
      "exact retry did not preserve provider acceptance",
    );
    assert(requests.length === 2, "exact retry request count changed");
    assert(requests[0] === requests[1], "exact retry bytes or headers changed");
  },
);

Deno.test(
  "Resend invitation transport deadline settles when fetch ignores abort",
  async () => {
    let releaseProvider: (() => void) | undefined;
    let configuredDeadline = 0;
    let clearCalls = 0;
    const transport = createResendInvitationTransport(
      {
        apiKey: PROVIDER_CREDENTIAL,
        callbackOrigin: CALLBACK_ORIGIN,
        from: FROM,
        replyTo: REPLY_TO,
      },
      {
        clearTimeout: () => {
          clearCalls += 1;
        },
        fetch: (_input, init) =>
          new Promise<Response>((resolve) => {
            assert(init?.signal instanceof AbortSignal, "abort signal missing");
            releaseProvider = () =>
              resolve(Response.json({ id: PROVIDER_MESSAGE_ID }));
          }),
        now: () => Date.parse(ATTEMPT_STARTED_AT) + 1_000,
        setTimeout: (callback, milliseconds) => {
          configuredDeadline = milliseconds;
          queueMicrotask(callback);
          return 1;
        },
      },
    );
    const prepared = transport.prepare({
      attemptId: ATTEMPT_ID,
      attemptStartedAt: ATTEMPT_STARTED_AT,
      callbackUrl: CALLBACK,
      expiresAt: EXPIRES_AT,
      invitationId: INVITATION_ID,
      recipientEmail: RECIPIENT,
    });
    assert(prepared !== null, "expected a prepared delivery attempt");
    const delivery = transport.deliver(prepared);
    const testDeadline = Symbol("test deadline");
    let testTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
    const observed = await Promise.race([
      delivery,
      new Promise<typeof testDeadline>(
        (resolve) =>
          (testTimer = globalThis.setTimeout(() => resolve(testDeadline), 25)),
      ),
    ]);
    if (observed === testDeadline) {
      releaseProvider?.();
      await delivery;
    }
    globalThis.clearTimeout(testTimer);

    assert(observed !== testDeadline, "fetch was not bounded by the deadline");
    assert(observed.kind === "provider_ambiguous", "timeout was not ambiguous");
    assert(configuredDeadline === 8_000, "timeout duration changed");
    assert(clearCalls === 1, "provider timeout was not cleared exactly once");
  },
);

Deno.test(
  "Resend invitation transport deadline settles when response body ignores abort",
  async () => {
    let expireDeadline: (() => void) | undefined;
    let releaseBody: (() => void) | undefined;
    let bodyCancelCalls = 0;
    const responseBody = new ReadableStream<Uint8Array>(
      {
        cancel: () => {
          bodyCancelCalls += 1;
        },
        start(controller) {
          releaseBody = () => {
            controller.enqueue(
              new TextEncoder().encode(
                JSON.stringify({ id: PROVIDER_MESSAGE_ID }),
              ),
            );
            controller.close();
          };
        },
        pull: () => {
          queueMicrotask(() => expireDeadline?.());
          return new Promise<void>(() => undefined);
        },
      },
      { highWaterMark: 0 },
    );
    const transport = createResendInvitationTransport(
      {
        apiKey: PROVIDER_CREDENTIAL,
        callbackOrigin: CALLBACK_ORIGIN,
        from: FROM,
        replyTo: REPLY_TO,
      },
      {
        clearTimeout: () => undefined,
        fetch: () =>
          Promise.resolve(
            new Response(responseBody, {
              headers: { "content-type": "application/json" },
              status: 200,
            }),
          ),
        now: () => Date.parse(ATTEMPT_STARTED_AT) + 1_000,
        setTimeout: (callback) => {
          expireDeadline = callback;
          return 1;
        },
      },
    );
    const prepared = transport.prepare({
      attemptId: ATTEMPT_ID,
      attemptStartedAt: ATTEMPT_STARTED_AT,
      callbackUrl: CALLBACK,
      expiresAt: EXPIRES_AT,
      invitationId: INVITATION_ID,
      recipientEmail: RECIPIENT,
    });
    assert(prepared !== null, "expected a prepared delivery attempt");
    const delivery = transport.deliver(prepared);
    const testDeadline = Symbol("test deadline");
    let testTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
    const observed = await Promise.race([
      delivery,
      new Promise<typeof testDeadline>(
        (resolve) =>
          (testTimer = globalThis.setTimeout(() => resolve(testDeadline), 25)),
      ),
    ]);
    if (observed === testDeadline) {
      releaseBody?.();
      await delivery;
    }
    globalThis.clearTimeout(testTimer);

    assert(
      observed !== testDeadline,
      "body read was not bounded by the deadline",
    );
    assert(
      observed.kind === "provider_ambiguous",
      "body timeout was not ambiguous",
    );
    await Promise.resolve();
    assert(bodyCancelCalls === 1, "timed-out body reader was not cancelled");
  },
);

Deno.test(
  "Resend invitation transport distinguishes strict idempotency conflicts",
  async () => {
    const responses = [
      Response.json(
        {
          message: "Another request with this key is still running.",
          name: "concurrent_idempotent_requests",
          statusCode: 409,
        },
        { status: 409 },
      ),
      Response.json(
        {
          message: "The same key was used with a different request.",
          name: "invalid_idempotent_request",
          statusCode: 409,
        },
        { status: 409 },
      ),
      Response.json(
        {
          extra: true,
          message: "Untrusted conflict shape.",
          name: "invalid_idempotent_request",
          statusCode: 409,
        },
        { status: 409 },
      ),
    ];
    const transport = createResendInvitationTransport(
      {
        apiKey: PROVIDER_CREDENTIAL,
        callbackOrigin: CALLBACK_ORIGIN,
        from: FROM,
        replyTo: REPLY_TO,
      },
      {
        clearTimeout: () => undefined,
        fetch: () => {
          const response = responses.shift();
          assert(response !== undefined, "missing provider fixture");
          return Promise.resolve(response);
        },
        now: () => Date.parse(ATTEMPT_STARTED_AT) + 1_000,
        setTimeout: () => 1,
      },
    );
    const prepared = transport.prepare({
      attemptId: ATTEMPT_ID,
      attemptStartedAt: ATTEMPT_STARTED_AT,
      callbackUrl: CALLBACK,
      expiresAt: EXPIRES_AT,
      invitationId: INVITATION_ID,
      recipientEmail: RECIPIENT,
    });
    assert(prepared !== null, "expected a prepared delivery attempt");

    const concurrent = await transport.deliver(prepared);
    const changedPayload = await transport.deliver(prepared);
    const untrusted = await transport.deliver(prepared);

    assert(
      concurrent.kind === "provider_ambiguous",
      "concurrent request conflict was treated as safe rejection",
    );
    assert(
      changedPayload.kind === "provider_rejected",
      "strict changed-payload conflict was not rejected",
    );
    assert(
      untrusted.kind === "provider_ambiguous",
      "untrusted conflict detail was treated as safe rejection",
    );
  },
);

Deno.test(
  "Resend invitation transport sanitizes network ambiguity without logging",
  async () => {
    const originalConsole = {
      debug: console.debug,
      error: console.error,
      info: console.info,
      log: console.log,
      warn: console.warn,
    };
    let logCalls = 0;
    const observeLog = (..._data: unknown[]) => {
      logCalls += 1;
    };
    console.debug = observeLog;
    console.error = observeLog;
    console.info = observeLog;
    console.log = observeLog;
    console.warn = observeLog;
    try {
      const transport = createResendInvitationTransport(
        {
          apiKey: PROVIDER_CREDENTIAL,
          callbackOrigin: CALLBACK_ORIGIN,
          from: FROM,
          replyTo: REPLY_TO,
        },
        {
          clearTimeout: () => {
            throw new Error("SENTINEL-private-cleanup-detail");
          },
          fetch: () =>
            Promise.reject(new Error("SENTINEL-private-network-detail")),
          now: () => Date.parse(ATTEMPT_STARTED_AT) + 1_000,
          setTimeout: () => 1,
        },
      );
      const prepared = transport.prepare({
        attemptId: ATTEMPT_ID,
        attemptStartedAt: ATTEMPT_STARTED_AT,
        callbackUrl: CALLBACK,
        expiresAt: EXPIRES_AT,
        invitationId: INVITATION_ID,
        recipientEmail: RECIPIENT,
      });
      assert(prepared !== null, "expected a prepared delivery attempt");

      const result = await transport.deliver(prepared);

      assert(
        JSON.stringify(result) === '{"kind":"provider_ambiguous"}',
        "network failure detail escaped",
      );
      assert(logCalls === 0, "confidential delivery material was logged");
    } finally {
      console.debug = originalConsole.debug;
      console.error = originalConsole.error;
      console.info = originalConsole.info;
      console.log = originalConsole.log;
      console.warn = originalConsole.warn;
    }
  },
);

Deno.test(
  "Resend invitation transport distinguishes rejections from server ambiguity",
  async () => {
    const statuses = [301, 400, 429, 408, 500, 503];
    let cancelledBodies = 0;
    const transport = createResendInvitationTransport(
      {
        apiKey: PROVIDER_CREDENTIAL,
        callbackOrigin: CALLBACK_ORIGIN,
        from: FROM,
        replyTo: REPLY_TO,
      },
      {
        clearTimeout: () => undefined,
        fetch: () => {
          const status = statuses.shift();
          assert(status !== undefined, "missing provider status fixture");
          const body = new ReadableStream<Uint8Array>({
            cancel: () => {
              cancelledBodies += 1;
            },
            start: () => undefined,
          });
          return Promise.resolve(
            new Response(body, {
              headers: { "content-type": "application/json" },
              status,
            }),
          );
        },
        now: () => Date.parse(ATTEMPT_STARTED_AT) + 1_000,
        setTimeout: () => 1,
      },
    );
    const prepared = transport.prepare({
      attemptId: ATTEMPT_ID,
      attemptStartedAt: ATTEMPT_STARTED_AT,
      callbackUrl: CALLBACK,
      expiresAt: EXPIRES_AT,
      invitationId: INVITATION_ID,
      recipientEmail: RECIPIENT,
    });
    assert(prepared !== null, "expected a prepared delivery attempt");

    for (let index = 0; index < 6; index += 1) {
      const result = await transport.deliver(prepared);
      assert(
        result.kind ===
          (index < 3 ? "provider_rejected" : "provider_ambiguous"),
        "HTTP failure certainty was misreported",
      );
    }
    await Promise.resolve();

    assert(cancelledBodies === 6, "non-2xx response body was not discarded");
  },
);

Deno.test(
  "Resend invitation transport requires a strict 2xx JSON receipt",
  async () => {
    const responses = [
      Response.json({}),
      Response.json({ extra: true, id: PROVIDER_MESSAGE_ID }),
      Response.json({ id: "ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF" }),
      new Response(JSON.stringify({ id: PROVIDER_MESSAGE_ID }), {
        headers: { "content-type": "text/plain" },
        status: 200,
      }),
      new Response("not-json", {
        headers: { "content-type": "application/json" },
        status: 200,
      }),
      new Response(new Uint8Array([0xff]), {
        headers: { "content-type": "application/json" },
        status: 200,
      }),
      new Response(null, {
        headers: { "content-type": "application/json" },
        status: 204,
      }),
    ];
    const transport = createResendInvitationTransport(
      {
        apiKey: PROVIDER_CREDENTIAL,
        callbackOrigin: CALLBACK_ORIGIN,
        from: FROM,
        replyTo: REPLY_TO,
      },
      {
        clearTimeout: () => undefined,
        fetch: () => {
          const response = responses.shift();
          assert(response !== undefined, "missing provider response fixture");
          return Promise.resolve(response);
        },
        now: () => Date.parse(ATTEMPT_STARTED_AT) + 1_000,
        setTimeout: () => 1,
      },
    );
    const prepared = transport.prepare({
      attemptId: ATTEMPT_ID,
      attemptStartedAt: ATTEMPT_STARTED_AT,
      callbackUrl: CALLBACK,
      expiresAt: EXPIRES_AT,
      invitationId: INVITATION_ID,
      recipientEmail: RECIPIENT,
    });
    assert(prepared !== null, "expected a prepared delivery attempt");

    for (let index = 0; index < 7; index += 1) {
      const result = await transport.deliver(prepared);
      assert(
        result.kind === "provider_ambiguous",
        `malformed success response ${index} was treated as acceptance`,
      );
    }
  },
);

Deno.test(
  "Resend invitation transport bounds declared and streamed response bodies",
  async () => {
    let streamPulls = 0;
    let streamCancels = 0;
    const streamedBody = new ReadableStream<Uint8Array>(
      {
        cancel: () => {
          streamCancels += 1;
        },
        pull(controller) {
          streamPulls += 1;
          controller.enqueue(new Uint8Array(8_193));
        },
      },
      { highWaterMark: 0 },
    );
    const responses = [
      new Response("{}", {
        headers: {
          "content-length": "16385",
          "content-type": "application/json",
        },
        status: 200,
      }),
      new Response(streamedBody, {
        headers: { "content-type": "application/json" },
        status: 200,
      }),
    ];
    const transport = createResendInvitationTransport(
      {
        apiKey: PROVIDER_CREDENTIAL,
        callbackOrigin: CALLBACK_ORIGIN,
        from: FROM,
        replyTo: REPLY_TO,
      },
      {
        clearTimeout: () => undefined,
        fetch: () => {
          const response = responses.shift();
          assert(response !== undefined, "missing oversized response fixture");
          return Promise.resolve(response);
        },
        now: () => Date.parse(ATTEMPT_STARTED_AT) + 1_000,
        setTimeout: () => 1,
      },
    );
    const prepared = transport.prepare({
      attemptId: ATTEMPT_ID,
      attemptStartedAt: ATTEMPT_STARTED_AT,
      callbackUrl: CALLBACK,
      expiresAt: EXPIRES_AT,
      invitationId: INVITATION_ID,
      recipientEmail: RECIPIENT,
    });
    assert(prepared !== null, "expected a prepared delivery attempt");

    const declared = await transport.deliver(prepared);
    const streamed = await transport.deliver(prepared);
    await Promise.resolve();

    assert(declared.kind === "provider_ambiguous", "declared bound escaped");
    assert(streamed.kind === "provider_ambiguous", "streamed bound escaped");
    assert(streamPulls === 2, "stream body was read beyond the byte bound");
    assert(streamCancels === 1, "oversized stream was not cancelled");
  },
);

Deno.test(
  "Resend invitation transport rejects invalid configuration generically",
  () => {
    const invalidConfigurations: unknown[] = [
      {},
      {
        apiKey: PROVIDER_CREDENTIAL,
        callbackOrigin: CALLBACK_ORIGIN,
        extra: true,
        from: FROM,
        replyTo: REPLY_TO,
      },
      {
        apiKey: `${PROVIDER_CREDENTIAL}\n`,
        callbackOrigin: CALLBACK_ORIGIN,
        from: FROM,
        replyTo: REPLY_TO,
      },
      {
        apiKey: PROVIDER_CREDENTIAL,
        callbackOrigin: "http://staff.desmoslock.invalid",
        from: FROM,
        replyTo: REPLY_TO,
      },
      {
        apiKey: PROVIDER_CREDENTIAL,
        callbackOrigin: `${CALLBACK_ORIGIN}/`,
        from: FROM,
        replyTo: REPLY_TO,
      },
      {
        apiKey: PROVIDER_CREDENTIAL,
        callbackOrigin: CALLBACK_ORIGIN,
        from: "not-a-mailbox",
        replyTo: REPLY_TO,
      },
      {
        apiKey: PROVIDER_CREDENTIAL,
        callbackOrigin: CALLBACK_ORIGIN,
        from: FROM,
        replyTo: "Reply <support@example.invalid>",
      },
    ];

    for (const configuration of invalidConfigurations) {
      let message = "";
      try {
        createResendInvitationTransport(configuration);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      assert(
        message === "Resend invitation transport configuration is invalid",
        "invalid configuration detail escaped",
      );
    }
  },
);

Deno.test(
  "Resend invitation transport enforces invitation and retry deadlines",
  async () => {
    const longExpiresAt = "2026-09-05T12:00:00.000Z";
    const startedAt = Date.parse(ATTEMPT_STARTED_AT);
    let currentNow = startedAt;
    let fetchCalls = 0;
    const transport = createResendInvitationTransport(
      {
        apiKey: PROVIDER_CREDENTIAL,
        callbackOrigin: CALLBACK_ORIGIN,
        from: FROM,
        replyTo: REPLY_TO,
      },
      {
        clearTimeout: () => undefined,
        fetch: () => {
          fetchCalls += 1;
          return Promise.resolve(Response.json({ id: PROVIDER_MESSAGE_ID }));
        },
        now: () => currentNow,
        setTimeout: () => 1,
      },
    );
    const longAttempt = transport.prepare({
      attemptId: ATTEMPT_ID,
      attemptStartedAt: ATTEMPT_STARTED_AT,
      callbackUrl: CALLBACK,
      expiresAt: longExpiresAt,
      invitationId: INVITATION_ID,
      recipientEmail: RECIPIENT,
    });
    const shortAttempt = transport.prepare({
      attemptId: ATTEMPT_ID,
      attemptStartedAt: ATTEMPT_STARTED_AT,
      callbackUrl: CALLBACK,
      expiresAt: EXPIRES_AT,
      invitationId: INVITATION_ID,
      recipientEmail: RECIPIENT,
    });
    assert(longAttempt !== null && shortAttempt !== null, "preparation failed");

    currentNow = startedAt - 1;
    assert(
      (await transport.deliver(longAttempt)).kind === "provider_rejected",
      "pre-attempt clock was accepted",
    );
    currentNow = startedAt + RESEND_AUTOMATIC_RETRY_MAXIMUM_AGE_MILLISECONDS;
    assert(
      (await transport.deliver(longAttempt)).kind === "provider_rejected",
      "retry-age boundary was accepted",
    );
    currentNow = Date.parse(EXPIRES_AT);
    assert(
      (await transport.deliver(shortAttempt)).kind === "provider_rejected",
      "invitation expiry boundary was accepted",
    );
    currentNow = Number.NaN;
    assert(
      (await transport.deliver(longAttempt)).kind === "provider_rejected",
      "invalid runtime clock was accepted",
    );
    currentNow =
      startedAt + RESEND_AUTOMATIC_RETRY_MAXIMUM_AGE_MILLISECONDS - 1;
    assert(
      (await transport.deliver(longAttempt)).kind === "provider_accepted",
      "valid final retry millisecond was rejected",
    );

    assert(fetchCalls === 1, "expired attempts reached the provider");
  },
);

Deno.test(
  "Resend invitation transport refuses altered frozen attempts",
  async () => {
    let fetchCalls = 0;
    const transport = createResendInvitationTransport(
      {
        apiKey: PROVIDER_CREDENTIAL,
        callbackOrigin: CALLBACK_ORIGIN,
        from: FROM,
        replyTo: REPLY_TO,
      },
      {
        clearTimeout: () => undefined,
        fetch: () => {
          fetchCalls += 1;
          return Promise.resolve(Response.json({ id: PROVIDER_MESSAGE_ID }));
        },
        now: () => Date.parse(ATTEMPT_STARTED_AT) + 1_000,
        setTimeout: () => 1,
      },
    );
    const prepared = transport.prepare({
      attemptId: ATTEMPT_ID,
      attemptStartedAt: ATTEMPT_STARTED_AT,
      callbackUrl: CALLBACK,
      expiresAt: EXPIRES_AT,
      invitationId: INVITATION_ID,
      recipientEmail: RECIPIENT,
    });
    assert(prepared !== null, "expected a prepared delivery attempt");
    const altered = [
      { ...prepared, providerRequestBody: `${prepared.providerRequestBody} ` },
      { ...prepared, idempotencyKey: `${prepared.idempotencyKey}.changed` },
      { ...prepared, unexpected: true },
    ] as PreparedResendInvitationDelivery[];

    for (const attempt of altered) {
      const result = await transport.deliver(attempt);
      assert(result.kind === "provider_rejected", "altered attempt was sent");
    }

    assert(fetchCalls === 0, "altered frozen attempt reached the provider");
  },
);

Deno.test(
  "Resend invitation transport sanitizes configuration access failures",
  () => {
    let getterCalls = 0;
    const configuration = Object.defineProperties(
      {},
      {
        apiKey: {
          enumerable: true,
          get: () => {
            getterCalls += 1;
            throw new Error("SENTINEL-private-configuration-detail");
          },
        },
        callbackOrigin: { enumerable: true, value: CALLBACK_ORIGIN },
        from: { enumerable: true, value: FROM },
        replyTo: { enumerable: true, value: REPLY_TO },
      },
    );
    let message = "";

    try {
      createResendInvitationTransport(configuration);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    assert(
      message === "Resend invitation transport configuration is invalid",
      "configuration failure detail escaped",
    );
    assert(getterCalls === 0, "configuration accessor was invoked");
  },
);

Deno.test(
  "Resend invitation transport fails closed on unreadable material",
  () => {
    const transport = createResendInvitationTransport({
      apiKey: PROVIDER_CREDENTIAL,
      callbackOrigin: CALLBACK_ORIGIN,
      from: FROM,
      replyTo: REPLY_TO,
    });
    let getterCalls = 0;
    const material = Object.defineProperties(
      {},
      {
        attemptId: { enumerable: true, value: ATTEMPT_ID },
        attemptStartedAt: { enumerable: true, value: ATTEMPT_STARTED_AT },
        callbackUrl: { enumerable: true, value: CALLBACK },
        expiresAt: { enumerable: true, value: EXPIRES_AT },
        invitationId: { enumerable: true, value: INVITATION_ID },
        recipientEmail: {
          enumerable: true,
          get: () => {
            getterCalls += 1;
            throw new Error("SENTINEL-private-material-detail");
          },
        },
      },
    ) as ResendInvitationMaterial;

    const prepared = transport.prepare(material);

    assert(prepared === null, "material accessor failure escaped");
    assert(getterCalls === 0, "material accessor was invoked");
  },
);

Deno.test(
  "Resend invitation transport fails closed on unreadable frozen attempts",
  async () => {
    let fetchCalls = 0;
    const transport = createResendInvitationTransport(
      {
        apiKey: PROVIDER_CREDENTIAL,
        callbackOrigin: CALLBACK_ORIGIN,
        from: FROM,
        replyTo: REPLY_TO,
      },
      {
        clearTimeout: () => undefined,
        fetch: () => {
          fetchCalls += 1;
          return Promise.resolve(Response.json({ id: PROVIDER_MESSAGE_ID }));
        },
        now: () => Date.parse(ATTEMPT_STARTED_AT) + 1_000,
        setTimeout: () => 1,
      },
    );
    const prepared = transport.prepare({
      attemptId: ATTEMPT_ID,
      attemptStartedAt: ATTEMPT_STARTED_AT,
      callbackUrl: CALLBACK,
      expiresAt: EXPIRES_AT,
      invitationId: INVITATION_ID,
      recipientEmail: RECIPIENT,
    });
    assert(prepared !== null, "expected a prepared delivery attempt");
    const unreadable = new Proxy(prepared, {
      ownKeys: () => {
        throw new Error("SENTINEL-private-attempt-detail");
      },
    }) as PreparedResendInvitationDelivery;

    const result = await transport.deliver(unreadable);

    assert(
      result.kind === "provider_rejected",
      "attempt failure was not closed",
    );
    assert(fetchCalls === 0, "unreadable attempt reached the provider");
  },
);
