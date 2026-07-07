"use client";
import { useCallback, useEffect, useRef, useState } from "react";

const API = process.env.NEXT_PUBLIC_API || "http://localhost:8080";
const DEFAULT_EVENT_ID = "00000000-0000-0000-0000-000000000001";
const DEFAULT_MAX_SEATS = 4;

const LEGEND = [
  ["ว่าง", "AVAILABLE"],
  ["เลือกอยู่", "SELECTED"],
  ["มีคนถืออยู่", "HELD"],
  ["ขายแล้ว", "SOLD"],
];

// Tokens live in localStorage for this demo. Production hardening: keep the
// long-lived refresh token in an httpOnly cookie instead (needs HTTPS +
// SameSite=None for the cross-origin :3000→:8080 dev split, so it's a deploy-
// time change). React auto-escaping keeps the XSS surface low meanwhile.
function loadAuth() {
  if (typeof window === "undefined") return null;
  try {
    return JSON.parse(localStorage.getItem("auth") || "null");
  } catch {
    return null;
  }
}

export default function Page() {
  // { access, refresh, userId, email, is_admin }
  const [auth, setAuthState] = useState(null);
  const [ready, setReady] = useState(false); // localStorage read complete
  const authRef = useRef(null);

  const setAuth = useCallback((a) => {
    authRef.current = a;
    setAuthState(a);
    if (typeof window !== "undefined") {
      if (a) localStorage.setItem("auth", JSON.stringify(a));
      else localStorage.removeItem("auth");
    }
  }, []);

  useEffect(() => {
    const a = loadAuth();
    if (a) {
      authRef.current = a;
      setAuthState(a);
    }
    setReady(true);
  }, []);

  const [events, setEvents] = useState([]);
  const [eventId, setEventId] = useState(DEFAULT_EVENT_ID);
  const [eventName, setEventName] = useState("Live in Bangkok 2026");
  const [maxSeats, setMaxSeats] = useState(DEFAULT_MAX_SEATS);
  const [adminView, setAdminView] = useState(false);

  const [seats, setSeats] = useState([]);
  const [selected, setSelected] = useState([]);
  const [order, setOrder] = useState(null); // {id, expiresAt, idemKey}
  const [remaining, setRemaining] = useState(0);
  const [orders, setOrders] = useState([]);
  const [msg, setMsg] = useState("");
  const orderRef = useRef(null);
  orderRef.current = order;

  // authFetch attaches the access token and, on a 401, transparently rotates
  // via the refresh token once before giving up (which logs the user out).
  const authFetch = useCallback(
    async (url, opts = {}) => {
      const a = authRef.current;
      if (!a) throw new Error("not authenticated");
      const withTok = (tok) =>
        fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${tok}` } });

      let res = await withTok(a.access);
      if (res.status === 401 && a.refresh) {
        const r = await fetch(`${API}/api/refresh`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refresh_token: a.refresh }),
        });
        if (r.ok) {
          const d = await r.json();
          setAuth({ ...a, access: d.access_token, refresh: d.refresh_token });
          res = await withTok(d.access_token);
        } else {
          setAuth(null); // refresh dead → back to login
        }
      }
      return res;
    },
    [setAuth]
  );

  const logout = useCallback(() => {
    const a = authRef.current;
    if (a?.refresh) {
      fetch(`${API}/api/logout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: a.refresh }),
      }).catch(() => {});
    }
    setAuth(null);
    setOrder(null);
    setSelected([]);
    setOrders([]);
    setMsg("");
    setAdminView(false);
  }, [setAuth]);

  const loadEvents = useCallback(() => {
    fetch(`${API}/api/events`)
      .then((r) => r.json())
      .then((d) => {
        const evs = d.events || [];
        setEvents(evs);
        setEventId((cur) =>
          evs.some((e) => e.id === cur)
            ? cur
            : evs.find((e) => e.id === DEFAULT_EVENT_ID)?.id || evs[0]?.id || cur
        );
      })
      .catch(() => {});
  }, []);

  const loadSeats = useCallback(() => {
    fetch(`${API}/api/events/${eventId}/seats`)
      .then((r) => r.json())
      .then((d) => {
        setSeats(d.seats || []);
        if (d.event?.name) setEventName(d.event.name);
        if (d.event?.max_seats_per_order) setMaxSeats(d.event.max_seats_per_order);
      })
      .catch(() => {});
  }, [eventId]);

  const loadOrders = useCallback(() => {
    if (!authRef.current) return;
    authFetch(`${API}/api/orders`)
      .then((r) => (r.ok ? r.json() : { orders: [] }))
      .then((d) => setOrders(d.orders || []))
      .catch(() => {});
  }, [authFetch]);

  useEffect(() => {
    if (!auth) return;
    loadEvents();
    loadSeats();
    loadOrders();
    const t = setInterval(loadSeats, 2000);
    return () => clearInterval(t);
  }, [auth, loadEvents, loadSeats, loadOrders]);

  useEffect(() => {
    setSelected([]);
    setOrder(null);
  }, [eventId]);

  // Hold countdown.
  useEffect(() => {
    const t = setInterval(() => {
      const o = orderRef.current;
      if (!o) return;
      const left = Math.max(0, Math.floor((new Date(o.expiresAt) - Date.now()) / 1000));
      setRemaining(left);
      if (left === 0) {
        setOrder(null);
        setSelected([]);
        setMsg("หมดเวลาชำระเงิน ที่นั่งถูกปล่อยคืนแล้ว");
      }
    }, 500);
    return () => clearInterval(t);
  }, []);

  const toggleSeat = (s) => {
    if (order || s.status !== "AVAILABLE") return;
    setSelected((cur) =>
      cur.includes(s.id)
        ? cur.filter((x) => x !== s.id)
        : cur.length < maxSeats
        ? [...cur, s.id]
        : cur
    );
  };

  const book = async () => {
    setMsg("");
    const res = await authFetch(`${API}/api/bookings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event_id: eventId, seat_ids: selected }),
    });
    const d = await res.json();
    if (res.status === 201) {
      setOrder({ id: d.order_id, expiresAt: d.expires_at, idemKey: crypto.randomUUID() });
      loadSeats();
    } else if (res.status === 409) {
      setMsg("มีคนตัดหน้าไปแล้ว 😅 เลือกที่นั่งใหม่ได้เลย");
      setSelected([]);
      loadSeats();
    } else if (res.status === 429) {
      setMsg("คุณถือที่นั่งไว้เยอะเกินไปแล้ว — ชำระหรือยกเลิกก่อน");
    } else {
      setMsg(`จองไม่สำเร็จ: ${d.error || res.status}`);
    }
  };

  const pay = async () => {
    setMsg("");
    const res = await authFetch(`${API}/api/orders/${order.id}/pay`, {
      method: "POST",
      headers: { "Idempotency-Key": order.idemKey },
    });
    const d = await res.json();
    if (res.ok && d.payment_status === "SUCCEEDED") {
      setMsg(`ชำระเงินสำเร็จ 🎫 order ${order.id.slice(0, 8)}…`);
      setOrder(null);
      setSelected([]);
      loadSeats();
      loadOrders();
    } else {
      setMsg(`ชำระเงินไม่สำเร็จ: ${d.error || res.status}`);
    }
  };

  const cancel = async () => {
    await authFetch(`${API}/api/orders/${order.id}`, { method: "DELETE" });
    setOrder(null);
    setSelected([]);
    setMsg("ยกเลิกแล้ว ที่นั่งถูกปล่อยคืน");
    loadSeats();
    loadOrders();
  };

  // Group seats into rows by leading letter (A1..A20 => row A).
  const rows = {};
  for (const s of seats) {
    const row = s.seat_no.replace(/[0-9]+$/, "");
    (rows[row] ||= []).push(s);
  }
  for (const r of Object.values(rows)) {
    r.sort((a, b) => parseInt(a.seat_no.match(/\d+$/)) - parseInt(b.seat_no.match(/\d+$/)));
  }

  const total = seats
    .filter((s) => selected.includes(s.id))
    .reduce((sum, s) => sum + Number(s.price), 0);

  const fmt = (sec) =>
    `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;

  if (!ready) return null;
  if (!auth) return <AuthForm onAuthed={setAuth} />;

  const showAdmin = adminView && auth.is_admin;

  return (
    <main className="shell">
      <header className="topbar anim-rise">
        <div>
          <p className="eyebrow">{showAdmin ? "ADMIN · จัดการงาน" : "Flash Sale · เปิดจองแล้ว"}</p>
          <h1 className="title">{showAdmin ? "แผงจัดการงานแสดง" : eventName}</h1>
          <p className="subtitle">
            เข้าสู่ระบบเป็น <b>{auth.email || auth.userId}</b>
          </p>
        </div>
        <div className="topbar__actions">
          {auth.is_admin && (
            <button onClick={() => setAdminView((v) => !v)} data-testid="admin-toggle" className="btn btn--ghost">
              {showAdmin ? "หน้าซื้อตั๋ว" : "จัดการงาน (Admin)"}
            </button>
          )}
          <button onClick={logout} data-testid="logout-btn" className="btn btn--ghost">
            ออกจากระบบ
          </button>
        </div>
      </header>

      {showAdmin ? (
        <AdminPanel authFetch={authFetch} onChanged={() => { loadEvents(); loadSeats(); }} />
      ) : (
        <>
          {events.length > 1 && (
            <div className="picker anim-rise">
              <span className="picker__label">เลือกงาน</span>
              <select
                value={eventId}
                onChange={(e) => setEventId(e.target.value)}
                data-testid="event-select"
                className="select"
              >
                {events.map((e) => (
                  <option key={e.id} value={e.id}>{e.name}</option>
                ))}
              </select>
            </div>
          )}

          <div className="stage anim-rise">STAGE</div>

          <div className="seatmap-wrap">
            <div className={`seatmap${order ? " locked" : ""}`}>
              {Object.entries(rows).map(([row, list]) => (
                <div key={row} className="seat-row">
                  <span className="seat-row__label">{row}</span>
                  {list.map((s) => (
                    <div
                      key={s.id}
                      className="seat"
                      title={`${s.seat_no} · ฿${s.price}`}
                      onClick={() => toggleSeat(s)}
                      data-testid="seat"
                      data-seat-no={s.seat_no}
                      data-status={s.status}
                      data-selected={selected.includes(s.id)}
                    >
                      {s.seat_no.match(/\d+$/)?.[0]}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>

          <div className="legend">
            {LEGEND.map(([label, state]) => (
              <span key={label}>
                <i data-status={state} />
                {label}
              </span>
            ))}
          </div>

          <div className="actionbar">
            {!order ? (
              <>
                <div className="actionbar__info">
                  <div className="actionbar__hint">
                    เลือกแล้ว <span className="count-tag">{selected.length}/{maxSeats}</span> ที่นั่ง
                  </div>
                  <div className="actionbar__big tnum">฿{total.toLocaleString()}</div>
                </div>
                <button onClick={book} disabled={selected.length === 0} className="btn btn--primary">
                  จองที่นั่ง (hold 10 นาที)
                </button>
              </>
            ) : (
              <>
                <div className="actionbar__info">
                  <div className="actionbar__hint">ถือที่นั่งไว้ให้คุณ — ชำระเงินภายใน</div>
                  <div className={`countdown${remaining < 60 ? " warn" : ""}`}>{fmt(remaining)}</div>
                </div>
                <button onClick={pay} className="btn btn--primary">ชำระเงิน (mock)</button>
                <button onClick={cancel} className="btn btn--ghost">ยกเลิก</button>
              </>
            )}
          </div>

          {msg && <p className="msg">{msg}</p>}

          {orders.length > 0 && (
            <section>
              <h2 className="section-h">การจองของฉัน</h2>
              <div className="orders">
                {orders.map((o) => (
                  <div key={o.id} className="order">
                    <span className={`pill ${o.status === "PAID" ? "pill--paid" : o.status === "PENDING" ? "pill--pending" : "pill--other"}`}>
                      {o.status}
                    </span>
                    <span className="order__seats">{o.seat_nos || "—"}</span>
                    <span className="tnum">฿{Number(o.amount).toLocaleString()}</span>
                  </div>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </main>
  );
}

// AdminPanel — content management for events: live sales stats, create an event
// (a show/round) with its seat map, and open/close the sale or change the
// per-order seat cap. All calls go through authFetch (admin-gated on the server).
function AdminPanel({ authFetch, onChanged }) {
  const [events, setEvents] = useState([]);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    authFetch(`${API}/api/admin/events`)
      .then((r) => (r.ok ? r.json() : { events: [] }))
      .then((d) => setEvents(d.events || []))
      .catch(() => {});
  }, [authFetch]);

  useEffect(() => { load(); }, [load]);

  const patch = async (id, body) => {
    const res = await authFetch(`${API}/api/admin/events/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) { load(); onChanged?.(); }
    else { const d = await res.json().catch(() => ({})); setMsg(`แก้ไขไม่สำเร็จ: ${d.error || res.status}`); }
  };

  const totals = events.reduce(
    (a, e) => ({ sold: a.sold + e.sold, revenue: a.revenue + Number(e.revenue) }),
    { sold: 0, revenue: 0 }
  );

  return (
    <div className="anim-rise">
      <div className="stat-grid">
        <StatTile label="งานทั้งหมด" value={events.length} />
        <StatTile label="ที่นั่งขายแล้ว" value={totals.sold.toLocaleString()} />
        <StatTile label="รายได้รวม" value={`฿${totals.revenue.toLocaleString()}`} accent />
      </div>

      <CreateEventForm
        authFetch={authFetch}
        busy={busy}
        setBusy={setBusy}
        onCreated={() => { load(); onChanged?.(); setMsg("สร้างงานใหม่แล้ว"); }}
        setMsg={setMsg}
      />

      {msg && <p className="msg">{msg}</p>}

      <div className="admin-list">
        {events.map((e) => <EventRow key={e.id} e={e} onPatch={patch} />)}
      </div>
    </div>
  );
}

function StatTile({ label, value, accent }) {
  return (
    <div className="stat">
      <div className="stat__label">{label}</div>
      <div className={`stat__value${accent ? " accent" : ""}`}>{value}</div>
    </div>
  );
}

function EventRow({ e, onPatch }) {
  const [cap, setCap] = useState(e.max_seats_per_order);
  const pct = e.total > 0 ? Math.round((e.sold / e.total) * 100) : 0;
  const onSale = e.status === "ON_SALE";

  return (
    <div className="event-card">
      <div className="event-card__top">
        <div>
          <div className="event-card__name">{e.name}</div>
          <div className="event-card__date">
            แสดง {new Date(e.starts_at).toLocaleDateString("th-TH", { day: "numeric", month: "short", year: "numeric" })}
          </div>
        </div>
        <span className={`pill ${onSale ? "pill--onsale" : "pill--closed"}`}>{onSale ? "เปิดขาย" : "ปิดขาย"}</span>
      </div>

      <div className="meter-row">
        <span>ขายแล้ว {e.sold.toLocaleString()} / {e.total.toLocaleString()} ({pct}%)</span>
        <span className="rev">฿{Number(e.revenue).toLocaleString()}</span>
      </div>
      <div className="meter"><div className="meter__fill" style={{ width: `${pct}%` }} /></div>

      <div className="event-card__controls">
        <button onClick={() => onPatch(e.id, { status: onSale ? "CLOSED" : "ON_SALE" })} className={`btn ${onSale ? "btn--ghost" : "btn--primary"}`}>
          {onSale ? "ปิดขาย" : "เปิดขาย"}
        </button>
        <div className="cap-edit">
          <span>ที่นั่ง/คน</span>
          <input type="number" min={1} max={20} value={cap} onChange={(ev) => setCap(Number(ev.target.value))} className="input" />
          <button onClick={() => onPatch(e.id, { max_seats_per_order: cap })} className="btn btn--ghost">บันทึก</button>
        </div>
      </div>
    </div>
  );
}

function CreateEventForm({ authFetch, busy, setBusy, onCreated, setMsg }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({
    name: "", starts_at: "", rows: 10, seats_per_row: 20,
    price: 1500, premium_rows: 3, premium_price: 2500, max_seats_per_order: 4,
  });
  const set = (k) => (ev) => setF((s) => ({ ...s, [k]: ev.target.value }));

  const submit = async (ev) => {
    ev.preventDefault();
    setMsg("");
    if (!f.name || !f.starts_at) { setMsg("กรอกชื่องานและวันแสดงก่อน"); return; }
    setBusy(true);
    try {
      const body = {
        name: f.name,
        starts_at: new Date(f.starts_at).toISOString(),
        rows: Number(f.rows), seats_per_row: Number(f.seats_per_row),
        price: Number(f.price), premium_rows: Number(f.premium_rows),
        premium_price: Number(f.premium_price), max_seats_per_order: Number(f.max_seats_per_order),
      };
      const res = await authFetch(`${API}/api/admin/events`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      if (res.status === 201) { setF((s) => ({ ...s, name: "", starts_at: "" })); setOpen(false); onCreated?.(); }
      else { const d = await res.json().catch(() => ({})); setMsg(`สร้างงานไม่สำเร็จ: ${d.error || res.status}`); }
    } finally { setBusy(false); }
  };

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} data-testid="new-event-btn" className="btn btn--primary" style={{ marginTop: 18 }}>
        + สร้างงานใหม่
      </button>
    );
  }

  const field = (label, key, type = "number") => (
    <label className="field">
      {label}
      <input type={type} value={f[key]} onChange={set(key)} className="input" />
    </label>
  );

  return (
    <form onSubmit={submit} className="create-form">
      <h3>สร้างงานใหม่ (รอบใหม่)</h3>
      <label className="field">
        ชื่องาน
        <input value={f.name} onChange={set("name")} data-testid="ev-name" placeholder="เช่น Live in Bangkok 2026 — Night 2" className="input" />
      </label>
      <label className="field">
        วันเวลาแสดง
        <input type="datetime-local" value={f.starts_at} onChange={set("starts_at")} data-testid="ev-date" className="input" />
      </label>
      <div className="field-grid">
        {field("จำนวนแถว", "rows")}
        {field("ที่นั่งต่อแถว", "seats_per_row")}
        {field("ที่นั่ง/คน", "max_seats_per_order")}
        {field("ราคาปกติ (฿)", "price")}
        {field("แถวพรีเมียม", "premium_rows")}
        {field("ราคาพรีเมียม (฿)", "premium_price")}
      </div>
      <div className="form-actions">
        <button type="submit" disabled={busy} data-testid="ev-submit" className="btn btn--primary">
          {busy ? "กำลังสร้าง…" : "สร้างงาน"}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="btn btn--ghost">ยกเลิก</button>
      </div>
    </form>
  );
}

// AuthForm — register or log in with email + password. On success it hands the
// tokens up via onAuthed.
function AuthForm({ onAuthed }) {
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
