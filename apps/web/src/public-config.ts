import {
  parsePublicBackendConfiguration,
  parsePublicStaffAuthConfiguration,
  type InternalBackendEnvironment,
} from "@desmoslock/contracts";

declare const __DESMOSLOCK_PUBLIC_BACKEND_ENVIRONMENT__: string;
declare const __DESMOSLOCK_PUBLIC_BACKEND_URL__: string;
declare const __DESMOSLOCK_PUBLIC_SUPABASE_PUBLISHABLE_KEY__: string;
declare const __DESMOSLOCK_PUBLIC_WEB_ORIGIN__: string;

export interface PublicWebConfiguration {
  readonly environment: InternalBackendEnvironment;
  readonly url: string;
  readonly origin: string;
  readonly publishableKey: string;
}

const publicWebConfigurationKeys = [
  "environment",
  "url",
  "origin",
  "publishableKey",
] as const;

function snapshotExactPublicWebConfiguration(
  value: unknown,
): Record<(typeof publicWebConfigurationKeys)[number], unknown> | null {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return null;
    }
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) return null;

    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length !== publicWebConfigurationKeys.length ||
      ownKeys.some(
        (key) =>
          typeof key !== "string" ||
          !publicWebConfigurationKeys.includes(
            key as (typeof publicWebConfigurationKeys)[number],
          ),
      )
    ) {
      return null;
    }

    const snapshot = Object.create(null) as Record<
      (typeof publicWebConfigurationKeys)[number],
      unknown
    >;
    for (const key of publicWebConfigurationKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        !descriptor.enumerable
      ) {
        return null;
      }
      snapshot[key] = descriptor.value as unknown;
    }
    return snapshot;
  } catch {
    return null;
  }
}

function hasControlText(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return (
      codePoint !== undefined &&
      (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
    );
  });
}

function parsePublicWebOrigin(value: unknown): string | null {
  if (typeof value !== "string" || hasControlText(value)) return null;

  let origin: URL;
  try {
    origin = new URL(value);
  } catch {
    return null;
  }

  const isLoopbackHostname =
    origin.hostname === "127.0.0.1" ||
    origin.hostname === "localhost" ||
    origin.hostname === "[::1]";
  if (
    origin.origin !== value ||
    origin.pathname !== "/" ||
    origin.search !== "" ||
    origin.hash !== "" ||
    origin.username !== "" ||
    origin.password !== "" ||
    (origin.protocol !== "https:" &&
      !(origin.protocol === "http:" && isLoopbackHostname))
  ) {
    return null;
  }

  return origin.origin;
}

export function parsePublicWebConfiguration(
  value: unknown,
): PublicWebConfiguration | null {
  const configuration = snapshotExactPublicWebConfiguration(value);
  if (configuration === null) return null;

  const backend = parsePublicBackendConfiguration({
    environment: configuration.environment,
    url: configuration.url,
  });
  const staffAuth = parsePublicStaffAuthConfiguration({
    publishableKey: configuration.publishableKey,
  });
  const origin = parsePublicWebOrigin(configuration.origin);
  if (backend === null || staffAuth === null || origin === null) return null;

  return {
    environment: backend.environment,
    url: backend.url,
    origin,
    publishableKey: staffAuth.publishableKey,
  };
}

export function isPublicWebConfigurationForRuntime(
  configuration: unknown,
  runtimeOrigin: unknown,
): configuration is PublicWebConfiguration {
  const parsedConfiguration = parsePublicWebConfiguration(configuration);
  const parsedRuntimeOrigin = parsePublicWebOrigin(runtimeOrigin);
  return (
    parsedConfiguration !== null &&
    parsedRuntimeOrigin !== null &&
    parsedConfiguration.origin === parsedRuntimeOrigin
  );
}

export const publicWebConfiguration = parsePublicWebConfiguration({
  environment:
    typeof __DESMOSLOCK_PUBLIC_BACKEND_ENVIRONMENT__ === "string"
      ? __DESMOSLOCK_PUBLIC_BACKEND_ENVIRONMENT__
      : undefined,
  url:
    typeof __DESMOSLOCK_PUBLIC_BACKEND_URL__ === "string"
      ? __DESMOSLOCK_PUBLIC_BACKEND_URL__
      : undefined,
  origin:
    typeof __DESMOSLOCK_PUBLIC_WEB_ORIGIN__ === "string"
      ? __DESMOSLOCK_PUBLIC_WEB_ORIGIN__
      : undefined,
  publishableKey:
    typeof __DESMOSLOCK_PUBLIC_SUPABASE_PUBLISHABLE_KEY__ === "string"
      ? __DESMOSLOCK_PUBLIC_SUPABASE_PUBLISHABLE_KEY__
      : undefined,
});
