// Central API access layer: base URL, token storage, and an authFetch factory
// that transparently rotates the refresh token on a 401. Keeping this in one
// place means every caller shares the same refresh-on-401 behavior and there is
// a single spot to change transport (base URL, headers, cookie migration).

export const API = process.env.NEXT_PUBLIC_API || "http://localhost:8080";

// Tokens live in localStorage for this demo. Production hardening: keep the
// long-lived refresh token in an httpOnly cookie instead (needs HTTPS +
// SameSite=None for the cross-origin :3000->:8080 dev split, so it's a deploy-
// time change). React auto-escaping keeps the XSS surface low meanwhile.
export function loadAuth() {
  if (typeof window === "undefined") return null;
  try {
    return JSON.parse(localStorage.getItem("auth") || "null");
  } catch {
    return null;
  }
}

// Persist (or clear, when a is null) the auth object to localStorage.
export function persistAuth(a) {
  if (typeof window === "undefined") return;
  if (a) localStorage.setItem("auth", JSON.stringify(a));
  else localStorage.removeItem("auth");
}

// POST /api/refresh — rotate tokens. Returns the new token pair on success
// ({ access_token, refresh_token, ... }) or null so the caller can log out.
export async function refreshTokens(refreshToken) {
  const r = await fetch(`${API}/api/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  return r.ok ? r.json() : null;
}

// POST /api/logout — best-effort revoke of the refresh token (fire-and-forget).
export function logoutRequest(refreshToken) {
  if (!refreshToken) return;
  fetch(`${API}/api/logout`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: refreshToken }),
  }).catch(() => {});
}

// createAuthFetch builds a fetch that attaches the access token and, on a 401,
// transparently rotates via the refresh token once before giving up (which logs
// the user out). getAuth returns the current auth object; setAuth stores rotated
// tokens (or null to log out). Kept as a factory so the component owns the
// React state while the transport logic lives here.
export function createAuthFetch({ getAuth, setAuth }) {
  return async function authFetch(url, opts = {}) {
    const a = getAuth();
    if (!a) throw new Error("not authenticated");
    const withTok = (tok) =>
      fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${tok}` } });

    let res = await withTok(a.access);
    if (res.status === 401 && a.refresh) {
      const d = await refreshTokens(a.refresh);
      if (d) {
        setAuth({ ...a, access: d.access_token, refresh: d.refresh_token });
        res = await withTok(d.access_token);
      } else {
        setAuth(null); // refresh dead -> back to login
      }
    }
    return res;
  };
}
