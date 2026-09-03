import { defineConfig } from "@playwright/test";

export default defineConfig({
  forbidOnly: true,
  fullyParallel: false,
  reporter: "line",
  testDir: "tests/e2e/electron",
  timeout: 60_000,
  workers: 1,
  use: {
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node scripts/serve-backend-health-fixture.mjs 43175",
    reuseExistingServer: false,
    timeout: 30_000,
    url: "http://127.0.0.1:43175/functions/v1/health",
  },
});
