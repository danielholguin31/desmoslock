#!/usr/bin/env node
/**
 * verify-desmoslock: drive the real DesmosLock v2 surfaces locally and capture
 * evidence. Local and synthetic only: every browser request that is not
 * loopback is aborted and recorded, Supabase Auth is stubbed with synthetic
 * values, and no .env file is read. Legacy top-level desktop/, server/ and
 * web/ are never run.
 *
 * Usage (from the repo root, Node 24.20.0 on PATH):
 *   node .agents/skills/verify-desmoslock/scripts/verify-desmoslock.mjs doctor
 *   node .agents/skills/verify-desmoslock/scripts/verify-desmoslock.mjs build
 *   node .agents/skills/verify-desmoslock/scripts/verify-desmoslock.mjs web
 *   node .agents/skills/verify-desmoslock/scripts/verify-desmoslock.mjs desktop
 *   node .agents/skills/verify-desmoslock/scripts/verify-desmoslock.mjs electron-suite
 *   node .agents/skills/verify-desmoslock/scripts/verify-desmoslock.mjs all
 *
 * Evidence: .verify-evidence/<run-id>/<surface>/ at the repo root (gitignored).
 */

/* global document -- only referenced inside page.evaluate / waitForFunction callbacks, which run in the renderer. */

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "../../../..");
const EVIDENCE_ROOT = path.join(REPO_ROOT, ".verify-evidence");

// Ports and synthetic public configuration mirror package.json `test:web`
// and `test:electron`. The publishable key is the repository's own synthetic
// placeholder from `test:web`, not a real project key.
const LOOPBACK = "127.0.0.1";
const WEB_PORT = 43173;
const WEB_HEALTH_PORT = 43174;
const DESKTOP_HEALTH_PORT = 43175;
const WEB_ORIGIN = `http://${LOOPBACK}:${WEB_PORT}`;
const WEB_BUILD_ENV = Object.freeze({
  DESMOSLOCK_PUBLIC_BACKEND_ENVIRONMENT: "local",
  DESMOSLOCK_PUBLIC_BACKEND_URL: `http://${LOOPBACK}:${WEB_HEALTH_PORT}`,
  DESMOSLOCK_PUBLIC_WEB_ORIGIN: WEB_ORIGIN,
  DESMOSLOCK_PUBLIC_SUPABASE_PUBLISHABLE_KEY:
    "sb_publishable_rrrrrrrrrrrrrrrrrrrrrr_cccccccc",
});
const DESKTOP_BUILD_ENV = Object.freeze({
  DESMOSLOCK_PUBLIC_BACKEND_ENVIRONMENT: "local",
  DESMOSLOCK_PUBLIC_BACKEND_URL: `http://${LOOPBACK}:${DESKTOP_HEALTH_PORT}`,
});
const SYNTHETIC_EMAIL = "teacher@example.test";
const SYNTHETIC_PASSWORD = "synthetic-password";
// Valid shape for parseStudentJoinCode (12 chars, no I/L/O/U); synthetic.
const SYNTHETIC_JOIN_CODE = "ABCDEFGHJKMN";

// ---- small utilities ----

function log(message) {
  process.stdout.write(`[verify] ${message}\n`);
}

/** True for loopback http(s) and for non-network schemes (data:, app schemes). */
function isLocal(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      return true;
    return parsed.hostname === LOOPBACK || parsed.hostname === "localhost";
  } catch {
    return false;
  }
}

function runCommand(command, args, env = {}) {
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    encoding: "utf8",
    stdio: "pipe",
  });
  return {
    code: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

function portIsFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, LOOPBACK, () => server.close(() => resolve(true)));
  });
}

async function waitForHttp(url, attempts = 100) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return true;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

/** Starts a repo fixture script; stop() kills only the pid this run started. */
function startOwned(script, args) {
  const child = spawn(process.execPath, [script, ...args], {
    cwd: REPO_ROOT,
    env: { PATH: process.env.PATH ?? "" },
    stdio: "ignore",
  });
  return {
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      await Promise.race([
        exited,
        new Promise((resolve) => setTimeout(resolve, 3_000)),
      ]);
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    },
  };
}

class Evidence {
  constructor(runId, surface) {
    this.dir = path.join(EVIDENCE_ROOT, runId, surface);
    this.steps = [];
  }
  async init() {
    await fs.mkdir(this.dir, { recursive: true });
  }
  async shot(page, name, note) {
    const file = path.join(this.dir, `${name}.png`);
    await page.screenshot({ path: file, fullPage: true });
    this.steps.push({ step: name, note, screenshot: path.basename(file) });
  }
  record(step, data) {
    this.steps.push({ step, ...data });
  }
  async write(name, content) {
    await fs.writeFile(
      path.join(this.dir, name),
      typeof content === "string" ? content : JSON.stringify(content, null, 2),
    );
  }
}

async function loadPlaywright() {
  try {
    return await import("@playwright/test");
  } catch (error) {
    throw new Error(
      `@playwright/test is not installed at the repo root (run npm ci): ${error.message}`,
      { cause: error },
    );
  }
}

// ---- doctor (read-only) ----

async function doctor() {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });

  add(
    "node 24.20.0",
    process.version === "v24.20.0",
    `running ${process.version}`,
  );
  const npm = runCommand("npm", ["--version"]);
  add("npm 11.x", npm.output.trim().startsWith("11."), npm.output.trim());
  add(
    "repo root",
    existsSync(path.join(REPO_ROOT, "apps/web/package.json")) &&
      existsSync(path.join(REPO_ROOT, "apps/desktop/package.json")),
    REPO_ROOT,
  );
  let playwright = null;
  try {
    playwright = await loadPlaywright();
    add("@playwright/test", true, "importable");
  } catch (error) {
    add("@playwright/test", false, error.message);
  }
  if (playwright) {
    const chromiumPath = playwright.chromium.executablePath();
    add("playwright chromium", existsSync(chromiumPath), chromiumPath);
  }
  const electronPathFile = path.join(
    REPO_ROOT,
    "node_modules/electron/path.txt",
  );
  add("electron devDependency", existsSync(electronPathFile), electronPathFile);
  add(
    "web dist built",
    existsSync(path.join(REPO_ROOT, "apps/web/dist/index.html")),
    "apps/web/dist/index.html (run `build` if missing)",
  );
  add(
    "desktop dist built",
    existsSync(path.join(REPO_ROOT, "apps/desktop/dist/main.js")),
    "apps/desktop/dist/main.js (run `build` if missing)",
  );
  add(
    "desktop native addons",
    ["durable-record.node", "aac-protection.node"].every((name) =>
      existsSync(path.join(REPO_ROOT, "apps/desktop/dist/native", name)),
    ),
    "apps/desktop/dist/native/{durable-record,aac-protection}.node",
  );
  add(
    "desktop native store platform",
    process.platform === "darwin",
    `platform=${process.platform}; the durable Student record store is macOS-only`,
  );
  for (const port of [WEB_PORT, WEB_HEALTH_PORT, DESKTOP_HEALTH_PORT]) {
    add(
      `port ${port} free`,
      await portIsFree(port),
      "in use means another instance is running; do not drive it",
    );
  }

  for (const check of checks)
    log(`${check.ok ? "ok  " : "FAIL"} ${check.name} — ${check.detail}`);
  return checks.every((check) => check.ok);
}

// ---- build ----

function build() {
  const steps = [
    ["packages", ["run", "build:packages"], {}],
    [
      "web (synthetic local config)",
      ["run", "build", "--workspace", "@desmoslock/web"],
      WEB_BUILD_ENV,
    ],
    [
      "desktop (synthetic local config)",
      ["run", "build", "--workspace", "@desmoslock/desktop"],
      DESKTOP_BUILD_ENV,
    ],
  ];
  for (const [label, args, env] of steps) {
    log(`building ${label}`);
    const result = runCommand("npm", args, env);
    if (result.code !== 0) {
      process.stderr.write(result.output);
      throw new Error(`build failed: ${label}`);
    }
  }
}

// ---- web network guard: loopback only, synthetic Auth stubs ----

async function installWebNetworkGuard(context) {
  const requests = [];
  const blocked = [];
  const authCors = {
    "access-control-allow-headers":
      "apikey, authorization, content-type, x-client-info, x-supabase-api-version",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-origin": WEB_ORIGIN,
    "access-control-expose-headers": "x-supabase-api-version",
  };
  const json = (route, status, body) =>
    route.fulfill({
      body: JSON.stringify(body),
      contentType: "application/json",
      headers: { ...authCors, "x-supabase-api-version": "2024-01-01" },
      status,
    });

  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = request.url();
    requests.push({ method: request.method(), url });
    if (!isLocal(url)) {
      blocked.push(url);
      await route.abort("blockedbyclient");
      return;
    }
    const parsed = new URL(url);
    if (!parsed.pathname.startsWith("/auth/v1/")) {
      // Static assets and the local health fixture only.
      await route.continue();
      return;
    }
    // Every Auth call is answered here; none is forwarded anywhere.
    if (request.method() === "OPTIONS") {
      await route.fulfill({ headers: authCors, status: 204 });
      return;
    }
    if (
      parsed.pathname === "/auth/v1/token" &&
      parsed.searchParams.get("grant_type") === "password"
    ) {
      await json(route, 400, {
        code: "email_not_confirmed",
        message: "synthetic",
      });
      return;
    }
    if (parsed.pathname === "/auth/v1/resend") {
      await json(route, 200, {});
      return;
    }
    if (parsed.pathname === "/auth/v1/verify") {
      await json(route, 400, { code: "otp_expired", msg: "synthetic" });
      return;
    }
    await json(route, 500, {
      code: "unexpected_failure",
      message: "unstubbed synthetic auth path",
    });
  });
  return { requests, blocked };
}

// ---- web surface ----

async function verifyWeb(runId) {
  if (!existsSync(path.join(REPO_ROOT, "apps/web/dist/index.html")))
    throw new Error("apps/web/dist missing: run the `build` subcommand first");
  for (const port of [WEB_PORT, WEB_HEALTH_PORT])
    if (!(await portIsFree(port)))
      throw new Error(
        `port ${port} is in use; refusing to drive an instance this run did not start`,
      );

  const evidence = new Evidence(runId, "web");
  await evidence.init();
  const staticServer = startOwned("scripts/serve-static.mjs", [
    "apps/web/dist",
    String(WEB_PORT),
  ]);
  const healthServer = startOwned("scripts/serve-backend-health-fixture.mjs", [
    String(WEB_HEALTH_PORT),
  ]);
  let browser;
  let currentPage = null;
  const guards = [];
  try {
    const { chromium } = await loadPlaywright();
    if (
      !(await waitForHttp(WEB_ORIGIN)) ||
      !(await waitForHttp(
        `http://${LOOPBACK}:${WEB_HEALTH_PORT}/functions/v1/health`,
      ))
    )
      throw new Error("local static server or health fixture did not start");

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    guards.push(await installWebNetworkGuard(context));
    const page = await context.newPage();
    currentPage = page;
    const consoleLines = [];
    page.on("console", (m) => consoleLines.push(`${m.type()}: ${m.text()}`));
    page.on("pageerror", (e) => consoleLines.push(`pageerror: ${e.message}`));

    // 1. Boot + backend health badge.
    await page.goto(WEB_ORIGIN);
    await page
      .locator('[data-v2-status][data-backend-status="ready"]')
      .waitFor({ timeout: 15_000 });
    const statusText = (
      await page.locator("[data-v2-status]").textContent()
    )?.trim();
    await page.getByRole("heading", { name: "Staff sign in" }).waitFor();
    await evidence.shot(page, "01-staff-sign-in", `status="${statusText}"`);

    // 2. Password sign-in -> unverified email -> resend.
    await page.getByLabel("Email").fill(SYNTHETIC_EMAIL);
    await page.getByLabel("Password").fill(SYNTHETIC_PASSWORD);
    await evidence.shot(page, "02-credentials-filled", "synthetic values");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page
      .getByRole("heading", { name: "Verify your email" })
      .waitFor({ timeout: 15_000 });
    await evidence.shot(page, "03-verify-your-email", "stubbed 400");
    await page
      .getByRole("button", { name: "Resend verification email" })
      .click();
    await page
      .getByRole("heading", { name: "Verification email sent" })
      .waitFor({ timeout: 15_000 });
    await evidence.shot(page, "04-verification-email-sent", "stubbed 200");

    await evidence.write("console.log", consoleLines.join("\n"));
    await context.close();

    // 3. Invitation callback (fresh context: no prior sign-in state) is
    //    scrubbed from the address bar and stays inert until confirmed.
    const inviteContext = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    guards.push(await installWebNetworkGuard(inviteContext));
    const invitePage = await inviteContext.newPage();
    const tokenHash = "a".repeat(56);
    await invitePage.goto(`${WEB_ORIGIN}/?auth=invite#token_hash=${tokenHash}`);
    await invitePage
      .getByRole("heading", { name: "Continue securely" })
      .waitFor({ timeout: 15_000 });
    const scrubbedUrl = invitePage.url();
    await evidence.shot(invitePage, "05-invite-callback-scrubbed", scrubbedUrl);
    if (scrubbedUrl !== `${WEB_ORIGIN}/`)
      throw new Error(`callback URL was not scrubbed: ${scrubbedUrl}`);
    if ((await invitePage.content()).includes(tokenHash))
      throw new Error("token hash still present in the DOM");
    await invitePage.getByRole("button", { name: "Continue securely" }).click();
    currentPage = invitePage;
    // With the versioned error header the SDK parses `otp_expired`, which
    // the staff auth view maps to "Invitation unavailable".
    const failedClosed = invitePage.getByRole("heading", {
      name: "Invitation unavailable",
    });
    await failedClosed.waitFor({ timeout: 15_000 });
    const terminalHeading = (await failedClosed.textContent())?.trim();
    await evidence.shot(
      invitePage,
      "06-invite-verify-failed-closed",
      `stubbed otp_expired -> "${terminalHeading}"`,
    );
    await inviteContext.close();

    const blocked = guards.flatMap((guard) => guard.blocked);
    if (blocked.length > 0)
      throw new Error(
        `non-loopback requests attempted (blocked): ${blocked.join(", ")}`,
      );
    evidence.record("result", { passed: true });
    return { ok: true, dir: evidence.dir };
  } catch (error) {
    if (currentPage !== null && !currentPage.isClosed()) {
      const headings = await currentPage
        .locator("h1, h2, h3, [role=status]")
        .allTextContents()
        .catch(() => []);
      evidence.record("failure-state", { url: currentPage.url(), headings });
      await evidence
        .shot(currentPage, "99-failure", "state at failure")
        .catch(() => undefined);
    }
    evidence.record("result", { passed: false, error: error.message });
    return { ok: false, dir: evidence.dir, error: error.message };
  } finally {
    await evidence.write("steps.json", evidence.steps);
    await evidence.write("network.json", {
      requests: guards.flatMap((guard) => guard.requests),
      blocked: guards.flatMap((guard) => guard.blocked),
    });
    await browser?.close();
    await staticServer.stop();
    await healthServer.stop();
  }
}

// ---- desktop surface: the real built Electron app ----

async function verifyDesktop(runId) {
  if (!existsSync(path.join(REPO_ROOT, "apps/desktop/dist/main.js")))
    throw new Error(
      "apps/desktop/dist missing: run the `build` subcommand first",
    );
  if (process.platform !== "darwin")
    throw new Error(
      `desktop drive is only proven on macOS; on ${process.platform} the native durable store is unsupported and the shell opens in recovery_required. Refusing to report a pass.`,
    );
  if (!(await portIsFree(DESKTOP_HEALTH_PORT)))
    throw new Error(
      `port ${DESKTOP_HEALTH_PORT} is in use; refusing to drive an instance this run did not start`,
    );

  const evidence = new Evidence(runId, "desktop");
  await evidence.init();
  const healthServer = startOwned("scripts/serve-backend-health-fixture.mjs", [
    String(DESKTOP_HEALTH_PORT),
  ]);
  const userDataDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "desmoslock-verify-desktop-"),
  );
  let application;
  let safety;
  try {
    const { _electron: electron } = await loadPlaywright();
    const { createElectronLaunchProfile } = await import(
      pathToFileURL(path.join(REPO_ROOT, "scripts/electron-launch-profile.mjs"))
        .href
    );
    safety = await import(
      pathToFileURL(
        path.join(REPO_ROOT, "scripts/production-desktop-resource-safety.mjs"),
      ).href
    );
    if (
      !(await waitForHttp(
        `http://${LOOPBACK}:${DESKTOP_HEALTH_PORT}/functions/v1/health`,
      ))
    )
      throw new Error("desktop health fixture did not start");

    // Same launch boundary as tests/e2e/electron/foundation.spec.ts: minimal
    // environment (HOME, TMPDIR) and an isolated, disposable user-data dir.
    const profile = createElectronLaunchProfile();
    application = await safety.acquireReadyElectronApplication({
      launch: () =>
        electron.launch({
          args: [
            ...profile.args,
            `--user-data-dir=${userDataDirectory}`,
            path.join(REPO_ROOT, "apps/desktop"),
          ],
          env: profile.env,
        }),
      ready: async (acquired) => {
        await safety.trackElectronApplicationForCooperativeCleanup(acquired);
        await acquired.firstWindow();
      },
    });
    const window = await application.firstWindow();
    const offLoopback = [];
    window.on("request", (request) => {
      if (!isLocal(request.url())) offLoopback.push(request.url());
    });

    await window
      .getByRole("heading", { exact: true, name: "DesmosLock" })
      .waitFor({ timeout: 20_000 });
    await window
      .locator('.student-session[data-phase="entry"]')
      .waitFor({ timeout: 20_000 });
    await evidence.shot(window, "01-student-entry", "Join a Test");

    const shell = await application.evaluate(({ BrowserWindow }) => {
      const [win] = BrowserWindow.getAllWindows();
      const prefs = win.webContents.getLastWebPreferences();
      return {
        url: win.webContents.getURL(),
        windowCount: BrowserWindow.getAllWindows().length,
        webPreferences: {
          contextIsolation: prefs.contextIsolation,
          nodeIntegration: prefs.nodeIntegration,
          sandbox: prefs.sandbox,
          webSecurity: prefs.webSecurity,
        },
      };
    });
    const bridge = await window.evaluate(async () => {
      const b = globalThis.desmoslockDesktop;
      return {
        keys: Object.keys(b ?? {}).sort(),
        version: b?.version,
        process: typeof globalThis.process,
        require: typeof globalThis.require,
        lockRequest: await b?.requestAssessmentLock(),
        view: await b?.readStudentSessionView(),
        malformedJoin: await b?.joinTest({ code: "not-a-code" }),
      };
    });
    await evidence.write("shell.json", shell);
    await evidence.write("bridge.json", bridge);
    if (shell.url !== "desmoslock-app://shell/index.html")
      throw new Error(`unexpected shell url ${shell.url}`);
    if (
      shell.webPreferences.contextIsolation !== true ||
      shell.webPreferences.nodeIntegration !== false ||
      shell.webPreferences.sandbox !== true
    )
      throw new Error(
        `shell web preferences not hardened: ${JSON.stringify(shell.webPreferences)}`,
      );
    if (bridge.process !== "undefined" || bridge.require !== "undefined")
      throw new Error("renderer can reach Node globals");
    if (bridge.lockRequest?.reason !== "native-protection-unavailable")
      throw new Error(
        `legacy lock bridge did not refuse: ${JSON.stringify(bridge.lockRequest)}`,
      );
    if (bridge.view?.admission.phase !== "entry")
      throw new Error(
        `fresh profile not in entry: ${bridge.view?.admission.phase}`,
      );
    if (bridge.malformedJoin !== null)
      throw new Error("bridge accepted a malformed join code");

    // Renderer rejects a malformed code before any IPC.
    await window.locator("#student-session-code").fill("bad");
    await window.locator('[data-action="submit-code"]').click();
    await window
      .getByText("Enter the exact 12-character code", { exact: false })
      .waitFor({ timeout: 10_000 });
    await evidence.shot(window, "02-malformed-code-rejected", "renderer");

    // A well-formed synthetic code travels the trusted IPC join path to the
    // loopback health fixture, which has no Student endpoints (404).
    await window.locator("#student-session-code").fill(SYNTHETIC_JOIN_CODE);
    await window.locator('[data-action="submit-code"]').click();
    await window.waitForFunction(
      () => {
        const phase = document.querySelector(".student-session")?.dataset.phase;
        const pending = document
          .querySelector(".student-session__feedback")
          ?.textContent?.includes("Submitting");
        return phase !== undefined && phase !== "joining" && !pending;
      },
      null,
      { timeout: 30_000 },
    );
    const afterJoin = await window.evaluate(async () => ({
      phase: document.querySelector(".student-session")?.dataset.phase,
      heading: document.querySelector("#student-session-heading")?.textContent,
      summary: document.querySelector(".student-session__summary")?.textContent,
      feedback: document.querySelector(".student-session__feedback")
        ?.textContent,
      view: await globalThis.desmoslockDesktop?.readStudentSessionView(),
    }));
    await evidence.write("join-attempt.json", afterJoin);
    await evidence.shot(
      window,
      "03-join-against-local-fixture",
      `phase=${afterJoin.phase}`,
    );
    if (afterJoin.view?.admission.phase === "active")
      throw new Error("fixture without Student endpoints produced admission");

    evidence.record("renderer-off-loopback-requests", { urls: offLoopback });
    if (offLoopback.length > 0)
      throw new Error(`renderer requested non-loopback: ${offLoopback}`);
    evidence.record("result", { passed: true });
    return { ok: true, dir: evidence.dir };
  } catch (error) {
    evidence.record("result", { passed: false, error: error.message });
    return { ok: false, dir: evidence.dir, error: error.message };
  } finally {
    await evidence.write("steps.json", evidence.steps);
    if (application && safety)
      await safety.closeElectronApplicationCooperatively(application);
    await healthServer.stop();
    await fs.rm(userDataDirectory, { force: true, recursive: true });
  }
}

// ---- the repo's own Electron Playwright suite ----

async function electronSuite(runId) {
  if (!(await portIsFree(DESKTOP_HEALTH_PORT)))
    throw new Error(
      `port ${DESKTOP_HEALTH_PORT} is in use; the suite starts its own fixture there`,
    );
  const evidence = new Evidence(runId, "electron-suite");
  await evidence.init();
  const result = runCommand("npx", [
    "playwright",
    "test",
    "--config",
    "playwright.electron.config.ts",
    "--output",
    path.join(evidence.dir, "test-results"),
  ]);
  await evidence.write("playwright.log", result.output);
  return result.code === 0
    ? { ok: true, dir: evidence.dir }
    : {
        ok: false,
        dir: evidence.dir,
        error: `playwright.electron.config.ts exited ${result.code}`,
      };
}

// ---- main ----

async function main() {
  const [command = "help"] = process.argv.slice(2);
  if (command === "doctor") process.exit((await doctor()) ? 0 : 1);
  if (command === "build") {
    build();
    return;
  }
  const surfaces = {
    web: verifyWeb,
    desktop: verifyDesktop,
    "electron-suite": electronSuite,
  };
  const selected =
    command === "all"
      ? ["web", "desktop", "electron-suite"]
      : Object.hasOwn(surfaces, command)
        ? [command]
        : null;
  if (selected === null) {
    process.stdout.write(
      "usage: verify-desmoslock.mjs <doctor|build|web|desktop|electron-suite|all>\n",
    );
    process.exit(command === "help" ? 0 : 2);
  }
  if (command === "all") build();
  const runId = `run-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  log(`run ${runId}`);
  const results = {};
  for (const surface of selected) {
    log(`driving ${surface}`);
    try {
      results[surface] = await surfaces[surface](runId);
    } catch (error) {
      results[surface] = { ok: false, error: error.message };
    }
    const r = results[surface];
    const where = r.dir ? ` (${path.relative(REPO_ROOT, r.dir)})` : "";
    log(`${surface}: ${r.ok ? "PASS" : `FAIL — ${r.error}`}${where}`);
  }
  await fs.mkdir(path.join(EVIDENCE_ROOT, runId), { recursive: true });
  await fs.writeFile(
    path.join(EVIDENCE_ROOT, runId, "summary.json"),
    JSON.stringify(results, null, 2),
  );
  process.exit(Object.values(results).every((r) => r.ok) ? 0 : 1);
}

main().catch((error) => {
  process.stderr.write(`[verify] fatal: ${error.stack ?? error}\n`);
  process.exit(1);
});
