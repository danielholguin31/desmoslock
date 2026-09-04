import { expect, test } from "@playwright/test";

test("v2 web artifact mounts the production staff sign-in surface", async ({
  page,
}) => {
  const pageErrors: Error[] = [];
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await page.goto("/");

  await expect(page.getByLabel("DesmosLock")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Staff sign in" }),
  ).toBeVisible();
  await expect(page.locator("[data-v2-status]")).toHaveText(
    "Synthetic backend ready",
  );
  await expect(page.locator("[data-v2-status]")).toHaveAttribute(
    "data-backend-status",
    "ready",
  );
  await expect(page.getByLabel("Email")).toBeVisible();
  await expect(page.getByLabel("Password")).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  await expect(page.locator("form")).toHaveCount(1);
  await expect(
    page.getByText(/sign up|create owner|link account|service.role|secret/i),
  ).toHaveCount(0);
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test("invitation callbacks are scrubbed before provider completion, health, or auth rendering", async ({
  page,
}) => {
  let releaseProvider: (() => void) | undefined;
  let markProviderStarted: (() => void) | undefined;
  const providerStarted = new Promise<void>((resolve) => {
    markProviderStarted = resolve;
  });
  let healthRequests = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/functions/v1/health")) healthRequests += 1;
  });
  await page.route("**/auth/v1/verify", async (route) => {
    markProviderStarted?.();
    await new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    await route.fulfill({
      body: JSON.stringify({ code: "otp_expired", msg: "synthetic" }),
      contentType: "application/json",
      status: 400,
    });
  });

  const tokenHash = "a".repeat(56);
  await page.goto(`/?auth=invite&token_hash=${tokenHash}`);
  await providerStarted;

  await expect(page).toHaveURL("http://127.0.0.1:43173/");
  await expect(page.locator("[data-staff-auth-root]")).toBeHidden();
  expect(healthRequests).toBe(0);
  expect(await page.content()).not.toContain(tokenHash);

  releaseProvider?.();
  await expect(
    page.getByRole("heading", {
      name: "Authentication temporarily unavailable",
    }),
  ).toBeVisible();
  await expect(page.locator("[data-v2-status]")).toHaveAttribute(
    "data-backend-status",
    "ready",
  );
});
