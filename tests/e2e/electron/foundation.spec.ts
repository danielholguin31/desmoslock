import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  _electron as electron,
  expect,
  test,
  type Page,
} from "@playwright/test";

import type { TrustedDesktopBridge } from "../../../apps/desktop/src/trusted-bridge.js";

import { createElectronLaunchProfile } from "../../../scripts/electron-launch-profile.mjs";
import {
  acquireReadyElectronApplication,
  closeElectronApplicationCooperatively,
  runIndependentCleanupTasks,
  trackElectronApplicationForCooperativeCleanup,
} from "../../../scripts/production-desktop-resource-safety.mjs";

test("production Electron shell preserves Student isolation and denies protection for a reopened window", async () => {
  const userDataDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "desmoslock-foundation-e2e-"),
  );
  const launchProfile = (() => {
    const previousRunAsNode = process.env.ELECTRON_RUN_AS_NODE;
    const previousCredentialSentinel =
      process.env.DESMOSLOCK_E2E_CREDENTIAL_SENTINEL;
    try {
      process.env.ELECTRON_RUN_AS_NODE = "1";
      process.env.DESMOSLOCK_E2E_CREDENTIAL_SENTINEL =
        "must-not-cross-boundary";
      return createElectronLaunchProfile();
    } finally {
      if (previousRunAsNode === undefined) {
        delete process.env.ELECTRON_RUN_AS_NODE;
      } else {
        process.env.ELECTRON_RUN_AS_NODE = previousRunAsNode;
      }
      if (previousCredentialSentinel === undefined) {
        delete process.env.DESMOSLOCK_E2E_CREDENTIAL_SENTINEL;
      } else {
        process.env.DESMOSLOCK_E2E_CREDENTIAL_SENTINEL =
          previousCredentialSentinel;
      }
    }
  })();

  const application = await acquireReadyElectronApplication({
    launch: () =>
      electron.launch({
        args: [
          ...launchProfile.args,
          `--user-data-dir=${userDataDirectory}`,
          path.resolve("apps/desktop"),
        ],
        env: launchProfile.env,
        ...(launchProfile.chromiumSandbox === undefined
          ? {}
          : { chromiumSandbox: launchProfile.chromiumSandbox }),
      }),
    ready: async (acquiredApplication) => {
      await trackElectronApplicationForCooperativeCleanup(acquiredApplication);
      await acquiredApplication.firstWindow();
    },
  });

  try {
    const window = await application.firstWindow();

    await expect(
      window.getByRole("heading", { exact: true, name: "DesmosLock" }),
    ).toBeVisible();
    const expectedPhase =
      process.platform === "darwin" ? "entry" : "unavailable";
    const assertStudentBoundary = async (page: Page) => {
      await expect(page.locator(".student-session")).toHaveAttribute(
        "data-phase",
        expectedPhase,
      );
      await expect(
        page.getByRole("heading", {
          exact: true,
          name: "Assessment protection unavailable",
        }),
      ).toBeVisible();
      const boundary = await page.evaluate(async () => {
        const bridge = (
          globalThis as typeof globalThis & {
            desmoslockDesktop?: TrustedDesktopBridge;
          }
        ).desmoslockDesktop;
        return {
          bridge: Object.keys(bridge ?? {}).sort(),
          version: bridge?.version,
          process: typeof globalThis.process,
          require: typeof globalThis.require,
          studentView: await bridge?.readStudentSessionView(),
          lockRequestResult: await bridge?.requestAssessmentLock(),
        };
      });
      expect(boundary.bridge).toEqual([
        "beginTargetedReadmission",
        "forfeitStudentSession",
        "joinTest",
        "onStudentSessionViewChanged",
        "readStudentSessionView",
        "refreshStudentSession",
        "requestAssessmentLock",
        "retryStudentSession",
        "version",
      ]);
      expect(boundary.version).toBe("2.0.0");
      expect(boundary.process).toBe("undefined");
      expect(boundary.require).toBe("undefined");
      expect(boundary.lockRequestResult).toEqual({
        ok: false,
        reason: "native-protection-unavailable",
      });
      expect(boundary.studentView).toEqual({
        revision: expect.any(Number),
        phase: expectedPhase,
        session: null,
        protection: "unavailable",
        calculatorEligible: false,
        pendingOperation: null,
      });
      expect(Number.isSafeInteger(boundary.studentView?.revision)).toBe(true);
      expect(boundary.studentView?.revision).toBeGreaterThanOrEqual(1);
      await expect(
        page.getByRole("button", { name: /lock intent/i }),
      ).toHaveCount(0);
      expect(
        await application.evaluate(({ BrowserWindow, webContents }) => ({
          calculators: webContents
            .getAllWebContents()
            .filter(
              (contents) =>
                contents.getURL() === "desmoslock-calculator://host/index.html",
            ).length,
          attachedViews: BrowserWindow.getAllWindows().map(
            (window) => window.contentView.children.length,
          ),
        })),
      ).toEqual({ calculators: 0, attachedViews: [0] });
    };
    await assertStudentBoundary(window);

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

    expect(
      await application.evaluate(() => ({
        credentialSentinel: "DESMOSLOCK_E2E_CREDENTIAL_SENTINEL" in process.env,
        electronRunAsNode: "ELECTRON_RUN_AS_NODE" in process.env,
        nodeOptions: "NODE_OPTIONS" in process.env,
      })),
    ).toEqual({
      credentialSentinel: false,
      electronRunAsNode: false,
      nodeOptions: false,
    });

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
    await assertStudentBoundary(reopenedWindow);
  } finally {
    await runIndependentCleanupTasks([
      () => closeElectronApplicationCooperatively(application),
      () => fs.rm(userDataDirectory, { force: true, recursive: true }),
    ]);
  }
});
