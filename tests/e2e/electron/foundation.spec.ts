import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { _electron as electron, expect, test } from "@playwright/test";

test("production Electron shell isolates renderers and resets assessment state for a reopened window", async () => {
  const userDataDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "desmoslock-foundation-e2e-"),
  );
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== "ELECTRON_RUN_AS_NODE") {
      environment[key] = value;
    }
  }

  const linuxLaunchFlags =
    process.platform === "linux"
      ? ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"]
      : [];
  if (process.platform === "linux") {
    environment.ELECTRON_DISABLE_SANDBOX = "1";
  }

  const application = await electron.launch({
    args: [
      ...linuxLaunchFlags,
      `--user-data-dir=${userDataDirectory}`,
      path.resolve("apps/desktop"),
    ],
    env: environment,
    ...(process.platform === "linux" ? { chromiumSandbox: false } : {}),
  });

  try {
    const window = await application.firstWindow();

    await expect(
      window.getByRole("heading", { exact: true, name: "DesmosLock" }),
    ).toBeVisible();
    await expect(window.locator("[data-v2-status]")).toHaveText(
      "Secure calculator ready",
    );
    await expect(
      window.evaluate(() => ({
        bridge: Object.keys(
          (
            window as typeof window & {
              desmoslockDesktop?: Record<string, unknown>;
            }
          ).desmoslockDesktop ?? {},
        ).sort(),
        process: typeof globalThis.process,
        require: typeof globalThis.require,
      })),
    ).resolves.toEqual({
      bridge: ["requestAssessmentLock", "version"],
      process: "undefined",
      require: "undefined",
    });
    await expect(
      window.getByRole("button", { name: /lock intent/i }),
    ).toHaveCount(0);

    const preferences = await application.evaluate(({ BrowserWindow }) => {
      const [window] = BrowserWindow.getAllWindows();
      if (window === undefined)
        throw new Error("Electron created no BrowserWindow");
      const webContents = window.webContents as typeof window.webContents & {
        getLastWebPreferences(): {
          contextIsolation?: boolean;
          devTools?: boolean;
          disableDialogs?: boolean;
          nodeIntegration?: boolean;
          sandbox?: boolean;
        };
      };
      return webContents.getLastWebPreferences();
    });

    expect(preferences.contextIsolation).toBe(true);
    expect(preferences.devTools ?? false).toBe(false);
    expect(preferences.disableDialogs).toBe(true);
    expect(preferences.nodeIntegration).toBe(false);
    expect(preferences.sandbox).toBe(true);

    await application.evaluate(({ BrowserWindow, session }) => {
      const [shellWindow] = BrowserWindow.getAllWindows();
      if (shellWindow === undefined) {
        throw new Error("Electron created no BrowserWindow");
      }
      const trackedSession =
        session.defaultSession as typeof session.defaultSession & {
          shellDownloadDenials?: number;
          shellDownloadPolicyObserved?: boolean;
        };
      trackedSession.shellDownloadDenials = 0;
      trackedSession.shellDownloadPolicyObserved = false;
      trackedSession.on(
        "will-download",
        (event, _item, initiatingWebContents) => {
          if (initiatingWebContents?.id !== shellWindow.webContents.id) return;
          trackedSession.shellDownloadPolicyObserved ||= event.defaultPrevented;
          trackedSession.shellDownloadDenials =
            (trackedSession.shellDownloadDenials ?? 0) + 1;
          event.preventDefault();
        },
      );
    });
    await expect(
      window.evaluate(async () => {
        const permission = await navigator.permissions.query({
          name: "geolocation",
        });
        const download = document.createElement("a");
        download.download = "desmoslock-shell-download-must-not-exist.txt";
        download.href = "data:text/plain,blocked";
        download.click();
        return permission.state;
      }),
    ).resolves.toBe("denied");
    await expect
      .poll(() =>
        application.evaluate(({ session }) => {
          const trackedSession =
            session.defaultSession as typeof session.defaultSession & {
              shellDownloadDenials?: number;
              shellDownloadPolicyObserved?: boolean;
            };
          return {
            count: trackedSession.shellDownloadDenials ?? 0,
            deniedByProductionPolicy:
              trackedSession.shellDownloadPolicyObserved ?? false,
          };
        }),
      )
      .toEqual({ count: 1, deniedByProductionPolicy: true });

    await expect(
      window.evaluate(() =>
        (
          globalThis as typeof globalThis & {
            desmoslockDesktop?: {
              requestAssessmentLock(): Promise<unknown>;
            };
          }
        ).desmoslockDesktop?.requestAssessmentLock(),
      ),
    ).resolves.toEqual({ ok: true });

    await expect
      .poll(() =>
        application.evaluate(({ app }) => app.listenerCount("activate")),
      )
      .toBeGreaterThan(0);
    await application.evaluate(async ({ app, BrowserWindow }) => {
      app.removeAllListeners("window-all-closed");
      const [currentWindow] = BrowserWindow.getAllWindows();
      if (currentWindow === undefined) {
        throw new Error("Electron created no BrowserWindow");
      }
      await new Promise<void>((resolveClosed) => {
        currentWindow.once("closed", resolveClosed);
        currentWindow.close();
      });
      app.emit("activate");
    });
    await expect
      .poll(
        () =>
          application
            .windows()
            .filter(
              (candidate) =>
                !candidate.isClosed() &&
                candidate.url() === "desmoslock-app://shell/index.html",
            ).length,
      )
      .toBe(1);
    const reopenedWindow = application
      .windows()
      .find(
        (candidate) =>
          !candidate.isClosed() &&
          candidate.url() === "desmoslock-app://shell/index.html",
      );
    if (reopenedWindow === undefined) {
      throw new Error("Electron did not reopen the trusted shell window");
    }
    await expect(
      reopenedWindow.getByRole("heading", {
        exact: true,
        name: "DesmosLock",
      }),
    ).toBeVisible();
    await expect(
      reopenedWindow.evaluate(() =>
        (
          globalThis as typeof globalThis & {
            desmoslockDesktop?: {
              requestAssessmentLock(): Promise<unknown>;
            };
          }
        ).desmoslockDesktop?.requestAssessmentLock(),
      ),
    ).resolves.toEqual({ ok: true });
  } finally {
    await application.close();
    await fs.rm(userDataDirectory, { force: true, recursive: true });
  }
});
