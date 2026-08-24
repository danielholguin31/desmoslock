import { handleRequest } from "./index.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
    );
  }
}

Deno.test("health endpoint returns a credential-free v2 marker", async () => {
  const response = handleRequest(new Request("http://localhost/health"));

  assertEquals(response.status, 200);
  assertEquals(response.headers.get("cache-control"), "no-store");
  assertEquals(await response.json(), {
    schemaGeneration: 2,
    service: "desmoslock-v2",
    status: "ok",
  });
});

Deno.test("health endpoint rejects non-GET requests", () => {
  const response = handleRequest(
    new Request("http://localhost/health", {
      method: "POST",
    }),
  );

  assertEquals(response.status, 405);
  assertEquals(response.headers.get("allow"), "GET");
});
