// deno-lint-ignore-file require-await

import { createSupabaseHttpClient } from "./supabase-http.ts";

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
  "Supabase HTTP client rejects cross-origin egress before fetch",
  async () => {
    let requests = 0;
    const client = createSupabaseHttpClient(
      {
        expectedOrigin: "https://abcdefghijklmnopqrst.supabase.co",
        publishableKey: "synthetic-publishable-sentinel",
        supabaseUrl: "https://abcdefghijklmnopqrst.supabase.co",
      },
      async () => {
        requests += 1;
        return new Response(null, { status: 200 });
      },
    );
    await assertRejects(() =>
      client.request("https://attacker.invalid/auth/v1/recover", {
        method: "POST",
      }),
    );
    assertEquals(requests, 0);
  },
);

Deno.test(
  "Supabase HTTP client pins the configured origin and disables redirects",
  async () => {
    const requests: Array<{ init?: RequestInit; url: string }> = [];
    const client = createSupabaseHttpClient(
      {
        expectedOrigin: "https://abcdefghijklmnopqrst.supabase.co",
        publishableKey: "synthetic-publishable-sentinel",
        supabaseUrl: "https://abcdefghijklmnopqrst.supabase.co",
      },
      async (input, init) => {
        requests.push({ init, url: String(input) });
        return new Response(null, { status: 200 });
      },
    );
    await client.request("/rest/v1/rpc/example", { method: "POST" });
    assertEquals(
      requests[0].url,
      "https://abcdefghijklmnopqrst.supabase.co/rest/v1/rpc/example",
    );
    assertEquals(requests[0].init?.redirect, "error");
  },
);

Deno.test(
  "Supabase HTTP client rejects a matching arbitrary HTTPS origin",
  () => {
    let requests = 0;
    try {
      createSupabaseHttpClient(
        {
          expectedOrigin: "https://attacker.invalid",
          publishableKey: "synthetic-publishable-sentinel",
          supabaseUrl: "https://attacker.invalid",
        },
        async () => {
          requests += 1;
          return new Response(null, { status: 200 });
        },
      );
    } catch {
      assertEquals(requests, 0);
      return;
    }
    throw new Error("Expected arbitrary HTTPS origin to be rejected");
  },
);

Deno.test(
  "Supabase HTTP client accepts every pinned local runtime host",
  () => {
    for (const origin of [
      "http://127.0.0.1:54321",
      "http://[::1]:54321",
      "http://host.docker.internal:54321",
      "http://kong:8000",
    ]) {
      const client = createSupabaseHttpClient(
        {
          expectedOrigin: origin,
          publishableKey: "synthetic-publishable-sentinel",
          supabaseUrl: origin,
        },
        async () => new Response(null, { status: 200 }),
      );
      assertEquals(client.origin, origin);
    }
  },
);
