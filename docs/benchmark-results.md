# Benchmark & Demo Results

Captured 2026-07-06 on the docker-compose stack (Postgres 16, Redis 7, Go API),
fresh `docker compose down -v && up` seed (event `…001` = 200 seats, event `…002`
= 1,000,000 seats / 10,000 AVAILABLE). Numbers are for the slide deck — reproduce
with the commands in [CLAUDE.md](../CLAUDE.md).

---

## 1. k6 race — oversell under 1,000 concurrent users

`k6/race.js`: 1,000 VUs each log in and POST the **same** seat once.

| Metric | Value |
|---|---|
| `booking_success` | **1** |
| `booking_conflict` (409) | **999** |
| `booking_other_error` | 0 |
| Wall clock | ~0.7 s |
| `http_reqs` | 2,001 (1,000 login + 1,000 book + 1 setup) |
| `http_req_duration` avg / p95 / max | 140 ms / 226 ms / 297 ms |

**DB proof (source of truth, not just the app's word):**

```
seat_no | order_items
--------+------------
 A1     |          1     ← exactly one winner, oversell = 0
```

The Redis atomic hold shed 999 racers in ~1 ms each; the Postgres
`UNIQUE(order_items.seat_id)` guard stands behind it. Verified by
`api/booking_test.go::TestNoOversellUnderRace` (200 goroutines) as well.

> **Latency caveat.** The duration numbers above are a **best case**: a fresh
> `down -v && up` seed where every VU's `register` succeeds with a single bcrypt
> hash. On a re-run (users already exist) each VU does `register` → 409 → `login`,
> doubling the bcrypt work; with 1,000 VUs hitting bcrypt (cost 10) simultaneously
> on a CPU-limited host the tail balloons to **avg ~1.4 s / p95 ~4 s**. The
> `booking_success = 1` invariant is unaffected — the extra latency is auth
> (bcrypt), not the booking path. Reset between capture runs for comparable numbers.

---

## 2. EXPLAIN ANALYZE — partial *covering* index on the 1M-row event

Query: `SELECT id, seat_no, price FROM seats WHERE event_id = '…002' AND status = 'AVAILABLE'`
(10,000 of 1,000,000 rows AVAILABLE). Index is now
`idx_seats_available ON seats(event_id) INCLUDE (id, seat_no, price) WHERE status='AVAILABLE'`.

| Scenario | Plan | Execution time |
|---|---|---|
| No index, warm (steady of 3) | Parallel Seq Scan (2 workers) | ~34 ms |
| Covering index, warm 1st run | Index Only Scan, **Heap Fetches: 0** | 5.9 ms |
| Covering index, warm steady | Index Only Scan, **Heap Fetches: 0** | **~1.3 ms** → **~26× faster** |

**Two things had to be true to get here — both matter for the slide:**
1. **Covering the query** (`INCLUDE id, seat_no, price`) turns it into an
   *Index Only Scan* — no heap fetches. The earlier plain `(event_id)` partial
   index needed 10,000 scattered heap fetches, which capped the win at ~4× warm
   and actually **lost to the seq scan on a cold cache** (228 ms vs 175 ms).
2. **`VACUUM` first.** After a bulk seed the visibility map isn't all-visible, so
   even the covering index does heap fetches until the table is vacuumed. Post-VACUUM
   → `Heap Fetches: 0`.

Honest speedup for this 10k-row result is **~26×** (1.3 ms vs 34 ms), not the
README's original "~100×". It **approaches/exceeds 100× as the event nears
sell-out** — fewer AVAILABLE rows means the index-only scan returns in sub-ms while
the parallel seq scan stays flat at ~34 ms (it must read all 1M rows regardless).
The operational win is also about **not burning 2 CPU cores on a full scan every
time the seat map is polled** under flash-sale load.

---

## 3. MVCC / autovacuum tuning — driven by real payments

`k6/checkout.js`: 200 users each book a distinct seat **and pay** → 200 real
`UPDATE seats SET status='SOLD'` writes (checkout_paid = 200/200).

| `seats` | baseline (fresh seed) | after 200 book+pay | after `VACUUM seats` |
|---|---|---|---|
| `n_dead_tup` | 0 | **200** | **0** |

Also observed: `orders.n_dead_tup = 200` (each order INSERTed PENDING then UPDATEd
to PAID = one dead tuple), while `order_items` / `payments` stay at 0 (insert-only).

```
seats reloptions: {autovacuum_vacuum_scale_factor=0.01, fillfactor=85}
```

Talking point: every seat UPDATE leaves a dead tuple (MVCC). The tuned
`autovacuum_vacuum_scale_factor = 0.01` triggers reclamation at **1%** of the
table (~10k dead on a 1M-row table) instead of the 20% default — critical for a
write-heavy flash-sale table. A manual `VACUUM seats` reclaims immediately and
resets the counter to 0 (shown above). `fillfactor = 85` leaves room for HOT
updates to reduce index churn.
