export interface IsolatedProcessOutputReceipt {
  readonly output: string;
  readonly stderr: string;
  readonly stderrEof: true;
  readonly stdout: string;
  readonly stdoutEof: true;
}

export interface IsolatedProcessCloseReceipt extends IsolatedProcessOutputReceipt {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface IsolatedProcessTerminationReceipt {
  readonly close: IsolatedProcessCloseReceipt | null;
  readonly forceSignalSent: boolean;
  readonly gracefulSignalSent: boolean;
  readonly output: IsolatedProcessOutputReceipt;
  /**
   * Every {processId, startedAt} identity in the sentinel's retirement
   * snapshot disappeared. Descendants that escaped before observation are
   * outside this claim.
   */
  readonly recordedProcessIdentitiesGone: true;
  readonly targetOutcome:
    | {
        readonly kind: "observed";
        readonly exitCode: number | null;
        readonly signal: NodeJS.Signals | null;
      }
    | { readonly kind: "unobserved-before-final-kill" };
}

export interface IsolatedProcessTree {
  /** Whether this handle completed its one-way retirement protocol. */
  isRetired(): boolean;
  output(): string;
  targetIsRunning(): boolean;
  terminate(options?: {
    readonly forceMilliseconds?: number;
    readonly graceMilliseconds?: number;
  }): Promise<IsolatedProcessTerminationReceipt>;
  waitForClose(
    timeoutMilliseconds: number,
  ): Promise<IsolatedProcessCloseReceipt | null>;
}

export function spawnIsolatedProcessTree(options: {
  readonly arguments: readonly string[];
  readonly command: string;
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
}): Promise<IsolatedProcessTree>;
