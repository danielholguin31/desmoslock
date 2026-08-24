export interface GatekeeperAcceptanceInput {
  readonly role?: "mini" | "macbook";
  readonly scope?: string;
  readonly hardwareFamily?: string;
  readonly hardwareIdentifier?: string;
  readonly draftUrl?: string;
  readonly draft?: Record<string, unknown>;
  readonly releaseNotes?: string;
  readonly checksumText?: string;
  readonly receipts?: readonly Record<string, unknown>[];
  readonly quarantineMutated?: boolean;
}

export function verifyGatekeeperAcceptance(
  input: GatekeeperAcceptanceInput,
): void {
  void input;
  throw new Error("v2 verifyGatekeeperAcceptance is not implemented");
}

export function fingerprintHardwareIdentifier(raw: string): string {
  void raw;
  throw new Error("v2 fingerprintHardwareIdentifier is not implemented");
}
