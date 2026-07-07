package main

import (
	"context"
	"errors"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/redis/go-redis/v9"
)

type ctxKey string

const userIDKey ctxKey = "userID"

// isUUID validates path/body ids up front so a malformed id is a clean
// 400 instead of leaking a DB error as a 500.
var uuidRe = regexp.MustCompile(
	`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

func isUUID(s string) bool { return uuidRe.MatchString(s) }

// ---------------------------------------------------------------- auth
// Registration/login/refresh/logout live in auth.go. auth() below is the
// access-token middleware shared by every protected endpoint.

func (a *app) auth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		raw := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if raw == "" {
			writeErr(w, http.StatusUnauthorized, "missing_token")
			return
		}
		tok, err := jwt.Parse(raw, func(t *jwt.Token) (any, error) {
			if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
				return nil, errors.New("bad alg")
			}
			return a.jwtSecret, nil
		})
		if err != nil || !tok.Valid {
			writeErr(w, http.StatusUnauthorized, "invalid_token")
			return
		}
		sub, _ := tok.Claims.GetSubject()
		next(w, r.WithContext(context.WithValue(r.Context(), userIDKey, sub)))
	}
}

// ---------------------------------------------------------------- seats

// listSeats reads DB truth, then overlays live Redis holds so the UI
// can show HELD seats without any DB write.
func (a *app) listSeats(w http.ResponseWriter, r *http.Request) {
	eventID := r.PathValue("id")
	if !isUUID(eventID) {
		writeErr(w, http.StatusBadRequest, "bad_event_id")
		return
	}
	// Event header lets the UI show the name, sale status, and per-order seat cap.
	var evName, evStatus string
	var maxPer int
	if err := a.db.QueryRow(r.Context(),
		`SELECT name, status, max_seats_per_order FROM events WHERE id = $1`,
		eventID).Scan(&evName, &evStatus, &maxPer); err != nil {
		writeErr(w, http.StatusNotFound, "event_not_found")
		return
	}
	rows, err := a.db.Query(r.Context(), `
		SELECT id, seat_no, status, price
		FROM seats WHERE event_id = $1
		ORDER BY seat_no
		LIMIT 1000`, eventID)
	// LIMIT guards the endpoint against huge venues (our 1M-row demo
	// event included). Production: paginate by zone/section instead.
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_event")
		return
	}
	defer rows.Close()

	type seat struct {
		ID     string  `json:"id"`
		SeatNo string  `json:"seat_no"`
		Status string  `json:"status"`
		Price  float64 `json:"price"`
	}
	var seats []seat
	var keys []string
	for rows.Next() {
		var s seat
		if err := rows.Scan(&s.ID, &s.SeatNo, &s.Status, &s.Price); err != nil {
			writeErr(w, http.StatusInternalServerError, "db_error")
			return
		}
		seats = append(seats, s)
		keys = append(keys, holdKey(eventID, s.ID))
	}
	if len(keys) > 0 {
		if vals, err := a.rdb.MGet(r.Context(), keys...).Result(); err == nil {
			for i, v := range vals {
				if v != nil && seats[i].Status == "AVAILABLE" {
					seats[i].Status = "HELD"
				}
			}
		}
		// If Redis is down we degrade gracefully: seats render from DB
		// truth and booking (which requires Redis) will refuse — never oversell.
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"event": map[string]any{
			"id": eventID, "name": evName, "status": evStatus,
			"max_seats_per_order": maxPer,
		},
		"seats": seats,
	})
}

func holdKey(eventID, seatID string) string {
	return "hold:" + eventID + ":" + seatID
}

// listEvents returns the on-sale events for the customer picker (public).
func (a *app) listEvents(w http.ResponseWriter, r *http.Request) {
	rows, err := a.db.Query(r.Context(), `
		SELECT id, name, starts_at, sale_opens_at, max_seats_per_order
		FROM events
		WHERE status = 'ON_SALE'
		ORDER BY created_at`)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db_error")
		return
	}
	defer rows.Close()

	type event struct {
		ID               string    `json:"id"`
		Name             string    `json:"name"`
		StartsAt         time.Time `json:"starts_at"`
		SaleOpensAt      time.Time `json:"sale_opens_at"`
		MaxSeatsPerOrder int       `json:"max_seats_per_order"`
	}
	events := []event{}
	for rows.Next() {
		var e event
		if err := rows.Scan(&e.ID, &e.Name, &e.StartsAt, &e.SaleOpensAt, &e.MaxSeatsPerOrder); err != nil {
			writeErr(w, http.StatusInternalServerError, "db_error")
			return
		}
		events = append(events, e)
	}
	writeJSON(w, http.StatusOK, map[string]any{"events": events})
}

// ---------------------------------------------------------------- booking

// holdScript takes N seat keys and holds ALL of them or NONE (returns 0
// if any key already exists). Atomic because Redis runs Lua single-threaded.
var holdScript = redis.NewScript(`
for i, k in ipairs(KEYS) do
  if redis.call('EXISTS', k) == 1 then return 0 end
end
for i, k in ipairs(KEYS) do
  redis.call('SET', k, ARGV[1], 'EX', tonumber(ARGV[2]))
end
return 1`)

func (a *app) createBooking(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(userIDKey).(string)
	var body struct {
		EventID string   `json:"event_id"`
		SeatIDs []string `json:"seat_ids"`
	}
	if err := decodeJSON(w, r, &body); err != nil || body.EventID == "" {
		writeErr(w, http.StatusBadRequest, "bad_request")
		return
	}
	if n := len(body.SeatIDs); n < 1 || n > 20 {
		// Hard structural bound; the real per-event cap is checked below once we
		// know the event's max_seats_per_order.
		writeErr(w, http.StatusBadRequest, "seat_count_out_of_range")
		return
	}
	if !isUUID(body.EventID) {
		writeErr(w, http.StatusBadRequest, "bad_event_id")
		return
	}
	for _, s := range body.SeatIDs {
		if !isUUID(s) {
			writeErr(w, http.StatusBadRequest, "bad_seat_id")
			return
		}
	}
	// Deterministic ordering everywhere we touch multiple seats,
	// so two overlapping orders can never deadlock.
	sort.Strings(body.SeatIDs)

	// Server-side sale gate: the frontend clock is not a security boundary.
	var opensAt time.Time
	var evStatus string
	var maxPer int
	err := a.db.QueryRow(r.Context(),
		`SELECT sale_opens_at, status, max_seats_per_order FROM events WHERE id = $1`,
		body.EventID).Scan(&opensAt, &evStatus, &maxPer)
	if err != nil {
		writeErr(w, http.StatusNotFound, "event_not_found")
		return
	}

	// Demand log: record this attempt on a real event and its final outcome,
	// enqueued off the hot path (logAttempt is non-blocking). Defaults to ERROR;
	// each return below sets the real outcome before it fires.
	outcome := "ERROR"
	defer func() { a.logAttempt(userID, body.EventID, body.SeatIDs, outcome) }()

	if evStatus != "ON_SALE" || time.Now().Before(opensAt) {
		outcome = "SALE_NOT_OPEN"
		writeErr(w, http.StatusForbidden, "sale_not_open")
		return
	}
	if len(body.SeatIDs) > maxPer {
		outcome = "TOO_MANY_SEATS"
		writeErr(w, http.StatusBadRequest, "seat_count_exceeds_limit")
		return
	}

	// LAYER 1 — Redis atomic hold. Under a thundering herd the losers shed
	// here in ~1ms: they do only the one cheap indexed sale-gate read above,
	// then take a 409 from Redis — never the expensive booking transaction or
	// the per-user hold-cap join (which only the hold winner runs, below).
	keys := make([]string, len(body.SeatIDs))
	for i, s := range body.SeatIDs {
		keys[i] = holdKey(body.EventID, s)
	}
	ok, err := holdScript.Run(r.Context(), a.rdb, keys, userID, int(a.holdTTL.Seconds())).Int()
	if err != nil {
		writeErr(w, http.StatusServiceUnavailable, "booking_unavailable")
		return
	}
	if ok == 0 {
		outcome = "SEAT_TAKEN"
		writeErr(w, http.StatusConflict, "seat_taken")
		return
	}
	releaseHolds := func() { a.rdb.Del(context.Background(), keys...) }

	// Anti-hoarding: cap concurrent unpaid seats per user. Runs only for the
	// hold winner (losers already 409'd at Redis), keeping the join off the hot
	// loser path. Best-effort — a small TOCTOU race is acceptable here; the
	// oversell guarantee still rests on Layers 1+2, this only limits griefing.
	var heldNow int
	if err := a.db.QueryRow(r.Context(), `
		SELECT count(*) FROM order_items oi
		JOIN orders o ON o.id = oi.order_id
		WHERE o.user_id = $1 AND o.status = 'PENDING' AND o.expires_at > now()`,
		userID).Scan(&heldNow); err != nil {
		releaseHolds()
		writeErr(w, http.StatusInternalServerError, "db_error")
		return
	}
	if heldNow+len(body.SeatIDs) > a.maxHeldSeats {
		releaseHolds()
		outcome = "HOLD_LIMIT"
		writeErr(w, http.StatusTooManyRequests, "hold_limit_exceeded")
		return
	}

	// LAYER 2 — Postgres. Pending order + order_items. The UNIQUE index
	// on order_items(seat_id) is the last line of defense even if Redis
	// ever failed us.
	expiresAt := time.Now().Add(a.holdTTL)
	tx, err := a.db.Begin(r.Context())
	if err != nil {
		releaseHolds()
		writeErr(w, http.StatusInternalServerError, "db_error")
		return
	}
	defer tx.Rollback(r.Context())

	var orderID string
	err = tx.QueryRow(r.Context(), `
		INSERT INTO orders (user_id, status, expires_at)
		VALUES ($1, 'PENDING', $2) RETURNING id`,
		userID, expiresAt).Scan(&orderID)
	if err != nil {
		releaseHolds()
		writeErr(w, http.StatusInternalServerError, "db_error")
		return
	}

	tag, err := tx.Exec(r.Context(), `
		INSERT INTO order_items (order_id, seat_id, price)
		SELECT $1, s.id, s.price
		FROM seats s
		WHERE s.id = ANY($2::uuid[])
		  AND s.event_id = $3
		  AND s.status = 'AVAILABLE'`,
		orderID, body.SeatIDs, body.EventID)
	if err != nil {
		releaseHolds()
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" { // unique_violation
			outcome = "SEAT_TAKEN"
			writeErr(w, http.StatusConflict, "seat_taken")
			return
		}
		writeErr(w, http.StatusInternalServerError, "db_error")
		return
	}
	if int(tag.RowsAffected()) != len(body.SeatIDs) {
		// Some seat was SOLD or belongs to another event: all-or-nothing.
		releaseHolds()
		outcome = "SEAT_TAKEN"
		writeErr(w, http.StatusConflict, "seat_taken")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		releaseHolds()
		writeErr(w, http.StatusInternalServerError, "db_error")
		return
	}

	outcome = "SUCCESS"
	writeJSON(w, http.StatusCreated, map[string]any{
		"order_id":   orderID,
		"expires_at": expiresAt.UTC().Format(time.RFC3339),
	})
}

// listOrders backs the "my bookings" page — served by idx_orders_user.
func (a *app) listOrders(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(userIDKey).(string)
	rows, err := a.db.Query(r.Context(), `
		SELECT o.id, o.status, o.created_at,
		       COALESCE(sum(oi.price), 0) AS amount,
		       COALESCE(string_agg(s.seat_no, ', ' ORDER BY s.seat_no), '') AS seat_nos
		FROM orders o
		LEFT JOIN order_items oi ON oi.order_id = o.id
		LEFT JOIN seats s ON s.id = oi.seat_id
		WHERE o.user_id = $1
		GROUP BY o.id
		ORDER BY o.created_at DESC
		LIMIT 20`, userID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db_error")
		return
	}
	defer rows.Close()

	type order struct {
		ID        string    `json:"id"`
		Status    string    `json:"status"`
		CreatedAt time.Time `json:"created_at"`
		Amount    float64   `json:"amount"`
		SeatNos   string    `json:"seat_nos"`
	}
	orders := []order{}
	for rows.Next() {
		var o order
		if err := rows.Scan(&o.ID, &o.Status, &o.CreatedAt, &o.Amount, &o.SeatNos); err != nil {
			writeErr(w, http.StatusInternalServerError, "db_error")
			return
		}
		orders = append(orders, o)
	}
	writeJSON(w, http.StatusOK, map[string]any{"orders": orders})
}

// ---------------------------------------------------------------- payment

// payOrder is a mock gateway, but the idempotency contract is real:
// same Idempotency-Key = same result, charged once.
func (a *app) payOrder(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(userIDKey).(string)
	orderID := r.PathValue("id")
	if !isUUID(orderID) {
		writeErr(w, http.StatusBadRequest, "bad_order_id")
		return
	}
	idemKey := r.Header.Get("Idempotency-Key")
	if idemKey == "" {
		writeErr(w, http.StatusBadRequest, "idempotency_key_required")
		return
	}

	tx, err := a.db.Begin(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db_error")
		return
	}
	defer tx.Rollback(r.Context())

	// Replay? Return the original outcome without touching anything. Scope the
	// lookup to this order so a key can only replay the payment it actually made;
	// the same key reused against a *different* order falls through and is caught
	// by the UNIQUE(idempotency_key) insert below (409 duplicate_payment).
	var prevStatus string
	err = tx.QueryRow(r.Context(),
		`SELECT status FROM payments WHERE idempotency_key = $1 AND order_id = $2`,
		idemKey, orderID).Scan(&prevStatus)
	if err == nil {
		writeJSON(w, http.StatusOK, map[string]string{
			"order_id": orderID, "payment_status": prevStatus, "replayed": "true"})
		return
	} else if !errors.Is(err, pgx.ErrNoRows) {
		writeErr(w, http.StatusInternalServerError, "db_error")
		return
	}

	var status string
	var expiresAt time.Time
	err = tx.QueryRow(r.Context(), `
		SELECT status, expires_at FROM orders
		WHERE id = $1 AND user_id = $2
		FOR UPDATE`, orderID, userID).Scan(&status, &expiresAt)
	if errors.Is(err, pgx.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "order_not_found")
		return
	} else if err != nil {
		writeErr(w, http.StatusInternalServerError, "db_error")
		return
	}
	if status == "PAID" {
		writeJSON(w, http.StatusOK, map[string]string{"order_id": orderID, "payment_status": "SUCCEEDED"})
		return
	}
	if status != "PENDING" || time.Now().After(expiresAt) {
		writeErr(w, http.StatusGone, "order_expired")
		return
	}

	// Optimistic confirm: only flip seats that are still AVAILABLE. A row-count
	// mismatch means someone raced us, so we roll back. Guard seatCount > 0 so a
	// scan error (which would leave it 0) can't make a 0-row UPDATE look like a
	// valid confirm and mark an item-less order PAID.
	var seatCount int
	if err := tx.QueryRow(r.Context(),
		`SELECT count(*) FROM order_items WHERE order_id = $1`, orderID).Scan(&seatCount); err != nil || seatCount == 0 {
		writeErr(w, http.StatusInternalServerError, "db_error")
		return
	}

	tag, err := tx.Exec(r.Context(), `
		UPDATE seats SET status = 'SOLD'
		WHERE id IN (SELECT seat_id FROM order_items WHERE order_id = $1)
		  AND status = 'AVAILABLE'`, orderID)
	if err != nil || int(tag.RowsAffected()) != seatCount {
		writeErr(w, http.StatusConflict, "seat_no_longer_available")
		return
	}

	var amount float64
	tx.QueryRow(r.Context(),
		`SELECT COALESCE(sum(price),0) FROM order_items WHERE order_id = $1`,
		orderID).Scan(&amount)

	_, err = tx.Exec(r.Context(), `
		INSERT INTO payments (order_id, idempotency_key, status, amount)
		VALUES ($1, $2, 'SUCCEEDED', $3)`, orderID, idemKey, amount)
	if err != nil {
		writeErr(w, http.StatusConflict, "duplicate_payment")
		return
	}
	if _, err := tx.Exec(r.Context(),
		`UPDATE orders SET status = 'PAID' WHERE id = $1`, orderID); err != nil {
		writeErr(w, http.StatusInternalServerError, "db_error")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeErr(w, http.StatusInternalServerError, "db_error")
		return
	}

	// Release Redis holds early (they'd expire anyway).
	a.clearHoldsForOrder(orderID)

	writeJSON(w, http.StatusOK, map[string]any{
		"order_id": orderID, "payment_status": "SUCCEEDED", "amount": amount,
	})
}

// ---------------------------------------------------------------- cancel

func (a *app) cancelOrder(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(userIDKey).(string)
	orderID := r.PathValue("id")
	if !isUUID(orderID) {
		writeErr(w, http.StatusBadRequest, "bad_order_id")
		return
	}

	tx, err := a.db.Begin(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db_error")
		return
	}
	defer tx.Rollback(r.Context())

	var status string
	err = tx.QueryRow(r.Context(), `
		SELECT status FROM orders WHERE id = $1 AND user_id = $2
		FOR UPDATE`, orderID, userID).Scan(&status)
	if errors.Is(err, pgx.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "order_not_found")
		return
	} else if err != nil {
		writeErr(w, http.StatusInternalServerError, "db_error")
		return
	}
	if status != "PENDING" {
		writeErr(w, http.StatusConflict, "not_cancellable")
		return
	}

	// Collect hold keys BEFORE deleting the items that point to them.
	var keys []string
	rows, err := tx.Query(r.Context(), `
		SELECT s.event_id, oi.seat_id
		FROM order_items oi JOIN seats s ON s.id = oi.seat_id
		WHERE oi.order_id = $1`, orderID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db_error")
		return
	}
	for rows.Next() {
		var eventID, seatID string
		if rows.Scan(&eventID, &seatID) == nil {
			keys = append(keys, holdKey(eventID, seatID))
		}
	}
	rows.Close()

	if _, err := tx.Exec(r.Context(),
		`DELETE FROM order_items WHERE order_id = $1`, orderID); err != nil {
		writeErr(w, http.StatusInternalServerError, "db_error")
		return
	}
	if _, err := tx.Exec(r.Context(),
		`UPDATE orders SET status = 'CANCELLED' WHERE id = $1`, orderID); err != nil {
		writeErr(w, http.StatusInternalServerError, "db_error")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeErr(w, http.StatusInternalServerError, "db_error")
		return
	}
	if len(keys) > 0 {
		a.rdb.Del(context.Background(), keys...)
	}
	writeJSON(w, http.StatusOK, map[string]string{"order_id": orderID, "status": "CANCELLED"})
}

// clearHoldsForOrder deletes Redis hold keys for an order's seats.
// Called after commit/cancel; failures are harmless (TTL cleans up).
func (a *app) clearHoldsForOrder(orderID string) {
	ctx := context.Background()
	rows, err := a.db.Query(ctx, `
		SELECT s.event_id, oi.seat_id
		FROM order_items oi JOIN seats s ON s.id = oi.seat_id
		WHERE oi.order_id = $1`, orderID)
	if err != nil {
		return
	}
	defer rows.Close()
	var keys []string
	for rows.Next() {
		var eventID, seatID string
		if rows.Scan(&eventID, &seatID) == nil {
			keys = append(keys, holdKey(eventID, seatID))
		}
	}
	if len(keys) > 0 {
		a.rdb.Del(ctx, keys...)
	}
}
