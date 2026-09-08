import assert from "node:assert/strict";
import dgram from "node:dgram";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { packager } from "@electron/packager";
import { _electron as electron } from "@playwright/test";
import { build } from "esbuild";
import { statFile } from "@electron/asar";

import {
  hardenPackagedElectron,
  verifyPackagedElectronFuses,
} from "./electron-fuse-policy.mjs";
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
  ...(process.platform === "darwin" ? ["native/durable-record.node"] : []),
  "preload.cjs",
  "renderer.js",
  "styles.css",
];
const studentBridgeKeys = [
  "beginTargetedReadmission",
  "forfeitStudentSession",
  "joinTest",
  "onStudentSessionViewChanged",
  "readStudentSessionView",
  "refreshStudentSession",
  "requestAssessmentLock",
  "retryStudentSession",
  "version",
];

async function selectExistingElectronArchive(electronVersion) {
  assert.equal(
    electronVersion,
    "43.4.1",
    "Packaging requires the reviewed Electron version",
  );
  assert.ok(
    ["darwin", "linux", "win32"].includes(process.platform),
    "Packaging platform is unsupported",
  );
  assert.ok(
    ["arm64", "x64"].includes(process.arch),
    "Packaging architecture is unsupported",
  );
  const filename = `electron-v${electronVersion}-${process.platform}-${process.arch}.zip`;
  const checksums = JSON.parse(
    await fs.readFile(
      path.join(repositoryRoot, "node_modules/electron/checksums.json"),
      "utf8",
    ),
  );
  const expectedHash = checksums[filename];
  assert.match(
    expectedHash ?? "",
    /^[0-9a-f]{64}$/,
    "The installed Electron package must pin the exact archive checksum",
  );
  let directory = process.env.DESMOSLOCK_ELECTRON_ZIP_DIR;
  if (directory === undefined) {
    // Address one existing official cache entry, matching @electron/get's
    // Cache.getCacheDirectory and env-paths('electron', { suffix: '' }).
    // npm ci already populates this entry in CI; this verifier never downloads.
    const defaultCacheRoot =
      process.platform === "darwin"
        ? path.join(os.homedir(), "Library/Caches/electron")
        : process.platform === "win32"
          ? path.join(
              process.env.LOCALAPPDATA ||
                path.join(os.homedir(), "AppData/Local"),
              "electron/Cache",
            )
          : path.join(
              process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"),
              "electron",
            );
    const cacheRoot = process.env.electron_config_cache ?? defaultCacheRoot;
    assert.equal(
      path.isAbsolute(cacheRoot),
      true,
      "The selected Electron cache root must be absolute",
    );
    const releaseDirectory = `https://github.com/electron/electron/releases/download/v${electronVersion}`;
    directory = path.join(
      cacheRoot,
      createHash("sha256").update(releaseDirectory).digest("hex"),
    );
  }
  assert.equal(
    path.isAbsolute(directory),
    true,
    "The selected Electron ZIP directory must be absolute",
  );
  const archivePath = path.join(directory, filename);
  let status;
  try {
    status = await fs.lstat(archivePath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    throw new Error(
      `Required existing ${filename} is unavailable. Select its verified directory with DESMOSLOCK_ELECTRON_ZIP_DIR or retain npm ci's official Electron cache; this verifier will not download or search for it.`,
      { cause: error },
    );
  }
  assert.equal(
    status.isFile() && !status.isSymbolicLink(),
    true,
    "The selected Electron ZIP must be a regular archive file",
  );
  const hasher = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(archivePath)) {
    hasher.update(chunk);
    bytes += chunk.length;
  }
  const sha256 = hasher.digest("hex");
  assert.equal(
    bytes,
    status.size,
    "The selected Electron archive changed while being verified",
  );
  assert.equal(
    sha256,
    expectedHash,
    "The existing Electron archive does not match the installed package's checksum",
  );
  if (process.platform === "darwin" && process.arch === "arm64") {
    assert.equal(
      sha256,
      "fe3cac8cbfd9ba1739fac6c69166cf30848741f93cbe251d800ae6ef7cebb64b",
    );
    assert.equal(bytes, 122_238_952);
  }
  return { directory: await fs.realpath(directory), filename, sha256, bytes };
}

async function inspectNativeRecordArtifact(filename) {
  const status = await fs.lstat(filename);
  assert.equal(
    status.isSymbolicLink(),
    false,
    "Native artifact must be an owned regular file",
  );
  assert.equal(status.isFile(), true);
  const bytes = await fs.readFile(filename);
  assert.ok(
    bytes.length >= 32,
    "Native artifact must contain a Mach-O64 header",
  );
  assert.equal(
    bytes.readUInt32LE(0),
    0xfeedfacf,
    "Native artifact must be little-endian Mach-O64",
  );
  assert.ok(
    ["arm64", "x64"].includes(process.arch),
    "Native artifact architecture is unsupported",
  );
  assert.equal(
    bytes.readUInt32LE(4),
    process.arch === "arm64" ? 0x0100000c : 0x01000007,
    "Native artifact CPU must match the selected runtime",
  );
  assert.equal(
    bytes.readUInt32LE(12),
    8,
    "Native storage must be a Mach-O bundle",
  );
  return {
    path: "dist/native/durable-record.node",
    architecture: process.arch,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
  };
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

async function inspectProductionShell(application, expectedPhase) {
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
      studentView: await bridge?.readStudentSessionView(),
      manualLockControls:
        globalThis.document.querySelectorAll("[data-lock-intent]").length,
      protection: globalThis.document.querySelector(
        ".student-session__protection h3",
      )?.textContent,
      phase:
        globalThis.document.querySelector(".student-session")?.dataset.phase,
    };
  });
  assert.equal(shellBoundary.backendStatus, "ready");
  assert.deepEqual(shellBoundary.bridgeKeys, studentBridgeKeys);
  assert.equal(shellBoundary.bridgeVersion, "2.0.0");
  assert.deepEqual(shellBoundary.lockRequestResult, {
    ok: false,
    reason: "native-protection-unavailable",
  });
  assert.equal(shellBoundary.manualLockControls, 0);
  assert.equal(shellBoundary.protection, "Assessment protection unavailable");
  assert.equal(shellBoundary.phase, expectedPhase);
  assert.deepEqual(Object.keys(shellBoundary.studentView).sort(), [
    "calculatorEligible",
    "pendingOperation",
    "phase",
    "protection",
    "revision",
    "session",
  ]);
  assert.equal(shellBoundary.studentView.phase, expectedPhase);
  assert.equal(shellBoundary.studentView.protection, "unavailable");
  assert.equal(shellBoundary.studentView.calculatorEligible, false);
  assert.equal(shellBoundary.studentView.session, null);
  assert.equal(shellBoundary.studentView.pendingOperation, null);
  assert.ok(Number.isSafeInteger(shellBoundary.studentView.revision));
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
    electronVersion: "43.4.1",
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
    if (expectedPhase === "entry" || expectedPhase === "recovery_required") {
      const input = shell.locator("#student-session-code");
      await input.scrollIntoViewIfNeeded();
      assert.equal(await input.isVisible(), true);
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
        "The detached calculator must not occlude join or recovery",
      );
    }
  }
  if (expectedPhase === "unavailable") {
    await shell.locator('[data-action="open-recovery"]').click();
    assert.equal(
      await shell.locator("#student-session-code").isVisible(),
      true,
    );
    assert.equal(
      await shell.locator('label[for="student-session-code"]').textContent(),
      "Private re-admission code",
    );
    await shell.locator('[data-action="cancel-recovery"]').click();
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

const temporaryRoot = await fs.mkdtemp(
  path.join(os.tmpdir(), "desmoslock-production-verification-"),
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
  const electronArchive = await selectExistingElectronArchive(
    electronManifest.version,
  );
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
  assert.deepEqual(
    await listFiles(distributionRoot),
    expectedDistributionFiles,
    "Production build must contain only the reviewed runtime assets and no source maps",
  );
  const productionRuntimeText = (
    await Promise.all(
      expectedDistributionFiles.map((relativePath) =>
        relativePath === "native/durable-record.node"
          ? ""
          : fs.readFile(path.join(distributionRoot, relativePath), "utf8"),
      ),
    )
  ).join("\n");
  const nativeArtifact =
    process.platform === "darwin"
      ? await inspectNativeRecordArtifact(
          path.join(distributionRoot, "native/durable-record.node"),
        )
      : null;
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

  const packageDirectories = await packager({
    arch: process.arch,
    asar:
      process.platform === "darwin"
        ? { unpack: "dist/native/durable-record.node" }
        : true,
    dir: stagingRoot,
    electronVersion: electronManifest.version,
    electronZipDir: electronArchive.directory,
    executableName: packagedExecutableName,
    name: "DesmosLock Internal",
    osxSign: false,
    out: path.join(temporaryRoot, "package"),
    tmpdir: path.join(temporaryRoot, "packager-tmp"),
    overwrite: true,
    platform: process.platform,
    prune: false,
    quiet: true,
  });
  assert.equal(packageDirectories.length, 1);
  const packagedArtifact = await packagedExecutable(packageDirectories[0]);
  const resourcesDirectory =
    process.platform === "darwin"
      ? path.join(packagedArtifact.appBundle, "Contents/Resources")
      : path.join(packageDirectories[0], "resources");
  if (nativeArtifact !== null) {
    assert.equal(
      statFile(
        path.join(resourcesDirectory, "app.asar"),
        "dist/native/durable-record.node",
      ).unpacked,
      true,
    );
    assert.deepEqual(
      await listFiles(path.join(resourcesDirectory, "app.asar.unpacked")),
      ["dist/native/durable-record.node"],
    );
    assert.deepEqual(
      await inspectNativeRecordArtifact(
        path.join(
          resourcesDirectory,
          "app.asar.unpacked/dist/native/durable-record.node",
        ),
      ),
      nativeArtifact,
    );
  } else {
    assert.throws(() =>
      statFile(
        path.join(resourcesDirectory, "app.asar"),
        "dist/native/durable-record.node",
      ),
    );
  }
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

  // This actual-main gate uses the production OS-encryption adapter. Authoring
  // or running the synthetic fixture does not satisfy that separate gate.
  const userDataDirectory = path.join(temporaryRoot, "actual-main-user-data");
  application = await launchInternalProductionBuild(userDataDirectory);
  const productionShell = await inspectProductionShell(
    application,
    process.platform === "darwin" ? "entry" : "unavailable",
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
    electronVersion: "43.4.1",
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
    `${JSON.stringify({ nativeArtifact, electronArchive: { filename: electronArchive.filename, sha256: electronArchive.sha256, bytes: electronArchive.bytes }, actualMain: { entry: productionShell.shellBoundary.phase, recovery: productionRecovery?.shellBoundary.phase ?? null, calculatorEligible: false }, calculatorEvidence: "synthetic-isolation-fixture-only" })}\n`,
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
