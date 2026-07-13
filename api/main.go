package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"ticket-booking/api/internal/config"
)

type app struct {
	db            *pgxpool.Pool
	rdb           *redis.Client
	jwtSecret     []byte
	holdTTL       time.Duration
	accessTTL     time.Duration // short-lived access JWT
	refreshTTL    time.Duration // opaque refresh token lifetime (Redis)
	maxHeldSeats  int           // per-user cap on concurrent unpaid held seats (anti-hoarding)
	powDifficulty int           // proof-of-work leading-zero bits on login/register (0 = off)
	attempts      chan bookingAttempt // buffered demand-log queue, drained by attemptWriter
}

func getenv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func main() {
	ctx := context.Background()

	cfg, err := config.Load()
	if err != nil {
		log.Fatal("config: ", err)
	}

	db, err := pgxpool.New(ctx, cfg.DatabaseURL)
	if err != nil {
		log.Fatal("pg connect: ", err)
	}
	defer db.Close()

	rdb := redis.NewClient(&redis.Options{Addr: cfg.RedisAddr})
	defer rdb.Close()

	a := &app{
		db:            db,
		rdb:           rdb,
		jwtSecret:     []byte(cfg.JWTSecret),
		holdTTL:       cfg.HoldTTL,
		accessTTL:     cfg.AccessTTL,
		refreshTTL:    cfg.RefreshTTL,
		maxHeldSeats:  cfg.MaxHeldSeats,
		powDifficulty: cfg.PoWDifficulty,
		attempts:      make(chan bookingAttempt, 10000),
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("ok"))
	})
	// readyz checks real dependencies — this is what a load balancer probes.
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		if err := a.db.Ping(ctx); err != nil {
			writeErr(w, http.StatusServiceUnavailable, "postgres_down")
			return
		}
		if err := a.rdb.Ping(ctx).Err(); err != nil {
			writeErr(w, http.StatusServiceUnavailable, "redis_down")
			return
		}
		w.Write([]byte("ready"))
	})
	mux.HandleFunc("POST /api/register", a.register)
	mux.HandleFunc("POST /api/login", a.login)
	mux.HandleFunc("POST /api/refresh", a.refresh)
	mux.HandleFunc("POST /api/logout", a.logout)
	mux.HandleFunc("GET /api/events", a.listEvents) // public: on-sale events for the customer picker
	mux.HandleFunc("GET /api/events/{id}/seats", a.listSeats)
	mux.HandleFunc("GET /api/orders", a.auth(a.listOrders))
	mux.HandleFunc("POST /api/bookings", a.auth(a.createBooking))
	mux.HandleFunc("POST /api/orders/{id}/pay", a.auth(a.payOrder))
	mux.HandleFunc("DELETE /api/orders/{id}", a.auth(a.cancelOrder))

	// Admin content management (create events/rounds, open/close sale, set the
	// per-order cap, view sales stats). adminAuth gates every route.
	mux.HandleFunc("GET /api/admin/events", a.adminAuth(a.listAdminEvents))
	mux.HandleFunc("POST /api/admin/events", a.adminAuth(a.createAdminEvent))
	mux.HandleFunc("PATCH /api/admin/events/{id}", a.adminAuth(a.patchAdminEvent))

	// Bootstrap the admin in the background with retry: on a fresh boot Postgres
	// may still be running init scripts (the demo seeds 1M rows), so a single
	// attempt can hit "connection refused" and silently leave no admin. Retrying
	// until it lands means `docker compose down -v && up` reliably has an admin.
	go func() {
		for attempt := 1; attempt <= 30; attempt++ {
			if err := a.ensureAdmin(ctx); err == nil {
				if attempt > 1 {
					log.Printf("admin bootstrap: ok after %d attempts", attempt)
				}
				return
			} else if attempt == 30 {
				log.Println("admin bootstrap: giving up after retries:", err)
			}
			time.Sleep(2 * time.Second)
		}
	}()

	workerCtx, stopWorker := context.WithCancel(ctx)
	go a.expiryWorker(workerCtx)
	go a.attemptWriter(workerCtx) // drains the demand log to Postgres off the hot path

	rl := newRateLimiter(rdb)
	srv := &http.Server{
		Addr:    ":" + cfg.Port,
		Handler: cors(logRequests(rl.middleware(mux))),
		// Timeouts: a slow or malicious client must not pin a goroutine forever.
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      20 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	go func() {
		log.Println("api listening on", srv.Addr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatal(err)
		}
	}()

	// Graceful shutdown: stop taking requests, let in-flight ones finish.
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig
	log.Println("shutting down...")
	stopWorker()
	shutdownCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	srv.Shutdown(shutdownCtx)
}

// expiryWorker flips PENDING orders past their deadline to EXPIRED and
// deletes their order_items, releasing the unique seat guard.
func (a *app) expiryWorker(ctx context.Context) {
	tick := time.NewTicker(30 * time.Second)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			n, err := a.expireOverdueOrders(ctx)
			if err != nil {
				log.Println("expiry worker:", err)
				continue
			}
			if n > 0 {
				log.Printf("expiry worker: released %d seat(s)", n)
			}
		}
	}
}

// expireOverdueOrders flips PENDING orders past their deadline to EXPIRED and
// deletes their order_items, releasing the unique seat guard. Returns the
// number of seats released. Extracted from the worker loop so it is testable.
func (a *app) expireOverdueOrders(ctx context.Context) (int64, error) {
	tag, err := a.db.Exec(ctx, `
		WITH expired AS (
			UPDATE orders SET status = 'EXPIRED'
			WHERE status = 'PENDING' AND expires_at < now()
			RETURNING id
		)
		DELETE FROM order_items
		WHERE order_id IN (SELECT id FROM expired)`)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

func cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", getenv("CORS_ORIGIN", "http://localhost:3000"))
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, Idempotency-Key, X-PoW-Challenge, X-PoW-Solution")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func decodeJSON(w http.ResponseWriter, r *http.Request, v any) error {
	// 1MB cap: nobody books seats with a bigger payload than that.
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	defer r.Body.Close()
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	return dec.Decode(v)
}

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (s *statusWriter) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}

func logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		sw := &statusWriter{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(sw, r)
		log.Printf("%s %s %d %s", r.Method, r.URL.Path, sw.status, time.Since(start))
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, code string) {
	writeJSON(w, status, map[string]string{"error": code})
}
