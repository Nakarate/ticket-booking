package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"math/bits"
	"net/http"
	"time"
)

// Proof-of-work anti-automation. When POW_DIFFICULTY > 0, credential endpoints
// require the caller to have found a `solution` such that
// sha256("<challenge>:<solution>") begins with `difficulty` zero bits. Verifying
// is one hash (cheap for us); finding a solution costs ~2^difficulty hashes
// (expensive at scale for a bot). Challenges are single-use and short-lived,
// tracked in Redis, so solutions can't be precomputed or replayed.

func leadingZeroBits(b []byte) int {
	n := 0
	for _, x := range b {
		if x == 0 {
			n += 8
			continue
		}
		return n + bits.LeadingZeros8(x)
	}
	return n
}

func powSolved(challenge, solution string, difficulty int) bool {
	h := sha256.Sum256([]byte(challenge + ":" + solution))
	return leadingZeroBits(h[:]) >= difficulty
}

func powKey(challenge string) string { return "pow:" + challenge }

// issuePoWChallenge mints a single-use challenge and records it in Redis with a
// short TTL (so an unsolved challenge can't be hoarded or precomputed offline).
func (a *app) issuePoWChallenge(ctx context.Context) (string, error) {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	c := hex.EncodeToString(buf)
	return c, a.rdb.Set(ctx, powKey(c), "1", 2*time.Minute).Err()
}

// checkPoW gates a handler. Returns true if the request may proceed. When PoW is
// required but absent/invalid it writes a 400 carrying a fresh challenge, so the
// client can solve and retry.
func (a *app) checkPoW(w http.ResponseWriter, r *http.Request) bool {
	if a.powDifficulty <= 0 {
		return true
	}
	challenge := r.Header.Get("X-PoW-Challenge")
	solution := r.Header.Get("X-PoW-Solution")
	fail := func(code string) bool {
		c, _ := a.issuePoWChallenge(r.Context())
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"error": code, "challenge": c, "difficulty": a.powDifficulty,
		})
		return false
	}
	if challenge == "" || solution == "" {
		return fail("pow_required")
	}
	// GETDEL consumes the challenge atomically → single-use, no replay.
	v, err := a.rdb.GetDel(r.Context(), powKey(challenge)).Result()
	if err != nil || v != "1" {
		return fail("pow_invalid")
	}
	if !powSolved(challenge, solution, a.powDifficulty) {
		return fail("pow_invalid")
	}
	return true
}
