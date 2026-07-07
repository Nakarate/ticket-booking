-- Demo event: 200 seats (rows A-J x 20), on sale now.
INSERT INTO events (id, name, starts_at, sale_opens_at)
VALUES ('00000000-0000-0000-0000-000000000001',
        'Live in Bangkok 2026',
        now() + interval '30 days',
        now());

INSERT INTO seats (event_id, seat_no, price)
SELECT '00000000-0000-0000-0000-000000000001',
       chr(64 + r) || c,
       CASE WHEN r <= 3 THEN 2500 ELSE 1500 END
FROM generate_series(1, 10) AS r,
     generate_series(1, 20) AS c;

-- Big event: 1,000,000 seats for the EXPLAIN ANALYZE demo.
-- 99% SOLD so the partial index has real work to do. CLOSED so it stays out of
-- the customer event picker (it exists only for the DB benchmark, not booking).
INSERT INTO events (id, name, starts_at, sale_opens_at, status)
VALUES ('00000000-0000-0000-0000-000000000002',
        'EXPLAIN Demo Arena',
        now() + interval '60 days',
        now(), 'CLOSED');

INSERT INTO seats (event_id, seat_no, status, price)
SELECT '00000000-0000-0000-0000-000000000002',
       'S' || g,
       CASE WHEN g % 100 = 0 THEN 'AVAILABLE' ELSE 'SOLD' END,
       1000
FROM generate_series(1, 1000000) AS g;

ANALYZE seats;
