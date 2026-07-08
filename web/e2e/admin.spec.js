const { test, expect } = require("@playwright/test");

// Admin dashboard e2e: log in as the bootstrap admin, create a NEW production via
// the form (production dropdown + date + 24h time), add a second round with the
// "add round" button (production pre-selected), close a round through the confirm
// dialog, and confirm the customer sees the grouped production.

async function loginAdmin(page) {
  await page.goto("/");
  await page.getByTestId("auth-email").fill("admin@demo.local");
  await page.getByTestId("auth-password").fill("admin-demo-123456");
  await page.getByTestId("auth-submit").click(); // form defaults to login
  await page.getByTestId("admin-toggle").click(); // → admin dashboard
}

test.describe("admin dashboard", () => {
  test("create production, add a round, close-sale, customer sees the group", async ({ page }) => {
    const SERIES = `E2E Fest ${Date.now()}`;
    await loginAdmin(page);
    await expect(page.getByTestId("new-event-btn")).toBeVisible();

    // --- Create a brand-new production (round 1) ---
    await page.getByTestId("new-event-btn").click();
    await page.getByTestId("ev-production").selectOption("__new__");
    await page.getByTestId("ev-series").fill(SERIES);
    await page.getByTestId("ev-venue").fill("E2E Arena");
    await page.getByTestId("ev-name").fill("รอบ A");
    await page.getByTestId("ev-date").fill("2027-06-15");
    await page.getByTestId("ev-time").selectOption("20:00"); // 24h dropdown
    await page.getByTestId("ev-submit").click();

    const group = page.locator(".admin-group", { hasText: SERIES });
    await expect(group).toBeVisible();
    await expect(group.getByText("1 รอบ")).toBeVisible();

    // --- Add a second round via the "add round" button (production pre-joined) ---
    await group.getByRole("button", { name: /เพิ่มรอบ/ }).click();
    await page.getByTestId("ev-name").fill("รอบ B");
    await page.getByTestId("ev-date").fill("2027-06-16");
    await page.getByTestId("ev-submit").click();
    await expect(group.getByText("2 รอบ")).toBeVisible();

    // --- Customer view: both rounds on sale → one grouped card, "2 รอบ" ---
    await page.getByTestId("admin-toggle").click(); // to the shop
    const card = page.getByTestId("event-card").filter({ hasText: SERIES });
    await expect(card).toBeVisible();
    await expect(card.getByText("2 รอบ")).toBeVisible();

    // --- Back to admin: close the first round through the confirm dialog ---
    await page.getByTestId("admin-toggle").click(); // back to admin
    const firstRound = group.locator(".event-card").first();
    await firstRound.getByRole("button", { name: "ปิดขาย" }).click();
    await page.getByTestId("confirm-ok").click();
    await expect(firstRound.getByRole("button", { name: "เปิดขาย" })).toBeVisible();
  });
});
