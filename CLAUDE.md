# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> 🗺️ **Jump to a module without scanning:** [docs/architecture.md](docs/architecture.md) is the
> module map — per-file responsibilities, key symbols with line numbers, the route→handler
> table, and a "change X → go here" index. Start there to locate code; this file explains *why*.

## What this is

A flash-sale ticket booking MVP (reserved seating) whose one hard invariant is **oversell = 0** under high concurrent load. It is a demo/interview artifact, not production — some simplifications (mock payment gateway, in-memory rate limiter) are deliberate and annotated in the code with what production would do instead. Auth is real: password + bcrypt with short access JWT + refresh tokens (see `auth.go`).

Stack: Next.js 14 (web) · Go 1.22 stdlib (api) · PostgreSQL 16 · Redis 7 · k6 (load tests). There is **no root package manager**; the four services (`api/`, `web/`, `db/`, `k6/`) are wired together by `docker-compose.yml`.

## Commands

```bash
# Run the whole stack (Postgres auto-seeds on first boot)
docker compose up --build
#   web  http://localhost:3000   |   api  http://localhost:8080/healthz

# Full reset (drops the pgdata volume — required between load-test runs,
# else seats stay HELD/SOLD from the previous round)
docker compose down -v && docker compose up --build

# API tests (needs Postgres + Redis reachable; auto-skips if not)
cd api && go test -v ./...
cd api && go test -v -run TestNoOversellUnderRace   # the core oversell test

# If host port 5432 is taken by a native Postgres (tests then "skip" with an
# auth error), run them INSIDE the compose network against the container:
docker run --rm --network ticket-booking_default \
  -v "$PWD/api":/src -w /src \
  -e DATABASE_URL="postgres://ticket:ticket@postgres:5432/ticket?sslmode=disable" \
  -e REDIS_ADDR="redis:6379" \
  golang:1.22 go test -v ./...

# Web
cd web && npm install && npm run dev   # or: build / start

# Web E2E (Playwright) — needs the full stack up (docker compose up -d)
cd web && npm run test:e2e             # headless; runs against http://localhost:3000
cd web && npm run test:e2e:ui          # interactive UI mode
cd web && npx playwright test e2e/booking.spec.js -g "book then pay"   # single test

# Load test — 1,000 VUs fight over one seat (expect success=1, conflict=999)
docker run --rm --network host -v $PWD/k6:/k6 grafana/k6 run /k6/race.js
# Mac/Windows (no --network host):
docker run --rm -e API=http://host.docker.internal:8080 -v $PWD/k6:/k6 grafana/k6 run /k6/race.js
```

`go.sum` is gitignored; `go test`/`go build` regenerate it. Run `go` commands from inside `api/` (that is where `go.mod` lives).

## Architecture: the two-layer oversell guard

This is the whole point of the codebase. A booking must pass through **both** layers, and either one alone prevents oversell — the second exists so the system stays correct even if Redis fails.

1. **Layer 1 — Redis atomic hold** (`holdScript` in `api/handlers.go`). A Lua script holds all N requested seats or none (`EXISTS` check then `SET … EX`, single-threaded so it is atomic). Absorbs the thundering herd: the winner proceeds, everyone else gets `409` in ~1ms after only a single cheap indexed sale-gate read — the losers never reach the booking transaction or the per-user hold-cap join (both are winner-only, after the hold). Holds auto-expire via TTL (`HOLD_TTL_SECONDS`, default 600).

2. **Layer 2 — Postgres = source of truth.** The `UNIQUE INDEX idx_one_seat_one_order ON order_items(seat_id)` (`db/001_init.sql`) is the final guard — one seat can belong to exactly one live order, enforced by the DB regardless of what Redis did. Payment then does an **optimistic confirm**: `UPDATE seats … WHERE status='AVAILABLE'` and checks the affected row count equals the seat count; any mismatch means someone raced us and the transaction rolls back.

If Redis is down, `listSeats` still renders from DB truth and `createBooking` returns `503` — the system degrades to "can't book" but **never** oversells.

### Invariants to preserve when editing booking code

- **Deadlock avoidance**: any path touching multiple seats must `sort.Strings(seat_ids)` before locking. Locking seats in a consistent order is what stops two overlapping orders from deadlocking.
- **Idempotency**: `payOrder` is keyed on the `Idempotency-Key` header (unique in the `payments` table). A replay returns the original outcome and charges once — preserve this contract for any write endpoint.
- **Server-side sale gate**: `createBooking` checks `events.sale_opens_at`/`status` server-side. The frontend countdown is UX only, never a security boundary.
- **Seat release**: seats are freed by **deleting `order_items` rows** (which releases the unique guard), done by the expiry worker, cancel, and expiry paths — not by flipping a status column. `seats.status` is only `AVAILABLE`/`SOLD`.

These invariants are covered by the Go integration tests: `api/booking_test.go` (the oversell race) and `api/booking_edge_test.go` (multi-seat all-or-nothing, sale gate, seat-count limits, payment idempotency, pay-after-expiry, the expiry worker via the extracted `expireOverdueOrders`, and cancel/paid-order rules). Both connect to real Postgres+Redis and skip when unreachable; keep them passing when touching booking logic.

## Service layout

- **`api/`** — Go stdlib only, no web framework. `main.go` = bootstrap (env config, pgx pool, Redis client, Go 1.22 `http.ServeMux` with `"POST /api/..."` method+pattern routes, middleware chain `cors → logRequests → rateLimit`, graceful shutdown) plus the `expiryWorker` goroutine that flips overdue `PENDING` orders to `EXPIRED` every 30s, and the `attemptWriter` goroutine that batch-writes the booking demand log off the hot path. `auth.go` = register/login/refresh/logout (bcrypt password hash, short-lived access JWT + opaque refresh token in Redis, rotated on refresh, revoked on logout) plus the `auth()` access-token middleware. `handlers.go` = booking/seat/payment endpoints plus the public `GET /api/events` (returns each on-sale show with its `series_id`/`series_name`/`venue` + availability/price so the web can group shows into productions). `admin.go` = admin content management (`GET/POST /api/admin/events`, `PATCH /api/admin/events/{id}`): create an event/round and its seat map, open/close the sale, set the per-order cap (`events.max_seats_per_order`), and read live sales stats — all behind `adminAuth` (an `is_admin` DB check). **Ticketmaster-style grouping**: shows share a `series_id` to form one production; `createAdminEvent` joins an existing production by `series_id` (exact, no name matching) or starts a new one by `series_name`. The bootstrap admin is upserted from `ADMIN_EMAIL`/`ADMIN_PASSWORD` (`ensureAdmin`), **retried in the background** at boot (a fresh `down -v && up` seeds 1M rows before Postgres accepts connections, so a single attempt could miss it and leave no admin). `analytics.go` = booking-attempt demand log (buffered channel + background batch writer): who wanted which seats and the outcome, incl. the race losers who never create an order — written off the hot path so losers still shed at Redis in ~1ms. `ratelimit.go` = **Redis** Lua token-bucket limiter (shared across instances): a general per-IP limit (`RATE_RPS`/`RATE_BURST`) plus a stricter per-IP limit on `/api/login` + `/api/register` (`AUTH_RATE_RPS`/`AUTH_RATE_BURST`); fails open on Redis error; skips `/healthz` + `/readyz`.
- **`web/`** — Next.js 14 App Router, **plain JSX (no TypeScript)**. The whole UI is one client component, `app/page.jsx`, with a 3-level customer flow: a landing of **production cards** (shows sharing a `series_id` group into one card) → a **date/round picker** for multi-show productions (single-show goes straight through) → the **seat map** + hold countdown + mock payment. Admins get a grouped dashboard (rounds nested per production, "add round" button) and a create form (production dropdown + date + 24h time). Money/destructive actions (pay/cancel/logout/close-sale) route through a confirm dialog. Talks to the API via `NEXT_PUBLIC_API`. Seat `<div>`s carry `data-testid="seat"` + `data-seat-no` / `data-status` / `data-selected`; other testids (`event-card`, `show-row`, `confirm-ok`, `auth-*`, `ev-*`) back the e2e tests and must stay in sync.
- **`web/e2e/`** — Playwright E2E tests (`booking.spec.js`, `helpers.js`) covering login, seat selection (incl. the 4-seat max and deselect), and the book → hold-countdown → cancel and book → pay → PAID-in-my-bookings flows. They run against the **live docker stack** (no mocking) and are written to be re-runnable without a DB reset: helpers pick fresh `AVAILABLE`+unselected seats each run, since paid seats become permanently `SOLD`. If seats run low after many runs, reset with `docker compose down -v && docker compose up --build`.
- **`db/`** — `001_init.sql` (schema, indexes, and autovacuum/fillfactor tuning on the UPDATE-heavy `seats` table; `events` has `series_id`/`series_name`/`venue` for production grouping) and `002_seed.sql` (a standalone `Live in Bangkok 2026` + a 3-show `Bangkok EDM Festival 2026` production + the 1M-row internal benchmark event) run automatically as Postgres docker-entrypoint init scripts. `demo_explain.sql` is a manual EXPLAIN-ANALYZE walkthrough (seq scan vs partial index on a 1M-row event) — not part of normal runtime.
- **`k6/`** — `race.js` (1,000 VUs fight over one seat → oversell test) and `checkout.js` (N users each book+pay a distinct seat → drives seat UPDATEs for the MVCC bloat demo). Run on the compose network with `-e API=http://api:8080`.
- **`docs/benchmark-results.md`** — captured k6 + EXPLAIN (index-only scan) + MVCC numbers for the demo/slides; regenerate from the commands there after a `down -v && up` reset.

Every index and every DB tuning choice in `001_init.sql` is commented with why it exists; read those comments before changing the schema.

## Config

All via env (see `docker-compose.yml` for the wired defaults): `DATABASE_URL`, `REDIS_ADDR`, `JWT_SECRET`, `APP_ENV`, `HOLD_TTL_SECONDS`, `ACCESS_TTL_SECONDS` (access JWT, default 900), `REFRESH_TTL_SECONDS` (refresh token, default 604800), `MAX_HELD_SEATS_PER_USER` (per-user anti-hoarding cap, default 8), `RATE_RPS`/`RATE_BURST` (general per-IP limit; default burst 5000, kept high so k6 races pass), `AUTH_RATE_RPS`/`AUTH_RATE_BURST` (stricter per-IP limit on login/register; k6-friendly defaults, tighten in prod), `POW_DIFFICULTY` (proof-of-work leading-zero bits on login/register, default 0 = off; `pow.go`), `ADMIN_EMAIL`/`ADMIN_PASSWORD` (bootstrap admin upserted on boot; defaults `admin@demo.local` / `admin-demo-123456`), `PORT`, `CORS_ORIGIN`, and `NEXT_PUBLIC_API` for web.

`JWT_SECRET` is **fail-closed** (`validateJWTSecret` in `main.go`): empty always aborts boot, and with `APP_ENV=production` a short (<32-char) or known-weak secret aborts too — so a bare `go run ./...` without `JWT_SECRET` set will exit. Tests build the `app` struct directly (no env needed). See `docs/security-review.md` for the security assessment and `docs/adr/0001-*.md` for the build-vs-buy decision. Note: `login` requires a password now (`{email, password}`); test/k6 helpers register first — anything calling the old passwordless `{email}` login will 400.
