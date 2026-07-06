package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
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

// weakSecrets are values that must never sign real tokens. Anyone with the repo
// knows them, so a token signed with one is forgeable by anyone.
var weakSecrets = map[string]bool{
	"dev-secret": true, "dev-secret-change-in-prod": true,
	"changeme": true, "secret": true, "password": true, "test-secret": true,
}

// validateJWTSecret fails closed: an empty secret is always fatal, and in
// production a short or known-weak secret is rejected outright. In non-prod it
// only warns, so local dev still boots.
func validateJWTSecret(secret, env string) error {
	if secret == "" {
		return errors.New("JWT_SECRET is required (set a strong random value)")
	}
	if env == "production" {
		if len(secret) < 32 {
			return fmt.Errorf("JWT_SECRET too short for production (%d chars, need >= 32)", len(secret))
		}
		if weakSecrets[secret] {
			return errors.New("JWT_SECRET is a known weak/default value; generate a unique secret")
		}
	} else if weakSecrets[secret] || len(secret) < 32 {
		log.Printf("WARNING: weak JWT_SECRET in %q mode — never use this in production", env)
	}
	return nil
}

func main() {
	ctx := context.Background()

	db, err := pgxpool.New(ctx, getenv("DATABASE_URL",
		"postgres://ticket:ticket@localhost:5432/ticket?sslmode=disable"))
	if err != nil {
		log.Fatal("pg connect: ", err)
	}
	defer db.Close()

	rdb := redis.NewClient(&redis.Options{Addr: getenv("REDIS_ADDR", "localhost:6379")})
	defer rdb.Close()

	jwtSecret := getenv("JWT_SECRET", "")
	if err := validateJWTSecret(jwtSecret, getenv("APP_ENV", "development")); err != nil {
		log.Fatal("JWT_SECRET: ", err)
	}

	ttlSec, _ := strconv.Atoi(getenv("HOLD_TTL_SECONDS", "600"))
	accessSec, _ := strconv.Atoi(getenv("ACCESS_TTL_SECONDS", "900"))      // 15m
	refreshSec, _ := strconv.Atoi(getenv("REFRESH_TTL_SECONDS", "604800")) // 7d
	maxHeld, _ := strconv.Atoi(getenv("MAX_HELD_SEATS_PER_USER", "8"))
	if maxHeld <= 0 {
		maxHeld = 8
	}
	powDifficulty, _ := strconv.Atoi(getenv("POW_DIFFICULTY", "0"))
	a := &app{
		db:            db,
		rdb:           rdb,
		jwtSecret:     []byte(jwtSecret),
		holdTTL:       time.Duration(ttlSec) * time.Second,
		accessTTL:     time.Duration(accessSec) * time.Second,
		refreshTTL:    time.Duration(refreshSec) * time.Second,
		maxHeldSeats:  maxHeld,
		powDifficulty: powDifficulty,
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
	mux.HandleFunc("GET /api/events/{id}/seats", a.listSeats)
	mux.HandleFunc("GET /api/orders", a.auth(a.listOrders))
	mux.HandleFunc("POST /api/bookings", a.auth(a.createBooking))
	mux.HandleFunc("POST /api/orders/{id}/pay", a.auth(a.payOrder))
	mux.HandleFunc("DELETE /api/orders/{id}", a.auth(a.cancelOrder))

	// Background worker: expire unpaid orders so seats free up in the DB.
	// (Redis holds free themselves via TTL.)
	workerCtx, stopWorker := context.WithCancel(ctx)
	go a.expiryWorker(workerCtx)
	go a.attemptWriter(workerCtx) // drains the demand log to Postgres off the hot path

	rl := newRateLimiter(rdb)
	srv := &http.Server{
		Addr:    ":" + getenv("PORT", "8080"),
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
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
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
