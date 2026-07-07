package main

// Edge-case integration tests for the booking lifecycle.
//
// Like booking_test.go these hit real Postgres + Redis (docker compose up
// postgres redis) and skip automatically when they are unreachable. Each test
// seeds its own isolated event/seats/users and cleans them up, so the suite is
// order-independent and re-runnable.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
)

// ---------------------------------------------------------------- harness

type testEnv struct {
	t   *testing.T
	a   *app
	ctx context.Context

	eventIDs []string
	seatIDs  []string
	orderIDs []string
	userIDs  []string
	holdKeys []string
}

func newTestEnv(t *testing.T) *testEnv {
	t.Helper()
	ctx := context.Background()

	db, err := pgxpool.New(ctx, getenv("DATABASE_URL",
		"postgres://ticket:ticket@localhost:5432/ticket?sslmode=disable"))
	if err != nil || db.Ping(ctx) != nil {
		t.Skip("postgres unavailable — run: docker compose up postgres redis")
	}
	rdb := redis.NewClient(&redis.Options{Addr: getenv("REDIS_ADDR", "localhost:6379")})
	if rdb.Ping(ctx).Err() != nil {
		db.Close()
		t.Skip("redis unavailable — run: docker compose up postgres redis")
	}

	e := &testEnv{
		t:   t,
		ctx: ctx,
		a: &app{db: db, rdb: rdb, jwtSecret: []byte("test-secret"),
			holdTTL: 10 * time.Minute, accessTTL: 15 * time.Minute,
			refreshTTL: 24 * time.Hour, maxHeldSeats: 8},
	}
	t.Cleanup(func() {
		c := context.Background()
		db.Exec(c, `DELETE FROM payments WHERE order_id = ANY($1)`, e.orderIDs)
		db.Exec(c, `DELETE FROM order_items WHERE order_id = ANY($1)`, e.orderIDs)
		db.Exec(c, `DELETE FROM orders WHERE id = ANY($1)`, e.orderIDs)
		db.Exec(c, `DELETE FROM booking_attempts WHERE event_id = ANY($1)`, e.eventIDs)
		db.Exec(c, `DELETE FROM seats WHERE id = ANY($1)`, e.seatIDs)
		db.Exec(c, `DELETE FROM seats WHERE event_id = ANY($1)`, e.eventIDs) // admin-created seats
		db.Exec(c, `DELETE FROM events WHERE id = ANY($1)`, e.eventIDs)
		db.Exec(c, `DELETE FROM users WHERE id = ANY($1)`, e.userIDs)
		if len(e.holdKeys) > 0 {
			rdb.Del(c, e.holdKeys...)
		}
		rdb.Close()
		db.Close()
	})
	return e
}

// seedEvent inserts an event plus seatCount AVAILABLE seats and returns their ids.
func (e *testEnv) seedEvent(seatCount int, saleOpensAt time.Time, status string) (string, []string) {
	e.t.Helper()
	var eventID string
	if err := e.a.db.QueryRow(e.ctx, `
		INSERT INTO events (name, starts_at, sale_opens_at, status)
		VALUES ('edge-test', now() + interval '1 day', $1, $2)
		RETURNING id`, saleOpensAt, status).Scan(&eventID); err != nil {
		e.t.Fatal(err)
	}
	e.eventIDs = append(e.eventIDs, eventID)

	seatIDs := make([]string, seatCount)
	for i := 0; i < seatCount; i++ {
		var sid string
		if err := e.a.db.QueryRow(e.ctx, `
			INSERT INTO seats (event_id, seat_no, price)
			VALUES ($1, $2, 100) RETURNING id`,
			eventID, fmt.Sprintf("S%d", i+1)).Scan(&sid); err != nil {
			e.t.Fatal(err)
		}
		seatIDs[i] = sid
		e.seatIDs = append(e.seatIDs, sid)
		e.holdKeys = append(e.holdKeys, holdKey(eventID, sid))
	}
	return eventID, seatIDs
}

func decodeBody(w *httptest.ResponseRecorder) map[string]any {
	m := map[string]any{}
	_ = json.Unmarshal(w.Body.Bytes(), &m)
	return m
}

// login registers a fresh user (password auth) and returns an access token.
// Named login for brevity; each test uses a unique email, cleaned up on teardown.
func (e *testEnv) login(email string) string {
	e.t.Helper()
	body, _ := json.Marshal(map[string]string{"email": email, "password": "test-password-123"})
	w := httptest.NewRecorder()
	e.a.register(w, httptest.NewRequest("POST", "/api/register", bytes.NewReader(body)))
	m := decodeBody(w)
	if id, ok := m["user_id"].(string); ok {
		e.userIDs = append(e.userIDs, id)
	}
	tok, _ := m["access_token"].(string)
	if tok == "" {
		e.t.Fatalf("register failed: %v", m)
	}
	return tok
}

func (e *testEnv) book(token, eventID string, seatIDs []string) (int, map[string]any) {
	e.t.Helper()
	body, _ := json.Marshal(map[string]any{"event_id": eventID, "seat_ids": seatIDs})
	req := httptest.NewRequest("POST", "/api/bookings", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	e.a.auth(e.a.createBooking)(w, req)
	m := decodeBody(w)
	if id, ok := m["order_id"].(string); ok {
		e.orderIDs = append(e.orderIDs, id)
	}
	return w.Code, m
}

func (e *testEnv) pay(token, orderID, idemKey string) (int, map[string]any) {
	e.t.Helper()
	req := httptest.NewRequest("POST", "/api/orders/"+orderID+"/pay", nil)
	req.SetPathValue("id", orderID) // Go 1.22: set the path value the mux would inject
	req.Header.Set("Authorization", "Bearer "+token)
	if idemKey != "" {
		req.Header.Set("Idempotency-Key", idemKey)
	}
	w := httptest.NewRecorder()
	e.a.auth(e.a.payOrder)(w, req)
	return w.Code, decodeBody(w)
}

func (e *testEnv) cancel(token, orderID string) (int, map[string]any) {
	e.t.Helper()
	req := httptest.NewRequest("DELETE", "/api/orders/"+orderID, nil)
	req.SetPathValue("id", orderID)
	req.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	e.a.auth(e.a.cancelOrder)(w, req)
	return w.Code, decodeBody(w)
}

func (e *testEnv) listSeats(eventID string) int {
	e.t.Helper()
	// Use a placeholder URL (the raw id may not be URL-valid); the handler only
	// reads PathValue, which we set directly.
	req := httptest.NewRequest("GET", "/api/events/x/seats", nil)
	req.SetPathValue("id", eventID)
	w := httptest.NewRecorder()
	e.a.listSeats(w, req)
	return w.Code
}

func (e *testEnv) scalar(dest any, sql string, args ...any) {
	e.t.Helper()
	if err := e.a.db.QueryRow(e.ctx, sql, args...).Scan(dest); err != nil {
		e.t.Fatalf("query %q: %v", sql, err)
	}
}

// ---------------------------------------------------------------- tests

// A failed multi-seat booking must leave the *other* seats untouched:
// Redis holds all-or-nothing, so a conflict never strands a partial hold.
func TestMultiSeatAllOrNothing(t *testing.T) {
	e := newTestEnv(t)
	eventID, seats := e.seedEvent(2, time.Now().Add(-time.Hour), "ON_SALE")
	s1, s2 := seats[0], seats[1]

	if code, _ := e.book(e.login("u1@edge.dev"), eventID, []string{s1}); code != 201 {
		t.Fatalf("first booking of S1: want 201, got %d", code)
	}
	// U2 tries S1+S2 together — S1 is taken, so the whole order must fail.
	if code, body := e.book(e.login("u2@edge.dev"), eventID, []string{s1, s2}); code != 409 {
		t.Fatalf("multi-seat with taken S1: want 409, got %d (%v)", code, body)
	}
	// Proof S2 was never held by the failed order: U3 can still book it alone.
	if code, _ := e.book(e.login("u3@edge.dev"), eventID, []string{s2}); code != 201 {
		t.Fatalf("S2 should remain free after all-or-nothing failure: want 201, got %d", code)
	}
}

// The server-side sale gate rejects bookings before open time and for events
// that are not ON_SALE — the frontend clock is not trusted.
func TestSaleGate(t *testing.T) {
	e := newTestEnv(t)
	token := e.login("gate@edge.dev")

	futureEvent, futureSeats := e.seedEvent(1, time.Now().Add(time.Hour), "ON_SALE")
	if code, body := e.book(token, futureEvent, futureSeats); code != 403 {
		t.Fatalf("booking before sale opens: want 403, got %d (%v)", code, body)
	}

	closedEvent, closedSeats := e.seedEvent(1, time.Now().Add(-time.Hour), "CLOSED")
	if code, body := e.book(token, closedEvent, closedSeats); code != 403 {
		t.Fatalf("booking a non-ON_SALE event: want 403, got %d (%v)", code, body)
	}
}

// Booking accepts 1..4 seats; 0 and 5 are rejected up front.
func TestSeatCountValidation(t *testing.T) {
	e := newTestEnv(t)
	eventID, seats := e.seedEvent(5, time.Now().Add(-time.Hour), "ON_SALE")
	token := e.login("count@edge.dev")

	if code, _ := e.book(token, eventID, []string{}); code != 400 {
		t.Fatalf("0 seats: want 400, got %d", code)
	}
	if code, _ := e.book(token, eventID, seats); code != 400 { // all 5
		t.Fatalf("5 seats: want 400, got %d", code)
	}
}

// Paying twice with the same Idempotency-Key charges exactly once; the replay
// returns the original outcome.
func TestPaymentIdempotency(t *testing.T) {
	e := newTestEnv(t)
	eventID, seats := e.seedEvent(1, time.Now().Add(-time.Hour), "ON_SALE")
	token := e.login("pay@edge.dev")

	_, book := e.book(token, eventID, seats)
	orderID := book["order_id"].(string)

	code, first := e.pay(token, orderID, "idem-key-1")
	if code != 200 || first["payment_status"] != "SUCCEEDED" {
		t.Fatalf("first pay: want 200 SUCCEEDED, got %d (%v)", code, first)
	}
	code, replay := e.pay(token, orderID, "idem-key-1")
	if code != 200 || replay["replayed"] != "true" {
		t.Fatalf("replayed pay: want 200 replayed=true, got %d (%v)", code, replay)
	}

	var payments, sold int
	e.scalar(&payments, `SELECT count(*) FROM payments WHERE order_id = $1`, orderID)
	if payments != 1 {
		t.Fatalf("charged %d times, want exactly 1", payments)
	}
	e.scalar(&sold, `SELECT count(*) FROM seats WHERE id = ANY($1) AND status = 'SOLD'`, seats)
	if sold != 1 {
		t.Fatalf("seat not marked SOLD after payment (sold=%d)", sold)
	}
	var orderStatus string
	e.scalar(&orderStatus, `SELECT status FROM orders WHERE id = $1`, orderID)
	if orderStatus != "PAID" {
		t.Fatalf("order status = %q, want PAID", orderStatus)
	}
}

// Paying an order whose hold has already expired is rejected with 410.
func TestPayAfterExpiry(t *testing.T) {
	e := newTestEnv(t)
	eventID, seats := e.seedEvent(1, time.Now().Add(-time.Hour), "ON_SALE")
	token := e.login("expire-pay@edge.dev")

	_, book := e.book(token, eventID, seats)
	orderID := book["order_id"].(string)

	// Force the hold to have already lapsed.
	if _, err := e.a.db.Exec(e.ctx,
		`UPDATE orders SET expires_at = now() - interval '1 minute' WHERE id = $1`, orderID); err != nil {
		t.Fatal(err)
	}
	if code, body := e.pay(token, orderID, "idem-expired"); code != 410 {
		t.Fatalf("pay after expiry: want 410, got %d (%v)", code, body)
	}
}

// The expiry worker flips overdue PENDING orders to EXPIRED, deletes their
// order_items (releasing the seat) and reports the count released.
func TestExpiryWorkerReleasesSeat(t *testing.T) {
	e := newTestEnv(t)
	eventID, seats := e.seedEvent(1, time.Now().Add(-time.Hour), "ON_SALE")

	_, book := e.book(e.login("expire@edge.dev"), eventID, seats)
	orderID := book["order_id"].(string)

	if _, err := e.a.db.Exec(e.ctx,
		`UPDATE orders SET expires_at = now() - interval '1 minute' WHERE id = $1`, orderID); err != nil {
		t.Fatal(err)
	}

	released, err := e.a.expireOverdueOrders(e.ctx)
	if err != nil {
		t.Fatal(err)
	}
	if released < 1 {
		t.Fatalf("expireOverdueOrders released %d seats, want >= 1", released)
	}

	var status string
	e.scalar(&status, `SELECT status FROM orders WHERE id = $1`, orderID)
	if status != "EXPIRED" {
		t.Fatalf("order status = %q, want EXPIRED", status)
	}
	var items int
	e.scalar(&items, `SELECT count(*) FROM order_items WHERE order_id = $1`, orderID)
	if items != 0 {
		t.Fatalf("order_items not released (count=%d)", items)
	}

	// The DB guard is released; clear the (still-live) Redis hold to simulate
	// its TTL lapsing, then confirm the seat is bookable again.
	e.a.rdb.Del(e.ctx, holdKey(eventID, seats[0]))
	if code, _ := e.book(e.login("rebook@edge.dev"), eventID, seats); code != 201 {
		t.Fatalf("rebooking a released seat: want 201, got %d", code)
	}
}

// Cancelling a PENDING order releases its seat and is not repeatable.
func TestCancelReleasesAndIsFinal(t *testing.T) {
	e := newTestEnv(t)
	eventID, seats := e.seedEvent(1, time.Now().Add(-time.Hour), "ON_SALE")
	owner := e.login("cancel@edge.dev")

	_, book := e.book(owner, eventID, seats)
	orderID := book["order_id"].(string)

	if code, body := e.cancel(owner, orderID); code != 200 {
		t.Fatalf("cancel PENDING order: want 200, got %d (%v)", code, body)
	}
	var status string
	e.scalar(&status, `SELECT status FROM orders WHERE id = $1`, orderID)
	if status != "CANCELLED" {
		t.Fatalf("order status = %q, want CANCELLED", status)
	}

	// Seat released (cancel clears the Redis hold too): someone else can book it.
	if code, _ := e.book(e.login("after-cancel@edge.dev"), eventID, seats); code != 201 {
		t.Fatalf("rebooking after cancel: want 201, got %d", code)
	}
	// Cancelling again is a conflict, not a silent success.
	if code, _ := e.cancel(owner, orderID); code != 409 {
		t.Fatalf("second cancel: want 409, got %d", code)
	}
}

// Anti-hoarding: one user cannot hold more than maxHeldSeats unpaid seats.
func TestHoldCapPerUser(t *testing.T) {
	e := newTestEnv(t)
	e.a.maxHeldSeats = 8
	eventID, seats := e.seedEvent(10, time.Now().Add(-time.Hour), "ON_SALE")
	token := e.login("hoarder@edge.dev")

	if code, _ := e.book(token, eventID, seats[0:4]); code != 201 {
		t.Fatalf("first 4-seat hold: want 201, got %d", code)
	}
	if code, _ := e.book(token, eventID, seats[4:8]); code != 201 {
		t.Fatalf("second 4-seat hold (=8 held): want 201, got %d", code)
	}
	// 9th seat would exceed the cap of 8.
	if code, body := e.book(token, eventID, seats[8:9]); code != 429 {
		t.Fatalf("hold beyond cap: want 429, got %d (%v)", code, body)
	}
	// A different user is unaffected by the first user's holds.
	if code, _ := e.book(e.login("other@edge.dev"), eventID, seats[8:9]); code != 201 {
		t.Fatalf("different user within cap: want 201, got %d", code)
	}
}

// listSeats rejects a non-UUID event id instead of returning 200 with no data.
func TestListSeatsRejectsBadEventID(t *testing.T) {
	e := newTestEnv(t)
	eventID, _ := e.seedEvent(1, time.Now().Add(-time.Hour), "ON_SALE")
	if code := e.listSeats("' OR '1'='1"); code != 400 {
		t.Fatalf("malformed event id: want 400, got %d", code)
	}
	if code := e.listSeats(eventID); code != 200 {
		t.Fatalf("valid event id: want 200, got %d", code)
	}
}

// A PAID order cannot be cancelled.
func TestPaidOrderNotCancellable(t *testing.T) {
	e := newTestEnv(t)
	eventID, seats := e.seedEvent(1, time.Now().Add(-time.Hour), "ON_SALE")
	owner := e.login("paid@edge.dev")

	_, book := e.book(owner, eventID, seats)
	orderID := book["order_id"].(string)
	if code, _ := e.pay(owner, orderID, "idem-paid"); code != 200 {
		t.Fatalf("pay: want 200, got %d", code)
	}
	if code, body := e.cancel(owner, orderID); code != 409 {
		t.Fatalf("cancel PAID order: want 409, got %d (%v)", code, body)
	}
}
