import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";
import { build } from "esbuild";

import { createAppBrowserDefine } from "../../scripts/build-app.mjs";

import { API_ORIGIN, check, code, rpc } from "./staff-auth-loopback.mjs";

const origin = "http://127.0.0.1:43175";
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

// The real production entrypoint, SDK and backend run unchanged. Only static
// assets are served by this helper. Bundle output and ephemeral configuration
// stay in memory; no storage-state file, trace, screenshot, HAR or video exists.
export async function runMembershipBrowserAcceptance({
  publishableKey,
  owner,
  actor,
  schoolId,
}) {
  let server;
  let browser;
  let stage = "production entrypoint startup";
  try {
    const built = await build({
      absWorkingDir: root,
      bundle: true,
      define: createAppBrowserDefine("web", {
        environment: "local",
        url: API_ORIGIN,
        origin,
        publishableKey,
      }),
      entryPoints: [path.join(root, "apps/web/src/main.ts")],
      format: "esm",
      logLevel: "silent",
      outfile: "main.js",
      platform: "browser",
      sourcemap: false,
      target: "chrome136",
      write: false,
    });
    check(built.outputFiles.length === 1, "Browser bundle shape changed");
    const assets = new Map([
      ["/main.js", ["text/javascript", built.outputFiles[0].contents]],
    ]);
    for (const [url, name, type] of [
      ["/", "index.html", "text/html"],
      ["/styles.css", "styles.css", "text/css"],
      ["/auth/staff-auth.css", "auth/staff-auth.css", "text/css"],
    ])
      assets.set(url, [
        type,
        await readFile(path.join(root, "apps/web/src", name)),
      ]);
    server = createServer((request, response) => {
      const asset = assets.get(request.url);
      if (request.method !== "GET" || !asset) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, {
        "content-type": asset[0],
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      });
      response.end(asset[1]);
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(43175, "127.0.0.1", resolve);
    });
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      serviceWorkers: "block",
      viewport: { width: 1440, height: 900 },
    });
    let unexpectedEgress = false;
    await context.route("**/*", async (route) => {
      const endpoint = new URL(route.request().url());
      if (endpoint.origin !== origin && endpoint.origin !== API_ORIGIN) {
        unexpectedEgress = true;
        await route.abort();
      } else {
        await route.continue();
      }
    });
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    let errors = 0;
    let navigations = 0;
    let observedTeacher = false;
    let observedInactive = false;
    page.on("pageerror", () => {
      errors += 1;
    });
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) navigations += 1;
    });
    page.on("response", async (response) => {
      if (
        new URL(response.url()).pathname !==
        "/rest/v1/rpc/current_staff_context"
      )
        return;
      try {
        const rows = await response.json();
        observedTeacher ||= rows.some(
          (row) => row.code === "ok" && row.membership_role === "teacher",
        );
        observedInactive ||= rows.some(
          (row) => row.code === "membership_inactive",
        );
      } catch {
        errors += 1;
      }
    });

    stage = "real password and authenticator sign-in";
    await page.goto(origin, { waitUntil: "networkidle" });
    await page.getByLabel("Email", { exact: true }).fill(actor.email);
    await page.getByLabel("Password", { exact: true }).fill(actor.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page
      .getByRole("heading", {
        name: "Verify Administrator access",
        exact: true,
      })
      .waitFor();
    await page
      .getByLabel("Authenticator code", { exact: true })
      .fill(await actor.factor.nextCode());
    await page.getByRole("button", { name: "Verify", exact: true }).click();
    await page
      .getByRole("heading", { name: "Administrator access", exact: true })
      .waitFor();
    check(
      await page
        .getByRole("button", { name: "Invite Teacher", exact: true })
        .isVisible(),
      "Real Administrator browser omitted Teacher management",
    );
    check(
      (await page
        .getByRole("button", { name: "Invite Administrator", exact: true })
        .count()) === 0,
      "Administrator browser exposed Owner-only invitations",
    );
    const documentStart = await page.evaluate(() => performance.timeOrigin);

    stage = "same-document backend downgrade";
    code(
      await rpc(owner, "change_membership_role", {
        workspace_id: schoolId,
        profile_id: actor.profileId,
        role: "teacher",
        expected_role_revision: 1,
      }),
      "membership_role_changed",
    );
    await page
      .getByRole("heading", { name: "Teacher access", exact: true })
      .waitFor();
    check(
      observedTeacher,
      "Browser did not observe the real backend role downgrade",
    );
    check(
      (await page
        .getByRole("button", { name: "Invite Teacher", exact: true })
        .count()) === 0,
      "Downgraded browser retained privileged management",
    );
    check(
      await page
        .getByText("Your School access changed.", { exact: false })
        .isVisible(),
      "Downgraded browser omitted its access-change notice",
    );

    stage = "same-document backend revocation";
    code(
      await rpc(owner, "revoke_membership", {
        workspace_id: schoolId,
        profile_id: actor.profileId,
        expected_role_revision: 2,
      }),
      "membership_revoked",
    );
    await page
      .getByRole("heading", { name: "School access inactive", exact: true })
      .waitFor();
    check(
      observedInactive,
      "Browser did not observe real backend Membership revocation",
    );
    check(
      (await page
        .getByRole("button", { name: "Invite Teacher", exact: true })
        .count()) === 0,
      "Revoked browser retained privileged management",
    );
    check(
      (await page.getByText(actor.email, { exact: false }).count()) === 0,
      "Revoked browser retained the protected staff identity",
    );
    check(
      await page.locator("[data-protected-school-data]").isHidden(),
      "Revoked browser exposed protected School content",
    );
    check(
      navigations === 1 &&
        (await page.evaluate(() => performance.timeOrigin)) === documentStart,
      "Membership freshness required a document reload",
    );
    check(
      !unexpectedEgress && errors === 0,
      "Real Membership browser encountered an unexpected request or script error",
    );
  } catch {
    // Playwright errors can contain fill values or page content. Expose only
    // this fixed stage, never the original exception or browser diagnostics.
    throw new Error(
      `Membership browser failed during ${stage}; details redacted`,
    );
  } finally {
    await browser?.close().catch(() => {});
    if (server?.listening)
      await new Promise((resolve) => server.close(resolve));
  }
}
