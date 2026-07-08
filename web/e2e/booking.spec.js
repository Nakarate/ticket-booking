const { test, expect } = require("@playwright/test");
const { openApp, availableSeats, selectAvailableSeats } = require("./helpers");

const bookButton = (page) => page.getByRole("button", { name: /จองที่นั่ง/ });
const payButton = (page) => page.getByRole("button", { name: /ชำระเงิน/ });
const cancelButton = (page) => page.getByRole("button", { name: /ยกเลิก/ });

test.describe("seat map & auth", () => {
  test("registers, logs in and renders the seat map", async ({ page }) => {
    const email = await openApp(page);

    // The registered identity is shown in the header.
    await expect(page.getByText(email)).toBeVisible();
    // Selection counter starts empty; book button disabled with 0 seats.
    await expect(page.getByText("เลือกแล้ว 0/4 ที่นั่ง")).toBeVisible();
    await expect(bookButton(page)).toBeDisabled();
    // Demo event seeds 200 seats.
    expect(await page.getByTestId("seat").count()).toBeGreaterThan(0);
  });
});

test.describe("event listing", () => {
  test("landing shows event cards; pick opens booking; back returns", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("auth-toggle").click(); // form defaults to login; switch to register
    const email = `e2e-nav-${Date.now()}@test.dev`;
    await page.getByTestId("auth-email").fill(email);
    await page.getByTestId("auth-password").fill("e2e-password-123");
    await page.getByTestId("auth-submit").click();

    // Landing: at least one event card, no seat map yet.
    await expect(page.getByTestId("event-card").first()).toBeVisible();
    await expect(page.getByTestId("seat")).toHaveCount(0);

    // A single-show production opens the seat map directly.
    await page.getByTestId("event-card").filter({ hasText: "Live in Bangkok 2026" }).click();
    await expect(page.getByTestId("seat").first()).toBeVisible();

    // Back → landing again.
    await page.getByTestId("back-to-events").click();
    await expect(page.getByTestId("event-card").first()).toBeVisible();
    await expect(page.getByTestId("seat")).toHaveCount(0);
  });

  test("multi-show production opens a date picker; pick a show to book", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("auth-toggle").click(); // form defaults to login; switch to register
    await page.getByTestId("auth-email").fill(`e2e-prod-${Date.now()}@test.dev`);
    await page.getByTestId("auth-password").fill("e2e-password-123");
    await page.getByTestId("auth-submit").click();

    // Landing → open the multi-show production (groups 3 shows into one card).
    await page.getByTestId("event-card").filter({ hasText: "Bangkok EDM Festival 2026" }).click();

    // Show picker lists the rounds; no seat map yet.
    await expect(page.getByTestId("show-row")).toHaveCount(3);
    await expect(page.getByTestId("seat")).toHaveCount(0);

    // Pick a show → seat map.
    await page.getByTestId("show-row").first().click();
    await expect(page.getByTestId("seat").first()).toBeVisible();

    // Back → show picker; back again → landing.
    await page.getByTestId("back-to-events").click();
    await expect(page.getByTestId("show-row")).toHaveCount(3);
    await page.getByTestId("back-to-productions").click();
    await expect(page.getByTestId("event-card").first()).toBeVisible();
  });
});

test.describe("seat selection", () => {
  test("selecting a seat updates counter, total and enables booking", async ({ page }) => {
    await openApp(page);

    const seat = availableSeats(page).first();
    const priceTitle = await seat.getAttribute("title"); // "A1 · ฿1200"
    const price = Number(priceTitle.split("฿")[1].replace(/,/g, ""));
    await seat.click();

    await expect(page.getByText("เลือกแล้ว 1/4 ที่นั่ง")).toBeVisible();
    // scope to the action-bar total (the price guide also contains ฿ prices)
    await expect(page.locator(".actionbar__big")).toHaveText(`฿${price.toLocaleString()}`);
    await expect(bookButton(page)).toBeEnabled();
  });

  test("cannot select more than the 4-seat maximum", async ({ page }) => {
    await openApp(page);
    await selectAvailableSeats(page, 4);
    await expect(page.getByText("เลือกแล้ว 4/4 ที่นั่ง")).toBeVisible();

    // A 5th click must be ignored — still 4.
    await availableSeats(page).first().click();
    await expect(page.getByText("เลือกแล้ว 4/4 ที่นั่ง")).toBeVisible();
  });

  test("clicking a selected seat deselects it", async ({ page }) => {
    await openApp(page);
    const [seatNo] = await selectAvailableSeats(page, 1);
    await expect(page.getByText("เลือกแล้ว 1/4 ที่นั่ง")).toBeVisible();

    await page.locator(`[data-testid="seat"][data-seat-no="${seatNo}"]`).click();
    await expect(page.getByText("เลือกแล้ว 0/4 ที่นั่ง")).toBeVisible();
  });
});

test.describe("booking lifecycle", () => {
  test("book places a hold with a live countdown, cancel releases it", async ({ page }) => {
    await openApp(page);
    await selectAvailableSeats(page, 2);
    await bookButton(page).click();

    // Hold acquired: countdown (mm:ss) and pay/cancel actions appear.
    await expect(page.getByText("ถือที่นั่งไว้ให้คุณ — ชำระเงินภายใน")).toBeVisible();
    await expect(page.getByText(/^\d{2}:\d{2}$/)).toBeVisible();
    await expect(payButton(page)).toBeVisible();
    await expect(cancelButton(page)).toBeVisible();

    await cancelButton(page).click();
    await page.getByTestId("confirm-ok").click(); // confirm dialog
    await expect(page.getByText(/ยกเลิกแล้ว ที่นั่งถูกปล่อยคืน/)).toBeVisible();
    // Back to the selection state.
    await expect(page.getByText("เลือกแล้ว 0/4 ที่นั่ง")).toBeVisible();
    await expect(bookButton(page)).toBeDisabled();
  });

  test("book then pay completes and appears under my bookings as PAID", async ({ page }) => {
    await openApp(page);
    const picked = await selectAvailableSeats(page, 1);
    await bookButton(page).click();
    await expect(payButton(page)).toBeVisible();

    await payButton(page).click();
    await page.getByTestId("confirm-ok").click(); // confirm dialog
    await expect(page.getByText(/ชำระเงินสำเร็จ/)).toBeVisible();

    // "My bookings" now lists a PAID order containing the seat we bought.
    const bookings = page.locator("section", { hasText: "การจองของฉัน" });
    await expect(bookings.getByText("PAID").first()).toBeVisible();
    await expect(bookings.getByText(picked[0])).toBeVisible();

    // The seat is now SOLD in the map (no longer available).
    await expect(
      page.locator(`[data-testid="seat"][data-seat-no="${picked[0]}"]`)
    ).toHaveAttribute("data-status", "SOLD");
  });

  test("dismissing the confirm dialog does not pay", async ({ page }) => {
    await openApp(page);
    await selectAvailableSeats(page, 1);
    await bookButton(page).click();
    await expect(payButton(page)).toBeVisible();

    await payButton(page).click();
    await page.getByTestId("confirm-cancel").click(); // dismiss, don't pay

    await expect(page.getByTestId("confirm-ok")).toHaveCount(0); // dialog closed
    await expect(page.getByText(/ชำระเงินสำเร็จ/)).toHaveCount(0); // nothing paid
    await expect(payButton(page)).toBeVisible(); // still holding, can still pay
  });
});
