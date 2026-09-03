import assert from "node:assert/strict";
import dgram from "node:dgram";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { packager } from "@electron/packager";
import { _electron as electron } from "@playwright/test";

import {
  hardenPackagedElectron,
  verifyPackagedElectronFuses,
} from "./electron-fuse-policy.mjs";
import { createElectronLaunchProfile } from "./electron-launch-profile.mjs";
import { spawnIsolatedProcessTree } from "./isolated-process-tree.mjs";
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
const packagedExecutableName = "desmoslock-internal";
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
const expectedDistributionFiles = [
  "calculator/host.js",
  "calculator/index.html",
  "calculator/styles.css",
  "index.html",
  "main.js",
  "preload.cjs",
  "renderer.js",
  "styles.css",
];

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

async function listFiles(root, relativeDirectory = "") {
  const directory = path.join(root, relativeDirectory);
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relativePath = path.posix.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(root, relativePath)));
    } else {
      files.push(relativePath);
    }
  }
  return files.sort();
}

async function packagedExecutable(packageDirectory) {
  if (process.platform === "darwin") {
    const appBundle = path.join(packageDirectory, "DesmosLock Internal.app");
    const executableDirectory = path.join(appBundle, "Contents", "MacOS");
    const executable = path.join(executableDirectory, packagedExecutableName);
    await fs.access(executable, fs.constants.X_OK);
    return Object.freeze({ appBundle, executable });
  }

  if (process.platform === "win32") {
    const executable = path.join(
      packageDirectory,
      `${packagedExecutableName}.exe`,
    );
    await fs.access(executable);
    return Object.freeze({ appBundle: null, executable });
  }

  const executable = path.join(packageDirectory, packagedExecutableName);
  await fs.access(executable, fs.constants.X_OK);
  return Object.freeze({ appBundle: null, executable });
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

function normalizedSwitchName(argument) {
  return argument
    .trim()
    .replace(/^-{1,2}/, "")
    .split("=", 1)[0];
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
  const normalizedName = normalizedSwitchName(forbiddenSwitch);
  assert.equal(boundary.isPackaged, true);
  assert.equal(boundary.environmentSandboxControlPresent, false);
  assert.deepEqual(boundary.argumentSwitches, [normalizedName]);
  assert.ok(Array.isArray(boundary.commandLineSwitches));
  if (forbiddenSwitch.startsWith("--")) {
    assert.ok(
      boundary.commandLineSwitches.includes(normalizedName),
      `Electron app.commandLine did not expose ${forbiddenSwitch} in the exact packaged application`,
    );
  }
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
      await application.firstWindow();
      await waitForCalculator(application);
    },
  });
}

async function inspectRuntime(application) {
  const shell = await application.firstWindow();
  await shell.waitForFunction(
    () =>
      globalThis.document.querySelector("[data-v2-status]")?.dataset
        .backendStatus === "ready",
  );
  const shellBoundary = await shell.evaluate(async () => {
    const bridge = globalThis.desmoslockDesktop;
    const status = globalThis.document.querySelector("[data-v2-status]");
    return {
      backendStatus: status?.dataset.backendStatus,
      bridgeKeys: bridge === undefined ? [] : Object.keys(bridge).sort(),
      bridgeVersion: bridge?.version,
      lockRequestResult: await bridge?.requestAssessmentLock(),
      manualLockControls:
        globalThis.document.querySelectorAll("[data-lock-intent]").length,
      status: status?.textContent,
    };
  });
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
  return { runtime, shellBoundary };
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
        "7c84b474e409b79fdb11e537b29a48f56382c1f88afc28b213fb5043fff7f2ca",
      fixtureValid: true,
      fixtureVersion: "internal-baseline-v1",
      schemaGeneration: 3,
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

const temporaryRoot = await fs.mkdtemp(
  path.join(os.tmpdir(), "desmoslock-production-verification-"),
);
let application = null;
let backendFixture = null;
let networkSinks = null;

await runWithIndependentCleanup(async () => {
  backendFixture = await createBackendHealthFixture();
  await run(
    process.execPath,
    [
      path.join(repositoryRoot, "scripts", "build-app.mjs"),
      "desktop",
      "--production",
    ],
    {
      env: {
        ...process.env,
        DESMOSLOCK_PUBLIC_BACKEND_ENVIRONMENT: "local",
        DESMOSLOCK_PUBLIC_BACKEND_URL: backendFixture.origin,
      },
    },
  );
  assert.deepEqual(
    await listFiles(distributionRoot),
    expectedDistributionFiles,
    "Production build must contain only the reviewed runtime assets and no source maps",
  );
  const productionRuntimeText = (
    await Promise.all(
      expectedDistributionFiles.map((relativePath) =>
        fs.readFile(path.join(distributionRoot, relativePath), "utf8"),
      ),
    )
  ).join("\n");
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
    /data-lock-intent|<button\b/i,
    "Production shell must not expose a manual lock-intent control",
  );

  const stagingRoot = path.join(temporaryRoot, "staging");
  await fs.mkdir(stagingRoot, { recursive: true });
  await fs.cp(distributionRoot, path.join(stagingRoot, "dist"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(stagingRoot, "package.json"),
    `${JSON.stringify(
      {
        main: "dist/main.js",
        name: "desmoslock-internal",
        private: true,
        productName: "DesmosLock Internal",
        type: "module",
        version: "2.0.0",
      },
      null,
      2,
    )}\n`,
  );

  const electronManifest = JSON.parse(
    await fs.readFile(
      path.join(repositoryRoot, "node_modules", "electron", "package.json"),
      "utf8",
    ),
  );
  const packageDirectories = await packager({
    arch: process.arch,
    asar: true,
    dir: stagingRoot,
    electronVersion: electronManifest.version,
    executableName: packagedExecutableName,
    name: "DesmosLock Internal",
    osxSign: false,
    out: path.join(temporaryRoot, "package"),
    overwrite: true,
    platform: process.platform,
    prune: false,
    quiet: true,
  });
  assert.equal(packageDirectories.length, 1);
  const packagedArtifact = await packagedExecutable(packageDirectories[0]);
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
  await hardenPackagedElectron(executablePath);
  assert.deepEqual(await verifyPackagedElectronFuses(executablePath), {
    EnableNodeCliInspectArguments: "DISABLE",
    EnableNodeOptionsEnvironmentVariable: "DISABLE",
    RunAsNode: "DISABLE",
  });

  const userDataDirectory = path.join(temporaryRoot, "internal-user-data");

  application = await launchInternalProductionBuild(userDataDirectory);
  const firstLaunch = await inspectRuntime(application);
  assert.deepEqual(firstLaunch.shellBoundary, {
    backendStatus: "ready",
    bridgeKeys: ["requestAssessmentLock", "version"],
    bridgeVersion: "2.0.0",
    lockRequestResult: { ok: true },
    manualLockControls: 0,
    status: "Synthetic backend ready",
  });
  assert.deepEqual(firstLaunch.runtime, {
    chromiumSandboxDisabledByLaunch: process.platform === "linux",
    contextIsolation: true,
    devTools: false,
    enabledFeatures: firstLaunch.runtime.enabledFeatures,
    isPackaged: false,
    isPersistent: false,
    nodeIntegration: false,
    preload: undefined,
    registeredPreloads: 0,
    remoteProxy: firstLaunch.runtime.remoteProxy,
    rendererSandboxPreference: true,
    storagePath: null,
    webviewTag: false,
  });
  assert.ok(
    firstLaunch.runtime.enabledFeatures.includes(
      "OverrideConnectionAllowlistOriginTrial",
    ),
    "Internal production build did not enable the Connection-Allowlist override",
  );
  assert.match(firstLaunch.runtime.remoteProxy, /PROXY 127\.0\.0\.1:9/);
  assert.deepEqual(await runInternalShellDenialProbe(application), {
    download: { count: 1, deniedByProductionPolicy: true },
    permission: "denied",
  });

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

  application = await launchInternalProductionBuild(userDataDirectory);
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
      ? "Internal production-build renderer policy and process-supervision checks passed under the non-release Linux compatibility profile; Chromium's OS sandbox was disabled. Issue #34 remains incomplete pending Desmos rights/exact assets and exact packaged physical UI acceptance.\n"
      : "Internal production-build renderer policy and exact packaged launch policy passed without a sandbox-disabling launch control. Issue #34 remains incomplete pending Desmos rights/exact assets and exact signed/notarized packaged physical UI acceptance.\n",
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
