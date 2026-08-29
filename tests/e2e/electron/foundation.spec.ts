import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { _electron as electron, expect, test } from "@playwright/test";

test("v2 Electron shell isolates renderers and resets synthetic state for a reopened window", async () => {
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
      window.getByRole("heading", { name: "DesmosLock v2" }),
    ).toBeVisible();
    await expect(window.locator("[data-v2-status]")).toHaveText(
      "Trusted shell ready · calculator isolated below",
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
      bridge: ["requestLock", "version"],
      process: "undefined",
      require: "undefined",
    });

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

    await window.getByRole("button", { name: "Send lock intent" }).click();
    await expect(window.locator("[data-v2-status]")).toHaveText(
      "Main process accepted the synthetic lock intent",
    );

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
      reopenedWindow.getByRole("heading", { name: "DesmosLock v2" }),
    ).toBeVisible();
    await reopenedWindow
      .getByRole("button", { name: "Send lock intent" })
      .click();
    await expect(reopenedWindow.locator("[data-v2-status]")).toHaveText(
      "Main process accepted the synthetic lock intent",
    );
  } finally {
    await application.close();
    await fs.rm(userDataDirectory, { force: true, recursive: true });
  }
});
