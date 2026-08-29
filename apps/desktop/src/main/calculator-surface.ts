export interface CalculatorSurfaceBounds {
  readonly height: number;
  readonly width: number;
  readonly x: number;
  readonly y: number;
}

export interface CalculatorSurface {
  readonly partition: string;
  readonly webContentsId: number;
  close(): Promise<void>;
  setBounds(bounds: CalculatorSurfaceBounds): void;
}

export interface CalculatorWebPreferences {
  readonly allowRunningInsecureContent: false;
  readonly contextIsolation: true;
  readonly devTools: false;
  readonly disableDialogs: true;
  readonly enableWebSQL: false;
  readonly experimentalFeatures: false;
  readonly nodeIntegration: false;
  readonly nodeIntegrationInSubFrames: false;
  readonly nodeIntegrationInWorker: false;
  readonly partition: string;
  readonly sandbox: true;
  readonly spellcheck: false;
  readonly webSecurity: true;
  readonly webviewTag: false;
}

export function createCalculatorWebPreferences(
  partition: string,
): Readonly<CalculatorWebPreferences> {
  if (partition.length === 0 || partition.startsWith("persist:")) {
    throw new Error("CalculatorSurface requires an ephemeral partition");
  }

  return Object.freeze({
    allowRunningInsecureContent: false,
    contextIsolation: true,
    devTools: false,
    disableDialogs: true,
    enableWebSQL: false,
    experimentalFeatures: false,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    nodeIntegrationInWorker: false,
    partition,
    sandbox: true,
    spellcheck: false,
    webSecurity: true,
    webviewTag: false,
  });
}
