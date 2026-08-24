import { app, BrowserWindow } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { RepositoryBuildIdentity } from "@desmoslock/contracts";

export const desktopBuild: RepositoryBuildIdentity = {
  sourceCommit: "development",
  sourceRepository: "danielholguin31/desmoslock",
  version: "2.0.0",
};

export const desktopChannel = "internal-v2" as const;

let mainWindow: BrowserWindow | null = null;

function createWindow(): BrowserWindow {
  const outputDirectory = path.dirname(fileURLToPath(import.meta.url));
  const window = new BrowserWindow({
    backgroundColor: "#f6f8fb",
    height: 720,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    width: 1080,
  });

  window.once("ready-to-show", () => window.show());
  window.once("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });
  void window.loadFile(path.join(outputDirectory, "index.html"));
  mainWindow = window;
  return window;
}

void app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
