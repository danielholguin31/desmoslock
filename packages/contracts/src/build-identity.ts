import { parseExactRecord } from "./exact-record.js";

export interface ClientBuildIdentity {
  readonly schemaVersion: 1;
  readonly sourceRepository: "danielholguin31/desmoslock";
  readonly sourceCommit: string;
  readonly sourceTree: string;
  readonly packageLockSha256: string;
  readonly buildId: string;
}

/** Build inputs describe one unsigned native-architecture preparation. */
export interface ClientBuildInputs {
  readonly schemaVersion: 1;
  readonly sourceRepository: ClientBuildIdentity["sourceRepository"];
  readonly sourceCommit: string;
  readonly sourceTree: string;
  readonly packageLockSha256: string;
  readonly packageVersion: string;
  readonly platform: "darwin";
  readonly architecture: "arm64" | "x64";
  readonly backendConfigurationSha256: string;
  readonly graphingProfile: "internal-graphing-v1";
  readonly tools: {
    readonly node: { readonly version: string; readonly sha256: string };
    readonly npm: { readonly version: string; readonly sha256: string };
    readonly electron: {
      readonly version: string;
      readonly archiveSha256: string;
    };
    readonly packager: { readonly version: string };
    readonly fuses: { readonly version: string };
    readonly compiler: { readonly version: string; readonly sha256: string };
    readonly sdk: {
      readonly version: string;
      readonly buildVersion: string;
      readonly settingsSha256: string;
    };
    readonly nodeHeadersSha256: string;
  };
}

function digest(value: unknown, length: 40 | 64): value is string {
  return (
    typeof value === "string" &&
    value.length === length &&
    /^[0-9a-f]+$/u.test(value) &&
    !/^0+$/u.test(value)
  );
}

function version(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 48 &&
    /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u.test(value)
  );
}

function source(row: Record<string, unknown>): boolean {
  return (
    row.schemaVersion === 1 &&
    row.sourceRepository === "danielholguin31/desmoslock" &&
    digest(row.sourceCommit, 40) &&
    digest(row.sourceTree, 40) &&
    digest(row.packageLockSha256, 64)
  );
}

/** Syntax validation only; caller-reported identity is not release attestation. */
export function parseClientBuildIdentity(
  value: unknown,
): ClientBuildIdentity | null {
  const row = parseExactRecord(value, [
    "schemaVersion",
    "sourceRepository",
    "sourceCommit",
    "sourceTree",
    "packageLockSha256",
    "buildId",
  ]);
  if (row === null || !source(row) || !digest(row.buildId, 64)) return null;
  return Object.freeze({
    schemaVersion: 1,
    sourceRepository: "danielholguin31/desmoslock",
    sourceCommit: row.sourceCommit as string,
    sourceTree: row.sourceTree as string,
    packageLockSha256: row.packageLockSha256 as string,
    buildId: row.buildId,
  });
}

function versioned(value: unknown, hashKey?: "sha256" | "archiveSha256") {
  const row = parseExactRecord(
    value,
    hashKey === undefined ? ["version"] : ["version", hashKey],
  );
  if (
    row === null ||
    !version(row.version) ||
    (hashKey !== undefined && !digest(row[hashKey], 64))
  )
    return null;
  return Object.freeze(
    hashKey === undefined
      ? { version: row.version }
      : { version: row.version, [hashKey]: row[hashKey] },
  );
}

export function parseClientBuildInputs(
  value: unknown,
): ClientBuildInputs | null {
  const row = parseExactRecord(value, [
    "schemaVersion",
    "sourceRepository",
    "sourceCommit",
    "sourceTree",
    "packageLockSha256",
    "packageVersion",
    "platform",
    "architecture",
    "backendConfigurationSha256",
    "graphingProfile",
    "tools",
  ]);
  if (
    row === null ||
    !source(row) ||
    !version(row.packageVersion) ||
    row.platform !== "darwin" ||
    (row.architecture !== "arm64" && row.architecture !== "x64") ||
    !digest(row.backendConfigurationSha256, 64) ||
    row.graphingProfile !== "internal-graphing-v1"
  )
    return null;
  const tools = parseExactRecord(row.tools, [
    "node",
    "npm",
    "electron",
    "packager",
    "fuses",
    "compiler",
    "sdk",
    "nodeHeadersSha256",
  ]);
  if (tools === null || !digest(tools.nodeHeadersSha256, 64)) return null;
  const node = versioned(tools.node, "sha256");
  const npm = versioned(tools.npm, "sha256");
  const electron = versioned(tools.electron, "archiveSha256");
  const packager = versioned(tools.packager);
  const fuses = versioned(tools.fuses);
  const compiler = parseExactRecord(tools.compiler, ["version", "sha256"]);
  const sdk = parseExactRecord(tools.sdk, [
    "version",
    "buildVersion",
    "settingsSha256",
  ]);
  if (
    node === null ||
    npm === null ||
    electron === null ||
    packager === null ||
    fuses === null ||
    compiler === null ||
    typeof compiler.version !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9 ._()+,-]{0,159}$/u.test(compiler.version) ||
    !digest(compiler.sha256, 64) ||
    sdk === null ||
    typeof sdk.version !== "string" ||
    !/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:\.(?:0|[1-9][0-9]*))?$/u.test(
      sdk.version,
    ) ||
    sdk.version.length > 48 ||
    typeof sdk.buildVersion !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9.]{0,31}$/u.test(sdk.buildVersion) ||
    !digest(sdk.settingsSha256, 64)
  )
    return null;
  return Object.freeze({
    schemaVersion: 1,
    sourceRepository: "danielholguin31/desmoslock",
    sourceCommit: row.sourceCommit as string,
    sourceTree: row.sourceTree as string,
    packageLockSha256: row.packageLockSha256 as string,
    packageVersion: row.packageVersion,
    platform: "darwin",
    architecture: row.architecture,
    backendConfigurationSha256: row.backendConfigurationSha256,
    graphingProfile: "internal-graphing-v1",
    tools: Object.freeze({
      node,
      npm,
      electron,
      packager,
      fuses,
      compiler: Object.freeze({
        version: compiler.version,
        sha256: compiler.sha256,
      }),
      sdk: Object.freeze({
        version: sdk.version,
        buildVersion: sdk.buildVersion,
        settingsSha256: sdk.settingsSha256,
      }),
      nodeHeadersSha256: tools.nodeHeadersSha256,
    }),
  }) as ClientBuildInputs;
}

function canonical(value: unknown): string {
  if (typeof value !== "object" || value === null) return JSON.stringify(value);
  return `{${Object.entries(value)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`;
}

/** Compact JSON, recursively ASCII-key sorted, UTF-8 when encoded; no newline. */
export function canonicalClientBuildInputs(value: unknown): string | null {
  const parsed = parseClientBuildInputs(value);
  return parsed === null ? null : canonical(parsed);
}

export function canonicalClientBuildIdentity(value: unknown): string | null {
  const parsed = parseClientBuildIdentity(value);
  return parsed === null ? null : canonical(parsed);
}
