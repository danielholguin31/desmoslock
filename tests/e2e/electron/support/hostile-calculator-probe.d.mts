export interface HostileCalculatorProbeInput {
  readonly httpOrigin: string;
  readonly tcpPort: number;
  readonly udpPort: number;
}

export interface HostileCalculatorProbeResult {
  readonly bridge: string;
  readonly externalProtocol: string;
  readonly fetch: string;
  readonly nodeProcess: string;
  readonly nodeRequire: string;
  readonly permission: string;
  readonly popup: string;
  readonly rtcPeerConnection: string;
  readonly webTransport: string;
}

export function runHostileCalculatorProbe(
  input: HostileCalculatorProbeInput,
): Promise<HostileCalculatorProbeResult>;
