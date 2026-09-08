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
// Optional schoolSettings adds a UI Save and an external rename before the
// existing downgrade/revocation. Its renameExternally(displayName) callback
// must perform and verify a real same-School RPC using the caller-owned client.
export async function runMembershipBrowserAcceptance({
  publishableKey,
  owner,
  actor,
  schoolId,
  schoolSettings,
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
      [
        "/school-settings/school-settings.css",
        "school-settings/school-settings.css",
        "text/css",
      ],
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
    const observedSchoolNames = new Set();
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
        for (const row of rows) {
          if (
            row.code === "ok" &&
            row.school_id === schoolId &&
            typeof row.school_name === "string" &&
            Number.isSafeInteger(row.school_settings_revision) &&
            row.school_settings_revision >= 1
          )
            observedSchoolNames.add(row.school_name);
        }
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

    if (schoolSettings !== undefined) {
      await exerciseSchoolSettings(page, schoolSettings, (nextStage) => {
        stage = nextStage;
      });
      check(
        observedSchoolNames.has(schoolSettings.localDisplayName) &&
          observedSchoolNames.has(schoolSettings.externalDisplayName),
        "Browser did not observe both real backend School name revisions",
      );
    }

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
    if (schoolSettings !== undefined) {
      await page
        .getByText(`School name: ${schoolSettings.externalDisplayName}`, {
          exact: true,
        })
        .waitFor();
      check(
        (await page.getByLabel("School name", { exact: true }).count()) === 0 &&
          (await page
            .getByRole("button", { name: "Save", exact: true })
            .count()) === 0 &&
          (await page
            .getByRole("heading", {
              name: "Confirm staff access revocation",
              exact: true,
            })
            .count()) === 0,
        "Downgraded browser retained School editing or Membership confirmation",
      );
    }

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
    if (schoolSettings !== undefined) {
      check(
        (await page
          .getByRole("heading", { name: "School settings", exact: true })
          .count()) === 0 &&
          (await page
            .getByText(schoolSettings.externalDisplayName, { exact: false })
            .count()) === 0,
        "Revoked browser retained protected School settings presentation",
      );
    }
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

async function exerciseSchoolSettings(page, settings, setStage) {
  const {
    localDisplayName,
    externalDisplayName,
    confirmationTargetEmail,
    renameExternally,
  } = settings;
  let draft = "Unsaved browser School draft";
  const invitationDraft = "unsent-browser-staff@example.test";
  check(
    typeof localDisplayName === "string" &&
      typeof externalDisplayName === "string" &&
      localDisplayName !== externalDisplayName &&
      typeof confirmationTargetEmail === "string" &&
      typeof renameExternally === "function",
    "School browser callback contract is incomplete",
  );
  while (draft === localDisplayName || draft === externalDisplayName)
    draft += "!";
  const authSection = page.locator("[data-auth-status]");
  const schoolSection = page.locator("[data-school-settings-status]");
  const schoolName = page.getByLabel("School name", { exact: true });
  const staffEmail = page.getByLabel("Staff email", { exact: true });
  const memberSelect = page.locator('select[name="staff_membership"]');

  setStage("ordinary School Save through the production browser");
  await schoolName.waitFor();
  check(
    (await schoolName.inputValue()) !== localDisplayName,
    "Browser rename must change the current School name",
  );
  await staffEmail.fill(invitationDraft);
  const originalEmail = await staffEmail.elementHandle();
  await schoolName.fill(localDisplayName);

  // Hold only the outbound UI rename until pending is visible. The request is
  // then continued unchanged to the real provider; no RPC result is fabricated.
  const endpoint = `${API_ORIGIN}/rest/v1/rpc/update_school_display_name`;
  const release = Promise.withResolvers();
  let renameRequests = 0;
  const holdRename = async (route) => {
    renameRequests += 1;
    await release.promise;
    await route.continue();
  };
  await page.route(endpoint, holdRename);
  try {
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.locator('[data-school-settings-status="saving"]').waitFor();
    check(
      await page
        .getByRole("button", { name: "Saving…", exact: true })
        .isDisabled(),
      "Ordinary Save did not immediately show disabled pending controls",
    );
    check(
      (await authSection.getAttribute("data-auth-status")) ===
        "authenticated" &&
        (await page
          .getByRole("button", { name: "Use current name", exact: true })
          .isVisible()) === false,
      "Ordinary Save entered an authentication or reconciliation flow",
    );
    release.resolve();
    await page
      .getByText("Saved the School name change.", { exact: true })
      .waitFor();
    await page
      .getByText(`Current School name: ${localDisplayName}`, { exact: true })
      .waitFor();
    await authSection
      .getByText(`at ${localDisplayName} with step-up verification.`, {
        exact: false,
      })
      .waitFor();
    check(
      renameRequests === 1,
      "Ordinary Save did not issue exactly one School rename",
    );
  } finally {
    release.resolve();
    await page.unroute(endpoint, holdRename);
  }
  check(
    originalEmail !== null &&
      (await originalEmail.evaluate((input) => input.isConnected)) &&
      (await staffEmail.inputValue()) === invitationDraft,
    "Local School rename remounted or discarded the unrelated invitation draft",
  );
  await originalEmail?.dispose();

  const selectedTarget = await memberSelect.evaluate((select, email) => {
    const matches = Array.from(select.options).filter(
      (option) => option.textContent.split(" — ").at(-2) === email,
    );
    return matches.length === 1 ? matches[0].value : null;
  }, confirmationTargetEmail);
  check(
    selectedTarget !== null,
    "School browser could not select its exact Teacher target",
  );
  await memberSelect.selectOption(selectedTarget);
  await page
    .getByRole("button", {
      name: "Review staff access revocation",
      exact: true,
    })
    .click();
  await page
    .getByRole("heading", {
      name: "Confirm staff access revocation",
      exact: true,
    })
    .waitFor();

  setStage("external School rename with a pending Membership confirmation");
  await schoolName.fill(draft);
  await schoolName.evaluate((input) => {
    input.focus();
    input.setSelectionRange(3, 10);
  });
  const originalDraft = await schoolName.elementHandle();
  const originalConfirmation = await page
    .getByRole("button", { name: "Revoke staff access", exact: true })
    .elementHandle();
  await renameExternally(externalDisplayName);
  await page
    .getByText(`Current School name: ${externalDisplayName}`, { exact: true })
    .waitFor();
  await authSection
    .getByText(`(${confirmationTargetEmail}) at ${externalDisplayName}?`, {
      exact: false,
    })
    .waitFor();
  check(
    (await authSection.getAttribute("data-auth-status")) ===
      "confirming_staff_membership_revocation" &&
      originalConfirmation !== null &&
      (await originalConfirmation.evaluate(
        (button) => button.isConnected && !button.disabled,
      )),
    "School rename replaced or cancelled the pending Membership confirmation",
  );
  check(
    (await schoolSection.getAttribute("data-school-settings-status")) ===
      "conflict" &&
      originalDraft !== null &&
      (await originalDraft.evaluate(
        (input, expectedDraft) =>
          input.isConnected &&
          input.value === expectedDraft &&
          input.ownerDocument.activeElement === input &&
          input.selectionStart === 3 &&
          input.selectionEnd === 10,
        draft,
      )),
    "External School rename lost the dirty draft, focus, caret or revision conflict",
  );
  check(
    (await page
      .getByRole("button", { name: "Keep my draft", exact: true })
      .isVisible()) &&
      (await page
        .getByRole("button", { name: "Save", exact: true })
        .isHidden()),
    "Dirty School draft silently adopted the new revision without reconciliation",
  );
  await originalDraft?.dispose();
  await originalConfirmation?.dispose();

  // Restore the management form to check its retained private form state, then
  // reopen the same confirmation so the existing live downgrade must clear it.
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page
    .getByRole("heading", { name: "Administrator access", exact: true })
    .waitFor();
  check(
    (await staffEmail.inputValue()) === invitationDraft &&
      (await memberSelect.inputValue()) === selectedTarget,
    "School rename lost the retained invitation draft or Membership selection",
  );
  await page
    .getByRole("button", {
      name: "Review staff access revocation",
      exact: true,
    })
    .click();
  await page
    .getByRole("heading", {
      name: "Confirm staff access revocation",
      exact: true,
    })
    .waitFor();
}
