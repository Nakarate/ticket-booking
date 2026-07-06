package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"net/http/httptest"
	"strconv"
	"testing"
)

func solvePoW(challenge string, difficulty int) string {
	for n := 0; ; n++ {
		s := strconv.Itoa(n)
		h := sha256.Sum256([]byte(challenge + ":" + s))
		if leadingZeroBits(h[:]) >= difficulty {
			return s
		}
	}
}

func TestLeadingZeroBits(t *testing.T) {
	cases := []struct {
		b    []byte
		want int
	}{
		{[]byte{0xff}, 0},
		{[]byte{0x0f}, 4},
		{[]byte{0x00, 0xff}, 8},
		{[]byte{0x00, 0x01}, 15},
		{[]byte{0x00, 0x00}, 16},
	}
	for _, c := range cases {
		if got := leadingZeroBits(c.b); got != c.want {
			t.Errorf("leadingZeroBits(%x) = %d, want %d", c.b, got, c.want)
		}
	}
}

// When PoW is enabled, register demands a solved challenge: a bare request is
// rejected with a challenge, a solved one succeeds, and the challenge is single-use.
func TestPoWGuard(t *testing.T) {
	e := newTestEnv(t)
	e.a.powDifficulty = 10
	body, _ := json.Marshal(map[string]string{"email": "pow-user@edge.dev", "password": "pass-12345"})

	// 1) No PoW → 400 pow_required + a fresh challenge.
	w := httptest.NewRecorder()
	e.a.register(w, httptest.NewRequest("POST", "/api/register", bytes.NewReader(body)))
	if w.Code != 400 {
		t.Fatalf("register without PoW: want 400, got %d", w.Code)
	}
	m := decodeBody(w)
	if m["error"] != "pow_required" {
		t.Fatalf("want pow_required, got %v", m["error"])
	}
	challenge := m["challenge"].(string)
	difficulty := int(m["difficulty"].(float64))

	// 2) Solve it and register → 201.
	sol := solvePoW(challenge, difficulty)
	reg := func(ch, s string) *httptest.ResponseRecorder {
		rw := httptest.NewRecorder()
		req := httptest.NewRequest("POST", "/api/register", bytes.NewReader(body))
		req.Header.Set("X-PoW-Challenge", ch)
		req.Header.Set("X-PoW-Solution", s)
		e.a.register(rw, req)
		return rw
	}
	ok := reg(challenge, sol)
	if ok.Code != 201 {
		t.Fatalf("register with valid PoW: want 201, got %d (%v)", ok.Code, decodeBody(ok))
	}
	if id, has := decodeBody(ok)["user_id"].(string); has {
		e.userIDs = append(e.userIDs, id)
	}

	// 3) Reusing the same challenge → 400 (single-use, consumed by GETDEL).
	if again := reg(challenge, sol); again.Code != 400 {
		t.Fatalf("reused PoW challenge: want 400, got %d", again.Code)
	}
}

// PoW off (difficulty 0) → register works with no challenge at all.
func TestPoWDisabledByDefault(t *testing.T) {
	e := newTestEnv(t) // maxHeldSeats set, powDifficulty defaults to 0
	if code, _ := e.doRegister("pow-off@edge.dev", "pass-12345"); code != 201 {
		t.Fatalf("register with PoW disabled: want 201, got %d", code)
	}
}
