package main

// Integration test: proves the core invariant — one seat, N racers,
// exactly ONE successful booking.
//
// Needs Postgres + Redis running (docker compose up postgres redis).
// Skips automatically when they are unreachable, so `go test ./...`
// is always safe to run.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
)

func TestNoOversellUnderRace(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	db, err := pgxpool.New(ctx, getenv("DATABASE_URL",
		"postgres://ticket:ticket@localhost:5432/ticket?sslmode=disable"))
	if err != nil || db.Ping(ctx) != nil {
		t.Skip("postgres unavailable — run: docker compose up postgres redis")
	}
	// Close via t.Cleanup, not defer: t.Cleanup funcs run in LIFO order AFTER
	// deferred calls, so registering the close first makes it run last — after
	// the data-cleanup below. (A defer here would close the pool before cleanup,
	// silently no-op'ing the deletes.)
	t.Cleanup(func() { db.Close() })

	rdb := redis.NewClient(&redis.Options{Addr: getenv("REDIS_ADDR", "localhost:6379")})
	if rdb.Ping(ctx).Err() != nil {
		t.Skip("redis unavailable — run: docker compose up postgres redis")
	}
	t.Cleanup(func() { rdb.Close() })

	a := &app{db: db, rdb: rdb, jwtSecret: []byte("test-secret"), holdTTL: time.Minute,
		accessTTL: 15 * time.Minute, refreshTTL: time.Hour, maxHeldSeats: 8}

	// Isolated fixture: fresh event with a single seat.
	var eventID, seatID string
	if err := db.QueryRow(ctx, `
		INSERT INTO events (name, starts_at)
		VALUES ('race-test', now() + interval '1 day')
		RETURNING id`).Scan(&eventID); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(ctx, `
		INSERT INTO seats (event_id, seat_no, price)
		VALUES ($1, 'RT1', 100)
		RETURNING id`, eventID).Scan(&seatID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		c := context.Background()
		db.Exec(c, `DELETE FROM order_items WHERE seat_id = $1`, seatID)
		db.Exec(c, `DELETE FROM orders WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'racer%@test.dev')`)
		db.Exec(c, `DELETE FROM seats WHERE id = $1`, seatID)
		db.Exec(c, `DELETE FROM events WHERE id = $1`, eventID)
		db.Exec(c, `DELETE FROM users WHERE email LIKE 'racer%@test.dev'`)
		rdb.Del(c, holdKey(eventID, seatID))
	})

	const racers = 200
	codes := make(chan int, racers)
	var wg sync.WaitGroup
	for i := 0; i < racers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()

			// Each racer is a distinct authenticated user (register = auto-login).
			lw := httptest.NewRecorder()
			loginBody, _ := json.Marshal(map[string]string{
				"email":    fmt.Sprintf("racer%d@test.dev", i),
				"password": "race-password-123",
			})
			a.register(lw, httptest.NewRequest("POST", "/api/register",
				bytes.NewReader(loginBody)))
			var lr struct {
				Token string `json:"access_token"`
			}
			if err := json.Unmarshal(lw.Body.Bytes(), &lr); err != nil || lr.Token == "" {
				codes <- 0
				return
			}

			bw := httptest.NewRecorder()
			bookBody, _ := json.Marshal(map[string]any{
				"event_id": eventID,
				"seat_ids": []string{seatID},
			})
			req := httptest.NewRequest("POST", "/api/bookings",
				bytes.NewReader(bookBody))
			req.Header.Set("Authorization", "Bearer "+lr.Token)
			a.auth(a.createBooking)(bw, req)
			codes <- bw.Code
		}(i)
	}
	wg.Wait()
	close(codes)

	success, conflict, other := 0, 0, 0
	for c := range codes {
		switch c {
		case 201:
			success++
		case 409:
			conflict++
		default:
			other++
		}
	}
	t.Logf("success=%d conflict=%d other=%d", success, conflict, other)
	if success != 1 {
		t.Fatalf("OVERSELL INVARIANT BROKEN: %d successful bookings for 1 seat (want exactly 1)", success)
	}
}
