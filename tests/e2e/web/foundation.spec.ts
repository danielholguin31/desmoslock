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
  await page.evaluate(() => {
    window.dispatchEvent(
      new PageTransitionEvent("pagehide", { persisted: true }),
    );
  });
  await expect(page.locator("[data-staff-auth-root]")).toBeHidden();
  await page.evaluate(() => {
    window.dispatchEvent(
      new PageTransitionEvent("pageshow", { persisted: true }),
    );
  });
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  await expect(page.locator("form")).toHaveCount(1);
  await expect(
    page.getByText(/sign up|create owner|link account|service.role|secret/i),
  ).toHaveCount(0);
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test("invitation callbacks stay inert until an explicit human confirmation", async ({
  page,
}) => {
  const consoleMessages: string[] = [];
  page.on("console", (message) => consoleMessages.push(message.text()));
  let releaseProvider: (() => void) | undefined;
  let markProviderStarted: (() => void) | undefined;
  const providerStarted = new Promise<void>((resolve) => {
    markProviderStarted = resolve;
  });
  let healthRequests = 0;
  const staticResourceRequests: Array<{
    readonly referer: string | undefined;
    readonly url: string;
  }> = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/functions/v1/health")) healthRequests += 1;
    if (
      request.resourceType() === "script" ||
      request.resourceType() === "stylesheet"
    ) {
      staticResourceRequests.push({
        referer: request.headers().referer,
        url: request.url(),
      });
    }
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
  await page.goto(`/?auth=invite#token_hash=${tokenHash}`);

  await expect(page).toHaveURL("http://127.0.0.1:43173/");
  await expect(
    page.getByRole("heading", { name: "Continue securely" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Continue securely" }),
  ).toBeVisible();
  expect(healthRequests).toBe(1);
  expect(staticResourceRequests.length).toBeGreaterThan(0);
  expect(staticResourceRequests.map(({ referer }) => referer)).toEqual(
    Array.from({ length: staticResourceRequests.length }, () => undefined),
  );
  expect(JSON.stringify(staticResourceRequests)).not.toContain(tokenHash);
  await expect(page.locator('meta[name="referrer"]')).toHaveAttribute(
    "content",
    "no-referrer",
  );
  expect(await page.content()).not.toContain(tokenHash);
  const browserState = await page.evaluate(() =>
    JSON.stringify({
      history: window.history.state,
      localStorage: { ...window.localStorage },
      sessionStorage: { ...window.sessionStorage },
    }),
  );
  expect(browserState).not.toContain(tokenHash);
  expect(JSON.stringify(consoleMessages)).not.toContain(tokenHash);

  await page.getByRole("button", { name: "Continue securely" }).click();
  await providerStarted;
  await expect(
    page.getByRole("heading", { name: "Checking invitation" }),
  ).toBeVisible();

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

test("reloading before invitation confirmation loses the bearer without consuming it", async ({
  page,
}) => {
  let authRequests = 0;
  await page.route("**/auth/v1/**", async (route) => {
    authRequests += 1;
    await route.abort();
  });
  const tokenHash = "c".repeat(56);

  await page.goto(`/?auth=invite#token_hash=${tokenHash}`);
  await expect(
    page.getByRole("heading", { name: "Continue securely" }),
  ).toBeVisible();
  await page.reload();

  await expect(page).toHaveURL("http://127.0.0.1:43173/");
  await expect(
    page.getByRole("heading", { name: "Reopen your email" }),
  ).toBeVisible();
  expect(authRequests).toBe(0);
  expect(await page.content()).not.toContain(tokenHash);
});

test("email verification round-trips the SDK-owned PKCE flow and scrubs before exchange", async ({
  page,
}) => {
  let resolveResend: ((url: string) => void) | undefined;
  const resendUrl = new Promise<string>((resolve) => {
    resolveResend = resolve;
  });
  let releaseExchange: (() => void) | undefined;
  let markExchangeStarted: (() => void) | undefined;
  const exchangeStarted = new Promise<void>((resolve) => {
    markExchangeStarted = resolve;
  });
  let exactPkceBody = false;
  let callbackNavigationStarted = false;
  let callbackAuthRequests = 0;
  let callbackUrlAtExchange: string | undefined;
  page.on("request", (request) => {
    if (callbackNavigationStarted && request.url().includes("/auth/v1/")) {
      callbackAuthRequests += 1;
    }
  });
  const authCorsHeaders = {
    "access-control-allow-headers":
      "apikey, authorization, content-type, x-client-info, x-supabase-api-version",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-origin": "http://127.0.0.1:43173",
    "access-control-expose-headers": "x-supabase-api-version",
  };

  await page.route("**/auth/v1/token**", async (route) => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ headers: authCorsHeaders, status: 204 });
      return;
    }
    const url = new URL(route.request().url());
    if (url.searchParams.get("grant_type") === "password") {
      await route.fulfill({
        body: JSON.stringify({
          code: "email_not_confirmed",
          message: "synthetic",
        }),
        contentType: "application/json",
        headers: {
          ...authCorsHeaders,
          "x-supabase-api-version": "2024-01-01",
        },
        status: 400,
      });
      return;
    }
    const body = route.request().postDataJSON() as Record<string, unknown>;
    exactPkceBody =
      Object.keys(body).sort().join(",") === "auth_code,code_verifier" &&
      body.auth_code === "synthetic-email-code" &&
      typeof body.code_verifier === "string" &&
      body.code_verifier.length >= 43;
    callbackUrlAtExchange = page.url();
    markExchangeStarted?.();
    await new Promise<void>((resolve) => {
      releaseExchange = resolve;
    });
    await route.fulfill({
      body: JSON.stringify({
        code: "flow_state_not_found",
        message: "synthetic",
      }),
      contentType: "application/json",
      headers: {
        ...authCorsHeaders,
        "x-supabase-api-version": "2024-01-01",
      },
      status: 404,
    });
  });
  await page.route("**/auth/v1/resend**", async (route) => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ headers: authCorsHeaders, status: 204 });
      return;
    }
    resolveResend?.(route.request().url());
    await route.fulfill({
      body: JSON.stringify({}),
      contentType: "application/json",
      headers: authCorsHeaders,
      status: 200,
    });
  });

  await page.goto("/");
  await page.getByLabel("Email").fill("teacher@example.test");
  await page.getByLabel("Password").fill("synthetic-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(
    page.getByRole("heading", { name: "Verify your email" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Resend verification email" }).click();
  await expect(
    page.getByRole("heading", { name: "Verification email sent" }),
  ).toBeVisible();
  const redirect = new URL(await resendUrl).searchParams.get("redirect_to");
  expect(redirect).not.toBeNull();
  const redirectUrl = new URL(redirect ?? "https://invalid.invalid");
  expect(redirectUrl.origin).toBe("http://127.0.0.1:43173");
  expect(redirectUrl.searchParams.get("auth")).toBe("email-verification");
  const flowId = redirectUrl.searchParams.get("sb_flow_id");
  expect(flowId).toMatch(/^[A-Za-z0-9_-]{8,64}$/u);

  callbackNavigationStarted = true;
  await page.goto(
    `/?auth=email-verification&sb_flow_id=${flowId ?? "missing"}&code=synthetic-email-code`,
  );
  await expect(page).toHaveURL("http://127.0.0.1:43173/");
  await expect(
    page.getByRole("heading", { name: "Continue securely" }),
  ).toBeVisible();
  expect(callbackAuthRequests).toBe(0);
  expect(exactPkceBody).toBe(false);
  expect(await page.content()).not.toContain("synthetic-email-code");
  const callbackBrowserState = await page.evaluate(() =>
    JSON.stringify({
      history: window.history.state,
      localStorage: { ...window.localStorage },
      sessionStorage: { ...window.sessionStorage },
    }),
  );
  expect(callbackBrowserState).not.toContain("synthetic-email-code");

  await page.getByRole("button", { name: "Continue securely" }).click();
  await exchangeStarted;
  expect(callbackUrlAtExchange).toBe("http://127.0.0.1:43173/");
  await expect(
    page.getByRole("heading", { name: "Checking verification link" }),
  ).toBeVisible();
  await expect(page.locator("[data-protected-school-data]")).toBeHidden();
  expect(exactPkceBody).toBe(true);
  releaseExchange?.();

  await expect(
    page.getByRole("heading", { name: "Authentication link unavailable" }),
  ).toBeVisible();
});

test("unsupported fragment credentials are synchronously scrubbed and never sent to Auth", async ({
  page,
}) => {
  const accessToken = "fragment-access-sentinel";
  const refreshToken = "fragment-refresh-sentinel";
  let authRequests = 0;
  await page.route("**/auth/v1/**", async (route) => {
    authRequests += 1;
    await route.abort();
  });

  await page.goto(
    `/#access_token=${accessToken}&refresh_token=${refreshToken}&type=recovery`,
  );

  await expect(page).toHaveURL("http://127.0.0.1:43173/");
  await expect(
    page.getByRole("heading", { name: "Continue securely" }),
  ).toBeVisible();
  expect(authRequests).toBe(0);
  await page.getByRole("button", { name: "Continue securely" }).click();
  await expect(
    page.getByRole("heading", { name: "Authentication link unavailable" }),
  ).toBeVisible();
  expect(authRequests).toBe(0);
  const content = await page.content();
  expect(content).not.toContain(accessToken);
  expect(content).not.toContain(refreshToken);
});

test("a failed address-bar scrub leaves the callback surface inert and offline", async ({
  page,
}) => {
  let applicationRequests = 0;
  let staticResourceRequests = 0;
  page.on("request", (request) => {
    if (
      request.url().includes("/auth/v1/") ||
      request.url().includes("/functions/v1/") ||
      request.url().includes("/rest/v1/")
    ) {
      applicationRequests += 1;
    }
    if (
      request.resourceType() === "script" ||
      request.resourceType() === "stylesheet"
    ) {
      staticResourceRequests += 1;
    }
  });
  await page.addInitScript(() => {
    window.history.replaceState = () => {
      throw new DOMException("synthetic history denial", "SecurityError");
    };
  });
  const tokenHash = "b".repeat(56);

  // The inline fail-closed path deliberately stops loading before the body or
  // application resources are parsed, so document load is not its boundary.
  await page.goto(`/?auth=invite#token_hash=${tokenHash}`, {
    waitUntil: "commit",
  });

  await expect(page.locator("html")).toHaveAttribute("hidden", "");
  await expect(page.locator("html")).toBeHidden();
  await expect(page.locator('script[src], link[rel="stylesheet"]')).toHaveCount(
    0,
  );
  expect(applicationRequests).toBe(0);
  expect(staticResourceRequests).toBe(0);
  expect(page.url()).toContain(tokenHash);
});
