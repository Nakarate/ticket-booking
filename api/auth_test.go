package main

import (
	"bytes"
	"encoding/json"
	"net/http/httptest"
	"testing"
)

// helpers that hit the auth handlers directly and return (status, body).

func (e *testEnv) doRegister(email, password string) (int, map[string]any) {
	e.t.Helper()
	body, _ := json.Marshal(map[string]string{"email": email, "password": password})
	w := httptest.NewRecorder()
	e.a.register(w, httptest.NewRequest("POST", "/api/register", bytes.NewReader(body)))
	m := decodeBody(w)
	if id, ok := m["user_id"].(string); ok {
		e.userIDs = append(e.userIDs, id)
	}
	return w.Code, m
}

func (e *testEnv) doLogin(email, password string) (int, map[string]any) {
	e.t.Helper()
	body, _ := json.Marshal(map[string]string{"email": email, "password": password})
	w := httptest.NewRecorder()
	e.a.login(w, httptest.NewRequest("POST", "/api/login", bytes.NewReader(body)))
	return w.Code, decodeBody(w)
}

func (e *testEnv) doRefresh(refreshTok string) (int, map[string]any) {
	e.t.Helper()
	body, _ := json.Marshal(map[string]string{"refresh_token": refreshTok})
	w := httptest.NewRecorder()
	e.a.refresh(w, httptest.NewRequest("POST", "/api/refresh", bytes.NewReader(body)))
	return w.Code, decodeBody(w)
}

func (e *testEnv) doLogout(refreshTok string) int {
	e.t.Helper()
	body, _ := json.Marshal(map[string]string{"refresh_token": refreshTok})
	w := httptest.NewRecorder()
	e.a.logout(w, httptest.NewRequest("POST", "/api/logout", bytes.NewReader(body)))
	return w.Code
}

func TestRegisterAndLogin(t *testing.T) {
	e := newTestEnv(t)
	const email, pw = "auth-user@edge.dev", "correct-horse-battery"

	code, body := e.doRegister(email, pw)
	if code != 201 || body["access_token"] == "" || body["refresh_token"] == "" {
		t.Fatalf("register: want 201 with tokens, got %d (%v)", code, body)
	}
	if code, _ := e.doRegister(email, pw); code != 409 {
		t.Fatalf("duplicate register: want 409, got %d", code)
	}
	if code, _ := e.doRegister("shorty@edge.dev", "short"); code != 400 {
		t.Fatalf("short password: want 400, got %d", code)
	}

	if code, body := e.doLogin(email, pw); code != 200 || body["access_token"] == "" {
		t.Fatalf("login good creds: want 200 with token, got %d (%v)", code, body)
	}
	if code, _ := e.doLogin(email, "wrong-password"); code != 401 {
		t.Fatalf("login wrong password: want 401, got %d", code)
	}
	if code, _ := e.doLogin("nobody@edge.dev", pw); code != 401 {
		t.Fatalf("login unknown email: want 401 (no enumeration), got %d", code)
	}
}

func TestRefreshRotationAndLogout(t *testing.T) {
	e := newTestEnv(t)
	_, reg := e.doRegister("refresh-user@edge.dev", "correct-horse-battery")
	r1, _ := reg["refresh_token"].(string)

	// Refresh issues a new pair and rotates (invalidates) the old refresh token.
	code, body := e.doRefresh(r1)
	if code != 200 || body["access_token"] == "" {
		t.Fatalf("refresh: want 200 with token, got %d (%v)", code, body)
	}
	r2, _ := body["refresh_token"].(string)
	if r2 == r1 || r2 == "" {
		t.Fatalf("refresh must rotate the token (got %q vs %q)", r2, r1)
	}
	if code, _ := e.doRefresh(r1); code != 401 {
		t.Fatalf("reusing rotated refresh token: want 401, got %d", code)
	}

	// Logout revokes the current refresh token.
	if s := e.doLogout(r2); s != 200 {
		t.Fatalf("logout: want 200, got %d", s)
	}
	if code, _ := e.doRefresh(r2); code != 401 {
		t.Fatalf("refresh after logout: want 401, got %d", code)
	}
}
