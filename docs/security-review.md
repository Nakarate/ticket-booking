# Security Assessment — Ticket Booking

Authorized self-assessment of our own system, run 2026-07-06 against the local
docker-compose stack (API `localhost:8080`). Method: live attack script
(`scratchpad/pentest.js`, 13 scenarios) + source review. This is an MVP/demo;
several findings are **deliberate demo simplifications** — flagged as such — but
listed so they don't ship to production by accident.

## Summary

| # | Finding | Severity | Status |
|---|---|---|---|
| 1 | Passwordless login → impersonation / account takeover | **Critical** | **Fixed** ✅ |
| 2 | Default JWT secret committed in `docker-compose.yml` | **High** | **Fixed** ✅ |
| 3 | Inventory hoarding — no per-user hold cap | **High** (business logic) | **Mitigated** ✅ |
| 4 | No anti-automation on login; rate limiting ineffective | **Medium** | **Fixed** ✅ |
| 5 | `listSeats` accepts non-UUID event id (200 empty) | **Low** | **Fixed** ✅ |
| 6 | Long-lived JWT (12h), no revocation | **Low** | **Fixed** ✅ |
| 7 | No TLS (plaintext JWT in transit) | **Info** (dev) | Open (dev) |

## Fixes applied

**Anti-automation (2026-07-07) — closes #4.** Rate limiting moved from an
in-memory per-process bucket to a **Redis Lua token bucket** shared across
instances (`ratelimit.go`), with a stricter per-IP limit on `/api/login` +
`/api/register` (`AUTH_RATE_*`). Added an optional **proof-of-work** challenge on
those endpoints (`pow.go`, `POW_DIFFICULTY`): a single-use, Redis-tracked
challenge the client must solve (sha256 leading-zero bits) — verifying costs us
one hash, solving costs a bot ~2^difficulty. Verified: `TestRedisRateLimiter`,
`TestPoWGuard`/`TestLeadingZeroBits`; live, a strict auth limit returned `429` on
the 8th signup from one IP, and at difficulty 18 a bot spent ~0.5s CPU per signup
(≈14h per 100k) while unsolved requests were rejected. The frontend solves the
challenge transparently and retries. Note: PoW defaults **off** so k6/e2e stay
fast; enable it (and tighten `AUTH_RATE_*`) in production.

**Self-review hardening (2026-07-07)** — an independent code-review pass + live
re-attack of the new auth surfaced four items, all addressed:

- **Login timing oracle (user enumeration).** The "unknown email" path skipped
  bcrypt, so it returned in ~2ms vs ~94ms for a real user — a **46× timing
  signal** to enumerate registered emails. Fixed by running a dummy bcrypt compare
  when the email isn't found; re-measured **1.0×** (98.5ms vs 95.7ms). `auth.go`.
- **Non-atomic refresh rotation.** `GET`+`DEL` let two concurrent uses of the same
  refresh token both succeed. Switched to atomic **`GETDEL`** so only one caller
  can ever redeem a token. `auth.go`.
- **Hold-cap query on the hot loser path (perf).** The anti-hoarding join ran on
  *every* booking before the Redis hold, contradicting the "losers shed at Redis
  without the expensive DB work" design. Moved it to **after** the hold (winner
  only); losers now take a 409 after just the one cheap sale-gate read. `handlers.go`.
- **Refresh token in `localStorage` (accepted for demo).** The httpOnly-cookie
  hardening needs HTTPS + `SameSite=None` for the cross-origin `:3000→:8080` dev
  split, so it's a deploy-time change; documented in `page.jsx` and left as the
  production step. XSS surface stays low (React auto-escaping, no `dangerouslySetInnerHTML`).

**Real authentication (2026-07-07) — closes #1 and #6.** Replaced passwordless
login with password + `bcrypt` (`auth.go`): `POST /api/register` and `/api/login`
verify credentials and issue a **short-lived access JWT (15m)** plus an **opaque
refresh token stored in Redis** (`POST /api/refresh` rotates it, `/api/logout`
revokes it). Login errors are generic (`invalid_credentials`) to avoid account
enumeration. `users.password_hash` added. Verified: register/login/refresh/logout
via curl and `TestRegisterAndLogin` / `TestRefreshRotationAndLogout`; frontend
gained a login/register form with transparent token refresh (`web/app/page.jsx`),
covered by `web/e2e/auth.spec.js`. This removes the takeover path **and** the
identity-forging that made hoarding (#3) exploitable across accounts.

### Earlier fixes (2026-07-06)

- **#2 — Fail-closed JWT secret.** Removed the hard-coded default in `main.go`;
  `validateJWTSecret` now makes an empty secret always fatal and, when
  `APP_ENV=production`, rejects short (<32 char) or known-weak secrets. Verified:
  booting with `APP_ENV=production` + the dev secret → *"JWT_SECRET too short for
  production (25 chars, need >= 32)"* and the process exits. Covered by
  `TestValidateJWTSecret`. Compose now sets `APP_ENV=development` (weak secret only
  warns locally).
- **#3 — Per-user hold cap.** `createBooking` counts a user's current unpaid,
  non-expired held seats and returns `429 hold_limit_exceeded` when a request would
  exceed `MAX_HELD_SEATS_PER_USER` (default 8). Verified live: one account holds 4+4
  then the 9th–12th → `429`, while a different user still books → `201`. Covered by
  `TestHoldCapPerUser`. *Partial mitigation:* it caps a single identity; full
  protection still needs #1 (real auth) + #4 (anti-automation), since attackers can
  mint fresh identities.
- **#5 — UUID validation in `listSeats`.** Added `isUUID(eventID)` → `400` on
  malformed input. Verified live (was 200, now 400). Covered by
  `TestListSeatsRejectsBadEventID`.

Still open: **#1** (passwordless auth — the deliberate demo simplification) and
**#4** (rate-limiter redesign into Redis + CAPTCHA) are larger changes left as
follow-ups; #1 is the root enabler, so #3's cap is defense-in-depth until it lands.
The build-vs-buy decision for #1/#4 is recorded in
[ADR-0001](adr/0001-build-vs-buy-auth-and-abuse-controls.md): we deliberately build
in-house for this self-contained demo, and swap to managed providers in production.

Defenses that **held** are listed at the bottom — several are genuinely well done.

---

## 1. Passwordless login → account takeover — Critical *(by-design demo)*

`POST /api/login` takes only an email and returns a JWT for that user
(`ON CONFLICT (email) DO UPDATE … RETURNING id`). Anyone who knows a victim's
email **becomes** that user.

**Evidence:** attacker logged in as `victim@bank.com` (no password), got the same
`user_id`, listed the victim's orders, and cancelled the victim's seat hold
(`cancel = 200`). This is also the root enabler of findings #3/#4 (unlimited free
identities).

**Fix (production):** real authentication — password or OTP, short-lived access
token + refresh token in an `httpOnly` cookie. The code comment already notes this;
it must not ship as-is. Everything downstream (`GET /api/orders`, pay, cancel) is
correctly scoped by the token's `sub`, so fixing login closes the takeover path.

## 2. Default JWT secret in `docker-compose.yml` — High

`JWT_SECRET: dev-secret-change-in-prod` is committed. Anyone with the repo can
forge a valid token for **any** `user_id`.

**Evidence:** signing `{sub: <victim_id>, exp: …}` with `dev-secret-change-in-prod`
→ `GET /api/orders` returned **200** with the victim's data. (Good news: forging
with a *wrong* secret → 401, so signatures are actually verified — see defenses.)

**Fix:** never ship a default secret. Require `JWT_SECRET` from the environment/secret
manager and **fail to boot** if it's unset or equals a known dev value; use ≥256-bit
random. Rotate. `main.go`'s `getenv("JWT_SECRET", "dev-secret")` fallback should be
removed for prod builds.

## 3. Inventory hoarding — no per-user hold cap — High *(business logic)*

A booking places a 10-minute hold without any payment. There is no cap on how many
holds one identity (or one IP) can create, and identities are free (#1).

**Evidence:** 10 throwaway accounts each held 4 seats → **40 seats locked** as unpaid
holds in seconds (available `197 → 157`). At scale this locks the entire event, denying
real buyers — the classic flash-sale scalp/grief. (README lists "waiting room" as out
of scope, so this is partly acknowledged.)

**Fix:** defense-in-depth — per-user/per-IP concurrent-hold cap; shorten hold TTL;
a waiting room / queue token; require a payment instrument to hold; bot heuristics.
The oversell guarantee is intact, but *availability* is not protected.

## 4. No anti-automation on login; rate limiting ineffective — Medium

`RATE_BURST` defaults to **2000** (intentionally high so k6 races pass), the limiter
is **in-memory per-instance** (won't hold across replicas — documented), and it keys
on the JWT (per-user) or IP. Login has no CAPTCHA / proof-of-work.

**Evidence:** 40 fresh accounts created from one IP → **40/40 succeeded, 0 limited.**

**Fix:** move the token-bucket into Redis (shared across instances — same pattern as
the seat hold), set production-sane limits, and add CAPTCHA / device attestation on
login and booking. Rate-limit account creation separately from authenticated actions.

## 5. `listSeats` accepts non-UUID event id — Low

`GET /api/events/{id}/seats` doesn't validate `id` as a UUID (unlike booking/pay/cancel,
which use `isUUID`). Injection payloads return `{"seats":null}` with **200** instead of
`400`.

**Evidence:** `event_id=' OR '1'='1` and a `UNION SELECT email FROM users` payload both
returned `{"seats":null}` — **no injection, no data leak** (query is parameterized), but
the wrong status code and no input validation. Minor robustness / info-hygiene issue.

**Fix:** `isUUID(eventID)` up front → `400` on malformed input, consistent with the
other handlers.

## 6. Long-lived JWT, no revocation — Low *(by-design demo)*

Tokens live 12h, carry no `jti`, and can't be revoked (the comment notes prod = 15m).
Combined with plaintext transport (#7) a captured token is usable for 12h.

**Fix:** short access-token TTL + refresh tokens; add `jti` and a denylist for logout.

## 7. No TLS — Info *(dev)*

The stack serves plain HTTP; JWTs travel in clear. Fine for local dev; terminate TLS
(and set HSTS) at the edge in production.

---

## Defenses that held (verified)

These attacks were **blocked** — worth keeping:

- **Oversell** — 2nd booking of a held seat → `409`; duplicate `seat_ids [X,X]` → `409`. Redis atomic hold + `UNIQUE(order_items.seat_id)` hold under contention (also proven by k6 at 1,000 VUs and `TestNoOversellUnderRace`).
- **SQL injection** — all queries parameterized; injection payloads return empty, no error/data leak.
- **JWT algorithm confusion** — `alg=none` → `401`; the parser rejects non-HMAC methods.
- **JWT signature forgery** — wrong-secret token → `401` (signature genuinely verified; #2 is only exploitable because the *real* secret is public).
- **IDOR** — Mallory cancelling the victim's order with her own token → `404` (every order op is `WHERE … AND user_id = $token`). Only #1 (becoming the victim) bypasses this.
- **Price tampering** — price is read from the DB (`seats.price`), never the client; extra JSON fields → `400` (`DisallowUnknownFields`).
- **Cross-event booking** — booking an event-002 seat via event-001 → `409` (`WHERE s.event_id = $3`).
- **Seat-count abuse** — 0 or 5 seats → `400` (1–4 enforced).
- **Idempotent payment** — missing `Idempotency-Key` → `400`; replayed key → charged once (`replayed=true`).
- **Info disclosure** — generic error codes (`db_error`, `email_required`), no stack traces, no `Server` version banner; CORS is a single origin, not `*`.
- **Frontend XSS** — React auto-escapes all rendered values (email, seat numbers, order status); no `dangerouslySetInnerHTML`.

## Top 3 to fix before any real deployment

1. Replace passwordless login with real auth (#1).
2. Remove the default `JWT_SECRET`; fail closed without a strong env-provided one (#2).
3. Add per-user hold caps + anti-automation to protect availability, not just correctness (#3, #4).
