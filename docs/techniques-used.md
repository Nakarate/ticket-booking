# เทคนิคทั้งหมดที่ใช้ในระบบนี้ (cheat-sheet)

> รวมทุกเทคนิค/เทคโนโลยีที่ใช้ในโปรเจกต์ — จัดเป็นหมวด อธิบายสั้น ๆ ว่า **แก้ปัญหาอะไร** และอยู่ **ไฟล์ไหน**
> ไว้ตอบคำถามทั้ง BU (ภาพรวม) และ SA/dev (ลงลึกได้ที่โค้ด)

**Stack:** Next.js 14 (web) · Go 1.22 stdlib (api) · PostgreSQL 16 · Redis 7 · k6 · Docker Compose

---

## 1. หัวใจ — กันขายซ้ำ (oversell = 0) ภายใต้คนแห่พร้อมกัน

| เทคนิค | แก้ปัญหาอะไร (ภาษาคน) | ไฟล์ |
|---|---|---|
| **Redis atomic hold (Lua)** | จับจองที่นั่งแบบ “ได้ทั้งหมดหรือไม่ได้เลย” ใน 1 จังหวะ — รับคนแห่กดพร้อมกัน คนแพ้หลุดใน ~1ms | `api/handlers.go` |
| **UNIQUE index** `order_items(seat_id)` | ด่านสุดท้ายที่ฐานข้อมูล: 1 ที่นั่ง = 1 ออเดอร์ ตลอดกาล ต่อให้ Redis พลาดก็ยังกันได้ | `db/001_init.sql` |
| **Optimistic concurrency** (ตอนจ่ายเงิน) | `UPDATE … WHERE status='AVAILABLE'` แล้วเช็คจำนวนแถว — ถ้ามีคนตัดหน้า = ยกเลิกอัตโนมัติ | `api/handlers.go` |
| **Defense-in-depth 2 ชั้น** | Redis + Postgres แยกอิสระ — ชั้นใดชั้นหนึ่งก็กัน oversell ได้เอง | (ทั้งสองไฟล์) |
| **Graceful degradation** | Redis ล่ม → จองไม่ได้ (503) แต่ **ไม่มีวันขายซ้ำ** หน้าเว็บยังดูได้ | `api/handlers.go` |
| **Deadlock avoidance** | เรียงลำดับ seat_id ก่อนล็อกเสมอ → 2 ออเดอร์ที่ทับกันไม่ค้างกันเอง | `api/handlers.go` (`sort.Strings`) |
| **Row locking** `SELECT … FOR UPDATE` | ล็อกออเดอร์ตอนจ่าย/ยกเลิก กันแก้ซ้อน | `api/handlers.go` |
| **Idempotency** | จ่ายซ้ำด้วยกุญแจเดิม = คิดเงินครั้งเดียว (กันกดรัว/เน็ตค้างแล้วส่งซ้ำ) | `payments.idempotency_key` |
| **TTL hold + expiry worker** | จองแล้วไม่จ่ายใน 10 นาที → ปล่อยที่นั่งคืนอัตโนมัติ (goroutine เบื้องหลัง) | `api/main.go` |
| **Server-side sale gate** | เช็คเวลาเปิดขายที่ฝั่งเซิร์ฟเวอร์ — นาฬิกาหน้าเว็บโกงไม่ได้ | `api/handlers.go` |

## 2. ฐานข้อมูล — เร็วและถูกต้องแม้ข้อมูลล้านแถว

| เทคนิค | แก้ปัญหาอะไร | ไฟล์ |
|---|---|---|
| **Partial index** (`WHERE status='AVAILABLE'`) | ทำ index เฉพาะที่นั่งว่าง → เล็กและเร็ว | `db/001_init.sql` |
| **Covering index / INCLUDE → Index-Only Scan** | ดึงข้อมูลจาก index ตรง ๆ ไม่ต้องแตะตาราง → เร็วขึ้น ~26 เท่าบน 1M แถว | `db/001_init.sql` |
| **MVCC + autovacuum tuning** | ตารางที่อัปเดตบ่อยจะมี “ขยะ” (dead tuple) → จูนให้เก็บกวาดที่ 1% + `fillfactor` (HOT updates) | `db/001_init.sql` |
| **Connection pool** (pgxpool) | ใช้ connection ซ้ำ ไม่เปิด-ปิดใหม่ทุกครั้ง → รับโหลดได้ | `api/main.go` |
| **Transactions** | จอง/จ่าย เป็นก้อนเดียว สำเร็จหมดหรือ rollback หมด | `api/handlers.go` |
| **Auto-seed** (docker-entrypoint) | ยกสแตกขึ้นมามีข้อมูล demo + event 1M แถวให้เลย | `db/002_seed.sql` |

## 3. ความปลอดภัย / auth / กันบอท

| เทคนิค | แก้ปัญหาอะไร | ไฟล์ |
|---|---|---|
| **bcrypt** | เก็บรหัสผ่านแบบ hash ถอดกลับไม่ได้ — ฐานข้อมูลหลุดก็ไม่รู้รหัสจริง | `api/auth.go` |
| **JWT (access) + refresh token ใน Redis** | ตั๋วเข้าระบบอายุสั้น 15 นาที + ตั๋วต่ออายุที่ยกเลิกได้ (revoke/logout) | `api/auth.go` |
| **Refresh rotation (`GETDEL` atomic)** | ต่ออายุแล้วตั๋วเก่าใช้ไม่ได้ทันที — กันขโมยตั๋วไปใช้ซ้ำ | `api/auth.go` |
| **Fail-closed secret** | ถ้าใช้กุญแจ (JWT secret) อ่อน/ว่าง ในโปรดักชัน = ไม่ยอมสตาร์ท | `api/main.go` |
| **Rate limit (Redis token bucket, Lua)** | ยามห้ามกดรัวจาก IP เดียว, ใช้ร่วมกันทุกเซิร์ฟเวอร์ → 429 | `api/ratelimit.go` |
| **Proof-of-Work (SHA-256)** | “เกมทอยเต๋า” ก่อนสมัคร — บอททำแสนบัญชีไม่คุ้ม *(→ `anti-bot-explained.md`)* | `api/pow.go` |
| **Per-user hold cap** | 1 คนถือที่นั่งค้างได้จำกัด — กันกวาดตั๋วไปขายต่อ | `api/handlers.go` |
| **Timing-attack mitigation** | ตอนล็อกอินผิด เสียเวลาเท่ากันทุกกรณี → เดาไม่ได้ว่าอีเมลไหนสมัครแล้ว | `api/auth.go` |
| **Parameterized query** | ทุก query ใส่ค่าผ่านพารามิเตอร์ → กัน SQL injection | ทั้ง `api/` |
| **Input validation (UUID)** | เช็ครูปแบบ id ก่อน → ข้อมูลมั่วเป็น 400 ไม่ใช่ 500/หลุด error | `api/handlers.go` |
| **CORS + generic errors + no server banner** | จำกัด origin, error กลาง ๆ ไม่บอก internal, ไม่โชว์เวอร์ชันเซิร์ฟเวอร์ | `api/main.go` |

## 4. สถาปัตยกรรม API (Go stdlib — ไม่มี framework)

| เทคนิค | แก้ปัญหาอะไร | ไฟล์ |
|---|---|---|
| **`http.ServeMux` (method+pattern)** | routing ด้วย stdlib ล้วน (`"POST /api/…"`) ไม่พึ่ง framework | `api/main.go` |
| **Middleware chain** | `cors → log → rate limit` ครอบทุก request เป็นชั้น ๆ | `api/main.go` |
| **Background worker (goroutine)** | expiry worker ปล่อยที่นั่งหมดเวลา ทำงานนอก request | `api/main.go` |
| **Graceful shutdown** | ปิดเซิร์ฟเวอร์แบบรอ request ที่ค้างเสร็จก่อน (signal + context) | `api/main.go` |
| **Health/readiness probes** | `/healthz` (มีชีวิต) · `/readyz` (พร้อมจริง — เช็ค DB/Redis) ให้ load balancer | `api/main.go` |
| **Timeouts + body size cap** | กัน client ช้า/ยิง payload ใหญ่ ค้าง resource | `api/main.go` |

## 5. Frontend (Next.js)

| เทคนิค | แก้ปัญหาอะไร | ไฟล์ |
|---|---|---|
| **Next.js 14 App Router (client component)** | หน้า UI เดียวจบ: ผังที่นั่ง + นับถอยหลัง + จ่ายเงิน | `web/app/page.jsx` |
| **Refresh-on-401 (adaptive)** | ตั๋วหมดอายุ → ต่อให้อัตโนมัติแล้วลองใหม่ ลูกค้าไม่ต้องล็อกอินซ้ำ | `web/app/page.jsx` |
| **Polling ผังที่นั่ง (2 วิ)** | เห็นที่นั่งอัปเดตเกือบ real-time (production ใช้ WebSocket) | `web/app/page.jsx` |
| **Web Crypto (แก้ PoW)** | เบราว์เซอร์แก้ “โจทย์ทอยเต๋า” ให้เอง | `web/app/page.jsx` |

## 6. การทดสอบ & วัดผล

| เทคนิค | แก้ปัญหาอะไร | ไฟล์ |
|---|---|---|
| **Go integration tests** (Postgres+Redis จริง) | ทดสอบ logic จริง ไม่ mock · skip อัตโนมัติถ้าไม่มี DB | `api/*_test.go` |
| **Concurrency race test** (200 goroutines) | พิสูจน์ oversell = 0 ในโค้ด | `api/booking_test.go` |
| **Playwright E2E** | คลิกจริงบนเว็บ: สมัคร → เลือกที่นั่ง → จอง → จ่าย | `web/e2e/` |
| **k6 load test** | จำลอง 1,000 คนแย่งที่นั่งเดียว / จอง+จ่ายพร้อมกัน | `k6/` |
| **EXPLAIN ANALYZE** | วัดความเร็ว query จริง (ก่อน/หลัง index) | `db/demo_explain.sql` |
| **Self-pentest + code review** | เจาะระบบตัวเอง 13 ท่า + ให้ agent รีวิวอิสระ | `docs/security-review.md` |

## 7. Infra / Ops

| เทคนิค | แก้ปัญหาอะไร | ไฟล์ |
|---|---|---|
| **Docker Compose (4 services)** | ยกทั้งระบบขึ้นด้วยคำสั่งเดียว `docker compose up` | `docker-compose.yml` |
| **Health checks + `depends_on`** | รอ DB/Redis พร้อมก่อนค่อยสตาร์ท API | `docker-compose.yml` |
| **Config ผ่าน env** | ปรับพฤติกรรม (TTL, rate, PoW, secret) โดยไม่แก้โค้ด | `docker-compose.yml` |
| **Incident playbook** | แผนรับมือระบบล่มหน้างาน (รู้ก่อน → บอกลูกค้า → แก้/เลื่อน) | (สไลด์ / ตอบ Q&A) |

---

## 8. Admin & Data (จัดการงาน + ข้อมูลการตลาด)

| เทคนิค | แก้ปัญหาอะไร | ไฟล์ |
|---|---|---|
| **Admin content management** | แอดมินสร้าง event/รอบการขายเอง, เปิด-ปิดการขาย, เลื่อนเวลา, ตั้งจำนวนที่นั่งต่อออเดอร์ — ไม่ต้อง hardcode | `api/admin.go` |
| **Production grouping (Ticketmaster-style)** | งานหลัก 1 อัน = หลายรอบ (`events.series_id`) → ลูกค้าเห็นการ์ดเดียว → เลือกวัน/รอบ → จอง; แอดมิน join รอบเข้า production ด้วย series_id (ไม่ต้อง match ชื่อ) | `api/admin.go` · `web/app/page.jsx` |
| **`adminAuth` (เช็ค `is_admin` จาก DB)** | สิทธิ์แอดมินอ่านจากฐานข้อมูล ไม่ใช่จาก token → ให้/ถอนสิทธิ์ได้ทันทีไม่ต้องรอ token หมดอายุ | `api/admin.go` |
| **`ensureAdmin` (bootstrap)** | สร้างแอดมินตัวแรกจาก env `ADMIN_EMAIL/PASSWORD` ตอนบูต — demo มีแอดมินได้โดยไม่ต้อง seed มือ | `api/admin.go` |
| **Per-order seat cap** (`max_seats_per_order`) | จำกัดจำนวนที่นั่งต่อ 1 ออเดอร์ ตั้งค่าได้ต่อ event | `api/admin.go` |
| **Booking demand log (async batch)** | เก็บ “ใครอยากได้ที่นั่งไหน ได้/ไม่ได้” ให้ทีมข้อมูล — เข้า buffered channel + goroutine batch-insert **นอก hot path** (คนแพ้ยังหลุดที่ Redis ~1ms ไม่แตะ DB) | `api/analytics.go` |

## เอกสารประกอบอื่น ๆ

- `CLAUDE.md` — ภาพรวมสถาปัตยกรรม + คำสั่งทั้งหมด
- `docs/benchmark-results.md` — ตัวเลขจริง k6 / EXPLAIN / MVCC
- `docs/security-review.md` — ผลเจาะระบบ + สิ่งที่แก้
- `docs/anti-bot-explained.md` — PoW/rate-limit/hold-cap แบบละเอียด (ภาษาคน + เทคนิค)
- `docs/adr/0001-*.md` — เหตุผล build เอง vs ใช้ provider

> **จำง่าย ๆ 1 ประโยค:** ระบบนี้เอา **Redis กันแรงกระแทก + Postgres เป็นความจริง** มากัน oversell, จูน **index/MVCC** ให้เร็ว, และซ้อน **auth + rate-limit + PoW + hold-cap** กันบอท — ทุกอย่างพิสูจน์ด้วยเทสต์และตัวเลขจริง
