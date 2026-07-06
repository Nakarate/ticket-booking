// The wow moment: 1,000 users hit "book" on the SAME seat at once.
// Expected result: booking_success = 1, booking_conflict = 999, oversell = 0.
//
// Run (host networking so localhost:8080 resolves):
//   docker run --rm --network host -v $PWD/k6:/k6 grafana/k6 run /k6/race.js
// Or with k6 installed locally:
//   k6 run k6/race.js

import http from "k6/http";
import { Counter } from "k6/metrics";

const API = __ENV.API || "http://localhost:8080";
const EVENT_ID = "00000000-0000-0000-0000-000000000001";
const VUS = Number(__ENV.VUS) || 1000; // single source of truth for the log below

export const options = {
  scenarios: {
    race: {
      executor: "per-vu-iterations",
      vus: VUS,
      iterations: 1,
      maxDuration: "60s",
    },
  },
};

const success = new Counter("booking_success");
const conflict = new Counter("booking_conflict");
const failed = new Counter("booking_other_error");

// setup runs once: pick one AVAILABLE seat for everyone to fight over.
export function setup() {
  const res = http.get(`${API}/api/events/${EVENT_ID}/seats`);
  const seats = res.json("seats");
  const target = seats.find((s) => s.status === "AVAILABLE");
  if (!target) throw new Error("no available seat — re-run docker compose down -v && up");
  console.log(`>>> ${VUS} users will race for seat ${target.seat_no}`);
  return { seatId: target.id };
}

// authToken registers a fresh user (or logs in if it already exists from a
// previous run) and returns a short-lived access token.
function authToken(vu) {
  const creds = JSON.stringify({ email: `vu${vu}@race.dev`, password: "race-pass-123" });
  const h = { headers: { "Content-Type": "application/json" } };
  let r = http.post(`${API}/api/register`, creds, h);
  if (r.status !== 201) r = http.post(`${API}/api/login`, creds, h);
  return r.json("access_token");
}

export default function (data) {
  // Each VU is a distinct authenticated user.
  const token = authToken(__VU);

  const res = http.post(
    `${API}/api/bookings`,
    JSON.stringify({ event_id: EVENT_ID, seat_ids: [data.seatId] }),
    {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
    }
  );

  if (res.status === 201) success.add(1);
  else if (res.status === 409) conflict.add(1);
  else failed.add(1);
}

export function teardown() {
  console.log(">>> check the summary: booking_success MUST equal 1");
}
