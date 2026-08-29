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
import { runHostileCalculatorProbe } from "../tests/e2e/electron/support/hostile-calculator-probe.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const desktopRoot = path.join(repositoryRoot, "apps", "desktop");
const distributionRoot = path.join(desktopRoot, "dist");
const calculatorUrl = "desmoslock-calculator://host/index.html";
const packagedExecutableName = "desmoslock-internal";
const forbiddenPackagedSwitches = Object.freeze([
  "--inspect=0",
  "--remote-debugging-pipe",
  "--remote-debugging-port=0",
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
    return executable;
  }

  if (process.platform === "win32") {
    const executable = path.join(
      packageDirectory,
      `${packagedExecutableName}.exe`,
    );
    await fs.access(executable);
    return executable;
  }

  const executable = path.join(packageDirectory, packagedExecutableName);
  await fs.access(executable, fs.constants.X_OK);
  return executable;
}

async function verifyExternalPackagedLaunch(executablePath, userDataDirectory) {
  const launchProfile = createElectronLaunchProfile();
  const tree = spawnIsolatedProcessTree({
    arguments: [...launchProfile.args, `--user-data-dir=${userDataDirectory}`],
    command: executablePath,
    cwd: path.dirname(executablePath),
    environment: launchProfile.env,
  });

  let termination;
  try {
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    assert.equal(
      tree.leaderIsRunning(),
      true,
      `Packaged executable did not remain active:\n${tree.output()}`,
    );
  } finally {
    termination = await tree.terminate();
  }
  assert.equal(termination.treeEmpty, true);
  assert.doesNotMatch(termination.close.output, diagnosticEndpointPattern);
}

async function verifyForbiddenPackagedSwitch(
  executablePath,
  userDataDirectory,
  forbiddenSwitch,
) {
  const launchProfile = createElectronLaunchProfile();
  const tree = spawnIsolatedProcessTree({
    arguments: [
      ...launchProfile.args,
      forbiddenSwitch,
      `--user-data-dir=${userDataDirectory}`,
    ],
    command: executablePath,
    cwd: path.dirname(executablePath),
    environment: launchProfile.env,
  });
  let result;
  let termination;
  try {
    result = await tree.waitForClose(5_000);
    if (result === null) {
      throw new Error(`Packaged executable accepted ${forbiddenSwitch}`);
    }
  } finally {
    termination = await tree.terminate();
  }

  assert.equal(
    termination.treeEmpty,
    true,
    `Packaged process tree survived rejection of ${forbiddenSwitch}`,
  );
  assert.equal(
    result.exitCode,
    78,
    `Packaged executable did not fail closed for ${forbiddenSwitch}`,
  );
  assert.equal(result.signal, null);
  assert.match(
    result.output,
    /Packaged runtime rejected a diagnostic switch\./,
  );
  assert.doesNotMatch(result.output, diagnosticEndpointPattern);
  return {
    diagnosticEndpointObserved: false,
    exitCode: result.exitCode,
    switch: forbiddenSwitch,
    treeEmpty: termination.treeEmpty,
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
  const application = await electron.launch({
    args: [
      ...launchProfile.args,
      `--user-data-dir=${userDataDirectory}`,
      desktopRoot,
    ],
    env: launchProfile.env,
    ...(launchProfile.chromiumSandbox === undefined
      ? {}
      : { chromiumSandbox: launchProfile.chromiumSandbox }),
  });
  await application.firstWindow();
  await waitForCalculator(application);
  return application;
}

async function inspectRuntime(application) {
  const shell = await application.firstWindow();
  const shellBoundary = await shell.evaluate(async () => {
    const bridge = globalThis.desmoslockDesktop;
    return {
      bridgeKeys: bridge === undefined ? [] : Object.keys(bridge).sort(),
      bridgeVersion: bridge?.version,
      lockRequestResult: await bridge?.requestAssessmentLock(),
      manualLockControls:
        globalThis.document.querySelectorAll("[data-lock-intent]").length,
      status:
        globalThis.document.querySelector("[data-v2-status]")?.textContent,
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
        sandbox: preferences.sandbox,
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
  const counters = { http: 0, tcp: 0, udp: 0 };
  const httpServer = http.createServer((_request, response) => {
    counters.http += 1;
    response.writeHead(204).end();
  });
  httpServer.on("upgrade", (request) => {
    counters.http += 1;
    request.socket.destroy();
  });
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const httpAddress = httpServer.address();
  assert.ok(
    httpAddress !== null && typeof httpAddress !== "string",
    "HTTP sink did not expose an address",
  );

  const udpServer = dgram.createSocket("udp4");
  udpServer.on("message", () => {
    counters.udp += 1;
  });
  await new Promise((resolve) => udpServer.bind(0, "127.0.0.1", resolve));
  const udpAddress = udpServer.address();

  const tcpServer = net.createServer((socket) => {
    counters.tcp += 1;
    socket.destroy();
  });
  await new Promise((resolve) => tcpServer.listen(0, "127.0.0.1", resolve));
  const tcpAddress = tcpServer.address();
  assert.ok(
    tcpAddress !== null && typeof tcpAddress !== "string",
    "TCP sink did not expose an address",
  );

  return {
    close: async () => {
      await Promise.allSettled([
        new Promise((resolve) => httpServer.close(() => resolve())),
        new Promise((resolve) => udpServer.close(() => resolve())),
        new Promise((resolve) => tcpServer.close(() => resolve())),
      ]);
    },
    counters,
    httpOrigin: `http://127.0.0.1:${httpAddress.port}`,
    tcpPort: tcpAddress.port,
    udpPort: udpAddress.port,
  };
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
let networkSinks = null;

try {
  await run(process.execPath, [
    path.join(repositoryRoot, "scripts", "build-app.mjs"),
    "desktop",
    "--production",
  ]);
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
    /\bsynthetic\b/i,
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
  const executablePath = await packagedExecutable(packageDirectories[0]);
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
    bridgeKeys: ["requestAssessmentLock", "version"],
    bridgeVersion: "2.0.0",
    lockRequestResult: { ok: true },
    manualLockControls: 0,
    status: "Secure calculator ready",
  });
  assert.deepEqual(firstLaunch.runtime, {
    contextIsolation: true,
    devTools: false,
    enabledFeatures: firstLaunch.runtime.enabledFeatures,
    isPackaged: false,
    isPersistent: false,
    nodeIntegration: false,
    preload: undefined,
    registeredPreloads: 0,
    remoteProxy: firstLaunch.runtime.remoteProxy,
    sandbox: true,
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
  await application.close();
  application = null;

  application = await launchInternalProductionBuild(userDataDirectory);
  assert.deepEqual(await readCalculatorState(application), {
    databases: [],
    expressions: ["y=x"],
    storedProbe: null,
  });
  await application.close();
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

  process.stdout.write(
    "Internal production-build isolation and external packaged launch policy passed; physical packaged UI acceptance remains gated.\n",
  );
} finally {
  if (application !== null) await application.close();
  if (networkSinks !== null) await networkSinks.close();
  await fs.rm(temporaryRoot, { force: true, recursive: true });
}
