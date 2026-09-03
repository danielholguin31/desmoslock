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
      async () => ({
        capabilities: ["auth", "database", "rest", "staff-auth"],
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
      capabilities: ["auth", "database", "rest", "staff-auth"],
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
      async () => {
        throw new Error("credential-shaped diagnostic must stay private");
      },
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
      async (input, init) => {
        requests.push({ input: String(input), init });
        if (String(input).endsWith("/auth/v1/health")) {
          return new Response(JSON.stringify({ status: "ok" }), {
            status: 200,
          });
        }
        return new Response(
          JSON.stringify([
            {
              fixture_digest:
                "f1ecc4d44ca04b3395b565dd2fe9f7887147e34f6196772f18bae00638244201",
              fixture_valid: true,
              fixture_version: "internal-baseline-v2",
              migration_set_sha256:
                "0ef2ff06cf7b93e67d4cf10ab422b96b41a486f65a7a6e52c07ce493a6e5dc66",
              schema_generation: 4,
            },
          ]),
          { status: 200 },
        );
      },
      () => timeoutSignal,
    );

    await assertEquals(await probe(), {
      capabilities: ["auth", "database", "rest", "staff-auth"],
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
      async (input) =>
        String(input).endsWith("/auth/v1/health")
          ? new Response(null, { status: 200 })
          : new Response(
              JSON.stringify([
                {
                  fixture_digest: "0".repeat(64),
                  fixture_valid: true,
                  fixture_version: "internal-baseline-v2",
                  migration_set_sha256:
                    "0ef2ff06cf7b93e67d4cf10ab422b96b41a486f65a7a6e52c07ce493a6e5dc66",
                  schema_generation: 4,
                },
              ]),
              { status: 200 },
            ),
      () => new AbortController().signal,
    );

    await assertRejects(() => probe());
  },
);

Deno.test(
  "backend probe rejects a well-formed but unattested migration set",
  async () => {
    const probe = createBackendProbe(
      {
        DESMOSLOCK_EXPECTED_SUPABASE_ORIGIN:
          "https://abcdefghijklmnopqrst.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: "synthetic-test-only-key",
        SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
      },
      async (input) =>
        String(input).endsWith("/auth/v1/health")
          ? new Response(null, { status: 200 })
          : new Response(
              JSON.stringify([
                {
                  fixture_digest:
                    "f1ecc4d44ca04b3395b565dd2fe9f7887147e34f6196772f18bae00638244201",
                  fixture_valid: true,
                  fixture_version: "internal-baseline-v2",
                  migration_set_sha256: "0".repeat(64),
                  schema_generation: 4,
                },
              ]),
              { status: 200 },
            ),
      () => new AbortController().signal,
    );

    await assertRejects(() => probe());
  },
);

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
      async () => {
        requests += 1;
        return new Response(null, { status: 200 });
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
        async () => {
          requests += 1;
          return new Response(null, { status: 200 });
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
        async (input) => {
          requests += 1;
          if (String(input).endsWith("/auth/v1/health")) {
            return new Response(null, { status: 200 });
          }
          return new Response(
            JSON.stringify([
              {
                fixture_digest:
                  "f1ecc4d44ca04b3395b565dd2fe9f7887147e34f6196772f18bae00638244201",
                fixture_valid: true,
                fixture_version: "internal-baseline-v2",
                migration_set_sha256:
                  "0ef2ff06cf7b93e67d4cf10ab422b96b41a486f65a7a6e52c07ce493a6e5dc66",
                schema_generation: 4,
              },
            ]),
            { status: 200 },
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
      async (input) => {
        requests.push(String(input));
        if (String(input).endsWith("/auth/v1/health")) {
          return new Response(null, { status: 200 });
        }
        return new Response(
          JSON.stringify([
            {
              fixture_digest:
                "f1ecc4d44ca04b3395b565dd2fe9f7887147e34f6196772f18bae00638244201",
              fixture_valid: true,
              fixture_version: "internal-baseline-v2",
              migration_set_sha256:
                "0ef2ff06cf7b93e67d4cf10ab422b96b41a486f65a7a6e52c07ce493a6e5dc66",
              schema_generation: 4,
            },
          ]),
          { status: 200 },
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
        async () => {
          requests += 1;
          return new Response(null, { status: 200 });
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
      async () => {
        requests += 1;
        return new Response(null, { status: 200 });
      },
      () => new AbortController().signal,
    );

    await assertRejects(() => probe());
    assertEquals(requests, 0);
  },
);
