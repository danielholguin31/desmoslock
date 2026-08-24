export interface ReleaseProvenanceInput {
  readonly packageManager?: string;
  readonly vendorRebuildJobs?: readonly string[];
  readonly remote?: string;
  readonly sourceRepository?: string;
  readonly workflowRepository?: string;
  readonly runner?: {
    readonly environment?: string;
    readonly os?: string;
    readonly requestedLabel?: string;
  };
  readonly builtAtUtc?: string;
  readonly nodeVersion?: string;
  readonly npmVersion?: string;
  readonly xcodeSdk?: string;
  readonly platform?: string;
}

export function verifyReleaseProvenance(input: ReleaseProvenanceInput): void {
  void input;
  throw new Error("v2 verifyReleaseProvenance is not implemented");
}

export function parseTrustedGitHubOrigin(remote: string): {
  readonly owner: string;
  readonly name: string;
} {
  void remote;
  throw new Error("v2 parseTrustedGitHubOrigin is not implemented");
}
