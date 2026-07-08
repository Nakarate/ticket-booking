package main

import (
	"context"
	"net/http"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"
)

// Admin content management: create events (shows/rounds), open or close their
// sale, set the per-order seat cap, and see live sales stats. Every endpoint is
// behind adminAuth. None of it touches the booking hot path or the oversell
// guard — creating an event is isolated INSERTs, and the per-order cap only
// bounds a request further.

// ensureAdmin upserts the bootstrap admin from ADMIN_EMAIL/ADMIN_PASSWORD on
// boot (no-op if unset). Lets the demo ship one admin without a hand-hashed seed.
func (a *app) ensureAdmin(ctx context.Context) error {
	email := normalizeEmail(getenv("ADMIN_EMAIL", ""))
	pass := getenv("ADMIN_PASSWORD", "")
	if email == "" || pass == "" {
		return nil
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(pass), bcrypt.DefaultCost)
	if err != nil {
		return err
	}
	_, err = a.db.Exec(ctx, `
		INSERT INTO users (email, password_hash, is_admin) VALUES ($1, $2, true)
		ON CONFLICT (email) DO UPDATE SET is_admin = true, password_hash = EXCLUDED.password_hash`,
		email, string(hash))
	return err
}

// adminAuth runs the normal access-token check, then requires the user to be an
// admin. Kept as a DB lookup (not a token claim) so admin can be granted/revoked
// without waiting for tokens to expire.
func (a *app) adminAuth(next http.HandlerFunc) http.HandlerFunc {
	return a.auth(func(w http.ResponseWriter, r *http.Request) {
		userID := r.Context().Value(userIDKey).(string)
		var isAdmin bool
		if err := a.db.QueryRow(r.Context(),
			`SELECT is_admin FROM users WHERE id = $1`, userID).Scan(&isAdmin); err != nil || !isAdmin {
			writeErr(w, http.StatusForbidden, "admin_only")
			return
		}
		next(w, r)
	})
}

// GET /api/admin/events — every event with live sales stats for the dashboard.
func (a *app) listAdminEvents(w http.ResponseWriter, r *http.Request) {
	rows, err := a.db.Query(r.Context(), `
		SELECT e.id, e.name, e.starts_at, e.sale_opens_at, e.status, e.max_seats_per_order,
		       e.series_id, e.series_name, e.venue,
		       count(s.id)                                        AS total,
		       count(s.id) FILTER (WHERE s.status = 'SOLD')       AS sold,
		       count(s.id) FILTER (WHERE s.status = 'AVAILABLE')  AS available,
		       COALESCE(sum(s.price) FILTER (WHERE s.status = 'SOLD'), 0) AS revenue
		FROM events e
		LEFT JOIN seats s ON s.event_id = e.id
		WHERE NOT e.internal
		GROUP BY e.id
		ORDER BY e.series_id NULLS FIRST, e.starts_at`)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db_error")
		return
	}
	defer rows.Close()

	type adminEvent struct {
		ID               string    `json:"id"`
		Name             string    `json:"name"`
		StartsAt         time.Time `json:"starts_at"`
		SaleOpensAt      time.Time `json:"sale_opens_at"`
		Status           string    `json:"status"`
		MaxSeatsPerOrder int       `json:"max_seats_per_order"`
		SeriesID         *string   `json:"series_id"`
		SeriesName       *string   `json:"series_name"`
		Venue            *string   `json:"venue"`
		Total            int       `json:"total"`
		Sold             int       `json:"sold"`
		Available        int       `json:"available"`
		Revenue          float64   `json:"revenue"`
	}
	events := []adminEvent{}
	for rows.Next() {
		var e adminEvent
		if err := rows.Scan(&e.ID, &e.Name, &e.StartsAt, &e.SaleOpensAt, &e.Status,
			&e.MaxSeatsPerOrder, &e.SeriesID, &e.SeriesName, &e.Venue,
			&e.Total, &e.Sold, &e.Available, &e.Revenue); err != nil {
			writeErr(w, http.StatusInternalServerError, "db_error")
			return
		}
		events = append(events, e)
	}
	writeJSON(w, http.StatusOK, map[string]any{"events": events})
}

// POST /api/admin/events — create an event (a show/round) and generate its seat
// map in one transaction. Seats are rows A.. × 1..seatsPerRow; the first
// premiumRows rows get premiumPrice, the rest get price.
func (a *app) createAdminEvent(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name             string  `json:"name"`
		StartsAt         string  `json:"starts_at"`      // RFC3339
		SaleOpensAt      string  `json:"sale_opens_at"`  // RFC3339, optional -> now
		Status           string  `json:"status"`         // ON_SALE | CLOSED, default ON_SALE
		Rows             int     `json:"rows"`
		SeatsPerRow      int     `json:"seats_per_row"`
		Price            float64 `json:"price"`
		PremiumRows      int     `json:"premium_rows"`   // optional
		PremiumPrice     float64 `json:"premium_price"`  // optional
		MaxSeatsPerOrder int     `json:"max_seats_per_order"`
		SeriesID         string  `json:"series_id"`   // optional — join an existing production directly
		SeriesName       string  `json:"series_name"` // optional — name for a NEW production
		Venue            string  `json:"venue"`       // optional
	}
	if err := decodeJSON(w, r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request")
		return
	}

	if body.Name == "" {
		writeErr(w, http.StatusBadRequest, "name_required")
		return
	}
	if body.Rows < 1 || body.Rows > 26 || body.SeatsPerRow < 1 || body.SeatsPerRow > 60 {
		writeErr(w, http.StatusBadRequest, "bad_layout") // rows A..Z, up to 60 per row
		return
	}
	if body.Rows*body.SeatsPerRow > 2000 {
		writeErr(w, http.StatusBadRequest, "too_many_seats") // keep the demo insert bounded
		return
	}
	if body.Price <= 0 {
		writeErr(w, http.StatusBadRequest, "bad_price")
		return
	}
	startsAt, err := time.Parse(time.RFC3339, body.StartsAt)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_starts_at")
		return
	}
	saleOpensAt := time.Now()
	if body.SaleOpensAt != "" {
		if saleOpensAt, err = time.Parse(time.RFC3339, body.SaleOpensAt); err != nil {
			writeErr(w, http.StatusBadRequest, "bad_sale_opens_at")
			return
		}
	}
	status := body.Status
	if status == "" {
		status = "ON_SALE"
	}
	if status != "ON_SALE" && status != "CLOSED" {
		writeErr(w, http.StatusBadRequest, "bad_status")
		return
	}
	maxPer := body.MaxSeatsPerOrder
	if maxPer <= 0 {
		maxPer = 4
	}
	if maxPer > 20 {
		writeErr(w, http.StatusBadRequest, "max_seats_per_order_too_high")
		return
	}
	premiumPrice := body.PremiumPrice
	if premiumPrice <= 0 {
		premiumPrice = body.Price
	}
	if body.PremiumRows < 0 || body.PremiumRows > body.Rows {
		writeErr(w, http.StatusBadRequest, "bad_premium_rows")
		return
	}

	tx, err := a.db.Begin(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db_error")
		return
	}
	defer tx.Rollback(r.Context())

	// Grouping into a production: pick series_id to join an existing one exactly
	// (no fragile name matching), or series_name to start a new one. Empty = standalone.
	seriesID := strings.TrimSpace(body.SeriesID)
	series := strings.TrimSpace(body.SeriesName)
	venue := strings.TrimSpace(body.Venue)
	if seriesID != "" && !isUUID(seriesID) {
		writeErr(w, http.StatusBadRequest, "bad_series_id")
		return
	}
	var eventID string
	if err := tx.QueryRow(r.Context(), `
		INSERT INTO events (name, starts_at, sale_opens_at, status, max_seats_per_order,
		                    series_id, series_name, venue)
		VALUES ($1, $2, $3, $4, $5,
		        CASE WHEN $6 <> '' THEN $6::uuid
		             WHEN $7 <> '' THEN gen_random_uuid()
		             ELSE NULL END,
		        CASE WHEN $6 <> '' THEN (SELECT series_name FROM events WHERE series_id = $6::uuid LIMIT 1)
		             WHEN $7 <> '' THEN $7
		             ELSE NULL END,
		        CASE WHEN $6 <> '' THEN (SELECT venue FROM events WHERE series_id = $6::uuid LIMIT 1)
		             WHEN $7 <> '' THEN NULLIF($8, '')
		             ELSE NULL END)
		RETURNING id`,
		body.Name, startsAt, saleOpensAt, status, maxPer, seriesID, series, venue).Scan(&eventID); err != nil {
		writeErr(w, http.StatusInternalServerError, "db_error")
		return
	}

	// Generate the seat map: seat_no = <row letter><col>, first premiumRows rows priced up.
	if _, err := tx.Exec(r.Context(), `
		INSERT INTO seats (event_id, seat_no, price)
		SELECT $1, chr((64 + r)::int) || c, CASE WHEN r <= $4 THEN $5::float8 ELSE $6::float8 END
		FROM generate_series(1, $2) AS r, generate_series(1, $3) AS c`,
		eventID, body.Rows, body.SeatsPerRow, body.PremiumRows, premiumPrice, body.Price); err != nil {
		writeErr(w, http.StatusInternalServerError, "db_error")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeErr(w, http.StatusInternalServerError, "db_error")
		return
	}

	writeJSON(w, http.StatusCreated, map[string]any{
		"event_id":   eventID,
		"seat_count": body.Rows * body.SeatsPerRow,
	})
}

// PATCH /api/admin/events/{id} — open/close the sale, reschedule it, or change
// the per-order seat cap. Only the fields present in the body are changed.
func (a *app) patchAdminEvent(w http.ResponseWriter, r *http.Request) {
	eventID := r.PathValue("id")
	if !isUUID(eventID) {
		writeErr(w, http.StatusBadRequest, "bad_event_id")
		return
	}
	var body struct {
		Status           *string `json:"status"`
		SaleOpensAt      *string `json:"sale_opens_at"`
		MaxSeatsPerOrder *int    `json:"max_seats_per_order"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request")
		return
	}

	if body.Status != nil && *body.Status != "ON_SALE" && *body.Status != "CLOSED" {
		writeErr(w, http.StatusBadRequest, "bad_status")
		return
	}
	var saleOpensAt *time.Time
	if body.SaleOpensAt != nil {
		t, err := time.Parse(time.RFC3339, *body.SaleOpensAt)
		if err != nil {
			writeErr(w, http.StatusBadRequest, "bad_sale_opens_at")
			return
		}
		saleOpensAt = &t
	}
	if body.MaxSeatsPerOrder != nil && (*body.MaxSeatsPerOrder < 1 || *body.MaxSeatsPerOrder > 20) {
		writeErr(w, http.StatusBadRequest, "bad_max_seats_per_order")
		return
	}

	// COALESCE keeps the existing value wherever the caller sent nothing (NULL).
	tag, err := a.db.Exec(r.Context(), `
		UPDATE events SET
		    status              = COALESCE($2, status),
		    sale_opens_at       = COALESCE($3, sale_opens_at),
		    max_seats_per_order = COALESCE($4, max_seats_per_order)
		WHERE id = $1`,
		eventID, body.Status, saleOpensAt, body.MaxSeatsPerOrder)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db_error")
		return
	}
	if tag.RowsAffected() == 0 {
		writeErr(w, http.StatusNotFound, "event_not_found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"id": eventID, "status": "updated"})
}
