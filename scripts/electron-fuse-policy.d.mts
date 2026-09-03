export interface ElectronFusePolicy {
  readonly version: "1";
  readonly resetAdHocDarwinSignature?: true;
  readonly 0: false;
  readonly 2: false;
  readonly 3: false;
}

export function createElectronFusePolicy(
  platform: NodeJS.Platform,
  architecture: string,
): ElectronFusePolicy;

export function hardenPackagedElectron(
  executablePath: string,
  platform?: NodeJS.Platform,
  architecture?: string,
): Promise<void>;

export function verifyPackagedElectronFuses(
  executablePath: string,
): Promise<Readonly<Record<string, string>>>;
