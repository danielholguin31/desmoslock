import dgram from "node:dgram";
import fs from "node:fs/promises";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";

import { createElectronLaunchProfile } from "../../../scripts/electron-launch-profile.mjs";
import {
  acquireWithLocalCleanup,
  closeElectronApplicationCooperatively,
  type CleanupTask,
  runIndependentCleanupTasks,
  trackElectronApplicationForCooperativeCleanup,
  waitForResourceAcquisition,
} from "../../../scripts/production-desktop-resource-safety.mjs";
import { runHostileCalculatorProbe } from "./support/hostile-calculator-probe.mjs";

const calculatorUrl = "desmoslock-calculator://host/index.html";

function closeServer(server: http.Server | net.Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
}

function closeUdpSocket(socket: dgram.Socket): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    try {
      socket.close(() => resolve());
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ERR_SOCKET_DGRAM_NOT_RUNNING"
      ) {
        resolve();
        return;
      }
      reject(error);
    }
  });
}

async function callCalculator<Result, Argument>(
  application: ElectronApplication,
  callback: (argument: Argument) => Promise<Result> | Result,
  argument: Argument,
): Promise<Result> {
  return application.evaluate(
    async ({ webContents }, input) => {
      const calculator = webContents
        .getAllWebContents()
        .find((contents) => contents.getURL() === input.calculatorUrl);
      if (calculator === undefined) throw new Error("Calculator is missing");
      const source = `(${input.callbackSource})(${JSON.stringify(input.argument)})`;
      return calculator.executeJavaScript(source) as Promise<Result>;
    },
    {
      argument,
      calculatorUrl,
      callbackSource: callback.toString(),
    },
  );
}

async function clickCalculatorControl(
  application: ElectronApplication,
  selector: string,
): Promise<void> {
  const point = await callCalculator(
    application,
    (targetSelector) => {
      const element = document.querySelector(targetSelector);
      if (element === null)
        throw new Error(`Missing control: ${targetSelector}`);
      const bounds = element.getBoundingClientRect();
      return {
        x: bounds.x + bounds.width / 2,
        y: bounds.y + bounds.height / 2,
      };
    },
    selector,
  );
  await application.evaluate(
    ({ webContents }, input) => {
      const calculator = webContents
        .getAllWebContents()
        .find((contents) => contents.getURL() === input.calculatorUrl);
      if (calculator === undefined) throw new Error("Calculator is missing");
      calculator.focus();
      calculator.sendInputEvent({
        button: "left",
        clickCount: 1,
        type: "mouseDown",
        x: input.point.x,
        y: input.point.y,
      });
      calculator.sendInputEvent({
        button: "left",
        clickCount: 1,
        type: "mouseUp",
        x: input.point.x,
        y: input.point.y,
      });
    },
    { calculatorUrl, point },
  );
}

async function typeCalculatorExpression(
  application: ElectronApplication,
  expression: string,
): Promise<void> {
  await clickCalculatorControl(application, "[data-expression-input]");
  await expect
    .poll(() =>
      callCalculator(
        application,
        () => document.activeElement?.hasAttribute("data-expression-input"),
        null,
      ),
    )
    .toBe(true);
  await application.evaluate(
    async ({ webContents }, input) => {
      const calculator = webContents
        .getAllWebContents()
        .find((contents) => contents.getURL() === input.calculatorUrl);
      if (calculator === undefined) throw new Error("Calculator is missing");
      await calculator.insertText(input.expression);
    },
    { calculatorUrl, expression },
  );
  await expect
    .poll(() =>
      callCalculator(
        application,
        () =>
          document.querySelector<HTMLInputElement>("[data-expression-input]")
            ?.value,
        null,
      ),
    )
    .toBe(expression);
  await clickCalculatorControl(application, "[data-expression-form] button");
}

test.describe.serial("isolated calculator surface", () => {
  let application: ElectronApplication;
  let shell: Page;
  let sinkOrigin: string;
  let sinkRequests = 0;
  let tcpSinkConnections = 0;
  let tcpSinkPort: number;
  let udpSinkPort: number;
  let udpSinkRequests = 0;
  let cleanupTasks: CleanupTask[] = [];

  test.beforeAll(async () => {
    const acquired = await acquireWithLocalCleanup(
      async (registerLocalCleanup) => {
        const acquiredCleanupTasks: CleanupTask[] = [];
        const registerCleanup = (cleanup: CleanupTask) => {
          registerLocalCleanup(cleanup);
          acquiredCleanupTasks.push(cleanup);
        };

        const acquiredSink = http.createServer((_request, response) => {
          sinkRequests += 1;
          response.writeHead(204).end();
        });
        acquiredSink.on("upgrade", (request) => {
          sinkRequests += 1;
          request.socket.destroy();
        });
        registerCleanup(() => closeServer(acquiredSink));
        await waitForResourceAcquisition(acquiredSink, () =>
          acquiredSink.listen(0, "127.0.0.1"),
        );
        const address = acquiredSink.address() as AddressInfo;
        const acquiredSinkOrigin = `http://127.0.0.1:${address.port}`;

        const acquiredUdpSink = dgram.createSocket("udp4");
        acquiredUdpSink.on("message", () => {
          udpSinkRequests += 1;
        });
        registerCleanup(() => closeUdpSocket(acquiredUdpSink));
        await waitForResourceAcquisition(acquiredUdpSink, () =>
          acquiredUdpSink.bind(0, "127.0.0.1"),
        );
        const acquiredUdpSinkPort = acquiredUdpSink.address().port;

        const acquiredTcpSink = net.createServer((socket) => {
          tcpSinkConnections += 1;
          socket.destroy();
        });
        registerCleanup(() => closeServer(acquiredTcpSink));
        await waitForResourceAcquisition(acquiredTcpSink, () =>
          acquiredTcpSink.listen(0, "127.0.0.1"),
        );
        const acquiredTcpSinkPort = (acquiredTcpSink.address() as AddressInfo)
          .port;

        const acquiredUserDataDirectory = await fs.mkdtemp(
          path.join(os.tmpdir(), "desmoslock-isolation-e2e-"),
        );
        registerCleanup(() =>
          fs.rm(acquiredUserDataDirectory, { force: true, recursive: true }),
        );

        const launchProfile = createElectronLaunchProfile();
        const acquiredApplication = await electron.launch({
          args: [
            ...launchProfile.args,
            `--user-data-dir=${acquiredUserDataDirectory}`,
            path.resolve("apps/desktop"),
          ],
          env: launchProfile.env,
          ...(launchProfile.chromiumSandbox === undefined
            ? {}
            : { chromiumSandbox: launchProfile.chromiumSandbox }),
        });
        const child = acquiredApplication.process();
        registerLocalCleanup(() =>
          child.exitCode === null && child.signalCode === null
            ? acquiredApplication.close()
            : undefined,
        );
        await trackElectronApplicationForCooperativeCleanup(
          acquiredApplication,
        );
        registerCleanup(() =>
          closeElectronApplicationCooperatively(acquiredApplication),
        );
        const acquiredShell = await acquiredApplication.firstWindow();
        await expect
          .poll(() =>
            acquiredApplication.evaluate(
              ({ webContents }, url) =>
                webContents
                  .getAllWebContents()
                  .filter((contents) => contents.getURL() === url).length,
              calculatorUrl,
            ),
          )
          .toBe(1);

        return {
          application: acquiredApplication,
          cleanupTasks: acquiredCleanupTasks,
          shell: acquiredShell,
          sinkOrigin: acquiredSinkOrigin,
          tcpSinkPort: acquiredTcpSinkPort,
          udpSinkPort: acquiredUdpSinkPort,
        };
      },
    );

    ({
      application,
      cleanupTasks,
      shell,
      sinkOrigin,
      tcpSinkPort,
      udpSinkPort,
    } = acquired);
  });

  test.afterAll(async () => {
    const acquiredCleanupTasks = cleanupTasks;
    cleanupTasks = [];
    await runIndependentCleanupTasks([...acquiredCleanupTasks].reverse());
  });

  test("keeps the trusted preload in the shell and out of the calculator", async () => {
    await expect
      .poll(async () =>
        application.evaluate(
          ({ webContents }, url) =>
            webContents
              .getAllWebContents()
              .filter((contents) => contents.getURL() === url).length,
          calculatorUrl,
        ),
      )
      .toBe(1);

    await expect(
      shell.evaluate(() => {
        const bridge = (
          window as typeof window & {
            desmoslockDesktop?: Record<string, unknown>;
          }
        ).desmoslockDesktop;
        return bridge === undefined ? [] : Object.keys(bridge).sort();
      }),
    ).resolves.toEqual(["requestAssessmentLock", "version"]);

    const isolation = await application.evaluate(
      async ({ app, webContents }, url) => {
        const calculator = webContents
          .getAllWebContents()
          .find((contents) => contents.getURL() === url);
        if (calculator === undefined) {
          throw new Error(
            `Calculator is missing; active URLs: ${webContents
              .getAllWebContents()
              .map((contents) => contents.getURL())
              .join(", ")}`,
          );
        }
        const preferences = (
          calculator as typeof calculator & {
            getLastWebPreferences(): {
              contextIsolation?: boolean;
              devTools?: boolean;
              disableDialogs?: boolean;
              nodeIntegration?: boolean;
              preload?: string;
              sandbox?: boolean;
              webviewTag?: boolean;
            };
          }
        ).getLastWebPreferences();
        return {
          contextIsolation: preferences.contextIsolation,
          devTools: preferences.devTools ?? false,
          disableDialogs: preferences.disableDialogs,
          enabledFeatures: app.commandLine
            .getSwitchValue("enable-features")
            .split(","),
          isPersistent: calculator.session.isPersistent(),
          nodeIntegration: preferences.nodeIntegration,
          preload: preferences.preload,
          registeredPreloads: calculator.session.getPreloadScripts().length,
          remoteProxy: await calculator.session.resolveProxy(
            "https://attacker.invalid",
          ),
          rendererSandboxPreference: preferences.sandbox,
          storagePath: calculator.session.getStoragePath(),
          webviewTag: preferences.webviewTag,
        };
      },
      calculatorUrl,
    );

    expect(isolation).toMatchObject({
      contextIsolation: true,
      devTools: false,
      disableDialogs: true,
      isPersistent: false,
      nodeIntegration: false,
      registeredPreloads: 0,
      rendererSandboxPreference: true,
      storagePath: null,
      webviewTag: false,
    });
    expect(isolation.enabledFeatures).toEqual(
      expect.arrayContaining([
        "CDPScreenshotNewSurface",
        "OverrideConnectionAllowlistOriginTrial",
      ]),
    );
    expect(isolation.remoteProxy).toContain("PROXY 127.0.0.1:9");
    expect(isolation.preload).toBeUndefined();
  });

  test("supports controlled expression and zoom interactions", async () => {
    await expect(
      callCalculator(
        application,
        () => document.querySelector("h2")?.textContent ?? "",
        null,
      ),
    ).resolves.toBe("Graphing calculator");
    await typeCalculatorExpression(application, "y=x^2");
    await clickCalculatorControl(application, "[data-zoom-in]");

    await expect
      .poll(() =>
        callCalculator(
          application,
          () => ({
            expressions: Array.from(
              document.querySelectorAll<HTMLElement>("[data-expression]"),
              (element) => element.dataset.expression,
            ),
            graphVisible:
              document
                .querySelector<SVGElement>("[data-graph]")
                ?.getBoundingClientRect().height !== 0,
            pathCount: document.querySelectorAll(".expression-path").length,
            zoom: document.querySelector("[data-zoom-label]")?.textContent,
          }),
          null,
        ),
      )
      .toEqual({
        expressions: ["y=x", "y=x^2"],
        graphVisible: true,
        pathCount: 2,
        zoom: "125%",
      });
    const screenshotBytes = await application.evaluate(
      async ({ webContents }, url) => {
        const calculator = webContents
          .getAllWebContents()
          .find((contents) => contents.getURL() === url);
        if (calculator === undefined) throw new Error("Calculator is missing");
        return (await calculator.capturePage()).toPNG().byteLength;
      },
      calculatorUrl,
    );

    expect(screenshotBytes).toBeGreaterThan(1_000);
  });

  test("blocks hostile desktop, network, popup, navigation, download, and permission attempts", async () => {
    await application.evaluate(({ webContents }, url) => {
      const calculator = webContents
        .getAllWebContents()
        .find((contents) => contents.getURL() === url);
      if (calculator === undefined) throw new Error("Calculator is missing");
      const tracked = calculator as typeof calculator & {
        blockedDownloadEvents?: number;
        productionDownloadDenialObserved?: boolean;
      };
      tracked.blockedDownloadEvents = 0;
      tracked.productionDownloadDenialObserved = false;
      calculator.session.on(
        "will-download",
        (event, _item, initiatingWebContents) => {
          tracked.productionDownloadDenialObserved ||= event.defaultPrevented;
          event.preventDefault();
          if (initiatingWebContents?.id === calculator.id) {
            tracked.blockedDownloadEvents =
              (tracked.blockedDownloadEvents ?? 0) + 1;
          }
        },
      );
    }, calculatorUrl);

    const hostile = await callCalculator(
      application,
      runHostileCalculatorProbe,
      {
        httpOrigin: sinkOrigin,
        tcpPort: tcpSinkPort,
        udpPort: udpSinkPort,
      },
    );

    expect(hostile).toMatchObject({
      bridge: "undefined",
      externalProtocol: "denied",
      fetch: "blocked",
      nodeProcess: "undefined",
      nodeRequire: "undefined",
      permission: "denied",
      popup: "blocked",
      rtcPeerConnection: "NotAllowedError",
      webTransport: "rejected",
    });

    await new Promise((resolve) => setTimeout(resolve, 500));
    const afterAttack = await application.evaluate(
      ({ BrowserWindow, webContents }, url) => {
        const calculator = webContents
          .getAllWebContents()
          .find((contents) => contents.getURL() === url);
        if (calculator === undefined) {
          throw new Error(
            `Calculator is missing; active URLs: ${webContents
              .getAllWebContents()
              .map((contents) => contents.getURL())
              .join(", ")}`,
          );
        }
        return {
          blockedDownloadEvents:
            (
              calculator as typeof calculator & {
                blockedDownloadEvents?: number;
              }
            ).blockedDownloadEvents ?? 0,
          productionDownloadDenialObserved:
            (
              calculator as typeof calculator & {
                productionDownloadDenialObserved?: boolean;
              }
            ).productionDownloadDenialObserved ?? false,
          calculatorUrl: calculator.getURL(),
          windowCount: BrowserWindow.getAllWindows().length,
        };
      },
      calculatorUrl,
    );

    expect(afterAttack).toEqual({
      blockedDownloadEvents: 1,
      calculatorUrl,
      productionDownloadDenialObserved: true,
      windowCount: 1,
    });
    expect(sinkRequests).toBe(0);
    expect(tcpSinkConnections).toBe(0);
    expect(udpSinkRequests).toBe(0);
    await expect(shell.locator("[data-v2-status]")).toHaveText(
      "Secure calculator ready",
    );

    await typeCalculatorExpression(application, "(2,3)");
    await expect(
      callCalculator(
        application,
        () => document.querySelector("[data-expression='(2,3)']") !== null,
        null,
      ),
    ).resolves.toBe(true);
  });

  test("accepts only the trusted shell's fixed assessment-lock request", async () => {
    await expect(
      shell.evaluate(() =>
        (
          globalThis as typeof globalThis & {
            desmoslockDesktop?: {
              requestAssessmentLock(): Promise<unknown>;
            };
          }
        ).desmoslockDesktop?.requestAssessmentLock(),
      ),
    ).resolves.toEqual({ ok: true });
  });

  test("destroys the owned calculator contents when its BrowserWindow closes", async () => {
    const calculatorId = await application.evaluate(({ webContents }, url) => {
      const calculator = webContents
        .getAllWebContents()
        .find((contents) => contents.getURL() === url);
      if (calculator === undefined) throw new Error("Calculator is missing");
      return calculator.id;
    }, calculatorUrl);

    await application.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.close();
    });
    await expect
      .poll(async () =>
        application.evaluate(
          ({ webContents }, id) =>
            webContents
              .getAllWebContents()
              .some((contents) => contents.id === id),
          calculatorId,
        ),
      )
      .toBe(false);
  });
});
