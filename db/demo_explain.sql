-- ============================================================
-- Demo script: run inside psql, one block at a time.
--   docker compose exec postgres psql -U ticket
-- ============================================================

-- ACT 1: query available seats WITHOUT the partial index
DROP INDEX IF EXISTS idx_seats_available;

EXPLAIN ANALYZE
SELECT id, seat_no, price
FROM seats
WHERE event_id = '00000000-0000-0000-0000-000000000002'
  AND status = 'AVAILABLE';
-- Expect: Seq Scan over ~1M rows, tens-to-hundreds of ms.

-- ACT 2: add the partial + covering index, same query
CREATE INDEX idx_seats_available ON seats(event_id)
    INCLUDE (id, seat_no, price) WHERE status = 'AVAILABLE';
-- VACUUM sets the visibility map so the scan can skip the heap entirely.
-- (After a bulk seed the map is not all-visible yet, so without this you'll
--  see "Heap Fetches: N" and the index barely beats the seq scan.)
VACUUM (ANALYZE) seats;

EXPLAIN ANALYZE
SELECT id, seat_no, price
FROM seats
WHERE event_id = '00000000-0000-0000-0000-000000000002'
  AND status = 'AVAILABLE';
-- Expect: Index Only Scan, "Heap Fetches: 0", ~sub-ms — the covering index
-- returns everything from the index. Compare Execution Time vs ACT 1.

-- ACT 3: MVCC bloat — run AFTER the k6 load test
SELECT relname, n_live_tup, n_dead_tup, last_autovacuum, last_vacuum
FROM pg_stat_user_tables
WHERE relname IN ('seats', 'orders', 'order_items');
-- Talking point: every UPDATE left a dead tuple behind (MVCC).
-- Our per-table tuning makes autovacuum reclaim at 1% instead of 20%:
SELECT reloptions FROM pg_class WHERE relname = 'seats';

-- Bonus: force a vacuum live and show the counters reset
VACUUM (VERBOSE, ANALYZE) seats;
