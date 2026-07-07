package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// adminToken registers a user, flags them admin in the DB, and returns their
// access token — still valid because adminAuth reads is_admin from the DB by sub.
func (e *testEnv) adminToken(email string) string {
	e.t.Helper()
	tok := e.login(email)
	if _, err := e.a.db.Exec(e.ctx, `UPDATE users SET is_admin = true WHERE email = $1`, normalizeEmail(email)); err != nil {
		e.t.Fatal(err)
	}
	return tok
}

// adminCall invokes an admin handler through adminAuth with the given token.
func (e *testEnv) adminCall(h http.HandlerFunc, method, path, pathID, token string, body any) (int, map[string]any) {
	e.t.Helper()
	var rdr *bytes.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rdr = bytes.NewReader(b)
	} else {
		rdr = bytes.NewReader(nil)
	}
	req := httptest.NewRequest(method, path, rdr)
	if pathID != "" {
		req.SetPathValue("id", pathID)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	e.a.adminAuth(h)(w, req)
	m := decodeBody(w)
	if id, ok := m["event_id"].(string); ok {
		e.eventIDs = append(e.eventIDs, id)
	}
	return w.Code, m
}

func (e *testEnv) createEvent(token string, body map[string]any) (int, map[string]any) {
	return e.adminCall(e.a.createAdminEvent, "POST", "/api/admin/events", "", token, body)
}

// A non-admin token is rejected by adminAuth; an admin token gets through.
func TestAdminOnlyGuard(t *testing.T) {
	e := newTestEnv(t)
	body := map[string]any{
		"name": "guard-test", "starts_at": time.Now().Add(24 * time.Hour).Format(time.RFC3339),
		"rows": 1, "seats_per_row": 2, "price": 100,
	}
	if code, _ := e.createEvent(e.login("plain@admin.dev"), body); code != 403 {
		t.Fatalf("non-admin creating an event: want 403, got %d", code)
	}
	if code, m := e.createEvent(e.adminToken("boss@admin.dev"), body); code != 201 {
		t.Fatalf("admin creating an event: want 201, got %d (%v)", code, m)
	}
}

// Creating an event generates its seat map and shows up in the admin list with
// correct stats.
func TestAdminCreateAndListEvent(t *testing.T) {
	e := newTestEnv(t)
	token := e.adminToken("boss2@admin.dev")

	code, m := e.createEvent(token, map[string]any{
		"name":                "Night 2",
		"starts_at":           time.Now().Add(24 * time.Hour).Format(time.RFC3339),
		"rows":                2,
		"seats_per_row":       3,
		"price":               100,
		"premium_rows":        1,
		"premium_price":       250,
		"max_seats_per_order": 2,
	})
	if code != 201 || m["seat_count"].(float64) != 6 {
		t.Fatalf("create event: want 201 seat_count=6, got %d (%v)", code, m)
	}
	eventID := m["event_id"].(string)

	// Premium pricing applied to the first row (3 seats @ 250), rest @ 100.
	var premium int
	e.scalar(&premium, `SELECT count(*) FROM seats WHERE event_id = $1 AND price = 250`, eventID)
	if premium != 3 {
		t.Fatalf("premium seats: want 3, got %d", premium)
	}

	lcode, lm := e.adminCall(e.a.listAdminEvents, "GET", "/api/admin/events", "", token, nil)
	if lcode != 200 {
		t.Fatalf("list events: want 200, got %d", lcode)
	}
	events, _ := lm["events"].([]any)
	var found map[string]any
	for _, ev := range events {
		m := ev.(map[string]any)
		if m["id"] == eventID {
			found = m
			break
		}
	}
	if found == nil {
		t.Fatal("created event not in admin list")
	}
	if found["total"].(float64) != 6 || found["available"].(float64) != 6 || found["sold"].(float64) != 0 {
		t.Fatalf("event stats: want total=6 available=6 sold=0, got %v", found)
	}
}

// PATCH closes a sale; a booking on the closed event is then rejected by the gate.
func TestAdminPatchClosesSale(t *testing.T) {
	e := newTestEnv(t)
	admin := e.adminToken("boss3@admin.dev")
	_, m := e.createEvent(admin, map[string]any{
		"name": "Closable", "starts_at": time.Now().Add(24 * time.Hour).Format(time.RFC3339),
		"rows": 1, "seats_per_row": 2, "price": 100,
	})
	eventID := m["event_id"].(string)
	var seat string
	e.scalar(&seat, `SELECT id FROM seats WHERE event_id = $1 LIMIT 1`, eventID)

	// Bookable while ON_SALE.
	if code, _ := e.book(e.login("early@admin.dev"), eventID, []string{seat}); code != 201 {
		t.Fatalf("booking an ON_SALE admin event: want 201, got %d", code)
	}

	// Close it, then a fresh seat can't be booked.
	if code, _ := e.adminCall(e.a.patchAdminEvent, "PATCH", "/api/admin/events/"+eventID, eventID, admin,
		map[string]any{"status": "CLOSED"}); code != 200 {
		t.Fatalf("patch close: want 200, got %d", code)
	}
	var seat2 string
	e.scalar(&seat2, `SELECT id FROM seats WHERE event_id = $1 AND id <> $2 LIMIT 1`, eventID, seat)
	if code, _ := e.book(e.login("late@admin.dev"), eventID, []string{seat2}); code != 403 {
		t.Fatalf("booking a CLOSED event: want 403, got %d", code)
	}
}

// The per-event max_seats_per_order cap is enforced on booking.
func TestPerEventSeatLimit(t *testing.T) {
	e := newTestEnv(t)
	admin := e.adminToken("boss4@admin.dev")
	_, m := e.createEvent(admin, map[string]any{
		"name": "Capped", "starts_at": time.Now().Add(24 * time.Hour).Format(time.RFC3339),
		"rows": 1, "seats_per_row": 5, "price": 100, "max_seats_per_order": 2,
	})
	eventID := m["event_id"].(string)

	rows, err := e.a.db.Query(e.ctx, `SELECT id FROM seats WHERE event_id = $1 ORDER BY seat_no LIMIT 3`, eventID)
	if err != nil {
		t.Fatal(err)
	}
	var ids []string
	for rows.Next() {
		var id string
		rows.Scan(&id)
		ids = append(ids, id)
	}
	rows.Close()

	token := e.login("buyer@admin.dev")
	if code, body := e.book(token, eventID, ids[:3]); code != 400 {
		t.Fatalf("3 seats over a cap of 2: want 400, got %d (%v)", code, body)
	}
	if code, _ := e.book(token, eventID, ids[:2]); code != 201 {
		t.Fatalf("2 seats within the cap: want 201, got %d", code)
	}
}
