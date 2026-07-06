// Full-funnel load: N users each book a DISTINCT seat and pay for it.
// Purpose: drive real `UPDATE seats SET status='SOLD'` writes so the MVCC /
// autovacuum demo has dead tuples to show (a paid seat = one dead heap tuple).
//
// Run on the compose network:
//   docker run --rm --network ticket-booking_default -e API=http://api:8080 \
//     -v $PWD/k6:/k6 grafana/k6 run /k6/checkout.js
// Reset first (docker compose down -v && up) so all 200 demo seats are free.

import http from "k6/http";
import { Counter } from "k6/metrics";

const API = __ENV.API || "http://localhost:8080";
const EVENT_ID = "00000000-0000-0000-0000-000000000001";
const VUS = Number(__ENV.VUS) || 200; // one per demo seat

export const options = {
  scenarios: {
    checkout: {
      executor: "per-vu-iterations",
      vus: VUS,
      iterations: 1,
      maxDuration: "60s",
    },
  },
};

const paid = new Counter("checkout_paid");
const bookConflict = new Counter("checkout_book_conflict");
const payFail = new Counter("checkout_pay_fail");

// setup runs once: hand each VU a different seat so bookings mostly succeed.
export function setup() {
  const res = http.get(`${API}/api/events/${EVENT_ID}/seats`);
  const seatIds = res
    .json("seats")
    .filter((s) => s.status === "AVAILABLE")
    .map((s) => s.id);
  if (seatIds.length === 0) throw new Error("no seats — docker compose down -v && up");
  console.log(`>>> ${VUS} users checking out across ${seatIds.length} seats`);
  return { seatIds };
}

function authToken(vu) {
  const creds = JSON.stringify({ email: `co${vu}@load.dev`, password: "load-pass-123" });
  const h = { headers: { "Content-Type": "application/json" } };
  let r = http.post(`${API}/api/register`, creds, h);
  if (r.status !== 201) r = http.post(`${API}/api/login`, creds, h);
  return r.json("access_token");
}

export default function (data) {
  const seatId = data.seatIds[(__VU - 1) % data.seatIds.length];
  const token = authToken(__VU);

  const book = http.post(
    `${API}/api/bookings`,
    JSON.stringify({ event_id: EVENT_ID, seat_ids: [seatId] }),
    { headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` } }
  );
  if (book.status !== 201) {
    bookConflict.add(1); // someone else's VU mapped to the same seat (mod wrap)
    return;
  }

  const orderId = book.json("order_id");
  const pay = http.post(
    `${API}/api/orders/${orderId}/pay`,
    null,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        // One key per VU: a retry of this same VU is charged once (idempotent).
        "Idempotency-Key": `checkout-vu-${__VU}`,
      },
    }
  );
  if (pay.status === 200) paid.add(1);
  else payFail.add(1);
}

export function teardown() {
  console.log(">>> paid seats are now SOLD; check seats.n_dead_tup for MVCC bloat");
}
