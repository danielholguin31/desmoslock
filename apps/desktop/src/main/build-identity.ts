import {
  parseClientBuildIdentity,
  type ClientBuildIdentity,
} from "@desmoslock/contracts";

declare const __DESMOSLOCK_CLIENT_BUILD_IDENTITY__: unknown;

/** Main-private provenance only. This grants no admission or native authority. */
export function readClientBuildIdentity(): ClientBuildIdentity | null {
  return parseClientBuildIdentity(
    typeof __DESMOSLOCK_CLIENT_BUILD_IDENTITY__ === "undefined"
      ? null
      : __DESMOSLOCK_CLIENT_BUILD_IDENTITY__,
  );
}
