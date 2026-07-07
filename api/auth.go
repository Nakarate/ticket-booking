package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/redis/go-redis/v9"
	"golang.org/x/crypto/bcrypt"
)

const minPasswordLen = 8

// dummyHash is a real bcrypt hash used to spend the same ~bcrypt time on the
// "unknown email" login path as on the "wrong password" path, so response
// timing doesn't reveal whether an email is registered (user enumeration).
var dummyHash, _ = bcrypt.GenerateFromPassword([]byte("timing-equalizer"), bcrypt.DefaultCost)

// signAccess mints a short-lived access JWT (default 15m). The auth middleware
// validates it; it is stateless, which is why it must be short.
func (a *app) signAccess(userID string) (string, error) {
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"sub": userID,
		"exp": time.Now().Add(a.accessTTL).Unix(),
	})
	return tok.SignedString(a.jwtSecret)
}

func refreshKey(t string) string { return "refresh:" + t }

// newRefreshToken returns an opaque 256-bit random token. Opaque (not a JWT) so
// it can be revoked server-side by deleting its Redis key.
func newRefreshToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// issueTokens returns an access JWT plus a refresh token persisted in Redis with
// the refresh TTL, so logout/rotation can invalidate it.
func (a *app) issueTokens(ctx context.Context, userID string) (access, refresh string, err error) {
	if access, err = a.signAccess(userID); err != nil {
		return
	}
	if refresh, err = newRefreshToken(); err != nil {
		return
	}
	err = a.rdb.Set(ctx, refreshKey(refresh), userID, a.refreshTTL).Err()
	return
}

func writeTokens(w http.ResponseWriter, status int, userID, access, refresh string, isAdmin bool) {
	writeJSON(w, status, map[string]any{
		"access_token":  access,
		"refresh_token": refresh,
		"user_id":       userID,
		"is_admin":      isAdmin,
	})
}

func normalizeEmail(s string) string { return strings.ToLower(strings.TrimSpace(s)) }

// register creates a user with a bcrypt-hashed password and logs them in.
func (a *app) register(w http.ResponseWriter, r *http.Request) {
	if !a.checkPoW(w, r) {
		return
	}
	var body struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request")
		return
	}
	email := normalizeEmail(body.Email)
	if email == "" || !strings.Contains(email, "@") {
		writeErr(w, http.StatusBadRequest, "invalid_email")
		return
	}
	if len(body.Password) < minPasswordLen {
		writeErr(w, http.StatusBadRequest, "password_too_short")
		return
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(body.Password), bcrypt.DefaultCost)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "hash_error")
		return
	}
	var id string
	err = a.db.QueryRow(r.Context(),
		`INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id`,
		email, string(hash)).Scan(&id)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" { // unique_violation
			writeErr(w, http.StatusConflict, "email_taken")
			return
		}
		writeErr(w, http.StatusInternalServerError, "db_error")
		return
	}
	access, refresh, err := a.issueTokens(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "token_error")
		return
	}
	writeTokens(w, http.StatusCreated, id, access, refresh, false)
}

// login verifies the password and issues tokens. Errors are generic
// ("invalid_credentials") so they don't reveal whether an email is registered.
func (a *app) login(w http.ResponseWriter, r *http.Request) {
	if !a.checkPoW(w, r) {
		return
	}
	var body struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request")
		return
	}
	var id, hash string
	var isAdmin bool
	err := a.db.QueryRow(r.Context(),
		`SELECT id, password_hash, is_admin FROM users WHERE email = $1`,
		normalizeEmail(body.Email)).Scan(&id, &hash, &isAdmin)
	if errors.Is(err, pgx.ErrNoRows) {
		// Spend the same bcrypt time as a real comparison, then fail — equal
		// timing whether or not the email exists.
		bcrypt.CompareHashAndPassword(dummyHash, []byte(body.Password))
		writeErr(w, http.StatusUnauthorized, "invalid_credentials")
		return
	} else if err != nil {
		writeErr(w, http.StatusInternalServerError, "db_error")
		return
	}
	if bcrypt.CompareHashAndPassword([]byte(hash), []byte(body.Password)) != nil {
		writeErr(w, http.StatusUnauthorized, "invalid_credentials")
		return
	}
	access, refresh, err := a.issueTokens(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "token_error")
		return
	}
	writeTokens(w, http.StatusOK, id, access, refresh, isAdmin)
}

// refresh rotates the refresh token: the old one is invalidated and a new
// access+refresh pair is issued. A revoked/expired token yields 401.
func (a *app) refresh(w http.ResponseWriter, r *http.Request) {
	var body struct {
		RefreshToken string `json:"refresh_token"`
	}
	if err := decodeJSON(w, r, &body); err != nil || body.RefreshToken == "" {
		writeErr(w, http.StatusBadRequest, "refresh_token_required")
		return
	}
	// GETDEL is atomic: two concurrent refreshes with the same token can't both
	// fetch it, so a rotated/replayed token is caught (only one caller wins).
	userID, err := a.rdb.GetDel(r.Context(), refreshKey(body.RefreshToken)).Result()
	if errors.Is(err, redis.Nil) {
		writeErr(w, http.StatusUnauthorized, "invalid_refresh")
		return
	} else if err != nil {
		writeErr(w, http.StatusServiceUnavailable, "auth_unavailable")
		return
	}
	access, refresh, err := a.issueTokens(r.Context(), userID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "token_error")
		return
	}
	// is_admin isn't re-sent on refresh; the client keeps what login returned.
	writeTokens(w, http.StatusOK, userID, access, refresh, false)
}

// logout revokes a refresh token. Idempotent: unknown token still returns 200.
func (a *app) logout(w http.ResponseWriter, r *http.Request) {
	var body struct {
		RefreshToken string `json:"refresh_token"`
	}
	if err := decodeJSON(w, r, &body); err == nil && body.RefreshToken != "" {
		a.rdb.Del(r.Context(), refreshKey(body.RefreshToken))
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "logged_out"})
}
