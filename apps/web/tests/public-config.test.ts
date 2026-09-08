import { describe, expect, it } from "vitest";

import {
  isPublicWebConfigurationForRuntime,
  parsePublicWebConfiguration,
  publicWebConfiguration,
} from "../src/public-config.js";

const syntheticPublishableKey = `sb_publishable_${"r".repeat(22)}_${"c".repeat(8)}`;

function localConfiguration(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    environment: "local",
    url: "http://127.0.0.1:54321",
    origin: "http://localhost:43174",
    publishableKey: syntheticPublishableKey,
    ...overrides,
  };
}

describe("web-only public configuration", () => {
  it("accepts and normalizes the exact public web shape", () => {
    const configuration = parsePublicWebConfiguration({
      environment: "staging",
      url: "https://synthetic-project.supabase.co",
      origin: "https://app.example.test",
      publishableKey: syntheticPublishableKey,
    });

    expect(configuration).toEqual({
      environment: "staging",
      url: "https://synthetic-project.supabase.co",
      origin: "https://app.example.test",
      publishableKey: syntheticPublishableKey,
    });
    expect(Object.keys(configuration ?? {})).toEqual([
      "environment",
      "url",
      "origin",
      "publishableKey",
    ]);
  });

  it.each([
    "http://localhost:43174",
    "http://127.0.0.1:43174",
    "http://[::1]:43174",
    "https://app.example.test",
  ])("accepts the trusted callback origin policy: %s", (origin) => {
    expect(parsePublicWebConfiguration(localConfiguration({ origin }))).toEqual(
      expect.objectContaining({ origin }),
    );
  });

  it.each([
    "http://app.example.test",
    "http://localhost.example.test",
    "http://localhost.",
    "https://app.example.test/",
    "https://app.example.test/path",
    "https://app.example.test?query=1",
    "https://app.example.test#fragment",
    "https://operator@app.example.test",
    "https://app.example.test:443",
    "HTTPS://app.example.test",
    " https://app.example.test",
    "https://app.example.test\n",
  ])(
    "rejects a non-canonical or untrusted application origin: %s",
    (origin) => {
      expect(
        parsePublicWebConfiguration(localConfiguration({ origin })),
      ).toBeNull();
    },
  );

  it.each([
    ["missing environment", { environment: undefined }],
    ["missing backend URL", { url: undefined }],
    ["missing application origin", { origin: undefined }],
    ["missing publishable key", { publishableKey: undefined }],
    ["invalid environment", { environment: "production" }],
    ["invalid backend URL", { url: "http://example.test" }],
    ["invalid publishable key", { publishableKey: "synthetic-invalid" }],
  ])("fails closed for %s", (_label, override) => {
    expect(
      parsePublicWebConfiguration(localConfiguration(override)),
    ).toBeNull();
  });

  it("rejects missing, partial, additional, inherited, and accessor fields", () => {
    const withAdditionalField = localConfiguration({
      operatorCredential: "synthetic-forbidden",
    });
    const inherited = Object.assign(
      Object.create({ inherited: true }),
      localConfiguration(),
    ) as Record<string, unknown>;
    const accessor = localConfiguration();
    Object.defineProperty(accessor, "origin", {
      enumerable: true,
      get() {
        throw new Error("configuration accessors must not run");
      },
    });
    const withSymbol = localConfiguration();
    Object.defineProperty(withSymbol, Symbol("unexpected"), {
      enumerable: true,
      value: "unexpected",
    });

    for (const value of [
      null,
      [],
      {},
      { environment: "local" },
      withAdditionalField,
      inherited,
      accessor,
      withSymbol,
    ]) {
      expect(() => parsePublicWebConfiguration(value)).not.toThrow();
      expect(parsePublicWebConfiguration(value)).toBeNull();
    }
  });

  it("requires the configured application origin to match the runtime exactly", () => {
    const configuration = localConfiguration();

    expect(
      isPublicWebConfigurationForRuntime(
        configuration,
        "http://localhost:43174",
      ),
    ).toBe(true);
    expect(
      isPublicWebConfigurationForRuntime(
        configuration,
        "http://127.0.0.1:43174",
      ),
    ).toBe(false);
    expect(
      isPublicWebConfigurationForRuntime(
        configuration,
        "http://localhost:43174/",
      ),
    ).toBe(false);
    expect(
      isPublicWebConfigurationForRuntime(
        { ...configuration, secretKey: "synthetic-forbidden" },
        "http://localhost:43174",
      ),
    ).toBe(false);
  });

  it("has no usable configuration when build definitions are absent", () => {
    expect(publicWebConfiguration).toBeNull();
  });
});
