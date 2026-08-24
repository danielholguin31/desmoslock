import { defineConfig } from "@playwright/test";

export default defineConfig({
  forbidOnly: true,
  fullyParallel: false,
  reporter: "line",
  testDir: "tests/e2e/electron",
  timeout: 60_000,
  use: {
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
