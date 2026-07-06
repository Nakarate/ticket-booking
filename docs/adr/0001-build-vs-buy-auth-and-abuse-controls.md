# ADR-0001: Build auth & abuse-controls in-house for the demo

**Status:** Accepted
**Date:** 2026-07-07
**Deciders:** Project owner (demo/interview artifact)

## Context

The security assessment ([security-review.md](../security-review.md)) surfaced two
open items that are deliberate MVP simplifications:

- **#1 Passwordless login** → anyone knowing an email becomes that user (account
  takeover; root enabler of identity-based abuse).
- **#4 Ineffective rate limiting / no anti-automation** → in-memory per-instance
  limiter with a high burst; unlimited free accounts from one IP → inventory
  hoarding.

We need to decide **how** to close these. The forces at play are specific to what
this project *is*:

- It is a **demo / interview artifact**, not a production service. Its job is to
  *showcase engineering depth* (concurrency, data integrity, security thinking).
- It must run **fully self-contained**: `docker compose up` on a laptop, offline,
  with **no external accounts, API keys, or paid services**, and be reproducible by
  a reviewer in one command.
- The existing stack already has **Postgres + Redis** — the same primitives these
  features need.
- Timeline is short; the deliverable is a working system + slides, not a hardened
  product.

We are **explicitly aware** that managed providers exist and are usually the
*correct* production choice. This ADR records that we evaluated them and chose to
build in-house **for the demo's constraints**, not out of ignorance of the
alternatives.

## Decision

For this demo, **build auth and abuse-controls in-house**, reusing the Postgres +
Redis already in the stack, with **zero external dependencies or cost**:

- **Auth (#1):** password + `bcrypt`, short-lived access JWT (~15m) + refresh token
  stored in Redis (revocable); no third-party IdP.
- **Abuse-controls (#4):** move the token-bucket rate limiter into Redis (Lua, same
  pattern as the seat hold); stricter limits on login/signup; a **self-hosted
  proof-of-work challenge** instead of a third-party CAPTCHA; per-user hold cap
  (already shipped).

In production we would revisit this and **buy** most of it (see Consequences).

## Options Considered

### Option A: Build in-house (self-contained) — **chosen for demo**

| Dimension | Assessment |
|-----------|------------|
| Complexity | Medium — password/refresh flow + Redis Lua limiter, but no external integration |
| Cost | **$0** — reuses Postgres/Redis; all libs open source (`x/crypto/bcrypt`, stdlib `crypto/rand`) |
| Scalability | Good enough — Redis-backed limiter/refresh is horizontally shared; not billed per MAU |
| Team familiarity | High — same Go/SQL/Redis patterns already in the repo |
| Demo fit | **Excellent** — `docker compose up`, offline, nothing to sign up for |
| Production fit | Fair — works, but reinvents hardened, audited building blocks |

**Pros:** zero cost/keys, offline-reproducible, no vendor lock-in, demonstrates we
*understand* the mechanisms (not just wiring a SaaS), one-command review.
**Cons:** we own security-sensitive code (password storage, token rotation); no
managed threat intel, breach monitoring, MFA-out-of-the-box, or SOC2 coverage.

### Option B: Managed providers (buy)

Auth via **Auth0 / AWS Cognito / Clerk / Supabase Auth**; abuse-controls via
**Cloudflare Turnstile + Waiting Room + WAF**.

| Dimension | Assessment |
|-----------|------------|
| Complexity | Low to integrate, but adds external config, secrets, network dependency |
| Cost | Free tiers exist (Cognito 50k MAU, Clerk 10k MAU, Turnstile free); **paid** beyond tiers / for Waiting Room / WAF |
| Scalability | Excellent — that's their business |
| Team familiarity | Medium — provider-specific SDKs/dashboards |
| Demo fit | **Poor** — requires accounts, API keys, internet; reviewer can't `docker compose up` and go |
| Production fit | **Excellent** — audited, MFA, bot intel, breach monitoring included |

**Pros:** offloads hard/hazardous work, best-in-class security, fast to production.
**Cons:** breaks the self-contained/offline demo constraint; keys & billing; vendor
lock-in; hides the very mechanisms the demo means to show.

### Option C: Hybrid (build auth, buy CAPTCHA)

Build auth + Redis limiter in-house, but use **Cloudflare Turnstile** (free) for the
bot challenge.

| Dimension | Assessment |
|-----------|------------|
| Complexity | Medium |
| Cost | $0 (Turnstile free tier) |
| Demo fit | **Poor** — Turnstile still needs a site key + internet at runtime |
| Production fit | Good |

**Pros:** better real-world bot resistance than self-hosted PoW, still $0.
**Cons:** reintroduces an external dependency/key → breaks offline reproducibility.

## Trade-off Analysis

The decisive axis is **not cost or scalability — it's "self-contained demo" vs
"production-grade."** Options B and C score best for a real product but *fail the
core demo constraint*: a reviewer must be able to clone and `docker compose up`
with no signups, keys, or internet. Option A is the only one that preserves that,
and it doubles as a better *demonstration* — showing we can implement bcrypt
hashing, token rotation, and a Redis token-bucket, rather than configuring a SaaS.

The residual risk of Option A (owning security-sensitive code) is acceptable
**because this is a demo, not a system holding real users/money**. The moment it
were to hold real value, that risk flips and Option B becomes correct — which is
exactly what the Consequences/roadmap record.

## Consequences

**Becomes easier:**
- One-command, offline, key-free review; nothing to provision.
- Full control to demonstrate and explain every mechanism on the slides.
- No per-MAU billing, no vendor lock-in during the demo.

**Becomes harder / accepted risk:**
- We maintain password storage, token rotation, and abuse logic ourselves (must
  keep them correct and tested).
- Self-hosted PoW is weaker than managed bot management against determined bots.
- No built-in MFA, breach monitoring, or compliance coverage.

**What we'll revisit (production trigger = holds real users/money):**
- Swap in a managed IdP (Cognito/Auth0/Clerk) for auth, MFA, and account recovery.
- Add Cloudflare Turnstile/Waiting Room + WAF at the edge.
- Keep the Redis limiter as a second layer behind the edge.

## Action Items

Zero-cost, in-house path:

1. [x] Fail-closed `JWT_SECRET` (no weak default in prod) — `main.go`
2. [x] Per-user hold cap (`MAX_HELD_SEATS_PER_USER`) — `handlers.go`
3. [x] Replace passwordless login with password + `bcrypt`; `password_hash` column — `auth.go`
4. [x] Access JWT 15m + refresh token in Redis (rotate + revocable logout) — `auth.go`
5. [x] Move rate limiter to Redis (Lua token-bucket), stricter per-IP limit on `login`/register — `ratelimit.go`
6. [x] Self-hosted proof-of-work challenge on login/register (`POW_DIFFICULTY`) — `pow.go`
7. [x] Document the production swap-to-managed path (this ADR's Consequences)

---

## สรุปสำหรับสไลด์ (TH)

**ประเด็น:** security review เจอ 2 จุด (auth เป็น passwordless, ไม่มี anti-bot) — จะแก้ยังไง?

**ทางเลือก:**
- **Build เอง** (Postgres/Redis ที่มีอยู่ + open source) → **$0, ออฟไลน์, `docker compose up` จบ**
- **ซื้อ managed** (Auth0/Cognito/Clerk + Cloudflare) → โปรดักชันดีสุด แต่ต้องมี account/key/เน็ต → **demo ทำไม่ได้ในคำสั่งเดียว**

**ตัดสินใจ:** demo นี้ **ทำเองทั้งหมดในระบบตัวเอง** — เพราะ (1) ต้อง self-contained รันคนเดียวได้ (2) โชว์ว่าเรา *เข้าใจกลไก* จริง (bcrypt, refresh token, Redis token-bucket) ไม่ใช่แค่ต่อ SaaS

**สำคัญ:** เรา **aware** ว่าโปรดักชันจริงควรใช้ managed provider — ADR นี้บันทึกว่าเราเลือก build-in-house *ตามข้อจำกัดของ demo* ไม่ใช่เพราะไม่รู้จักทางเลือก และระบุ trigger ไว้ชัด: **พอระบบถือเงิน/ผู้ใช้จริง → สลับไปใช้ managed ทันที**
