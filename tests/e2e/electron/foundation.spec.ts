import path from "node:path";

import { _electron as electron, expect, test } from "@playwright/test";

test("v2 Electron shell requests isolated renderer preferences with Node access disabled", async () => {
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
    args: [...linuxLaunchFlags, path.resolve("apps/desktop")],
    chromiumSandbox: false,
    env: environment,
  });

  try {
    const window = await application.firstWindow();

    await expect(
      window.getByRole("heading", { name: "DesmosLock v2" }),
    ).toBeVisible();
    await expect(window.locator("[data-v2-status]")).toHaveText(
      "Synthetic backend ready",
    );
    await expect(window.locator("[data-v2-status]")).toHaveAttribute(
      "data-backend-status",
      "ready",
    );
    await expect(
      window.evaluate(() => ({
        process: typeof globalThis.process,
        require: typeof globalThis.require,
      })),
    ).resolves.toEqual({
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
          nodeIntegration?: boolean;
          preload?: string;
          sandbox?: boolean;
        };
      };
      return webContents.getLastWebPreferences();
    });

    expect(preferences.contextIsolation).toBe(true);
    expect(preferences.nodeIntegration).toBe(false);
    expect(preferences.sandbox).toBe(true);
    expect(preferences.preload).toBeUndefined();
  } finally {
    await application.close();
  }
});
