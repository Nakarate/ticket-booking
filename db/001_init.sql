-- ============================================================
-- Ticket booking schema
-- Design notes:
--  * order_items(seat_id) -> UNIQUE = the final DB-level guard against
--                            overselling (the sale is confirmed with an
--                            optimistic `UPDATE … WHERE status='AVAILABLE'`)
--  * payments.idempotency_key UNIQUE -> duplicate payment guard
--  * partial index        -> hot query "available seats of event"
--  * autovacuum tuning    -> seats is UPDATE-heavy (MVCC bloat)
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email         text NOT NULL UNIQUE,
    password_hash text NOT NULL,               -- bcrypt; set at registration
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE events (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name          text NOT NULL,
    starts_at     timestamptz NOT NULL,
    sale_opens_at timestamptz NOT NULL DEFAULT now(),
    status        text NOT NULL DEFAULT 'ON_SALE',
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE seats (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id      uuid NOT NULL REFERENCES events(id),
    seat_no       text NOT NULL,
    status        text NOT NULL DEFAULT 'AVAILABLE',  -- AVAILABLE | SOLD
    price         numeric(10,2) NOT NULL,
    UNIQUE (event_id, seat_no)
);

CREATE TABLE orders (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       uuid NOT NULL REFERENCES users(id),
    status        text NOT NULL DEFAULT 'PENDING',    -- PENDING | PAID | EXPIRED | CANCELLED
    expires_at    timestamptz NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE order_items (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id      uuid NOT NULL REFERENCES orders(id),
    seat_id       uuid NOT NULL REFERENCES seats(id),
    price         numeric(10,2) NOT NULL
);

CREATE TABLE payments (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id        uuid NOT NULL REFERENCES orders(id),
    idempotency_key text NOT NULL,
    status          text NOT NULL,                    -- SUCCEEDED | FAILED
    amount          numeric(10,2) NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now()
);

-- ---------- Indexes (each one earns its write cost) ----------

-- 1. Hot read path: "available seats of this event".
--    Partial (status='AVAILABLE') keeps it small; INCLUDE carries the exact
--    columns the query returns so it becomes an *index-only* scan — zero heap
--    fetches once the table is VACUUMed (visibility map all-visible).
CREATE INDEX idx_seats_available ON seats(event_id)
    INCLUDE (id, seat_no, price) WHERE status = 'AVAILABLE';

-- 2. THE oversell guard. One seat can live in one active order, ever.
--    Expiry/cancel flows DELETE order_items rows to free the seat.
CREATE UNIQUE INDEX idx_one_seat_one_order ON order_items(seat_id);

-- 3. Payment gateway retries / double-click must not double-charge.
CREATE UNIQUE INDEX idx_payments_idem ON payments(idempotency_key);

-- 4. "My bookings" page.
CREATE INDEX idx_orders_user ON orders(user_id, created_at DESC);

-- 5. Expiry worker scans only pending orders.
CREATE INDEX idx_orders_expiry ON orders(expires_at) WHERE status = 'PENDING';

CREATE INDEX idx_order_items_order ON order_items(order_id);

-- ---------- VACUUM tuning for the UPDATE-heavy table ----------
-- Default autovacuum triggers at ~20% dead tuples: too slow for a
-- flash-sale table. fillfactor 85 leaves page space for HOT updates.
ALTER TABLE seats SET (
    autovacuum_vacuum_scale_factor = 0.01,
    fillfactor = 85
);
