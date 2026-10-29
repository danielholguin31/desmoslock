// Synthetic surface isolation only: this entrypoint never starts product main,
// Student admission, OS encryption, or native assessment protection.
import path from "node:path";
import { app, BrowserWindow, ipcMain, protocol, session } from "electron";

import { prepareElectronCalculatorSurface } from "../../../../apps/desktop/src/main/electron-calculator-surface.js";
import { createTrustedShellWebPreferences } from "../../../../apps/desktop/src/main/hardened-web-preferences.js";
import {
  denyByDefaultCapabilityPolicy,
  installSessionDenialPolicy,
  installWebContentsEscapeDenial,
} from "../../../../apps/desktop/src/main/session-denial-policy.js";
import { createStaticProtocolHandler } from "../../../../apps/desktop/src/main/static-protocol.js";
import { trustedAssessmentLockChannel } from "../../../../apps/desktop/src/trusted-bridge.js";

const outputDirectory = process.argv.at(-1);
if (outputDirectory === undefined || !path.isAbsolute(outputDirectory))
  throw new Error(
    "Calculator isolation fixture requires an absolute built output directory",
  );

protocol.registerSchemesAsPrivileged(
  ["desmoslock-app", "desmoslock-calculator"].map((scheme) => ({
    scheme,
    privileges: {
      allowExtensions: false,
      allowServiceWorkers: false,
      bypassCSP: false,
      codeCache: false,
      corsEnabled: false,
      secure: true,
      standard: true,
      stream: false,
      supportFetchAPI: false,
    },
  })),
);
ipcMain.handle(trustedAssessmentLockChannel, () => ({
  ok: false,
  reason: "native-protection-unavailable",
}));
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

void app
  .whenReady()
  .then(async () => {
    installSessionDenialPolicy(
      session.defaultSession,
      denyByDefaultCapabilityPolicy,
    );
    const shellUrl = "desmoslock-app://shell/index.html";
    const document = new TextEncoder().encode(
      '<!doctype html><html lang="en"><meta charset="utf-8"><title>Synthetic calculator isolation fixture</title><h1 data-isolation-fixture>Synthetic calculator isolation fixture</h1></html>',
    );
    const handle = createStaticProtocolHandler({
      assets: {
        [shellUrl]: {
          body: document.buffer,
          contentType: "text/html; charset=utf-8",
        },
      },
      connectionAllowlist: "(response-origin);webrtc=block",
      contentSecurityPolicy:
        "default-src 'none'; script-src 'none'; style-src 'none'; connect-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    });
    session.defaultSession.protocol.handle("desmoslock-app", (request) =>
      handle({ method: request.method, url: request.url }),
    );
    const parent = new BrowserWindow({
      height: 720,
      width: 1080,
      show: false,
      webPreferences: createTrustedShellWebPreferences(
        path.join(outputDirectory, "preload.cjs"),
      ),
    });
    installWebContentsEscapeDenial(
      parent.webContents,
      "desmoslock-app:",
      denyByDefaultCapabilityPolicy,
    );
    await parent.loadURL(shellUrl);
    const { width, height } = parent.getContentBounds();
    const surface = await prepareElectronCalculatorSurface({
      bounds: { height: Math.max(1, height - 140), width, x: 0, y: 140 },
      onCleanupFailure: () => app.exit(1),
      outputDirectory,
      parent,
    });
    surface.attach();
    let quitting = false;
    app.on("before-quit", (event) => {
      if (quitting) return;
      event.preventDefault();
      quitting = true;
      void surface.close().then(
        () => app.exit(0),
        () => app.exit(1),
      );
    });
    parent.show();
  })
  .catch(() => app.exit(1));
