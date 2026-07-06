# Ticket Booking — Flash Sale MVP

ระบบจองตั๋วแบบระบุที่นั่ง (reserved seating) ที่การันตี **oversell = 0**
ภายใต้ concurrent load สูง

**Stack:** Next.js · Go (stdlib router) · PostgreSQL 16 · Redis 7 · k6

## Quickstart

```bash
docker compose up --build
```

- Web (seat map): http://localhost:3000
- API: http://localhost:8080/healthz
- Postgres seed อัตโนมัติ: event demo 200 ที่นั่ง + event 1M แถวสำหรับ EXPLAIN demo

รีเซ็ตข้อมูลทั้งหมด: `docker compose down -v && docker compose up --build`

## Concurrency design (2 ชั้น)

1. **Redis atomic hold** — Lua script จอง N ที่นั่งแบบ all-or-nothing
   (`SET NX` + TTL 10 นาที) รับแรงกระแทกแทน DB, แพ้ = 409 ใน ~1ms
2. **Postgres = source of truth** — `UNIQUE INDEX order_items(seat_id)`
   คือด่านสุดท้ายกัน oversell + optimistic confirm (`UPDATE … WHERE status='AVAILABLE'`)
   ต่อให้ Redis ล่มก็ขายซ้ำไม่ได้ (ระบบ degrade เป็นจองไม่ได้ชั่วคราว)

กัน deadlock: sort seat ids ก่อน lock เสมอ ทุก endpoint ที่ write เป็น
idempotent (`Idempotency-Key`), มี server-side sale gate กันยิงก่อนเวลาเปิดขาย

## Tests

```bash
cd api && go test -v ./...   # ต้องมี postgres+redis รันอยู่ (skip อัตโนมัติถ้าไม่มี)
```

`TestNoOversellUnderRace`: 200 goroutines แย่งที่นั่งเดียว — สำเร็จต้องได้ 1 เท่านั้น

## Demo commands

### 1. Race test — พันคนแย่งที่นั่งเดียว

```bash
# Linux:
docker run --rm --network host -v $PWD/k6:/k6 grafana/k6 run /k6/race.js

# Mac / Windows (Docker Desktop ไม่รองรับ --network host):
docker run --rm -e API=http://host.docker.internal:8080 \
  -v $PWD/k6:/k6 grafana/k6 run /k6/race.js
```

⚠️ ซ้อมบนเครื่องที่จะใช้ demo จริงล่วงหน้า — และรีเซ็ตข้อมูลก่อนซ้อมรอบใหม่ทุกครั้ง
(`docker compose down -v && docker compose up --build`) ไม่งั้นที่นั่งจากรอบก่อนยังถูกถือ/ขายอยู่

ดูบรรทัด `booking_success` ต้อง = **1** และ `booking_conflict` = 999

### 2. EXPLAIN ANALYZE — ก่อน/หลัง partial index (โจทย์ SA)

```bash
docker compose exec postgres psql -U ticket
# แล้วรันทีละ block จาก db/demo_explain.sql
```

Partial + covering index (`INCLUDE id, seat_no, price`) → **Index Only Scan,
Heap Fetches: 0**. บน 1M แถว (10k ว่าง): Seq Scan ~34ms vs Index Only ~1.3ms
= **~26 เท่า** (warm) และยิ่งใกล้ขายหมด (ที่ว่างเหลือน้อย) ยิ่งเข้าใกล้ ~100 เท่า
ต้อง `VACUUM` ก่อน index-only ถึงจะ skip heap ได้ — ตัวเลขจริงดูที่ [docs/benchmark-results.md](docs/benchmark-results.md)

### 3. MVCC / VACUUM — หลังรัน load test

```sql
SELECT relname, n_live_tup, n_dead_tup, last_autovacuum
FROM pg_stat_user_tables WHERE relname = 'seats';
```

ตาราง `seats` ถูก tune แล้ว: `autovacuum_vacuum_scale_factor = 0.01`,
`fillfactor = 85` (HOT updates) — ดูได้ที่ `db/001_init.sql`

### 4. Rate limiting โชว์ 429 (per-IP auth limit, Redis token bucket)

```bash
AUTH_RATE_RPS=1 AUTH_RATE_BURST=5 docker compose up -d api   # ลด limit ชั่วคราว
for i in $(seq 1 10); do curl -s -o /dev/null -w "%{http_code}\n" \
  -X POST localhost:8080/api/register -H 'Content-Type: application/json' \
  -d "{\"email\":\"bot$i-$RANDOM@spam.dev\",\"password\":\"pass-12345\"}"; done
# ~5 อันแรก 201, ที่เหลือ 429 — เสร็จแล้ว: docker compose up -d api (ค่า default กลับมา)
```

limiter อยู่ใน Redis (Lua) → ใช้ร่วมกันทุก instance. ค่า default (burst 2000)
ตั้งใจให้สูงพอที่ k6 race 1,000 VUs วิ่งผ่าน

### 5. Graceful degradation — ดับ Redis ต่อหน้ากรรมการ

```bash
docker compose stop redis    # จองไม่ได้ (503) แต่หน้าเว็บยังดูได้ ไม่ oversell
docker compose start redis   # กลับมาปกติ
```

## โครงสร้าง

```
api/            Go: main.go (bootstrap) + handlers.go (ทุก endpoint)
web/app/        Next.js: seat map + hold countdown + mock payment
db/001_init.sql schema + indexes + vacuum tuning (อ่าน comment ได้เลย)
db/002_seed.sql event demo + 1M rows
db/demo_explain.sql  สคริปต์โชว์ SA ทีละ act
k6/race.js      load test 1,000 concurrent
```

## แผน 4 วัน (เช็คลิสต์)

- [x] **เสาร์-อาทิตย์**: walking skeleton — compose ขึ้นครบ จองทะลุทุกชั้นได้
- [ ] **จันทร์**: ทดสอบ booking logic ทุก edge (multi-seat, TTL release, gate)
- [ ] **อังคาร**: seed 1M + เก็บผล EXPLAIN, รัน k6 เก็บตัวเลข, ซ้อม demo + อัดวิดีโอสำรอง
- [ ] **พุธ**: สไลด์ 3 องก์ + ตาราง assumptions + สไลด์ known edge cases — **ห้ามแตะ code**

## Out of scope (พูดบนสไลด์ ไม่ code)

Payment reconciliation (เงินเข้าหลัง TTL หมด), e-ticket + check-in,
transactional outbox, waiting room, read replica, refund, PDPA controls
