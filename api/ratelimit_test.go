package main

import (
	"context"
	"fmt"
	"testing"
	"time"
)

// The Redis token bucket allows up to `burst` requests, then denies until it
// refills. With a negligible refill rate the first `burst` calls pass and the
// rest are limited.
func TestRedisRateLimiter(t *testing.T) {
	e := newTestEnv(t) // skips if postgres/redis unavailable
	rl := &redisLimiter{rdb: e.a.rdb, script: tokenBucketScript}

	key := fmt.Sprintf("rl:test:%d", time.Now().UnixNano())
	t.Cleanup(func() { e.a.rdb.Del(context.Background(), key) })

	const burst = 3
	allowed := 0
	for i := 0; i < 5; i++ {
		if rl.allow(context.Background(), key, 0.0001 /*≈no refill*/, burst) {
			allowed++
		}
	}
	if allowed != burst {
		t.Fatalf("token bucket: want %d allowed of 5, got %d", burst, allowed)
	}

	// rps/burst <= 0 disables the limiter (always allow).
	if !rl.allow(context.Background(), key, 0, 0) {
		t.Fatal("zero rps/burst should disable limiting (allow)")
	}
}
