// Package config loads all runtime configuration from the environment and
// validates the JWT secret fail-closed. Bootstrap (main.go) calls Load once;
// everything downstream reads the returned Config.
package config

import (
	"errors"
	"fmt"
	"log"
	"os"
	"strconv"
	"time"
)

// Config holds the runtime configuration read at boot.
type Config struct {
	DatabaseURL   string
	RedisAddr     string
	JWTSecret     string
	AppEnv        string
	Port          string
	HoldTTL       time.Duration
	AccessTTL     time.Duration // short-lived access JWT
	RefreshTTL    time.Duration // opaque refresh token lifetime (Redis)
	MaxHeldSeats  int           // per-user cap on concurrent unpaid held seats (anti-hoarding)
	PoWDifficulty int           // proof-of-work leading-zero bits on login/register (0 = off)
}

func env(key, fallback string) string {
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

// ValidateJWTSecret fails closed: an empty secret is always fatal, and in
// production a short or known-weak secret is rejected outright. In non-prod it
// only warns, so local dev still boots.
func ValidateJWTSecret(secret, appEnv string) error {
	if secret == "" {
		return errors.New("JWT_SECRET is required (set a strong random value)")
	}
	if appEnv == "production" {
		if len(secret) < 32 {
			return fmt.Errorf("JWT_SECRET too short for production (%d chars, need >= 32)", len(secret))
		}
		if weakSecrets[secret] {
			return errors.New("JWT_SECRET is a known weak/default value; generate a unique secret")
		}
	} else if weakSecrets[secret] || len(secret) < 32 {
		log.Printf("WARNING: weak JWT_SECRET in %q mode — never use this in production", appEnv)
	}
	return nil
}

// Load reads configuration from the environment and validates the JWT secret.
// It returns an error only for fatal misconfiguration (a bad secret).
func Load() (Config, error) {
	ttlSec, _ := strconv.Atoi(env("HOLD_TTL_SECONDS", "600"))
	accessSec, _ := strconv.Atoi(env("ACCESS_TTL_SECONDS", "900"))      // 15m
	refreshSec, _ := strconv.Atoi(env("REFRESH_TTL_SECONDS", "604800")) // 7d
	maxHeld, _ := strconv.Atoi(env("MAX_HELD_SEATS_PER_USER", "8"))
	if maxHeld <= 0 {
		maxHeld = 8
	}
	powDifficulty, _ := strconv.Atoi(env("POW_DIFFICULTY", "0"))

	c := Config{
		DatabaseURL:   env("DATABASE_URL", "postgres://ticket:ticket@localhost:5432/ticket?sslmode=disable"),
		RedisAddr:     env("REDIS_ADDR", "localhost:6379"),
		JWTSecret:     env("JWT_SECRET", ""),
		AppEnv:        env("APP_ENV", "development"),
		Port:          env("PORT", "8080"),
		HoldTTL:       time.Duration(ttlSec) * time.Second,
		AccessTTL:     time.Duration(accessSec) * time.Second,
		RefreshTTL:    time.Duration(refreshSec) * time.Second,
		MaxHeldSeats:  maxHeld,
		PoWDifficulty: powDifficulty,
	}
	if err := ValidateJWTSecret(c.JWTSecret, c.AppEnv); err != nil {
		return c, err
	}
	return c, nil
}
