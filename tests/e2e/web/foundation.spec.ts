import { expect, test } from "@playwright/test";

test("v2 web artifact exposes only the internal foundation surface", async ({
  page,
}) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "DesmosLock" })).toBeVisible();
  await expect(page.locator("[data-v2-status]")).toHaveText(
    "Synthetic backend ready",
  );
  await expect(page.locator("[data-v2-status]")).toHaveAttribute(
    "data-backend-status",
    "ready",
  );
  await expect(page.locator("form")).toHaveCount(0);
  await expect(
    page.getByText(/quote|manual license|linux|local server/i),
  ).toHaveCount(0);
});
