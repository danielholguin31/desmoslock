import assert from "node:assert/strict";
import dgram from "node:dgram";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { _electron as electron } from "@playwright/test";
import { build } from "esbuild";

import {
  expectedDesktopDistributionFiles,
  inspectDesktopDistribution,
  nativeDistributionFiles,
  packagedExecutableName,
  packageUnsignedDesktop,
  selectExistingElectronArchive,
} from "./desktop-artifact.mjs";
import { createElectronLaunchProfile } from "./electron-launch-profile.mjs";
import { spawnIsolatedProcessTree } from "./isolated-process-tree.mjs";
import { assertPackagedSwitchRejectionBoundary } from "./packaged-switch-rejection-boundary.mjs";
import {
  acquireReadyElectronApplication,
  acquireWithLocalCleanup,
  closeElectronApplicationCooperatively,
  runIndependentCleanupTasks,
  runWithFinalizer,
  runWithIndependentCleanup,
  waitForResourceAcquisition,
} from "./production-desktop-resource-safety.mjs";
import { runHostileCalculatorProbe } from "../tests/e2e/electron/support/hostile-calculator-probe.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const desktopRoot = path.join(repositoryRoot, "apps", "desktop");
const distributionRoot = path.join(desktopRoot, "dist");
const calculatorUrl = "desmoslock-calculator://host/index.html";
const sandboxDisablingEnvironmentVariable = "ELECTRON_DISABLE_SANDBOX";
const sandboxWeakeningOrInliningSwitchNames = Object.freeze([
  "no-sandbox",
  "disable-gpu-sandbox",
  "disable-namespace-sandbox",
  "disable-sandbox",
  "disable-seccomp-filter-sandbox",
  "disable-seccomp-sandbox",
  "disable-setuid-sandbox",
  "in-process-gpu",
  "no-zygote",
  "single-process",
]);
const forbiddenPackagedSwitches = Object.freeze([
  "--inspect=0",
  "--remote-debugging-pipe",
  "--remote-debugging-port=0",
  ...(process.platform === "darwin"
    ? [
        ...sandboxWeakeningOrInliningSwitchNames.map((name) => `--${name}`),
        "--no-sandbox=true",
        "-no-sandbox",
        " --no-sandbox",
        "--disable-setuid-sandbox=true",
        "-disable-setuid-sandbox",
        " --disable-setuid-sandbox",
      ]
    : []),
]);
const diagnosticEndpointPattern =
  /(?:Debugger|DevTools) listening|ws:\/\/[^\s]+\/devtools\//i;
const expectedDistributionFiles = expectedDesktopDistributionFiles();
const studentBridgeKeys = [
  "beginTargetedReadmission",
  "cancelEmergencyEnd",
  "confirmEmergencyEnd",
  "forfeitStudentSession",
  "joinTest",
  "onStudentSessionViewChanged",
  "readStudentSessionView",
  "refreshStudentSession",
  "requestAssessmentLock",
  "retryStudentSession",
  "reviewEmergencyEnd",
  "startAssessment",
  "version",
];

function assertDetachedStudentView(
  view,
  expectedAdmissionPhase,
  expectedProtectionPhase,
) {
  assert.notEqual(
    view,
    null,
    "The configured production shell must publish a composed Student view",
  );
  assert.deepEqual(Object.keys(view).sort(), [
    "admission",
    "protection",
    "revision",
  ]);
  assert.ok(Number.isSafeInteger(view.revision) && view.revision >= 1);
  assert.deepEqual(view.admission, {
    phase: expectedAdmissionPhase,
    session: null,
    pendingOperation: null,
  });
  assert.ok(["idle", "recovery_required"].includes(expectedProtectionPhase));
  const recoveryBlocked = expectedProtectionPhase === "recovery_required";
  // Both an unreadable record and an unavailable native store leave this
  // process unable to confirm an empty journal. Neither proves a native end.
  assert.deepEqual(view.protection, {
    phase: expectedProtectionPhase,
    categories: {
      aac: { status: "pending", code: "awaiting_native_begin" },
      shortcuts: { status: "pending", code: "none" },
      applications: { status: "pending", code: "none" },
      persistence: recoveryBlocked
        ? { status: "unavailable", code: "durability_unavailable" }
        : { status: "pending", code: "none" },
      windowNetwork: { status: "pending", code: "none" },
    },
    calculatorVisible: false,
    failure: recoveryBlocked ? "persistence_unavailable" : null,
    nativeEndObserved: false,
    cleanup: recoveryBlocked ? "unconfirmed" : "not_requested",
    evidence: recoveryBlocked ? "unconfirmed" : "none",
    emergencyReview: false,
  });
}

async function run(command, arguments_, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      cwd: repositoryRoot,
      stdio: "inherit",
      ...options,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${command} exited with ${code === null ? `signal ${signal}` : `code ${code}`}`,
        ),
      );
    });
  });
}

function parsePackagedPolicyBoundary(output) {
  const match = output.match(/^Packaged runtime policy boundary: (.+)$/m);
  assert.notEqual(
    match,
    null,
    "Exact packaged application did not emit its rejection-boundary receipt",
  );
  return JSON.parse(match[1]);
}

function assertMacPackagedLaunchHasNoSandboxDisablingControl(launchProfile) {
  if (process.platform !== "darwin") return;
  assert.equal(
    launchProfile.args.some(
      (argument) =>
        argument === "--no-sandbox" || argument === "--disable-setuid-sandbox",
    ),
    false,
    "macOS packaged verification cannot use a sandbox-disabling switch",
  );
  assert.equal(
    launchProfile.env.ELECTRON_DISABLE_SANDBOX,
    undefined,
    "macOS packaged verification cannot disable the sandbox by environment",
  );
}

async function verifyExternalPackagedLaunch(executablePath, userDataDirectory) {
  const launchProfile = createElectronLaunchProfile();
  assertMacPackagedLaunchHasNoSandboxDisablingControl(launchProfile);
  const tree = await spawnIsolatedProcessTree({
    arguments: [...launchProfile.args, `--user-data-dir=${userDataDirectory}`],
    command: executablePath,
    cwd: path.dirname(executablePath),
    environment: launchProfile.env,
  });

  const { finalizerResult: termination } = await runWithFinalizer(
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      assert.equal(
        tree.targetIsRunning(),
        true,
        `Packaged executable did not remain active:\n${tree.output()}`,
      );
    },
    () => tree.terminate(),
    "Packaged launch assertion and process retirement both failed",
  );
  assert.equal(termination.recordedProcessIdentitiesGone, true);
  assert.doesNotMatch(termination.output.output, diagnosticEndpointPattern);
}

async function verifyForbiddenPackagedSwitch(
  executablePath,
  userDataDirectory,
  forbiddenSwitch,
) {
  const launchProfile = createElectronLaunchProfile();
  const tree = await spawnIsolatedProcessTree({
    arguments: [
      ...launchProfile.args,
      forbiddenSwitch,
      `--user-data-dir=${userDataDirectory}`,
    ],
    command: executablePath,
    cwd: path.dirname(executablePath),
    environment: launchProfile.env,
  });
  const { finalizerResult: termination, operationResult: result } =
    await runWithFinalizer(
      async () => {
        const close = await tree.waitForClose(5_000);
        if (close === null) {
          throw new Error(`Packaged executable accepted ${forbiddenSwitch}`);
        }
        return close;
      },
      () => tree.terminate(),
      `Packaged switch rejection and process retirement both failed for ${forbiddenSwitch}`,
    );

  assert.equal(
    termination.recordedProcessIdentitiesGone,
    true,
    `A recorded packaged process identity survived rejection of ${forbiddenSwitch}`,
  );
  assert.equal(
    result.exitCode,
    78,
    `Packaged executable did not fail closed for ${forbiddenSwitch}`,
  );
  assert.equal(result.signal, null);
  assert.match(
    result.output,
    /Packaged runtime rejected a forbidden launch control\./,
  );
  assert.doesNotMatch(result.output, diagnosticEndpointPattern);
  const boundary = parsePackagedPolicyBoundary(result.output);
  assertPackagedSwitchRejectionBoundary({
    boundary,
    forbiddenSwitch,
    launchProfile,
  });
  return {
    boundary,
    diagnosticEndpointObserved: false,
    exitCode: result.exitCode,
    recordedProcessIdentitiesGone: termination.recordedProcessIdentitiesGone,
    switch: forbiddenSwitch,
  };
}

async function verifyForbiddenPackagedEnvironmentControl(
  executablePath,
  userDataDirectory,
) {
  const launchProfile = createElectronLaunchProfile();
  assert.equal(
    launchProfile.env[sandboxDisablingEnvironmentVariable],
    undefined,
    "The baseline packaged launch profile must not carry the sandbox-disabling environment control",
  );
  const tree = await spawnIsolatedProcessTree({
    arguments: [...launchProfile.args, `--user-data-dir=${userDataDirectory}`],
    command: executablePath,
    cwd: path.dirname(executablePath),
    environment: {
      ...launchProfile.env,
      [sandboxDisablingEnvironmentVariable]: "1",
    },
  });
  const { finalizerResult: termination, operationResult: result } =
    await runWithFinalizer(
      async () => {
        const close = await tree.waitForClose(5_000);
        if (close === null) {
          throw new Error(
            `Packaged executable accepted ${sandboxDisablingEnvironmentVariable}=1`,
          );
        }
        return close;
      },
      () => tree.terminate(),
      "Packaged environment-control rejection and process retirement both failed",
    );

  assert.equal(
    termination.recordedProcessIdentitiesGone,
    true,
    `A recorded packaged process identity survived rejection of ${sandboxDisablingEnvironmentVariable}`,
  );
  assert.equal(
    result.exitCode,
    78,
    `Packaged executable did not fail closed for ${sandboxDisablingEnvironmentVariable}=1`,
  );
  assert.equal(result.signal, null);
  assert.match(
    result.output,
    /Packaged runtime rejected a forbidden launch control\./,
  );
  assert.doesNotMatch(result.output, diagnosticEndpointPattern);
  const boundary = parsePackagedPolicyBoundary(result.output);
  assert.deepEqual(boundary, {
    argumentSwitches: [],
    commandLineSwitches: ["no-sandbox"],
    environmentSandboxControlPresent: true,
    isPackaged: true,
  });
  return {
    boundary,
    control: sandboxDisablingEnvironmentVariable,
    diagnosticEndpointObserved: false,
    exitCode: result.exitCode,
    recordedProcessIdentitiesGone: termination.recordedProcessIdentitiesGone,
  };
}

async function waitForCalculator(application) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const count = await application.evaluate(
      ({ webContents }, url) =>
        webContents
          .getAllWebContents()
          .filter((contents) => contents.getURL() === url).length,
      calculatorUrl,
    );
    if (count === 1) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Internal calculator surface did not become ready");
}

async function launchInternalProductionBuild(userDataDirectory) {
  const launchProfile = createElectronLaunchProfile();
  return acquireReadyElectronApplication({
    launch: () =>
      electron.launch({
        args: [
          ...launchProfile.args,
          `--user-data-dir=${userDataDirectory}`,
          desktopRoot,
        ],
        env: launchProfile.env,
        ...(launchProfile.chromiumSandbox === undefined
          ? {}
          : { chromiumSandbox: launchProfile.chromiumSandbox }),
      }),
    ready: async (application) => {
      const shell = await application.firstWindow();
      await shell.waitForFunction(() => {
        const phase =
          globalThis.document.querySelector(".student-session")?.dataset.phase;
        return phase !== undefined && phase !== "loading";
      });
    },
  });
}

async function launchSyntheticCalculatorBuild(userDataDirectory, fixturePath) {
  const launchProfile = createElectronLaunchProfile();
  return acquireReadyElectronApplication({
    launch: () =>
      electron.launch({
        args: [
          ...launchProfile.args,
          `--user-data-dir=${userDataDirectory}`,
          fixturePath,
          distributionRoot,
        ],
        env: launchProfile.env,
        ...(launchProfile.chromiumSandbox === undefined
          ? {}
          : { chromiumSandbox: launchProfile.chromiumSandbox }),
      }),
    ready: async (application) => {
      const shell = await application.firstWindow();
      await shell.locator("[data-isolation-fixture]").waitFor();
      await waitForCalculator(application);
    },
  });
}

async function inspectProductionShell(
  application,
  expectedPhase,
  expectedProtectionPhase,
) {
  const shell = await application.firstWindow();
  await shell.waitForFunction(
    (phase) =>
      globalThis.document.querySelector(".student-session")?.dataset.phase ===
      phase,
    expectedPhase,
  );
  const shellBoundary = await shell.evaluate(async () => {
    const bridge = globalThis.desmoslockDesktop;
    return {
      bridgeKeys: bridge === undefined ? [] : Object.keys(bridge).sort(),
      bridgeVersion: bridge?.version,
      lockRequestResult: await bridge?.requestAssessmentLock(),
      studentView: await bridge?.readStudentSessionView(),
      manualLockControls:
        globalThis.document.querySelectorAll("[data-lock-intent]").length,
      protection:
        globalThis.document.querySelector("#protection-status")?.textContent,
      phase:
        globalThis.document.querySelector(".student-session")?.dataset.phase,
    };
  });
  assert.deepEqual(shellBoundary.bridgeKeys, studentBridgeKeys);
  assert.equal(shellBoundary.bridgeVersion, "2.0.0");
  assert.deepEqual(shellBoundary.lockRequestResult, {
    ok: false,
    reason: "native-protection-unavailable",
  });
  assert.equal(shellBoundary.manualLockControls, 0);
  assert.equal(
    shellBoundary.protection,
    expectedProtectionPhase === "idle"
      ? "Protection not started"
      : "Recovery required",
  );
  assert.equal(shellBoundary.phase, expectedPhase);
  assertDetachedStudentView(
    shellBoundary.studentView,
    expectedPhase,
    expectedProtectionPhase,
  );
  const recoveryBlocked = expectedProtectionPhase === "recovery_required";
  const start = shell.locator('[data-action="start-assessment"]');
  const emergency = shell.locator('[data-action="review-emergency"]');
  assert.equal(await start.isVisible(), !recoveryBlocked);
  assert.equal(await start.isDisabled(), true);
  assert.equal(await emergency.isVisible(), recoveryBlocked);
  if (recoveryBlocked) assert.equal(await emergency.isDisabled(), false);
  const boundary = await application.evaluate(
    ({ BrowserWindow, webContents }, url) => ({
      calculators: webContents
        .getAllWebContents()
        .filter((contents) => contents.getURL() === url).length,
      windows: BrowserWindow.getAllWindows().map((window) => ({
        attachedViews: window.contentView.children.length,
      })),
      electronVersion: process.versions.electron,
      architecture: process.arch,
      platform: process.platform,
    }),
    calculatorUrl,
  );
  assert.deepEqual(boundary, {
    calculators: 0,
    windows: [{ attachedViews: 0 }],
    electronVersion: "43.8.4",
    architecture: process.arch,
    platform: process.platform,
  });
  for (const [width, height] of [
    [860, 560],
    [1080, 720],
  ]) {
    const contentBounds = await application.evaluate(
      ({ BrowserWindow }, size) => {
        const window = BrowserWindow.getAllWindows()[0];
        window.setSize(size.width, size.height);
        return window.getContentBounds();
      },
      { width, height },
    );
    await shell.waitForFunction(
      (bounds) =>
        globalThis.innerWidth === bounds.width &&
        globalThis.innerHeight === bounds.height,
      contentBounds,
    );
    await shell.locator(".student-session").waitFor();
    const layout = await shell.evaluate(() => {
      const panel = globalThis.document.querySelector(".student-session");
      const bounds = panel.getBoundingClientRect();
      return {
        left: bounds.left,
        right: bounds.right,
        width: bounds.width,
        viewportWidth: globalThis.innerWidth,
        overflow:
          globalThis.document.documentElement.scrollWidth >
          globalThis.innerWidth,
      };
    });
    assert.ok(
      layout.left >= 0 &&
        layout.right <= layout.viewportWidth &&
        layout.width >= 500,
    );
    assert.equal(layout.overflow, false);
    const input = shell.locator("#student-session-code");
    const submit = shell.locator('[data-action="submit-code"]');
    if (recoveryBlocked) {
      assert.equal(
        await shell.locator(".student-session__code-form").isVisible(),
        false,
      );
      assert.equal(await input.isVisible(), false);
      for (const action of [
        submit,
        shell.locator('[data-action="open-recovery"]'),
        shell.locator('[data-action="cancel-recovery"]'),
      ]) {
        assert.equal(await action.isVisible(), false);
        assert.equal(await action.isDisabled(), true);
      }
      assert.equal(await emergency.isVisible(), true);
      assert.equal(await emergency.isDisabled(), false);
    } else {
      assert.equal(expectedPhase, "entry");
      await input.scrollIntoViewIfNeeded();
      assert.equal(await input.isVisible(), true);
      assert.equal(await input.isEditable(), true);
      assert.equal(await submit.isVisible(), true);
      assert.equal(await submit.isDisabled(), false);
      const usable = await input.evaluate((element) => {
        const box = element.getBoundingClientRect();
        return (
          globalThis.document.elementFromPoint(
            box.x + box.width / 2,
            box.y + box.height / 2,
          ) === element
        );
      });
      assert.equal(
        usable,
        true,
        "The detached calculator must not occlude joining",
      );
    }
  }
  return { shellBoundary, boundary };
}

async function inspectCalculatorRuntime(application) {
  const runtime = await application.evaluate(
    async ({ app, webContents }, url) => {
      const calculator = webContents
        .getAllWebContents()
        .find((contents) => contents.getURL() === url);
      if (calculator === undefined) throw new Error("Calculator is missing");
      const preferences = calculator.getLastWebPreferences();
      return {
        chromiumSandboxDisabledByLaunch:
          app.commandLine.hasSwitch("no-sandbox") ||
          app.commandLine.hasSwitch("disable-setuid-sandbox") ||
          process.env.ELECTRON_DISABLE_SANDBOX === "1",
        contextIsolation: preferences.contextIsolation,
        devTools: preferences.devTools ?? false,
        electronVersion: process.versions.electron,
        architecture: process.arch,
        platform: process.platform,
        enabledFeatures: app.commandLine
          .getSwitchValue("enable-features")
          .split(","),
        isPackaged: app.isPackaged,
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
  return runtime;
}

async function runInternalShellDenialProbe(application) {
  const shell = await application.firstWindow();
  await application.evaluate(({ BrowserWindow, session }) => {
    const [shellWindow] = BrowserWindow.getAllWindows();
    if (shellWindow === undefined) throw new Error("Internal shell is missing");
    const trackedSession = session.defaultSession;
    trackedSession.packagedShellDownloadDenials = 0;
    trackedSession.packagedShellDownloadPolicyObserved = false;
    trackedSession.on(
      "will-download",
      (event, _item, initiatingWebContents) => {
        if (initiatingWebContents?.id !== shellWindow.webContents.id) return;
        trackedSession.packagedShellDownloadPolicyObserved ||=
          event.defaultPrevented;
        trackedSession.packagedShellDownloadDenials += 1;
        event.preventDefault();
      },
    );
  });
  const permission = await shell.evaluate(async () => {
    const result = await globalThis.navigator.permissions.query({
      name: "geolocation",
    });
    const download = globalThis.document.createElement("a");
    download.download = "desmoslock-packaged-shell-must-not-exist.txt";
    download.href = "data:text/plain,blocked";
    download.click();
    return result.state;
  });

  const deadline = Date.now() + 1_000;
  let download = { count: 0, deniedByProductionPolicy: false };
  while (download.count === 0 && Date.now() < deadline) {
    download = await application.evaluate(({ session }) => ({
      count: session.defaultSession.packagedShellDownloadDenials ?? 0,
      deniedByProductionPolicy:
        session.defaultSession.packagedShellDownloadPolicyObserved ?? false,
    }));
    if (download.count === 0) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  return { download, permission };
}

async function createHostileNetworkSinks() {
  return acquireWithLocalCleanup(async (registerCleanup) => {
    const cleanupTasks = [];
    const trackCleanup = (cleanup) => {
      cleanupTasks.push(cleanup);
      registerCleanup(cleanup);
    };
    const counters = { http: 0, tcp: 0, udp: 0 };
    const httpServer = http.createServer((_request, response) => {
      counters.http += 1;
      response.writeHead(204).end();
    });
    httpServer.on("upgrade", (request) => {
      counters.http += 1;
      request.socket.destroy();
    });
    await waitForResourceAcquisition(httpServer, () =>
      httpServer.listen(0, "127.0.0.1"),
    );
    trackCleanup(
      () => new Promise((resolve) => httpServer.close(() => resolve())),
    );
    const httpAddress = httpServer.address();
    assert.ok(
      httpAddress !== null && typeof httpAddress !== "string",
      "HTTP sink did not expose an address",
    );

    const udpServer = dgram.createSocket("udp4");
    udpServer.on("message", () => {
      counters.udp += 1;
    });
    await waitForResourceAcquisition(udpServer, () =>
      udpServer.bind(0, "127.0.0.1"),
    );
    trackCleanup(
      () => new Promise((resolve) => udpServer.close(() => resolve())),
    );
    const udpAddress = udpServer.address();

    const tcpServer = net.createServer((socket) => {
      counters.tcp += 1;
      socket.destroy();
    });
    await waitForResourceAcquisition(tcpServer, () =>
      tcpServer.listen(0, "127.0.0.1"),
    );
    trackCleanup(
      () => new Promise((resolve) => tcpServer.close(() => resolve())),
    );
    const tcpAddress = tcpServer.address();
    assert.ok(
      tcpAddress !== null && typeof tcpAddress !== "string",
      "TCP sink did not expose an address",
    );

    return {
      close: () => runIndependentCleanupTasks([...cleanupTasks].reverse()),
      counters,
      httpOrigin: `http://127.0.0.1:${httpAddress.port}`,
      tcpPort: tcpAddress.port,
      udpPort: udpAddress.port,
    };
  });
}

async function createBackendHealthFixture() {
  return acquireWithLocalCleanup(async (registerCleanup) => {
    const healthBody = JSON.stringify({
      capabilities: ["auth", "database", "rest"],
      fixtureDigest:
        "f1ecc4d44ca04b3395b565dd2fe9f7887147e34f6196772f18bae00638244201",
      fixtureValid: true,
      fixtureVersion: "internal-baseline-v2",
      schemaGeneration: 4,
      service: "desmoslock-v2",
      status: "ready",
    });
    const server = http.createServer((request, response) => {
      if (request.method !== "GET" || request.url !== "/functions/v1/health") {
        response.writeHead(404, {
          "cache-control": "no-store",
          "content-type": "text/plain; charset=utf-8",
        });
        response.end("Not Found");
        return;
      }
      response.writeHead(200, {
        "access-control-allow-origin": "*",
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8",
      });
      response.end(healthBody);
    });
    await waitForResourceAcquisition(server, () =>
      server.listen(0, "127.0.0.1"),
    );
    const close = () => new Promise((resolve) => server.close(() => resolve()));
    registerCleanup(close);
    const address = server.address();
    assert.ok(
      address !== null && typeof address !== "string",
      "Backend health fixture did not expose an address",
    );
    return {
      close,
      origin: `http://127.0.0.1:${address.port}`,
    };
  });
}

async function runInternalHostileProbe(application, sinks) {
  await application.evaluate(({ webContents }, url) => {
    const calculator = webContents
      .getAllWebContents()
      .find((contents) => contents.getURL() === url);
    if (calculator === undefined) throw new Error("Calculator is missing");
    calculator.blockedDownloadEvents = 0;
    calculator.productionDownloadDenialObserved = false;
    calculator.session.on(
      "will-download",
      (event, _item, initiatingWebContents) => {
        calculator.productionDownloadDenialObserved ||= event.defaultPrevented;
        event.preventDefault();
        if (initiatingWebContents?.id === calculator.id) {
          calculator.blockedDownloadEvents += 1;
        }
      },
    );
  }, calculatorUrl);

  const result = await application.evaluate(
    async ({ webContents }, input) => {
      const calculator = webContents
        .getAllWebContents()
        .find((contents) => contents.getURL() === input.calculatorUrl);
      if (calculator === undefined) throw new Error("Calculator is missing");
      return calculator.executeJavaScript(
        `(${input.probeSource})(${JSON.stringify(input.probeInput)})`,
      );
    },
    {
      calculatorUrl,
      probeInput: {
        httpOrigin: sinks.httpOrigin,
        tcpPort: sinks.tcpPort,
        udpPort: sinks.udpPort,
      },
      probeSource: runHostileCalculatorProbe.toString(),
    },
  );

  await new Promise((resolve) => setTimeout(resolve, 500));
  await waitForCalculator(application);
  const boundary = await application.evaluate(
    ({ BrowserWindow, webContents }, url) => {
      const calculator = webContents
        .getAllWebContents()
        .find((contents) => contents.getURL() === url);
      if (calculator === undefined) throw new Error("Calculator is missing");
      return {
        blockedDownloadEvents: calculator.blockedDownloadEvents ?? 0,
        calculatorUrl: calculator.getURL(),
        productionDownloadDenialObserved:
          calculator.productionDownloadDenialObserved ?? false,
        windowCount: BrowserWindow.getAllWindows().length,
      };
    },
    calculatorUrl,
  );

  return { boundary, result };
}

async function setCalculatorState(application) {
  return application.evaluate(async ({ webContents }, url) => {
    const calculator = webContents
      .getAllWebContents()
      .find((contents) => contents.getURL() === url);
    if (calculator === undefined) throw new Error("Calculator is missing");
    return calculator.executeJavaScript(`(async () => {
      localStorage.setItem("production-relaunch-probe", "must-not-survive");
      await new Promise((resolve, reject) => {
        const request = indexedDB.open("production-relaunch-probe", 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          request.result.close();
          resolve();
        };
      });
      const input = document.querySelector("[data-expression-input]");
      const form = document.querySelector("[data-expression-form]");
      input.value = "y=x^2";
      form.requestSubmit();
      return Array.from(document.querySelectorAll("[data-expression]"),
        (element) => element.dataset.expression);
    })()`);
  }, calculatorUrl);
}

async function readCalculatorState(application) {
  return application.evaluate(async ({ webContents }, url) => {
    const calculator = webContents
      .getAllWebContents()
      .find((contents) => contents.getURL() === url);
    if (calculator === undefined) throw new Error("Calculator is missing");
    return calculator.executeJavaScript(`(async () => ({
      databases: (await indexedDB.databases()).map((database) => database.name),
      expressions: Array.from(document.querySelectorAll("[data-expression]"),
        (element) => element.dataset.expression),
      storedProbe: localStorage.getItem("production-relaunch-probe")
    }))()`);
  }, calculatorUrl);
}

const temporaryRoot = await fs.realpath(
  await fs.mkdtemp(
    path.join(os.tmpdir(), "desmoslock-production-verification-"),
  ),
);
let application = null;
let backendFixture = null;
let networkSinks = null;

await runWithIndependentCleanup(async () => {
  const electronManifest = JSON.parse(
    await fs.readFile(
      path.join(repositoryRoot, "node_modules/electron/package.json"),
      "utf8",
    ),
  );
  const electronArchive = await selectExistingElectronArchive({
    repositoryRoot,
    electronVersion: electronManifest.version,
  });
  backendFixture = await createBackendHealthFixture();
  const emptyBuildConfig = path.join(temporaryRoot, "empty-build-global-npmrc");
  await fs.writeFile(emptyBuildConfig, "", { mode: 0o600 });
  const nativeBuildEnvironment = Object.fromEntries(
    [
      "DESMOSLOCK_NATIVE_CLANG",
      "DESMOSLOCK_NATIVE_SDK",
      "DESMOSLOCK_NATIVE_NODE_HEADERS",
    ]
      .filter((key) => process.env[key] !== undefined)
      .map((key) => [key, process.env[key]]),
  );
  await run(
    process.execPath,
    [
      path.join(repositoryRoot, "scripts", "build-app.mjs"),
      "desktop",
      "--production",
    ],
    {
      env: {
        PATH: process.env.PATH ?? "",
        LANG: "C",
        LC_ALL: "C",
        TMPDIR: process.env.TMPDIR ?? temporaryRoot,
        TMP: process.env.TMPDIR ?? temporaryRoot,
        TEMP: process.env.TMPDIR ?? temporaryRoot,
        NODE_DISABLE_COMPILE_CACHE: "1",
        COREPACK_ENABLE_NETWORK: "0",
        npm_config_cache:
          process.env.npm_config_cache ?? path.join(temporaryRoot, "npm-cache"),
        npm_config_userconfig: "/dev/null",
        npm_config_globalconfig: emptyBuildConfig,
        npm_config_offline: "true",
        npm_config_update_notifier: "false",
        ...nativeBuildEnvironment,
        DESMOSLOCK_PUBLIC_BACKEND_ENVIRONMENT: "local",
        DESMOSLOCK_PUBLIC_BACKEND_URL: backendFixture.origin,
      },
    },
  );
  const distribution = await inspectDesktopDistribution({ distributionRoot });
  const productionRuntimeText = (
    await Promise.all(
      expectedDistributionFiles.map((relativePath) =>
        nativeDistributionFiles.includes(relativePath)
          ? ""
          : fs.readFile(path.join(distributionRoot, relativePath), "utf8"),
      ),
    )
  ).join("\n");
  const nativeArtifacts = distribution.nativeArtifacts;
  for (const prohibited of [
    /authorized local fixture/i,
    /controlled calculator/i,
    /desmoslock\.security\.denial\.observers/i,
    /no desktop bridge/i,
    /\bopenExternal\s*\(/,
    /sessionDenialObserverKey/,
    /\.\s*openExternal\b/,
    /\bSymbol\.for\s*\(/,
    /test-lock-intent/i,
    /Send lock intent/i,
  ]) {
    assert.doesNotMatch(
      productionRuntimeText,
      prohibited,
      `Production runtime contains a prohibited test or dispatch surface: ${prohibited}`,
    );
  }
  const shellDocument = await fs.readFile(
    path.join(distributionRoot, "index.html"),
    "utf8",
  );
  assert.doesNotMatch(
    shellDocument,
    /data-lock-intent|test-lock-intent|Send lock intent/i,
    "Production shell must not expose a manual lock-intent control",
  );

  const packagedArtifact = await packageUnsignedDesktop({
    repositoryRoot,
    distributionRoot,
    stageRoot: path.join(temporaryRoot, "staging"),
    outputRoot: path.join(temporaryRoot, "package"),
    temporaryRoot: path.join(temporaryRoot, "packager-tmp"),
    electronVersion: electronManifest.version,
    electronArchive,
  });
  assert.deepEqual(
    packagedArtifact.distribution,
    distribution,
    "Runtime distribution changed after production source checks",
  );
  const executablePath = packagedArtifact.executable;
  if (process.platform === "darwin") {
    assert.equal(
      executablePath,
      path.join(
        packagedArtifact.appBundle,
        "Contents",
        "MacOS",
        packagedExecutableName,
      ),
      "Packaged policy verification must exercise the executable inside the exact generated .app",
    );
  }
  // This actual-main gate uses the production OS-encryption adapter. Authoring
  // or running the synthetic fixture does not satisfy that separate gate.
  const userDataDirectory = path.join(temporaryRoot, "actual-main-user-data");
  application = await launchInternalProductionBuild(userDataDirectory);
  const productionShell = await inspectProductionShell(
    application,
    process.platform === "darwin" ? "entry" : "unavailable",
    process.platform === "darwin" ? "idle" : "recovery_required",
  );
  assert.deepEqual(await runInternalShellDenialProbe(application), {
    download: { count: 1, deniedByProductionPolicy: true },
    permission: "denied",
  });
  await closeElectronApplicationCooperatively(application);
  application = null;
  let productionRecovery = null;
  if (process.platform === "darwin") {
    const corruptRecord = path.join(
      userDataDirectory,
      "student-session/student-session.record",
    );
    await fs.writeFile(
      corruptRecord,
      Buffer.from("synthetic-unreadable-admission-record", "utf8"),
      { mode: 0o600, flag: "wx" },
    );
    application = await launchInternalProductionBuild(userDataDirectory);
    productionRecovery = await inspectProductionShell(
      application,
      "recovery_required",
      "recovery_required",
    );
    assert.equal(
      (await fs.readFile(corruptRecord)).toString("utf8"),
      "synthetic-unreadable-admission-record",
    );
    await closeElectronApplicationCooperatively(application);
    application = null;
  }

  const fixturePath = path.join(temporaryRoot, "calculator-isolation.mjs");
  await build({
    bundle: true,
    entryPoints: [
      path.join(
        repositoryRoot,
        "tests/e2e/electron/fixtures/calculator-isolation.ts",
      ),
    ],
    external: ["electron"],
    format: "esm",
    outfile: fixturePath,
    platform: "node",
    target: "node24",
  });
  const calculatorUserDataDirectory = path.join(
    temporaryRoot,
    "synthetic-calculator-user-data",
  );
  application = await launchSyntheticCalculatorBuild(
    calculatorUserDataDirectory,
    fixturePath,
  );
  const calculatorRuntime = await inspectCalculatorRuntime(application);
  assert.deepEqual(calculatorRuntime, {
    chromiumSandboxDisabledByLaunch: process.platform === "linux",
    contextIsolation: true,
    devTools: false,
    electronVersion: "43.8.4",
    architecture: process.arch,
    platform: process.platform,
    enabledFeatures: calculatorRuntime.enabledFeatures,
    isPackaged: false,
    isPersistent: false,
    nodeIntegration: false,
    preload: undefined,
    registeredPreloads: 0,
    remoteProxy: calculatorRuntime.remoteProxy,
    rendererSandboxPreference: true,
    storagePath: null,
    webviewTag: false,
  });
  assert.ok(
    calculatorRuntime.enabledFeatures.includes(
      "OverrideConnectionAllowlistOriginTrial",
    ),
    "Synthetic calculator fixture did not enable the production Connection-Allowlist prerequisite",
  );
  assert.match(calculatorRuntime.remoteProxy, /PROXY 127\.0\.0\.1:9/);

  networkSinks = await createHostileNetworkSinks();
  const hostile = await runInternalHostileProbe(application, networkSinks);
  assert.deepEqual(hostile.result, {
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
  assert.deepEqual(hostile.boundary, {
    blockedDownloadEvents: 1,
    calculatorUrl,
    productionDownloadDenialObserved: true,
    windowCount: 1,
  });
  assert.deepEqual(networkSinks.counters, { http: 0, tcp: 0, udp: 0 });
  await networkSinks.close();
  networkSinks = null;

  assert.deepEqual(await setCalculatorState(application), ["y=x", "y=x^2"]);
  await closeElectronApplicationCooperatively(application);
  application = null;

  application = await launchSyntheticCalculatorBuild(
    calculatorUserDataDirectory,
    fixturePath,
  );
  assert.deepEqual(await readCalculatorState(application), {
    databases: [],
    expressions: ["y=x"],
    storedProbe: null,
  });
  await closeElectronApplicationCooperatively(application);
  application = null;

  await verifyExternalPackagedLaunch(
    executablePath,
    path.join(temporaryRoot, "packaged-user-data"),
  );
  const rejectedSwitches = [];
  for (const forbiddenSwitch of forbiddenPackagedSwitches) {
    rejectedSwitches.push(
      await verifyForbiddenPackagedSwitch(
        executablePath,
        path.join(
          temporaryRoot,
          `rejected-${forbiddenSwitch.replaceAll(/[^a-z]+/gi, "-")}`,
        ),
        forbiddenSwitch,
      ),
    );
  }
  assert.deepEqual(
    rejectedSwitches.map((receipt) => receipt.switch),
    forbiddenPackagedSwitches,
  );
  if (process.platform === "darwin") {
    const rejectedEnvironmentControl =
      await verifyForbiddenPackagedEnvironmentControl(
        executablePath,
        path.join(temporaryRoot, "rejected-sandbox-environment-control"),
      );
    assert.deepEqual(rejectedEnvironmentControl, {
      boundary: {
        argumentSwitches: [],
        commandLineSwitches: ["no-sandbox"],
        environmentSandboxControlPresent: true,
        isPackaged: true,
      },
      control: sandboxDisablingEnvironmentVariable,
      diagnosticEndpointObserved: false,
      exitCode: 78,
      recordedProcessIdentitiesGone: true,
    });
  }

  process.stdout.write(
    process.platform === "linux"
      ? "Actual production shell keeps the calculator detached; synthetic calculator isolation and process-supervision checks passed under the non-release Linux compatibility profile with Chromium's OS sandbox disabled. OS encryption, physical protection and packaged UI acceptance remain unproven.\n"
      : "Actual production join/recovery shell keeps the calculator detached; separately synthetic calculator isolation and exact packaged launch policy checks passed without a sandbox-disabling launch control. OS encryption enrollment/continuity, physical protection and signed/notarized packaged UI acceptance remain unproven.\n",
  );
  process.stdout.write(
    `${JSON.stringify({ nativeArtifacts, electronArchive: { filename: electronArchive.filename, sha256: electronArchive.sha256, bytes: electronArchive.bytes }, actualMain: { entry: productionShell.shellBoundary.phase, recovery: productionRecovery?.shellBoundary.phase ?? null, calculatorVisible: false }, calculatorEvidence: "synthetic-isolation-fixture-only" })}\n`,
  );
}, [
  async () => {
    if (application !== null) {
      await closeElectronApplicationCooperatively(application);
    }
  },
  async () => {
    if (networkSinks !== null) await networkSinks.close();
  },
  async () => {
    if (backendFixture !== null) await backendFixture.close();
  },
  () => fs.rm(temporaryRoot, { force: true, recursive: true }),
]);
