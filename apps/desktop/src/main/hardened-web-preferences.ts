interface HardenedWebPreferences {
  readonly allowRunningInsecureContent: false;
  readonly contextIsolation: true;
  readonly devTools: false;
  readonly disableDialogs: true;
  readonly enableWebSQL: false;
  readonly experimentalFeatures: false;
  readonly nodeIntegration: false;
  readonly nodeIntegrationInSubFrames: false;
  readonly nodeIntegrationInWorker: false;
  readonly sandbox: true;
  readonly spellcheck: false;
  readonly webSecurity: true;
  readonly webviewTag: false;
}

export interface CalculatorWebPreferences extends HardenedWebPreferences {
  readonly partition: string;
}

export interface TrustedShellWebPreferences extends HardenedWebPreferences {
  readonly preload: string;
}

const hardenedWebPreferences: Readonly<HardenedWebPreferences> = Object.freeze({
  allowRunningInsecureContent: false,
  contextIsolation: true,
  devTools: false,
  disableDialogs: true,
  enableWebSQL: false,
  experimentalFeatures: false,
  nodeIntegration: false,
  nodeIntegrationInSubFrames: false,
  nodeIntegrationInWorker: false,
  sandbox: true,
  spellcheck: false,
  webSecurity: true,
  webviewTag: false,
});

export function createCalculatorWebPreferences(
  partition: string,
): Readonly<CalculatorWebPreferences> {
  if (partition.length === 0 || partition.startsWith("persist:")) {
    throw new Error("CalculatorSurface requires an ephemeral partition");
  }

  return Object.freeze({ ...hardenedWebPreferences, partition });
}

export function createTrustedShellWebPreferences(
  preload: string,
): Readonly<TrustedShellWebPreferences> {
  if (preload.length === 0) {
    throw new Error("Trusted shell requires a preload path");
  }

  return Object.freeze({ ...hardenedWebPreferences, preload });
}
