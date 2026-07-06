const { test, expect } = require("@playwright/test");

const heading = (page) => page.getByRole("heading", { name: "Live in Bangkok 2026" });

test.describe("authentication", () => {
  test("register → logout → log back in", async ({ page }) => {
    await page.goto("/");
    const email = `e2e-auth-${Date.now()}@test.dev`;
    const password = "e2e-password-123";

    // Register (default mode) → lands in the app.
    await page.getByTestId("auth-email").fill(email);
    await page.getByTestId("auth-password").fill(password);
    await page.getByTestId("auth-submit").click();
    await expect(heading(page)).toBeVisible();

    // Logout → back to the auth form.
    await page.getByTestId("logout-btn").click();
    await expect(page.getByTestId("auth-submit")).toBeVisible();
    await expect(heading(page)).toHaveCount(0);

    // Switch to login mode and sign in with the same credentials.
    await page.getByTestId("auth-toggle").click();
    await page.getByTestId("auth-email").fill(email);
    await page.getByTestId("auth-password").fill(password);
    await page.getByTestId("auth-submit").click();
    await expect(heading(page)).toBeVisible();
  });

  test("wrong password shows an error, does not log in", async ({ page }) => {
    await page.goto("/");
    const email = `e2e-bad-${Date.now()}@test.dev`;

    // Register first so the account exists.
    await page.getByTestId("auth-email").fill(email);
    await page.getByTestId("auth-password").fill("correct-password-1");
    await page.getByTestId("auth-submit").click();
    await expect(heading(page)).toBeVisible();
    await page.getByTestId("logout-btn").click();

    // Now try to log in with the wrong password.
    await page.getByTestId("auth-toggle").click();
    await page.getByTestId("auth-email").fill(email);
    await page.getByTestId("auth-password").fill("wrong-password-9");
    await page.getByTestId("auth-submit").click();

    await expect(page.getByTestId("auth-error")).toBeVisible();
    await expect(heading(page)).toHaveCount(0);
  });
});
