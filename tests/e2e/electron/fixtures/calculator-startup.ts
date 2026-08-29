import fs from "node:fs/promises";

import {
  app,
  BrowserWindow,
  protocol,
  webContents,
  type WebContents,
} from "electron";

import { createElectronCalculatorSurface } from "../../../../apps/desktop/src/main/electron-calculator-surface.js";

interface StartupProbe {
  calculatorWebContents: number;
  outcome: "fixture-error" | "pending" | "rejected" | "resolved";
  parentDestroyed: boolean;
  status: "complete" | "starting";
}

const calculatorUrl = "desmoslock-calculator://host/index.html";
const probe: StartupProbe = {
  calculatorWebContents: -1,
  outcome: "pending",
  parentDestroyed: false,
  status: "starting",
};

Object.assign(app, { startupProbe: probe });
app.on("window-all-closed", () => undefined);
protocol.registerSchemesAsPrivileged([
  {
    privileges: { secure: true, standard: true },
    scheme: "desmoslock-calculator",
  },
]);

function requiredArgument(offset: number): string {
  const value = process.argv.at(offset);
  if (value === undefined) {
    throw new Error(
      "Calculator startup fixture requires output and result paths",
    );
  }
  return value;
}
const outputDirectory = requiredArgument(-2);
const resultPath = requiredArgument(-1);

async function runProbe(): Promise<void> {
  await app.whenReady();
  const parent = new BrowserWindow({ show: false });
  const webContentsPrototype = Object.getPrototypeOf(parent.webContents) as {
    loadURL: WebContents["loadURL"];
  };
  const originalLoadURL = webContentsPrototype.loadURL;
  webContentsPrototype.loadURL = async function (
    this: WebContents,
    ...arguments_: Parameters<WebContents["loadURL"]>
  ): Promise<void> {
    await originalLoadURL.apply(this, arguments_);
    if (arguments_[0] === calculatorUrl) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  };
  const creation = createElectronCalculatorSurface({
    bounds: { height: 400, width: 600, x: 0, y: 0 },
    outputDirectory,
    parent,
  });
  setTimeout(() => parent.close(), 20);

  try {
    await creation;
    probe.outcome = "resolved";
  } catch {
    probe.outcome = "rejected";
  } finally {
    webContentsPrototype.loadURL = originalLoadURL;
  }

  await new Promise((resolve) => setTimeout(resolve, 750));
  probe.parentDestroyed = parent.isDestroyed();
  probe.calculatorWebContents = webContents
    .getAllWebContents()
    .filter(
      (contents: WebContents) => contents.getURL() === calculatorUrl,
    ).length;
  probe.status = "complete";
  await fs.writeFile(resultPath, JSON.stringify(probe));
}

void runProbe().catch(async () => {
  probe.outcome = "fixture-error";
  probe.status = "complete";
  await fs.writeFile(resultPath, JSON.stringify(probe));
});
