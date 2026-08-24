export interface StudentSessionLookup {
  readonly lookupError?: Error;
  readonly authError?: Error;
  readonly studentError?: Error;
  readonly testError?: Error;
  readonly students?: readonly unknown[];
  readonly test?: { readonly active?: boolean } | null;
}

export interface RestoredStudentSession {
  readonly studentId: string;
  readonly testId: string;
}

export async function restoreStudentSession(
  lookup: StudentSessionLookup,
): Promise<RestoredStudentSession | null> {
  void lookup;
  throw new Error("v2 restoreStudentSession is not implemented");
}

export async function engagePersistedLock(input: {
  readonly before: "stalled-calculator-load" | "never-resolving-restore";
}): Promise<"locked"> {
  void input;
  throw new Error("v2 engagePersistedLock is not implemented");
}

export async function clearStaleLockedState(): Promise<"unlocked"> {
  throw new Error("v2 clearStaleLockedState is not implemented");
}

export async function releaseRecoveryLock(input: {
  readonly session: "authoritative-missing";
}): Promise<null> {
  void input;
  throw new Error("v2 releaseRecoveryLock is not implemented");
}
