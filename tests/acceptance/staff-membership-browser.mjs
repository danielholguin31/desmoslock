import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";
import { build } from "esbuild";
import { parseCreateSchoolTestRpcResult } from "@desmoslock/contracts";

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
// Optional testWorkspace supplies titlePrefix and same-School real-client
// updateTitleExternally(testId, title), openExternally(testId), and
// endExternally(testId) callbacks. They must read the current revision and
// verify each mutation; browser-created Test IDs remain only in memory.
export async function runMembershipBrowserAcceptance({
  publishableKey,
  owner,
  actor,
  schoolId,
  schoolSettings,
  testWorkspace,
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
      [
        "/test-workspace/test-workspace.css",
        "test-workspace/test-workspace.css",
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
    let observedTestStylesheet = false;
    const observedSchoolNames = new Set();
    page.on("pageerror", () => {
      errors += 1;
    });
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) navigations += 1;
    });
    page.on("response", async (response) => {
      if (
        new URL(response.url()).pathname ===
          "/test-workspace/test-workspace.css" &&
        response.status() === 200
      )
        observedTestStylesheet = true;
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
    const setStage = (nextStage) => {
      stage = nextStage;
    };
    const tests =
      testWorkspace === undefined
        ? null
        : await startTestWorkspace(page, testWorkspace, setStage);

    if (schoolSettings !== undefined) {
      await exerciseSchoolSettings(page, schoolSettings, setStage, async () => {
        if (tests !== null) {
          await page
            .locator("[data-test-workspace-root]")
            .getByText(`School: ${schoolSettings.localDisplayName}`, {
              exact: true,
            })
            .waitFor();
          await reviewBrowserTestEnd(page, tests, setStage);
        }
      });
      check(
        observedSchoolNames.has(schoolSettings.localDisplayName) &&
          observedSchoolNames.has(schoolSettings.externalDisplayName),
        "Browser did not observe both real backend School name revisions",
      );
    } else if (tests !== null) {
      await reviewBrowserTestEnd(page, tests, setStage);
    }
    if (tests !== null) {
      await finishTestWorkspace(page, tests, schoolSettings, setStage);
      check(
        observedTestStylesheet,
        "Production browser did not load its Test workspace stylesheet",
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
    if (tests !== null) {
      await page.locator('[data-test-workspace-status="ready"]').waitFor();
      check(
        (await page
          .locator("[data-test-workspace-root]")
          .getByLabel("New Test title", { exact: true })
          .inputValue()) === "" &&
          (await page
            .locator("[data-test-workspace-root]")
            .getByRole("button", { name: "Create Test", exact: true })
            .isEnabled()),
        "Role downgrade retained old Test intent or denied a fresh Teacher workspace",
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
    if (tests !== null) {
      check(
        (await page.locator("[data-test-workspace-heading]").count()) === 0 &&
          (await page
            .getByText(tests.remoteChangedTitle, { exact: true })
            .count()) === 0,
        "Revoked browser retained protected Test presentation",
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

async function exerciseSchoolSettings(
  page,
  settings,
  setStage,
  afterLocalSave,
) {
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
  await afterLocalSave?.();

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
    (await schoolSection
      .getByRole("button", { name: "Keep my draft", exact: true })
      .isVisible()) &&
      (await schoolSection
        .getByRole("button", { name: "Save", exact: true })
        .isHidden()),
    "Dirty School draft silently adopted the new revision without reconciliation",
  );
  await originalDraft?.dispose();
  await originalConfirmation?.dispose();

  // Restore the management form to check its retained private form state, then
  // reopen the same confirmation so the existing live downgrade must clear it.
  await authSection
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
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

async function createBrowserTest(page, title) {
  const section = page.locator("[data-test-workspace-root]");
  await page.locator('[data-test-workspace-status="ready"]').waitFor();
  await section.getByLabel("New Test title", { exact: true }).fill(title);
  const [response] = await Promise.all([
    page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          "/rest/v1/rpc/create_school_test" &&
        response.request().method() === "POST",
    ),
    section.getByRole("button", { name: "Create Test", exact: true }).click(),
  ]);
  const result = parseCreateSchoolTestRpcResult(await response.json());
  check(
    response.ok() && result?.ok && result.code === "test_created",
    "Browser creation did not return one real Test identity",
  );
  await section.getByText("Test created.", { exact: true }).waitFor();
  await section.getByRole("heading", { name: title, exact: true }).waitFor();
  return result.testId;
}

async function startTestWorkspace(page, settings, setStage) {
  check(
    typeof settings.titlePrefix === "string" &&
      settings.titlePrefix.length > 0 &&
      typeof settings.updateTitleExternally === "function" &&
      typeof settings.openExternally === "function" &&
      typeof settings.endExternally === "function",
    "Test browser callback contract is incomplete",
  );
  const tests = {
    settings,
    localTitle: `${settings.titlePrefix} local draft`,
    localSavedTitle: `${settings.titlePrefix} local saved`,
    localDirtyTitle: `${settings.titlePrefix} retained title`,
    remoteTitle: `${settings.titlePrefix} external draft`,
    remoteSavedTitle: `${settings.titlePrefix} external saved`,
    remoteChangedTitle: `${settings.titlePrefix} changed during end review`,
    remoteDirtyTitle: `${settings.titlePrefix} unsaved title`,
    createDraft: `${settings.titlePrefix} unsaved creation`,
    mutationRequests: 0,
  };
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      [
        "/rest/v1/rpc/create_school_test",
        "/rest/v1/rpc/update_test_title",
        "/rest/v1/rpc/open_test",
        "/rest/v1/rpc/end_test",
      ].includes(new URL(request.url()).pathname)
    )
      tests.mutationRequests += 1;
  });
  const section = page.locator("[data-test-workspace-root]");
  setStage("real browser Test creation, title save and opening");
  tests.localId = await createBrowserTest(page, tests.localTitle);
  const title = section.getByLabel("Test title", { exact: true });
  await title.fill(tests.localSavedTitle);
  await section
    .getByRole("button", { name: "Save title", exact: true })
    .click();
  await section
    .getByText("Saved the Test title change.", { exact: true })
    .waitFor();
  await section
    .getByRole("heading", { name: tests.localSavedTitle, exact: true })
    .waitFor();
  await section.getByRole("button", { name: "Open Test", exact: true }).click();
  await section.getByText("Opened the Test.", { exact: true }).waitFor();
  await title.fill(tests.localDirtyTitle);
  tests.originalTitle = await title.elementHandle();
  return tests;
}

async function reviewBrowserTestEnd(page, tests, setStage) {
  setStage("retained Test draft and fresh End review after School Save");
  const section = page.locator("[data-test-workspace-root]");
  check(
    tests.originalTitle !== null &&
      (await tests.originalTitle.evaluate(
        (input, title) => input.isConnected && input.value === title,
        tests.localDirtyTitle,
      )),
    "School Save remounted or discarded the dirty Test title",
  );
  await tests.originalTitle?.dispose();
  await section
    .getByRole("button", { name: "Save title", exact: true })
    .click();
  await section
    .getByText("Saved the Test title change.", { exact: true })
    .waitFor();
  await section.getByRole("button", { name: "End Test", exact: true }).click();
  await section
    .getByRole("heading", { name: "End this Test?", exact: true })
    .waitFor();
  tests.originalEnd = await section
    .getByRole("button", { name: "Confirm end", exact: true })
    .elementHandle();
}

async function finishTestWorkspace(page, tests, schoolSettings, setStage) {
  const section = page.locator("[data-test-workspace-root]");
  const detail = section.locator(".test-workspace__detail");
  const title = section.getByLabel("Test title", { exact: true });
  const school = page.locator("[data-school-settings-root]");
  const auth = page.locator("[data-auth-status]");
  const schoolName = school.getByLabel("School name", { exact: true });
  let originalSchool = null;
  let originalMembership = null;
  let schoolDraft = null;
  if (schoolSettings !== undefined) {
    await section
      .getByText(
        `End “${tests.localDirtyTitle}” at ${schoolSettings.externalDisplayName}?`,
        { exact: true },
      )
      .waitFor();
    originalSchool = await schoolName.elementHandle();
    schoolDraft = await schoolName.inputValue();
    originalMembership = await auth
      .getByRole("button", { name: "Revoke staff access", exact: true })
      .elementHandle();
  }
  async function checkSiblings() {
    if (schoolSettings === undefined) return;
    check(
      originalSchool !== null &&
        (await originalSchool.evaluate(
          (input, draft) => input.isConnected && input.value === draft,
          schoolDraft,
        )) &&
        (await school
          .locator('[data-school-settings-status="conflict"]')
          .count()) === 1 &&
        originalMembership !== null &&
        (await originalMembership.evaluate(
          (button) => button.isConnected && !button.disabled,
        )) &&
        (await auth.getAttribute("data-auth-status")) ===
          "confirming_staff_membership_revocation",
      "Test changes remounted or discarded a School draft or Membership confirmation",
    );
  }

  setStage("real browser Test ending with preserved sibling modules");
  await section
    .locator('[data-test-workspace-action="confirm_end"]:not(:disabled)')
    .waitFor();
  check(
    tests.originalEnd !== null &&
      (await tests.originalEnd.evaluate(
        (button) => button.isConnected && !button.disabled,
      )),
    "School rename replaced or cancelled the Test End confirmation",
  );
  await tests.originalEnd?.dispose();
  await section
    .getByRole("button", { name: "Confirm end", exact: true })
    .click();
  await section
    .getByText("Test ended. Participation is closed.", { exact: true })
    .waitFor();
  await detail
    .getByText("Participation is closed. This Test is read-only.", {
      exact: true,
    })
    .waitFor();
  check(
    (await title.isHidden()) &&
      (await section
        .getByRole("button", { name: "Open Test", exact: true })
        .count()) === 0 &&
      (await section
        .getByRole("button", { name: "End Test", exact: true })
        .count()) === 0,
    "Browser-ended Test retained title or lifecycle controls",
  );
  await checkSiblings();

  setStage("external Test title refresh with a dirty focused title");
  const remoteId = await createBrowserTest(page, tests.remoteTitle);
  check(remoteId !== tests.localId, "Separate browser creations reused a Test");
  const originalTitle = await title.elementHandle();
  await title.fill(tests.remoteDirtyTitle);
  await title.evaluate((input) => {
    input.focus();
    input.setSelectionRange(3, 10);
  });
  const mutationsBeforeExternal = tests.mutationRequests;
  await tests.settings.updateTitleExternally(remoteId, tests.remoteSavedTitle);
  await section
    .getByRole("heading", { name: tests.remoteSavedTitle, exact: true })
    .waitFor();
  await page.locator('[data-test-workspace-status="conflict"]').waitFor();
  check(
    originalTitle !== null &&
      (await originalTitle.evaluate(
        (input, draft) =>
          input.isConnected &&
          input.value === draft &&
          input.ownerDocument.activeElement === input &&
          input.selectionStart === 3 &&
          input.selectionEnd === 10,
        tests.remoteDirtyTitle,
      )) &&
      (await section
        .getByRole("button", { name: "Keep my draft", exact: true })
        .isEnabled()) &&
      (await section
        .getByRole("button", { name: "Save title", exact: true })
        .isDisabled()),
    "Passive Test title refresh lost the draft, focus, caret or explicit conflict",
  );
  await originalTitle?.dispose();
  await checkSiblings();
  await section
    .getByRole("button", { name: "Use current Test", exact: true })
    .click();
  await page.locator('[data-test-workspace-status="ready"]').waitFor();
  check(
    (await title.inputValue()) === tests.remoteSavedTitle,
    "Explicit Test reconciliation did not adopt the current title",
  );

  setStage("passive external Test opening with retained School focus");
  if (schoolSettings !== undefined)
    await schoolName.evaluate((input) => {
      input.focus();
      input.setSelectionRange(3, 10);
    });
  await tests.settings.openExternally(remoteId);
  await detail.getByText("Open", { exact: true }).waitFor();
  await section
    .locator('[data-test-workspace-action="review_end"]:not(:disabled)')
    .waitFor();
  if (schoolSettings !== undefined)
    check(
      await originalSchool.evaluate(
        (input) =>
          input.ownerDocument.activeElement === input &&
          input.selectionStart === 3 &&
          input.selectionEnd === 10,
      ),
      "Passive Test opening stole the sibling School input focus or caret",
    );
  await checkSiblings();

  setStage("external Test title change cancels the original End intent");
  await section.getByRole("button", { name: "End Test", exact: true }).click();
  await section
    .getByRole("heading", { name: "End this Test?", exact: true })
    .waitFor();
  await tests.settings.updateTitleExternally(
    remoteId,
    tests.remoteChangedTitle,
  );
  await section
    .getByRole("heading", { name: tests.remoteChangedTitle, exact: true })
    .waitFor();
  await page.locator('[data-test-workspace-status="conflict"]').waitFor();
  check(
    (await section
      .getByRole("button", { name: "Confirm end", exact: true })
      .count()) === 0 &&
      (await section
        .getByRole("button", { name: "Keep my draft", exact: true })
        .count()) === 0,
    "Changed Test retained an obsolete End confirmation or silently rebased it",
  );
  await section
    .getByRole("button", { name: "Use current Test", exact: true })
    .click();
  await section.getByRole("button", { name: "End Test", exact: true }).click();
  await section
    .getByRole("heading", { name: "End this Test?", exact: true })
    .waitFor();

  setStage("passive external Test ending invalidates fresh End review");
  await tests.settings.endExternally(remoteId);
  await detail.getByText("Ended", { exact: true }).waitFor();
  await page.locator('[data-test-workspace-status="conflict"]').waitFor();
  check(
    (await section
      .getByRole("button", { name: "Confirm end", exact: true })
      .count()) === 0 && (await title.isHidden()),
    "Externally ended Test retained an interactive title or End confirmation",
  );
  await section
    .getByRole("button", { name: "Use current Test", exact: true })
    .click();
  await page.locator('[data-test-workspace-status="ready"]').waitFor();
  await detail
    .getByText("Participation is closed. This Test is read-only.", {
      exact: true,
    })
    .waitFor();
  await checkSiblings();
  check(
    tests.mutationRequests === mutationsBeforeExternal &&
      mutationsBeforeExternal === 6,
    "Browser replayed a Test mutation or skipped the six explicit UI writes",
  );
  await section
    .getByLabel("New Test title", { exact: true })
    .fill(tests.createDraft);
  await originalSchool?.dispose();
  await originalMembership?.dispose();
}
