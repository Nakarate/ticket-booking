const { expect } = require("@playwright/test");

/**
 * Register a fresh account and open the app, waiting until it is fully
 * interactive: the seat map has rendered at least one seat from the API.
 * Returns the email used so callers can assert on it.
 */
async function openApp(page) {
  await page.goto("/");
  const email = `e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.dev`;
  await page.getByTestId("auth-email").fill(email);
  await page.getByTestId("auth-password").fill("e2e-password-123");
  await page.getByTestId("auth-submit").click();
  await expect(page.getByRole("heading", { name: "Live in Bangkok 2026" })).toBeVisible();
  // Seat map is populated from GET /api/events/:id/seats (polled every 2s).
  await expect(page.getByTestId("seat").first()).toBeVisible();
  return email;
}

/**
 * Locator for seats the user can newly select: AVAILABLE on the server AND
 * not already selected. Selection does not change data-status, so filtering
 * on status alone would keep returning the same (already-selected) seat.
 */
function availableSeats(page) {
  return page.locator(
    '[data-testid="seat"][data-status="AVAILABLE"][data-selected="false"]'
  );
}

/**
 * Select `count` currently-available seats and return their seat numbers.
 * Picks seats fresh at click time so the suite is re-runnable without a DB
 * reset (each booked seat becomes SOLD and is skipped next run).
 */
async function selectAvailableSeats(page, count) {
  const picked = [];
  for (let i = 0; i < count; i++) {
    const seat = availableSeats(page).first();
    await expect(seat).toBeVisible();
    const seatNo = await seat.getAttribute("data-seat-no");
    await seat.click();
    // Wait for it to flip to selected before grabbing the next one.
    await expect(
      page.locator(`[data-testid="seat"][data-seat-no="${seatNo}"]`)
    ).toHaveAttribute("data-selected", "true");
    picked.push(seatNo);
  }
  return picked;
}

module.exports = { openApp, availableSeats, selectAvailableSeats };
