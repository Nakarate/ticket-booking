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

test.describe("seat selection", () => {
  test("selecting a seat updates counter, total and enables booking", async ({ page }) => {
    await openApp(page);

    const seat = availableSeats(page).first();
    const priceTitle = await seat.getAttribute("title"); // "A1 · ฿1200"
    const price = Number(priceTitle.split("฿")[1].replace(/,/g, ""));
    await seat.click();

    await expect(page.getByText("เลือกแล้ว 1/4 ที่นั่ง")).toBeVisible();
    await expect(page.getByText(`฿${price.toLocaleString()}`)).toBeVisible();
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
});
