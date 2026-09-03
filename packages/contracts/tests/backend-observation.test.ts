import { describe, expect, it } from "vitest";

import {
  createBackendHealthReader,
  observeBackend,
  parsePublicBackendConfiguration,
} from "../src/index.js";

describe("backend observation", () => {
  it("requires both public configuration fields explicitly", () => {
    expect(
      parsePublicBackendConfiguration({
        environment: undefined,
        url: undefined,
      }),
    ).toBeNull();
  });

  it("reads only the public health endpoint without credentials or redirects", async () => {
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> =
      [];
    const timeoutSignal = new AbortController().signal;
    const reader = createBackendHealthReader(
      async (input, init) => {
        requests.push(init === undefined ? { input } : { input, init });
        return new Response(JSON.stringify({ status: "ready" }), {
          headers: { "content-type": "application/json" },
          status: 200,
        });
      },
      () => timeoutSignal,
    );

    await expect(
      reader.readHealth(new URL("https://synthetic-staging.supabase.co")),
    ).resolves.toEqual({
      body: { status: "ready" },
      status: 200,
    });
    expect(requests).toEqual([
      {
        input: "https://synthetic-staging.supabase.co/functions/v1/health",
        init: {
          cache: "no-store",
          credentials: "omit",
          headers: { accept: "application/json" },
          method: "GET",
          redirect: "error",
          signal: timeoutSignal,
        },
      },
    ]);
  });

  it("reports a compatible synthetic staging backend as ready", async () => {
    const observation = await observeBackend(
      {
        environment: "staging",
        url: "https://synthetic-staging.supabase.co",
      },
      {
        async readHealth() {
          return {
            body: {
              capabilities: ["auth", "database", "rest"],
              fixtureDigest:
                "7c84b474e409b79fdb11e537b29a48f56382c1f88afc28b213fb5043fff7f2ca",
              fixtureValid: true,
              fixtureVersion: "internal-baseline-v1",
              schemaGeneration: 3,
              service: "desmoslock-v2",
              status: "ready",
            },
            status: 200,
          };
        },
      },
    );

    expect(observation).toEqual({
      environment: "staging",
      fixtureDigest:
        "7c84b474e409b79fdb11e537b29a48f56382c1f88afc28b213fb5043fff7f2ca",
      fixtureVersion: "internal-baseline-v1",
      schemaGeneration: 3,
      status: "ready",
    });
  });

  it("rejects a staging configuration that is local or contains privileged fields", async () => {
    const observation = await observeBackend(
      {
        environment: "staging",
        operatorCredential: "synthetic-placeholder",
        url: "http://127.0.0.1:54321",
      },
      {
        async readHealth() {
          throw new Error(
            "an invalid configuration must not reach the network",
          );
        },
      },
    );

    expect(observation).toEqual({
      reason: "configuration_invalid",
      status: "unavailable",
    });
  });

  it("rejects a delimiter-collapsed public configuration key", async () => {
    const observation = await observeBackend(
      {
        "environment,url": "staging,https://synthetic-staging.supabase.co",
      },
      {
        async readHealth() {
          throw new Error(
            "a delimiter-collapsed configuration must not reach the network",
          );
        },
      },
    );

    expect(observation).toEqual({
      reason: "configuration_invalid",
      status: "unavailable",
    });
  });

  it("rejects credentials embedded in the public backend URL before build or fetch", async () => {
    const credentialBearingUrl = new URL(
      "https://synthetic-staging.supabase.co",
    );
    credentialBearingUrl.username = "operator";
    credentialBearingUrl.password = "credential";
    const observation = await observeBackend(
      {
        environment: "staging",
        url: credentialBearingUrl.href,
      },
      {
        async readHealth() {
          throw new Error(
            "a credential-bearing URL must not reach the network",
          );
        },
      },
    );

    expect(observation).toEqual({
      reason: "configuration_invalid",
      status: "unavailable",
    });
  });

  it.each([
    "https://localhost",
    "https://localhost.",
    "https://foo.localhost",
    "https://foo.localhost.",
  ])("rejects the special-use localhost namespace for staging: %s", (url) => {
    expect(
      parsePublicBackendConfiguration({ environment: "staging", url }),
    ).toBeNull();
  });

  it("does not reject a DNS name merely because localhost is a nonterminal label", () => {
    expect(
      parsePublicBackendConfiguration({
        environment: "staging",
        url: "https://localhost.example.com",
      }),
    ).toEqual({
      environment: "staging",
      url: "https://localhost.example.com",
    });
  });

  it("fails closed when the backend health endpoint is unavailable", async () => {
    const observation = await observeBackend(
      {
        environment: "local",
        url: "http://127.0.0.1:54321",
      },
      {
        async readHealth() {
          return {
            body: { status: "unavailable" },
            status: 503,
          };
        },
      },
    );

    expect(observation).toEqual({
      reason: "service_unavailable",
      status: "unavailable",
    });
  });

  it("fails closed when the backend health contract is incompatible", async () => {
    const observation = await observeBackend(
      {
        environment: "local",
        url: "http://[::1]:54321",
      },
      {
        async readHealth() {
          return {
            body: {
              capabilities: ["auth", "database", "rest"],
              fixtureDigest: "not-a-sha-256",
              fixtureValid: true,
              fixtureVersion: "internal-baseline-v1",
              schemaGeneration: 3,
              service: "desmoslock-v2",
              status: "ready",
            },
            status: 200,
          };
        },
      },
    );

    expect(observation).toEqual({
      reason: "contract_incompatible",
      status: "unavailable",
    });
  });

  it("fails closed for a well-formed digest outside the pinned baseline", async () => {
    const observation = await observeBackend(
      {
        environment: "staging",
        url: "https://synthetic-staging.supabase.co",
      },
      {
        async readHealth() {
          return {
            body: {
              capabilities: ["auth", "database", "rest"],
              fixtureDigest: "0".repeat(64),
              fixtureValid: true,
              fixtureVersion: "internal-baseline-v1",
              schemaGeneration: 3,
              service: "desmoslock-v2",
              status: "ready",
            },
            status: 200,
          };
        },
      },
    );

    expect(observation).toEqual({
      reason: "contract_incompatible",
      status: "unavailable",
    });
  });

  it("rejects delimiter-collapsed capability names", async () => {
    const observation = await observeBackend(
      {
        environment: "staging",
        url: "https://synthetic-staging.supabase.co",
      },
      {
        async readHealth() {
          return {
            body: {
              capabilities: ["auth,database", "rest"],
              fixtureDigest:
                "7c84b474e409b79fdb11e537b29a48f56382c1f88afc28b213fb5043fff7f2ca",
              fixtureValid: true,
              fixtureVersion: "internal-baseline-v1",
              schemaGeneration: 3,
              service: "desmoslock-v2",
              status: "ready",
            },
            status: 200,
          };
        },
      },
    );

    expect(observation).toEqual({
      reason: "contract_incompatible",
      status: "unavailable",
    });
  });
});
