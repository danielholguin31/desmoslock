import { createBackendProbe, handleRequest } from "./index.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
    );
  }
}

async function assertRejects(action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch {
    return;
  }
  throw new Error("Expected action to reject");
}

Deno.test(
  "health endpoint reports the verified synthetic backend contract",
  async () => {
    const response = await handleRequest(
      new Request("http://localhost/health"),
      () =>
        Promise.resolve({
          capabilities: ["auth", "database", "rest"],
          fixtureDigest:
            "f1ecc4d44ca04b3395b565dd2fe9f7887147e34f6196772f18bae00638244201",
          fixtureValid: true,
          fixtureVersion: "internal-baseline-v2",
          schemaGeneration: 4,
        }),
    );

    assertEquals(response.status, 200);
    assertEquals(response.headers.get("cache-control"), "no-store");
    assertEquals(response.headers.get("access-control-allow-origin"), "*");
    assertEquals(await response.json(), {
      capabilities: ["auth", "database", "rest"],
      fixtureDigest:
        "f1ecc4d44ca04b3395b565dd2fe9f7887147e34f6196772f18bae00638244201",
      fixtureValid: true,
      fixtureVersion: "internal-baseline-v2",
      schemaGeneration: 4,
      service: "desmoslock-v2",
      status: "ready",
    });
  },
);

Deno.test("health endpoint rejects non-GET requests", async () => {
  const response = await handleRequest(
    new Request("http://localhost/health", {
      method: "POST",
    }),
  );

  assertEquals(response.status, 405);
  assertEquals(response.headers.get("allow"), "GET");
});

Deno.test(
  "health endpoint fails closed without exposing dependency errors",
  async () => {
    const response = await handleRequest(
      new Request("http://localhost/health"),
      () =>
        Promise.reject(
          new Error("credential-shaped diagnostic must stay private"),
        ),
    );

    assertEquals(response.status, 503);
    assertEquals(response.headers.get("cache-control"), "no-store");
    assertEquals(await response.json(), {
      reason: "dependency_unavailable",
      service: "desmoslock-v2",
      status: "unavailable",
    });
  },
);

Deno.test(
  "backend probe validates auth and the service-only baseline RPC",
  async () => {
    const requests: Array<{ input: string; init?: RequestInit }> = [];
    const timeoutSignal = new AbortController().signal;
    const probe = createBackendProbe(
      {
        DESMOSLOCK_EXPECTED_SUPABASE_ORIGIN:
          "https://abcdefghijklmnopqrst.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: "synthetic-test-only-key",
        SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
      },
      (input, init) => {
        requests.push({ input: String(input), init });
        if (String(input).endsWith("/auth/v1/health")) {
          return Promise.resolve(
            new Response(JSON.stringify({ status: "ok" }), {
              status: 200,
            }),
          );
        }
        return Promise.resolve(
          new Response(
            JSON.stringify([
              {
                fixture_digest:
                  "f1ecc4d44ca04b3395b565dd2fe9f7887147e34f6196772f18bae00638244201",
                fixture_valid: true,
                fixture_version: "internal-baseline-v2",
                migration_set_sha256:
                  "2ef021e3db72d5d2ef2602d1288d24b8a0fa20805a839aa96e49d778ff3ca49b",
                schema_generation: 4,
              },
            ]),
            { status: 200 },
          ),
        );
      },
      () => timeoutSignal,
    );

    await assertEquals(await probe(), {
      capabilities: ["auth", "database", "rest"],
      fixtureDigest:
        "f1ecc4d44ca04b3395b565dd2fe9f7887147e34f6196772f18bae00638244201",
      fixtureValid: true,
      fixtureVersion: "internal-baseline-v2",
      schemaGeneration: 4,
    });
    assertEquals(requests, [
      {
        input: "https://abcdefghijklmnopqrst.supabase.co/auth/v1/health",
        init: {
          headers: { apikey: "synthetic-test-only-key" },
          method: "GET",
          redirect: "error",
          signal: timeoutSignal,
        },
      },
      {
        input:
          "https://abcdefghijklmnopqrst.supabase.co/rest/v1/rpc/internal_baseline_status",
        init: {
          body: "{}",
          headers: {
            apikey: "synthetic-test-only-key",
            authorization: "Bearer synthetic-test-only-key",
            "content-profile": "desmoslock_v2",
            "content-type": "application/json",
          },
          method: "POST",
          redirect: "error",
          signal: timeoutSignal,
        },
      },
    ]);
  },
);

Deno.test(
  "backend probe rejects a well-formed but unpinned fixture digest",
  async () => {
    const probe = createBackendProbe(
      {
        DESMOSLOCK_EXPECTED_SUPABASE_ORIGIN:
          "https://abcdefghijklmnopqrst.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: "synthetic-test-only-key",
        SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
      },
      (input) =>
        Promise.resolve(
          String(input).endsWith("/auth/v1/health")
            ? new Response(null, { status: 200 })
            : new Response(
                JSON.stringify([
                  {
                    fixture_digest: "0".repeat(64),
                    fixture_valid: true,
                    fixture_version: "internal-baseline-v2",
                    migration_set_sha256:
                      "2ef021e3db72d5d2ef2602d1288d24b8a0fa20805a839aa96e49d778ff3ca49b",
                    schema_generation: 4,
                  },
                ]),
                { status: 200 },
              ),
        ),
      () => new AbortController().signal,
    );

    await assertRejects(() => probe());
  },
);

for (const migrationSetSha256 of [
  "80c2720ff352c721298e5814715374bf9e2a9c1152bbf2d2761ad781265f8701",
  "aa32ed754c87e7987199dbd6c5f685ae65236ba3f94921157fc6cb07ce67b308",
  "5cf17174bf44e491a6bd78fe540326d8bdee169518d75c8082e5bd9b833f3f62",
  "0".repeat(64),
  "7c3e7403b61d5c66123b15d2fe4de28ee2259d71a304ce8695d16630f5353a56",
  "9264f3b4933e4f1bb207d5a1a130ab0b3edafea787ac37fb25268b09afba2538",
]) {
  Deno.test(
    `backend probe rejects an unattested or historical migration set: ${migrationSetSha256}`,
    async () => {
      const probe = createBackendProbe(
        {
          DESMOSLOCK_EXPECTED_SUPABASE_ORIGIN:
            "https://abcdefghijklmnopqrst.supabase.co",
          SUPABASE_SERVICE_ROLE_KEY: "synthetic-test-only-key",
          SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
        },
        (input) =>
          Promise.resolve(
            String(input).endsWith("/auth/v1/health")
              ? new Response(null, { status: 200 })
              : new Response(
                  JSON.stringify([
                    {
                      fixture_digest:
                        "f1ecc4d44ca04b3395b565dd2fe9f7887147e34f6196772f18bae00638244201",
                      fixture_valid: true,
                      fixture_version: "internal-baseline-v2",
                      migration_set_sha256: migrationSetSha256,
                      schema_generation: 4,
                    },
                  ]),
                  { status: 200 },
                ),
          ),
        () => new AbortController().signal,
      );

      await assertRejects(() => probe());
    },
  );
}

Deno.test(
  "health endpoint sanitizes a timed-out backend dependency",
  async () => {
    const controller = new AbortController();
    const probe = createBackendProbe(
      {
        DESMOSLOCK_EXPECTED_SUPABASE_ORIGIN:
          "https://abcdefghijklmnopqrst.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: "synthetic-test-only-key",
        SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
      },
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("synthetic timeout", "AbortError"));
          });
        }),
      () => controller.signal,
    );

    const responsePromise = handleRequest(
      new Request("http://localhost/health"),
      probe,
    );
    controller.abort();
    const response = await responsePromise;

    assertEquals(response.status, 503);
    assertEquals(await response.json(), {
      reason: "dependency_unavailable",
      service: "desmoslock-v2",
      status: "unavailable",
    });
  },
);

Deno.test(
  "backend probe never sends the service key to an arbitrary HTTPS origin",
  async () => {
    let requests = 0;
    const probe = createBackendProbe(
      {
        DESMOSLOCK_EXPECTED_SUPABASE_ORIGIN: "https://arbitrary.example",
        SUPABASE_SERVICE_ROLE_KEY: "synthetic-test-only-key",
        SUPABASE_URL: "https://arbitrary.example",
      },
      () => {
        requests += 1;
        return Promise.resolve(new Response(null, { status: 200 }));
      },
      () => new AbortController().signal,
    );

    await assertRejects(() => probe());
    assertEquals(requests, 0);
  },
);

Deno.test(
  "backend probe never sends the service key without an exact local origin pin",
  async () => {
    for (const expectedOrigin of [
      undefined,
      "http://127.0.0.1:54322",
      "http://kong:8000",
    ]) {
      let requests = 0;
      const probe = createBackendProbe(
        {
          DESMOSLOCK_EXPECTED_SUPABASE_ORIGIN: expectedOrigin,
          SUPABASE_SERVICE_ROLE_KEY: "synthetic-test-only-key",
          SUPABASE_URL: "http://127.0.0.1:54321",
        },
        () => {
          requests += 1;
          return Promise.resolve(new Response(null, { status: 200 }));
        },
        () => new AbortController().signal,
      );

      await assertRejects(() => probe());
      assertEquals(requests, 0);
    }
  },
);

Deno.test(
  "backend probe accepts every explicitly pinned local development origin",
  async () => {
    for (const origin of [
      "http://127.0.0.1:54321",
      "http://[::1]:54321",
      "http://host.docker.internal:54321",
      "http://kong:8000",
    ]) {
      let requests = 0;
      const probe = createBackendProbe(
        {
          DESMOSLOCK_EXPECTED_SUPABASE_ORIGIN: origin,
          SUPABASE_SERVICE_ROLE_KEY: "synthetic-test-only-key",
          SUPABASE_URL: origin,
        },
        (input) => {
          requests += 1;
          if (String(input).endsWith("/auth/v1/health")) {
            return Promise.resolve(new Response(null, { status: 200 }));
          }
          return Promise.resolve(
            new Response(
              JSON.stringify([
                {
                  fixture_digest:
                    "f1ecc4d44ca04b3395b565dd2fe9f7887147e34f6196772f18bae00638244201",
                  fixture_valid: true,
                  fixture_version: "internal-baseline-v2",
                  migration_set_sha256:
                    "2ef021e3db72d5d2ef2602d1288d24b8a0fa20805a839aa96e49d778ff3ca49b",
                  schema_generation: 4,
                },
              ]),
              { status: 200 },
            ),
          );
        },
        () => new AbortController().signal,
      );

      await probe();
      assertEquals(requests, 2);
    }
  },
);

Deno.test(
  "backend probe accepts the exact unpinned Supabase CLI internal gateway",
  async () => {
    const requests: string[] = [];
    const probe = createBackendProbe(
      {
        DESMOSLOCK_EXPECTED_SUPABASE_ORIGIN: undefined,
        SUPABASE_SERVICE_ROLE_KEY: "synthetic-test-only-key",
        SUPABASE_URL: "http://kong:8000",
      },
      (input) => {
        requests.push(String(input));
        if (String(input).endsWith("/auth/v1/health")) {
          return Promise.resolve(new Response(null, { status: 200 }));
        }
        return Promise.resolve(
          new Response(
            JSON.stringify([
              {
                fixture_digest:
                  "f1ecc4d44ca04b3395b565dd2fe9f7887147e34f6196772f18bae00638244201",
                fixture_valid: true,
                fixture_version: "internal-baseline-v2",
                migration_set_sha256:
                  "2ef021e3db72d5d2ef2602d1288d24b8a0fa20805a839aa96e49d778ff3ca49b",
                schema_generation: 4,
              },
            ]),
            { status: 200 },
          ),
        );
      },
      () => new AbortController().signal,
    );

    await probe();
    assertEquals(requests.toSorted(), [
      "http://kong:8000/auth/v1/health",
      "http://kong:8000/rest/v1/rpc/internal_baseline_status",
    ]);
  },
);

Deno.test(
  "backend probe rejects every near-miss unpinned local gateway",
  async () => {
    for (const origin of [
      "http://127.0.0.1:54321",
      "http://host.docker.internal:54321",
      "http://kong:54321",
      "http://kong.example:8000",
      "https://kong:8000",
    ]) {
      let requests = 0;
      const probe = createBackendProbe(
        {
          DESMOSLOCK_EXPECTED_SUPABASE_ORIGIN: undefined,
          SUPABASE_SERVICE_ROLE_KEY: "synthetic-test-only-key",
          SUPABASE_URL: origin,
        },
        () => {
          requests += 1;
          return Promise.resolve(new Response(null, { status: 200 }));
        },
        () => new AbortController().signal,
      );

      await assertRejects(() => probe());
      assertEquals(requests, 0);
    }
  },
);

Deno.test(
  "backend probe rejects a hosted origin outside the independent pin",
  async () => {
    let requests = 0;
    const probe = createBackendProbe(
      {
        DESMOSLOCK_EXPECTED_SUPABASE_ORIGIN:
          "https://abcdefghijklmnopqrst.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: "synthetic-test-only-key",
        SUPABASE_URL: "https://zyxwvutsrqponmlkjihg.supabase.co",
      },
      () => {
        requests += 1;
        return Promise.resolve(new Response(null, { status: 200 }));
      },
      () => new AbortController().signal,
    );

    await assertRejects(() => probe());
    assertEquals(requests, 0);
  },
);
