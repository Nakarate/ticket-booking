package main

import (
	"context"
	"net"
	"net/http"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

// redisLimiter is a token-bucket rate limiter backed by a Redis Lua script.
// Lua runs single-threaded, so the check-and-decrement is atomic, and because
// the state lives in Redis it is shared across all API instances — unlike the
// previous in-memory version, which limited per-process (useless behind a load
// balancer). Same Redis-as-shared-state pattern as the seat hold.
type redisLimiter struct {
	rdb       *redis.Client
	script    *redis.Script
	rps       float64
	burst     float64
	authRps   float64
	authBurst float64
}

// tokenBucketScript refills the bucket by elapsed time, then spends one token.
// Returns 1 (allowed) or 0 (limited). Time comes from the caller (ARGV[3]) so
// the script stays deterministic across replicas.
var tokenBucketScript = redis.NewScript(`
local key   = KEYS[1]
local rate  = tonumber(ARGV[1])   -- tokens per second
local burst = tonumber(ARGV[2])   -- bucket capacity
local now   = tonumber(ARGV[3])   -- caller time, ms
local ttl   = tonumber(ARGV[4])   -- key ttl, seconds
local t = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(t[1])
local ts = tonumber(t[2])
if tokens == nil then tokens = burst; ts = now end
tokens = math.min(burst, tokens + math.max(0, now - ts) * rate / 1000.0)
local allowed = 0
if tokens >= 1 then tokens = tokens - 1; allowed = 1 end
redis.call('HSET', key, 'tokens', tokens, 'ts', now)
redis.call('EXPIRE', key, ttl)
return allowed
`)

func envFloat(key string, def float64) float64 {
	if v, err := strconv.ParseFloat(getenv(key, ""), 64); err == nil {
		return v
	}
	return def
}

func newRateLimiter(rdb *redis.Client) *redisLimiter {
	return &redisLimiter{
		rdb:    rdb,
		script: tokenBucketScript,
		// General limit: per client IP. Burst is high so the k6 load tests — which
		// drive ~3k requests from a single container IP — still pass. Tighten in
		// production (the seat map and booking are the endpoints this protects).
		rps:   envFloat("RATE_RPS", 500),
		burst: envFloat("RATE_BURST", 5000),
		// Auth limit: stricter per-IP guard on credential endpoints. Defaults are
		// still k6-friendly; tighten (e.g. rps 0.2 / burst 5) in production to
		// throttle account spam and password brute force.
		authRps:   envFloat("AUTH_RATE_RPS", 100),
		authBurst: envFloat("AUTH_RATE_BURST", 2000),
	}
}

// allow reports whether one token was available for key. On a Redis error it
// fails OPEN: a rate-limiter blip must not take the whole site down, and the
// booking path already fails closed on its own when Redis is truly unavailable.
func (rl *redisLimiter) allow(ctx context.Context, key string, rps, burst float64) bool {
	if rps <= 0 || burst <= 0 {
		return true
	}
	now := time.Now().UnixMilli()
	ttl := int64(burst/rps) + 60 // long enough to refill a full bucket, then evict
	res, err := rl.script.Run(ctx, rl.rdb, []string{key}, rps, burst, now, ttl).Int()
	if err != nil {
		return true
	}
	return res == 1
}

// clientIP returns the peer address. It deliberately ignores X-Forwarded-For:
// that header is client-controlled and spoofable, so trusting it here would let
// an attacker forge a new "IP" per request and defeat the per-IP limits below.
// Behind a real load balancer, read XFF only from *trusted* proxy hops — wire
// that in at deploy time (e.g. via a TRUSTED_PROXY allowlist), not here.
func clientIP(r *http.Request) string {
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		return host
	}
	return r.RemoteAddr
}

func (rl *redisLimiter) middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Never rate-limit health probes — a load balancer hammers these.
		if r.URL.Path == "/healthz" || r.URL.Path == "/readyz" {
			next.ServeHTTP(w, r)
			return
		}
		ip := clientIP(r)

		// General limit: keyed by client IP only. It must NOT key on the raw
		// Authorization header — this middleware runs *before* auth(), so the token
		// is unverified. Keying on it would let an unauthenticated caller rotate a
		// forged header to mint unlimited buckets and bypass the limit entirely
		// (e.g. flooding the unauthenticated seat-map endpoint).
		if !rl.allow(r.Context(), "rl:"+ip, rl.rps, rl.burst) {
			writeErr(w, http.StatusTooManyRequests, "rate_limited")
			return
		}

		// Stricter per-IP limit on credential endpoints (account spam, brute force).
		if r.Method == http.MethodPost && (r.URL.Path == "/api/login" || r.URL.Path == "/api/register") {
			if !rl.allow(r.Context(), "rlauth:"+ip, rl.authRps, rl.authBurst) {
				writeErr(w, http.StatusTooManyRequests, "rate_limited")
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}
