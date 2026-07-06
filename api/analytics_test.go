package main

import (
	"context"
	"testing"
	"time"
)

// Every booking attempt on a real event is logged with its outcome — the winner
// as SUCCESS and the racer who lost as SEAT_TAKEN — so the demand signal (incl.
// the losers, who never create an order) is captured. The write path is async;
// here we drain the queue deterministically and persist it, then read it back.
func TestBookingAttemptDemandLog(t *testing.T) {
	e := newTestEnv(t)
	e.a.attempts = make(chan bookingAttempt, 16) // wire the demand log for this test
	eventID, seats := e.seedEvent(1, time.Now().Add(-time.Hour), "ON_SALE")
	t.Cleanup(func() {
		e.a.db.Exec(context.Background(), `DELETE FROM booking_attempts WHERE event_id = $1`, eventID)
	})

	if code, _ := e.book(e.login("winner@demand.dev"), eventID, seats); code != 201 {
		t.Fatalf("winner booking: want 201, got %d", code)
	}
	if code, _ := e.book(e.login("loser@demand.dev"), eventID, seats); code != 409 {
		t.Fatalf("loser booking: want 409, got %d", code)
	}

	// Drain the queue (logAttempt fired synchronously inside each handler call).
	close(e.a.attempts)
	var drained []bookingAttempt
	for at := range e.a.attempts {
		drained = append(drained, at)
	}
	e.a.attempts = nil // stop further logging in this env
	if len(drained) != 2 {
		t.Fatalf("want 2 logged attempts, got %d", len(drained))
	}
	if err := e.a.insertAttempts(e.ctx, drained); err != nil {
		t.Fatal(err)
	}

	var success, taken int
	e.scalar(&success, `SELECT count(*) FROM booking_attempts WHERE event_id = $1 AND outcome = 'SUCCESS'`, eventID)
	e.scalar(&taken, `SELECT count(*) FROM booking_attempts WHERE event_id = $1 AND outcome = 'SEAT_TAKEN'`, eventID)
	if success != 1 || taken != 1 {
		t.Fatalf("demand log: want SUCCESS=1 SEAT_TAKEN=1, got SUCCESS=%d SEAT_TAKEN=%d", success, taken)
	}

	// The loser is captured with their seat of interest even though no order exists.
	var loserSeats int
	e.scalar(&loserSeats, `SELECT count(*) FROM booking_attempts
		WHERE event_id = $1 AND outcome = 'SEAT_TAKEN' AND seat_ids = $2`, eventID, seats)
	if loserSeats != 1 {
		t.Fatalf("loser's wanted seats not captured (got %d)", loserSeats)
	}
}
