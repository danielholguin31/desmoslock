import assert from "node:assert/strict";
import test from "node:test";

const localBackendOrigin = "http://127.0.0.1:54321";
const maximumAttempts = 40;
const retryDelayMs = 250;

async function delay() {
  await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
}

async function fetchLocal(path, init, expectedStatuses) {
  const endpoint = new URL(path, localBackendOrigin);
  let lastError;
  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    try {
      const response = await fetch(endpoint, {
        ...init,
        redirect: "manual",
        signal: AbortSignal.timeout(2_000),
      });
      if (expectedStatuses.includes(response.status)) return response;
      await response.body?.cancel();
      lastError = new Error("Disposable local backend is not ready");
    } catch (error) {
      lastError = error;
    }
    await delay();
  }
  throw new Error("Disposable local backend did not become reachable", {
    cause: lastError,
  });
}

test("disposable Auth is reachable or credential-gated without exposing a key", async () => {
  const response = await fetchLocal(
    "/auth/v1/health",
    { method: "GET" },
    [200, 401],
  );

  assert.equal([200, 401].includes(response.status), true);
  await response.body?.cancel();
});

test("anonymous PostgREST access fails closed before a staff RPC executes", async () => {
  const response = await fetchLocal(
    "/rest/v1/rpc/current_staff_context",
    {
      body: "{}",
      headers: {
        "content-profile": "desmoslock_v2",
        "content-type": "application/json",
      },
      method: "POST",
    },
    [401],
  );

  assert.equal(response.status, 401);
  await response.body?.cancel();
});

test("live public health is exact-ready for generation-4 schema prerequisites", async () => {
  const response = await fetchLocal(
    "/functions/v1/health",
    { method: "GET" },
    [200],
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    capabilities: ["auth", "database", "rest"],
    fixtureDigest:
      "f1ecc4d44ca04b3395b565dd2fe9f7887147e34f6196772f18bae00638244201",
    fixtureValid: true,
    fixtureVersion: "internal-baseline-v2",
    schemaGeneration: 4,
    service: "desmoslock-v2",
    status: "ready",
  });
});
