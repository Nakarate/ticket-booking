# Architecture & Module Map

> **Purpose:** a navigation index so an agent (or human) can jump straight to the
> right file instead of scanning the repo. Each row = one module, its file, what
> it owns, and its key symbols. Keep this in sync when you move code.
> Deep design rationale lives in [CLAUDE.md](../CLAUDE.md); this file is the *map*.

## Request flow

```
web (Next.js, app/page.jsx)
  → fetch NEXT_PUBLIC_API
    → API middleware chain:  cors → logRequests → rateLimit → (auth | adminAuth)
      → handler
        → Redis  (holds · refresh tokens · rate-limit buckets · PoW)
        → Postgres (source of truth — UNIQUE(order_items.seat_id) guards oversell)
```

The oversell invariant is the whole point; before touching booking code read the
"two-layer guard" + "Invariants" sections in [CLAUDE.md](../CLAUDE.md).

---

## API — Go (`api/`, module `ticket-booking/api`, package `main`)

> Mostly flat `package main` (file-per-concern, idiomatic Go). Config has been
> pulled into `internal/config`; the rest still hangs off one shared `app` struct.
> Full `internal/<domain>` split is in [§ Target structure](#target-structure-in-progress).

| Module | File | Owns | Key symbols |
|---|---|---|---|
| Config | [internal/config/config.go](../api/internal/config/config.go) | load all env config + fail-closed JWT-secret validation | `Config`, `Load` :67, `ValidateJWTSecret` :46 (tested in [config_test.go](../api/internal/config/config_test.go)) |
| Bootstrap | [main.go](../api/main.go) | pgxpool, Redis, ServeMux routes, middleware wiring, graceful shutdown, background workers | `main` (calls `config.Load`), `expiryWorker` :154, `expireOverdueOrders` :177, `cors`/`logRequests` middleware, `writeJSON`/`writeErr` |
| Booking / seats | [handlers.go](../api/handlers.go) | the two-layer oversell guard, seat map, events list, pay/cancel | `holdScript` Lua :178, `createBooking` :187, `payOrder` :396, `cancelOrder` :507, `listSeats` :59, `listEvents` :129, `listOrders` :350, `auth()` mw :33, `holdKey` :124 |
| Auth | [auth.go](../api/auth.go) | register/login/refresh/logout, JWT + refresh tokens, bcrypt | `register` :73, `login` :122, `refresh` :163, `logout` :191, `signAccess` :28, `issueTokens` :50, `dummyHash` :24 (timing) |
| Admin | [admin.go](../api/admin.go) | event/round CRUD, production grouping (series_id), sales stats, admin bootstrap | `createAdminEvent` :105, `listAdminEvents` :54, `patchAdminEvent` :237, `ensureAdmin` :20, `adminAuth` mw :40 |
| Analytics | [analytics.go](../api/analytics.go) | demand log (who wanted which seats), batched off the hot path | `logAttempt` :30, `attemptWriter` :42, `insertAttempts` :75 |
| Rate limit | [ratelimit.go](../api/ratelimit.go) | Redis Lua token bucket (general + stricter auth path) | `newRateLimiter` :55, `clientIP` :93 |
| Proof-of-work | [pow.go](../api/pow.go) | anti-bot challenge (default off, `POW_DIFFICULTY`) | `issuePoWChallenge` :41, `checkPoW` :53, `powSolved` :32 |

**Tests** (real PG+Redis, skip if unreachable): [booking_test.go](../api/booking_test.go) (oversell race), [booking_edge_test.go](../api/booking_edge_test.go) (multi-seat, sale gate, idempotency, expiry), [auth_test.go](../api/auth_test.go), [admin_test.go](../api/admin_test.go), [pow_test.go](../api/pow_test.go), [ratelimit_test.go](../api/ratelimit_test.go), [security_test.go](../api/security_test.go).

### Route → handler map

| Method · Path | Handler | Middleware |
|---|---|---|
| `GET /healthz` · `GET /readyz` | inline | — |
| `POST /api/register` · `/api/login` | `register` · `login` | rateLimit (auth) + PoW |
| `POST /api/refresh` · `/api/logout` | `refresh` · `logout` | rateLimit |
| `GET /api/events` | `listEvents` | — |
| `GET /api/events/{id}/seats` | `listSeats` | — |
| `POST /api/bookings` | `createBooking` | `auth` |
| `GET /api/orders` | `listOrders` | `auth` |
| `POST /api/orders/{id}/pay` | `payOrder` | `auth` |
| `DELETE /api/orders/{id}` | `cancelOrder` | `auth` |
| `GET/POST /api/admin/events` · `PATCH /api/admin/events/{id}` | `listAdminEvents` · `createAdminEvent` · `patchAdminEvent` | `adminAuth` |

Routes are declared in [main.go](../api/main.go) (`http.ServeMux`, method+pattern).

---

## Web — Next.js 14 App Router (`web/`, plain JSX)

Split into `app/` (orchestrator) + `features/` + `components/` + `lib/`. The
booking flow (seat map, hold countdown, pay/cancel, "my bookings") still lives in
`Page` — it is the stateful orchestrator that wires everything together.

| Module | File | Owns |
|---|---|---|
| Orchestrator + booking view | [app/page.jsx](../web/app/page.jsx) `Page` :21 | root state, routing between views, seat map + hold/pay/cancel, my-bookings; wires `authFetch` |
| API layer | [lib/api.js](../web/lib/api.js) | base URL (`NEXT_PUBLIC_API`), token storage (`loadAuth`/`persistAuth`), `refreshTokens`/`logoutRequest`, `createAuthFetch` (attach token + rotate on 401) |
| Formatting | [lib/format.js](../web/lib/format.js) | `fmtEventDate`, `fmtDateShort`, `showRangeLabel` (Thai locale) |
| Auth | [features/auth/AuthForm.jsx](../web/features/auth/AuthForm.jsx) | login/register form, inline PoW solver, error text |
| Catalog | [features/catalog/ProductionListing.jsx](../web/features/catalog/ProductionListing.jsx) · [ShowPicker.jsx](../web/features/catalog/ShowPicker.jsx) · [grouping.js](../web/features/catalog/grouping.js) | production cards, date/round picker, `groupEvents`/`groupAdminEvents` (by series_id) |
| Admin | [features/admin/AdminPanel.jsx](../web/features/admin/AdminPanel.jsx) | dashboard (grouped), `EventRow` (open/close, cap), `CreateEventForm` (dropdown + 24h time), `TIME_OPTIONS` |
| Shared UI | [components/ConfirmModal.jsx](../web/components/ConfirmModal.jsx) · [components/StatTile.jsx](../web/components/StatTile.jsx) | confirm dialog (pay/cancel/logout/close), metric tile |

Shell: [layout.jsx](../web/app/layout.jsx) · styles [globals.css](../web/app/globals.css).
**`data-testid`s are a contract** with e2e ([e2e/booking.spec.js](../web/e2e/booking.spec.js), [auth.spec.js](../web/e2e/auth.spec.js), [admin.spec.js](../web/e2e/admin.spec.js)) — keep them stable when refactoring.

---

## Data & load

| Area | File | Notes |
|---|---|---|
| Schema + indexes + MVCC tuning | [db/001_init.sql](../db/001_init.sql) | every index commented with *why*; `idx_one_seat_one_order` = the oversell guard; seats autovacuum @1% (status flip is non-HOT) |
| Seed | [db/002_seed.sql](../db/002_seed.sql) | 1 standalone show + 1 three-show production + 1M-row benchmark event |
| EXPLAIN walkthrough | [db/demo_explain.sql](../db/demo_explain.sql) | manual, not runtime |
| Load tests | [k6/race.js](../k6/race.js) (oversell), [k6/checkout.js](../k6/checkout.js) (write/MVCC) | run on the compose network |

Config: all via env — see [docker-compose.yml](../docker-compose.yml) and the Config section of [CLAUDE.md](../CLAUDE.md).

---

## "I want to change X → go here"

| Task | Start at |
|---|---|
| Oversell guard / hold logic | [handlers.go](../api/handlers.go) `holdScript`/`createBooking` + [db/001_init.sql](../db/001_init.sql) `idx_one_seat_one_order` |
| Payment / idempotency | [handlers.go](../api/handlers.go) `payOrder` :396 |
| Seat release / expiry | [handlers.go](../api/handlers.go) `cancelOrder`/`clearHoldsForOrder` + [main.go](../api/main.go) `expireOverdueOrders` |
| Login / tokens / bcrypt | [auth.go](../api/auth.go) |
| Admin create / productions grouping | [admin.go](../api/admin.go) `createAdminEvent` + web `CreateEventForm` |
| Rate limit / anti-bot | [ratelimit.go](../api/ratelimit.go) · [pow.go](../api/pow.go) |
| Customer UI flow | [page.jsx](../web/app/page.jsx) `Page`→`ProductionListing`→`ShowPicker` |
| A new API route | add to `http.ServeMux` in [main.go](../api/main.go), handler in the matching domain file |

---

## Target structure (in progress)

Refactoring incrementally toward domain (vertical-slice) packages. This section is
updated as each module moves; unchecked = still in the flat file above.

**API** → `cmd/api/main.go` (thin bootstrap) + `internal/{config,httpx,auth,booking,catalog,admin,analytics,ratelimit,pow,platform}` — each domain owns `handler.go` / `service.go` / `repo.go`.

- [x] `internal/config` — env load + `ValidateJWTSecret` (fail-closed) ✅
- [ ] `internal/platform/{postgres,redis}` — infra clients
- [ ] `internal/httpx` — server, middleware chain, respond helpers
- [ ] `internal/auth` · `internal/booking` · `internal/catalog` · `internal/admin` · `internal/analytics` · `internal/ratelimit` · `internal/pow` — **needs the shared `app` struct split into per-domain structs (larger/riskier)**

**Web** → `app/` (thin routes) + `features/{auth,catalog,booking,admin}` + `components/` (shared UI) + `lib/api.js` (authFetch/refresh, one place).

- [x] `lib/api.js` (authFetch + refresh + token storage) · `lib/format.js` (date helpers) ✅
- [x] `features/auth` ✅ · `features/catalog` ✅ · `features/admin` ✅  — booking flow stays in `Page` (the orchestrator)
- [x] `components/` — `ConfirmModal`, `StatTile` ✅ (buttons still inline)

**db** → `migrations/*.up.sql`+`*.down.sql` + `seed/` + `demo/`. **infra** → `deploy/`.
