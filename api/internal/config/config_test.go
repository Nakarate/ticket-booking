package config

import "testing"

// ValidateJWTSecret must fail closed: empty is always fatal, and production
// rejects short or known-weak secrets while dev only warns.
func TestValidateJWTSecret(t *testing.T) {
	strong := "9f3c1e7a2b8d4056af17c9e0b3d6512e7a84f0c19d2b6e35" // 48 chars

	cases := []struct {
		name    string
		secret  string
		env     string
		wantErr bool
	}{
		{"empty in dev", "", "development", true},
		{"empty in prod", "", "production", true},
		{"weak default in prod", "dev-secret-change-in-prod", "production", true},
		{"short in prod", "tooshort", "production", true},
		{"strong in prod", strong, "production", false},
		{"weak default in dev (warn only)", "dev-secret-change-in-prod", "development", false},
		{"strong in dev", strong, "development", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := ValidateJWTSecret(c.secret, c.env)
			if (err != nil) != c.wantErr {
				t.Fatalf("ValidateJWTSecret(%q, %q) err=%v, wantErr=%v", c.secret, c.env, err, c.wantErr)
			}
		})
	}
}
