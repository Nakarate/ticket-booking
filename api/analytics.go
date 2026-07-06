package main

import (
	"context"
	"log"
	"time"

	"github.com/jackc/pgx/v5"
)

// Demand log — every booking attempt and its outcome, captured for the
// data/marketing team ("who wanted which seats, and did they get them").
//
// The whole point of the two-layer design is that losers shed at Redis in ~1ms
// without touching the booking DB path. So logging must NOT add a synchronous
// insert on that hot path: attempts go into a buffered channel and a single
// background goroutine batch-inserts them. Under a 1,000-VU race the 999 losers
// enqueue in microseconds and never each hit Postgres. Best-effort by design —
// if the buffer is ever full we drop the record rather than slow a request.

type bookingAttempt struct {
	userID  string
	eventID string
	seatIDs []string
	outcome string // SUCCESS | SEAT_TAKEN | SALE_NOT_OPEN | HOLD_LIMIT | ERROR
}

// logAttempt enqueues an attempt for the background writer. Non-blocking, and a
// no-op when logging isn't wired (e.g. unit tests build the app without it).
func (a *app) logAttempt(userID, eventID string, seatIDs []string, outcome string) {
	if a.attempts == nil {
		return
	}
	select {
	case a.attempts <- bookingAttempt{userID, eventID, seatIDs, outcome}:
	default: // buffer full under extreme burst: drop rather than block the request
	}
}

// attemptWriter drains queued attempts and batch-inserts them, flushing on a
// full batch or a short timer — whichever comes first.
func (a *app) attemptWriter(ctx context.Context) {
	const maxBatch = 200
	buf := make([]bookingAttempt, 0, maxBatch)
	tick := time.NewTicker(2 * time.Second)
	defer tick.Stop()

	flush := func() {
		if len(buf) == 0 {
			return
		}
		if err := a.insertAttempts(context.Background(), buf); err != nil {
			log.Println("attempt writer:", err)
		}
		buf = buf[:0]
	}

	for {
		select {
		case <-ctx.Done():
			flush()
			return
		case <-tick.C:
			flush()
		case at := <-a.attempts:
			buf = append(buf, at)
			if len(buf) >= maxBatch {
				flush()
			}
		}
	}
}

// insertAttempts writes a batch of attempts in a single round trip.
func (a *app) insertAttempts(ctx context.Context, attempts []bookingAttempt) error {
	batch := &pgx.Batch{}
	for _, at := range attempts {
		batch.Queue(
			`INSERT INTO booking_attempts (user_id, event_id, seat_ids, outcome)
			 VALUES ($1, $2, $3, $4)`,
			at.userID, at.eventID, at.seatIDs, at.outcome)
	}
	br := a.db.SendBatch(ctx, batch)
	defer br.Close()
	for range attempts {
		if _, err := br.Exec(); err != nil {
			return err
		}
	}
	return nil
}
