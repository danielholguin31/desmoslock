import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  forbidOnly: true,
  fullyParallel: true,
  reporter: "line",
  testDir: "tests/e2e/web",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://127.0.0.1:43173",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node scripts/serve-static.mjs apps/web/dist 43173",
    reuseExistingServer: false,
    timeout: 30_000,
    url: "http://127.0.0.1:43173",
  },
});
