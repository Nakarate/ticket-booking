// @ts-check
const { defineConfig, devices } = require("@playwright/test");

// E2E runs against the full docker-compose stack (web + api + postgres + redis).
// Bring it up first:  docker compose up --build -d
// The seat map, booking, payment and "my bookings" all hit the real API,
// so there is no mocking here — these are true end-to-end tests.
const BASE_URL = process.env.E2E_BASE_URL || "http://localhost:3000";

module.exports = defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false, // tests consume real seats from one shared event; keep them serial
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
});
