import fs from "node:fs/promises";

import {
  app,
  BrowserWindow,
  protocol,
  webContents,
  type Session,
} from "electron";

import { prepareElectronCalculatorSurface } from "../../../../apps/desktop/src/main/electron-calculator-surface.js";

const calculatorUrl = "desmoslock-calculator://host/index.html";

interface SerializedFailure {
  readonly errors?: readonly SerializedFailure[];
  readonly message: string;
  readonly name: string;
}

function serializeFailure(reason: unknown): SerializedFailure {
  if (reason instanceof AggregateError) {
    return {
      errors: reason.errors.map((error: unknown) => serializeFailure(error)),
      message: reason.message,
      name: reason.name,
    };
  }
  if (reason instanceof Error) {
    return { message: reason.message, name: reason.name };
  }
  return { message: String(reason), name: "UnknownFailure" };
}

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
  const surface = await prepareElectronCalculatorSurface({
    bounds: { height: 400, width: 600, x: 0, y: 0 },
    onCleanupFailure: () => app.exit(1),
    outputDirectory,
    parent,
  });
  surface.attach();
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
  calculatorSession.clearStorageData = () => {
    calls.storage += 1;
    cleanupObservedWebContentsClose = calls.webContentsClose === 1;
    throw new Error("synthetic storage cleanup failure");
  };
  calculatorSession.clearCache = async () => {
    calls.cache += 1;
    throw new Error("synthetic cache cleanup failure");
  };
  calculatorSession.clearAuthCache = async () => {
    calls.auth += 1;
    throw new Error("synthetic auth cleanup failure");
  };
  calculatorSession.closeAllConnections = async () => {
    calls.connections += 1;
    throw new Error("synthetic connection cleanup failure");
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
    outcomes: outcomes.map((outcome) =>
      outcome.status === "fulfilled"
        ? { status: outcome.status }
        : { reason: serializeFailure(outcome.reason), status: outcome.status },
    ),
    parentDestroyed: parent.isDestroyed(),
    sameRejectionReason:
      outcomes[0]?.status === "rejected" &&
      outcomes[1]?.status === "rejected" &&
      outcomes[0].reason === outcomes[1].reason,
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
