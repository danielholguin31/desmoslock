export interface IsolatedProcessCloseReceipt {
  readonly exitCode: number | null;
  readonly output: string;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly stderrEof: true;
  readonly stdout: string;
  readonly stdoutEof: true;
}

export interface IsolatedProcessTerminationReceipt {
  readonly close: IsolatedProcessCloseReceipt;
  readonly forceSignalSent: boolean;
  readonly gracefulSignalSent: boolean;
  readonly treeEmpty: true;
}

export interface IsolatedProcessTree {
  readonly pid: number;
  isEmpty(): boolean;
  leaderIsRunning(): boolean;
  output(): string;
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
}): IsolatedProcessTree;
