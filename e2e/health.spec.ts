import { expect, test } from "@playwright/test";

test("the page is cross-origin isolated", async ({ page }) => {
  const response = await page.goto("/");

  expect(response?.headers()["cross-origin-opener-policy"]).toBe("same-origin");
  expect(response?.headers()["cross-origin-embedder-policy"]).toBe("credentialless");
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
});

test("the page shows the title and the API health turns ok", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Learn to DJ" })).toBeVisible();
  const health = page.getByRole("status", { name: "API health" });
  await expect(health).toHaveAttribute("data-status", "ok");
  await expect(health).toHaveText("API: ok");
});
