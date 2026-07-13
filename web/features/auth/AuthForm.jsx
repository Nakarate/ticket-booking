import { useState } from "react";
import { API } from "../../lib/api";

// AuthForm — register or log in with email + password. On success it hands the
// token bundle up via onAuthed. Solves a proof-of-work challenge inline when the
// server demands one (POW_DIFFICULTY > 0).
export function AuthForm({ onAuthed }) {
  const [mode, setMode] = useState("login"); // login | register — returning users are the common case
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e?.preventDefault();
    setErr("");
    setBusy(true);
    try {
      const url = `${API}/api/${mode}`;
      const body = JSON.stringify({ email, password });
      const call = (extra = {}) =>
        fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...extra }, body });

      let res = await call();
      let d = await res.json().catch(() => ({}));

      // Proof-of-work challenge (only when the server has it enabled): solve and retry.
      if (res.status === 400 && d.error === "pow_required") {
        setErr("กำลังพิสูจน์ตัวตน (proof-of-work)…");
        const solution = await solvePow(d.challenge, d.difficulty);
        res = await call({ "X-PoW-Challenge": d.challenge, "X-PoW-Solution": solution });
        d = await res.json().catch(() => ({}));
        setErr("");
      }

      const ok = (mode === "register" && res.status === 201) || (mode === "login" && res.status === 200);
      if (ok) {
        onAuthed({ access: d.access_token, refresh: d.refresh_token, userId: d.user_id, email, is_admin: !!d.is_admin });
      } else {
        setErr(errText(d.error, res.status));
      }
    } catch {
      setErr("เชื่อมต่อ API ไม่ได้ — เช็คว่า docker compose ขึ้นครบ");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="auth">
      <div className="auth__card anim-rise">
        <p className="eyebrow">Box Office · Live in Bangkok 2026</p>
        <h1 className="title">{mode === "register" ? "สมัครสมาชิก" : "เข้าสู่ระบบ"}</h1>
        <form onSubmit={submit}>
          <input
            type="email" placeholder="อีเมล" value={email}
            onChange={(e) => setEmail(e.target.value)}
            data-testid="auth-email" autoComplete="email" className="input"
          />
          <input
            type="password" placeholder="รหัสผ่าน (อย่างน้อย 8 ตัว)" value={password}
            onChange={(e) => setPassword(e.target.value)}
            data-testid="auth-password" autoComplete={mode === "register" ? "new-password" : "current-password"} className="input"
          />
          <button type="submit" disabled={busy} data-testid="auth-submit" className="btn btn--primary">
            {mode === "register" ? "สมัครและเข้าสู่ระบบ" : "เข้าสู่ระบบ"}
          </button>
        </form>
        {err && <p data-testid="auth-error" className="auth__error">{err}</p>}
        <button
          onClick={() => { setMode(mode === "register" ? "login" : "register"); setErr(""); }}
          data-testid="auth-toggle" className="auth__toggle"
        >
          {mode === "register" ? "มีบัญชีอยู่แล้ว? เข้าสู่ระบบ" : "ยังไม่มีบัญชี? สมัครสมาชิก"}
        </button>
      </div>
    </main>
  );
}

// solvePow finds a nonce whose sha256("challenge:nonce") starts with `difficulty`
// zero bits — the same puzzle the API verifies in one hash. Cheap for one login,
// costly for a bot doing thousands.
async function solvePow(challenge, difficulty) {
  const enc = new TextEncoder();
  for (let n = 0; ; n++) {
    const buf = await crypto.subtle.digest("SHA-256", enc.encode(`${challenge}:${n}`));
    const bytes = new Uint8Array(buf);
    let bitsZero = 0;
    for (const x of bytes) {
      if (x === 0) { bitsZero += 8; continue; }
      bitsZero += Math.clz32(x) - 24; // leading zeros within this byte
      break;
    }
    if (bitsZero >= difficulty) return String(n);
  }
}

function errText(code, status) {
  const map = {
    invalid_credentials: "อีเมลหรือรหัสผ่านไม่ถูกต้อง",
    email_taken: "อีเมลนี้ถูกใช้แล้ว — ลองเข้าสู่ระบบแทน",
    password_too_short: "รหัสผ่านต้องยาวอย่างน้อย 8 ตัว",
    invalid_email: "อีเมลไม่ถูกต้อง",
  };
  return map[code] || `ทำรายการไม่สำเร็จ (${code || status})`;
}
