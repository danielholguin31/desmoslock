import fs from "node:fs/promises";

import {
  app,
  BrowserWindow,
  protocol,
  webContents,
  type Session,
} from "electron";

import { createElectronCalculatorSurface } from "../../../../apps/desktop/src/main/electron-calculator-surface.js";

const calculatorUrl = "desmoslock-calculator://host/index.html";
function requiredArgument(offset: number): string {
  const value = process.argv.at(offset);
  if (value === undefined) {
    throw new Error(
      "Calculator close fixture requires output and result paths",
    );
  }
  return value;
}
const outputDirectory = requiredArgument(-2);
const resultPath = requiredArgument(-1);

app.on("window-all-closed", () => undefined);
protocol.registerSchemesAsPrivileged([
  {
    privileges: { secure: true, standard: true },
    scheme: "desmoslock-calculator",
  },
]);

async function runProbe(): Promise<void> {
  await app.whenReady();
  const parent = new BrowserWindow({ show: false });
  const surface = await createElectronCalculatorSurface({
    bounds: { height: 400, width: 600, x: 0, y: 0 },
    outputDirectory,
    parent,
  });
  const calculator = webContents
    .getAllWebContents()
    .find((contents) => contents.getURL() === calculatorUrl);
  if (calculator === undefined) throw new Error("Calculator is missing");

  const calls = {
    auth: 0,
    cache: 0,
    connections: 0,
    storage: 0,
    webContentsClose: 0,
  };
  const originalWebContentsClose = calculator.close.bind(calculator);
  calculator.close = (options) => {
    calls.webContentsClose += 1;
    originalWebContentsClose(options);
  };
  let cleanupObservedWebContentsClose = false;
  const calculatorSession = calculator.session as Session & {
    clearAuthCache: () => Promise<void>;
    clearCache: () => Promise<void>;
    clearStorageData: () => Promise<void>;
    closeAllConnections: () => Promise<void>;
  };
  calculatorSession.clearStorageData = async () => {
    calls.storage += 1;
    cleanupObservedWebContentsClose = calls.webContentsClose === 1;
    throw new Error("synthetic storage cleanup failure");
  };
  calculatorSession.clearCache = async () => {
    calls.cache += 1;
  };
  calculatorSession.clearAuthCache = async () => {
    calls.auth += 1;
  };
  calculatorSession.closeAllConnections = async () => {
    calls.connections += 1;
  };

  const outcomes = await Promise.allSettled([surface.close(), surface.close()]);
  const destructionDeadline = Date.now() + 1_000;
  while (
    webContents
      .getAllWebContents()
      .some((contents) => contents.getURL() === calculatorUrl) &&
    Date.now() < destructionDeadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const result = {
    calculatorWebContents: webContents
      .getAllWebContents()
      .filter((contents) => contents.getURL() === calculatorUrl).length,
    calls,
    cleanupObservedWebContentsClose,
    outcomes: outcomes.map((outcome) => outcome.status),
    parentDestroyed: parent.isDestroyed(),
  };
  parent.close();
  await fs.writeFile(resultPath, JSON.stringify(result));
}

void runProbe().catch(async (error: unknown) => {
  await fs.writeFile(
    resultPath,
    JSON.stringify({ fixtureError: String(error) }),
  );
});
