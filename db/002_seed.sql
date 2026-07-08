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

-- A multi-show production (Ticketmaster-style): one series, three show dates,
-- each its own event row + seat map. Groups into one card on the landing.
INSERT INTO events (id, name, starts_at, sale_opens_at, series_id, series_name, venue) VALUES
 ('00000000-0000-0000-0000-000000000101', 'รอบ Night 1',
  date_trunc('day', now()) + interval '20 days 19 hours', now(),
  '000000aa-0000-0000-0000-0000000000aa', 'Bangkok EDM Festival 2026', 'Impact Arena เมืองทองธานี'),
 ('00000000-0000-0000-0000-000000000102', 'รอบ Night 2',
  date_trunc('day', now()) + interval '21 days 19 hours', now(),
  '000000aa-0000-0000-0000-0000000000aa', 'Bangkok EDM Festival 2026', 'Impact Arena เมืองทองธานี'),
 ('00000000-0000-0000-0000-000000000103', 'รอบ Night 3',
  date_trunc('day', now()) + interval '22 days 19 hours', now(),
  '000000aa-0000-0000-0000-0000000000aa', 'Bangkok EDM Festival 2026', 'Impact Arena เมืองทองธานี');

INSERT INTO seats (event_id, seat_no, price)
SELECT e.ev, chr(64 + r) || c, CASE WHEN r <= 2 THEN 3500 ELSE 1800 END
FROM (VALUES
  ('00000000-0000-0000-0000-000000000101'::uuid),
  ('00000000-0000-0000-0000-000000000102'::uuid),
  ('00000000-0000-0000-0000-000000000103'::uuid)) AS e(ev),
  generate_series(1, 8) AS r,
  generate_series(1, 12) AS c;

-- Big event: 1,000,000 seats for the EXPLAIN ANALYZE demo.
-- 99% SOLD so the partial index has real work to do. CLOSED so it stays out of
-- the customer event picker (it exists only for the DB benchmark, not booking).
INSERT INTO events (id, name, starts_at, sale_opens_at, status, internal)
VALUES ('00000000-0000-0000-0000-000000000002',
        'EXPLAIN Demo Arena',
        now() + interval '60 days',
        now(), 'CLOSED', true);

INSERT INTO seats (event_id, seat_no, status, price)
SELECT '00000000-0000-0000-0000-000000000002',
       'S' || g,
       CASE WHEN g % 100 = 0 THEN 'AVAILABLE' ELSE 'SOLD' END,
       1000
FROM generate_series(1, 1000000) AS g;

ANALYZE seats;
-- Also analyze events: without stats the planner assumes ~hundreds of events and
-- seq-scans the whole (1M-row) seats table for the admin dashboard instead of
-- index-scanning one small event via idx_seats_event (~1300x slower). Cheap here.
ANALYZE events;
