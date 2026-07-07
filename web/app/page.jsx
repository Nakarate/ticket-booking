"use client";
import { useCallback, useEffect, useRef, useState } from "react";

const API = process.env.NEXT_PUBLIC_API || "http://localhost:8080";
const DEFAULT_EVENT_ID = "00000000-0000-0000-0000-000000000001";
const DEFAULT_MAX_SEATS = 4;

const COLORS = {
  AVAILABLE: { bg: "#16211f", border: "#2f8f6f", text: "#8fd9bd" },
  HELD: { bg: "#2a2113", border: "#b8860b", text: "#e6c477" },
  SOLD: { bg: "#1a1a1a", border: "#333", text: "#555" },
  SELECTED: { bg: "#2f8f6f", border: "#5fd9a8", text: "#0c1512" },
};

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

  // Public list of on-sale events for the picker. Keeps the current selection if
  // it's still on sale, else falls back to the demo event or the first one.
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

  // Seat map polling + orders + event list, only once authenticated.
  useEffect(() => {
    if (!auth) return;
    loadEvents();
    loadSeats();
    loadOrders();
    const t = setInterval(loadSeats, 2000);
    return () => clearInterval(t);
  }, [auth, loadEvents, loadSeats, loadOrders]);

  // Switching events clears any in-progress selection/hold.
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

  const seatStyle = (s) => {
    const state = selected.includes(s.id) ? "SELECTED" : s.status;
    const c = COLORS[state] || COLORS.SOLD;
    return {
      width: 30,
      height: 30,
      borderRadius: 7,
      border: `1px solid ${c.border}`,
      background: c.bg,
      color: c.text,
      fontSize: 9,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      cursor: s.status === "AVAILABLE" && !order ? "pointer" : "default",
      userSelect: "none",
      transition: "transform .08s",
    };
  };

  const fmt = (sec) =>
    `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;

  if (!ready) return null;
  if (!auth) return <AuthForm onAuthed={setAuth} />;

  const showAdmin = adminView && auth.is_admin;

  return (
    <main style={{ maxWidth: 920, margin: "0 auto", padding: "40px 20px 80px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16 }}>
        <div>
          <p style={{ letterSpacing: 4, fontSize: 11, color: "#8a877d", margin: 0 }}>
            {showAdmin ? "ADMIN · จัดการงาน" : "FLASH SALE · NOW OPEN"}
          </p>
          <h1 style={{ fontSize: 34, fontWeight: 500, margin: "6px 0 2px" }}>
            {showAdmin ? "แผงจัดการงานแสดง" : eventName}
          </h1>
          <p style={{ color: "#8a877d", marginTop: 0 }}>
            เข้าสู่ระบบเป็น <span style={{ color: "#c9c6bb" }}>{auth.email || auth.userId}</span>
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {auth.is_admin && (
            <button
              onClick={() => setAdminView((v) => !v)}
              data-testid="admin-toggle"
              style={btn(false)}
            >
              {showAdmin ? "หน้าซื้อตั๋ว" : "จัดการงาน (Admin)"}
            </button>
          )}
          <button onClick={logout} data-testid="logout-btn" style={btn(false)}>
            ออกจากระบบ
          </button>
        </div>
      </div>

      {showAdmin ? (
        <AdminPanel
          authFetch={authFetch}
          onChanged={() => {
            loadEvents();
            loadSeats();
          }}
        />
      ) : (
        <>
          {/* Event picker */}
          {events.length > 1 && (
            <div style={{ marginTop: 24, display: "flex", gap: 10, alignItems: "center" }}>
              <span style={{ fontSize: 13, color: "#8a877d" }}>เลือกงาน</span>
              <select
                value={eventId}
                onChange={(e) => setEventId(e.target.value)}
                data-testid="event-select"
                style={{ ...input, padding: "8px 12px", flex: 1, maxWidth: 360 }}
              >
                {events.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Stage */}
          <div
            style={{
              margin: "34px auto 26px",
              width: "70%",
              height: 34,
              borderRadius: "0 0 120px 120px",
              background: "#1b222a",
              border: "1px solid #2c3540",
              borderTop: "none",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#77828e",
              fontSize: 12,
              letterSpacing: 6,
            }}
          >
            STAGE
          </div>

          {/* Seat map */}
          <div style={{ display: "grid", gap: 7, justifyContent: "center" }}>
            {Object.entries(rows).map(([row, list]) => (
              <div key={row} style={{ display: "flex", gap: 7, alignItems: "center" }}>
                <span style={{ width: 16, fontSize: 11, color: "#666" }}>{row}</span>
                {list.map((s) => (
                  <div
                    key={s.id}
                    title={`${s.seat_no} · ฿${s.price}`}
                    style={seatStyle(s)}
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

          {/* Legend */}
          <div style={{ display: "flex", gap: 18, justifyContent: "center", marginTop: 22, fontSize: 12, color: "#9a978c" }}>
            {[["ว่าง", COLORS.AVAILABLE], ["เลือกอยู่", COLORS.SELECTED], ["มีคนถืออยู่", COLORS.HELD], ["ขายแล้ว", COLORS.SOLD]].map(([label, c]) => (
              <span key={label} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <span style={{ width: 12, height: 12, borderRadius: 4, background: c.bg, border: `1px solid ${c.border}` }} />
                {label}
              </span>
            ))}
          </div>

          {/* Action bar */}
          <div
            style={{
              marginTop: 34,
              padding: "18px 22px",
              borderRadius: 14,
              background: "#171d23",
              border: "1px solid #262e37",
              display: "flex",
              alignItems: "center",
              gap: 16,
              flexWrap: "wrap",
            }}
          >
            {!order ? (
              <>
                <div style={{ flex: 1, minWidth: 200 }}>
                  <div style={{ fontSize: 13, color: "#9a978c" }}>
                    เลือกแล้ว {selected.length}/{maxSeats} ที่นั่ง
                  </div>
                  <div style={{ fontSize: 22 }}>฿{total.toLocaleString()}</div>
                </div>
                <button onClick={book} disabled={selected.length === 0} style={btn(selected.length > 0)}>
                  จองที่นั่ง (hold 10 นาที)
                </button>
              </>
            ) : (
              <>
                <div style={{ flex: 1, minWidth: 200 }}>
                  <div style={{ fontSize: 13, color: "#9a978c" }}>ถือที่นั่งไว้ให้คุณ — ชำระเงินภายใน</div>
                  <div style={{ fontSize: 26, fontVariantNumeric: "tabular-nums", color: remaining < 60 ? "#e08a4f" : "#e8e6df" }}>
                    {fmt(remaining)}
                  </div>
                </div>
                <button onClick={pay} style={btn(true)}>ชำระเงิน (mock)</button>
                <button onClick={cancel} style={btn(false)}>ยกเลิก</button>
              </>
            )}
          </div>

          {msg && (
            <p style={{ marginTop: 16, padding: "10px 14px", background: "#20262c", borderRadius: 10, fontSize: 14 }}>
              {msg}
            </p>
          )}

          {/* My bookings — GET /api/orders (idx_orders_user) */}
          {orders.length > 0 && (
            <section style={{ marginTop: 28 }}>
              <h2 style={{ fontSize: 15, fontWeight: 500, color: "#9a978c", letterSpacing: 1 }}>การจองของฉัน</h2>
              <div style={{ display: "grid", gap: 8 }}>
                {orders.map((o) => (
                  <div
                    key={o.id}
                    style={{
                      display: "flex",
                      gap: 12,
                      alignItems: "center",
                      padding: "10px 14px",
                      borderRadius: 10,
                      background: "#171d23",
                      border: "1px solid #232b33",
                      fontSize: 13,
                    }}
                  >
                    <span
                      style={{
                        padding: "2px 10px",
                        borderRadius: 20,
                        fontSize: 11,
                        background: o.status === "PAID" ? "#1d3a2e" : o.status === "PENDING" ? "#332a15" : "#26262a",
                        color: o.status === "PAID" ? "#7ed9ac" : o.status === "PENDING" ? "#e0b45f" : "#8a8a90",
                      }}
                    >
                      {o.status}
                    </span>
                    <span style={{ flex: 1, color: "#c9c6bb" }}>{o.seat_nos || "—"}</span>
                    <span style={{ fontVariantNumeric: "tabular-nums" }}>฿{Number(o.amount).toLocaleString()}</span>
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

  useEffect(() => {
    load();
  }, [load]);

  const patch = async (id, body) => {
    const res = await authFetch(`${API}/api/admin/events/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      load();
      onChanged?.();
    } else {
      const d = await res.json().catch(() => ({}));
      setMsg(`แก้ไขไม่สำเร็จ: ${d.error || res.status}`);
    }
  };

  const totals = events.reduce(
    (a, e) => ({ sold: a.sold + e.sold, revenue: a.revenue + Number(e.revenue) }),
    { sold: 0, revenue: 0 }
  );

  return (
    <div style={{ marginTop: 26 }}>
      {/* Summary stat tiles */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
        <StatTile label="งานทั้งหมด" value={events.length} />
        <StatTile label="ที่นั่งขายแล้ว" value={totals.sold.toLocaleString()} />
        <StatTile label="รายได้รวม" value={`฿${totals.revenue.toLocaleString()}`} accent />
      </div>

      <CreateEventForm
        authFetch={authFetch}
        busy={busy}
        setBusy={setBusy}
        onCreated={() => {
          load();
          onChanged?.();
          setMsg("สร้างงานใหม่แล้ว");
        }}
        setMsg={setMsg}
      />

      {msg && (
        <p style={{ marginTop: 14, padding: "10px 14px", background: "#20262c", borderRadius: 10, fontSize: 14 }}>
          {msg}
        </p>
      )}

      {/* Event rows */}
      <div style={{ marginTop: 22, display: "grid", gap: 12 }}>
        {events.map((e) => (
          <EventRow key={e.id} e={e} onPatch={patch} />
        ))}
      </div>
    </div>
  );
}

function StatTile({ label, value, accent }) {
  return (
    <div style={{ padding: "16px 18px", borderRadius: 12, background: "#171d23", border: "1px solid #262e37" }}>
      <div style={{ fontSize: 12, color: "#8a877d", marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 600, fontVariantNumeric: "tabular-nums", color: accent ? "#7ed9ac" : "#e8e6df" }}>
        {value}
      </div>
    </div>
  );
}

function EventRow({ e, onPatch }) {
  const [cap, setCap] = useState(e.max_seats_per_order);
  const pct = e.total > 0 ? Math.round((e.sold / e.total) * 100) : 0;
  const onSale = e.status === "ON_SALE";

  return (
    <div style={{ padding: "16px 18px", borderRadius: 12, background: "#171d23", border: "1px solid #262e37" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 500 }}>{e.name}</div>
          <div style={{ fontSize: 12, color: "#8a877d" }}>
            แสดง {new Date(e.starts_at).toLocaleDateString("th-TH", { day: "numeric", month: "short", year: "numeric" })}
          </div>
        </div>
        {/* status pill: state carried by label + color, never color alone */}
        <span
          style={{
            padding: "3px 12px",
            borderRadius: 20,
            fontSize: 12,
            background: onSale ? "#1d3a2e" : "#2a2331",
            color: onSale ? "#7ed9ac" : "#c39ad6",
          }}
        >
          {onSale ? "เปิดขาย" : "ปิดขาย"}
        </span>
      </div>

      {/* Occupancy meter — single-hue magnitude, sold vs total */}
      <div style={{ marginTop: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#9a978c", marginBottom: 5 }}>
          <span>
            ขายแล้ว {e.sold.toLocaleString()} / {e.total.toLocaleString()} ที่นั่ง ({pct}%)
          </span>
          <span style={{ fontVariantNumeric: "tabular-nums", color: "#7ed9ac" }}>฿{Number(e.revenue).toLocaleString()}</span>
        </div>
        <div style={{ height: 8, borderRadius: 999, background: "#232b33", overflow: "hidden" }}>
          <div style={{ height: "100%", width: `${pct}%`, background: "#2f8f6f", borderRadius: 999 }} />
        </div>
      </div>

      {/* Controls */}
      <div style={{ marginTop: 16, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <button
          onClick={() => onPatch(e.id, { status: onSale ? "CLOSED" : "ON_SALE" })}
          style={btn(!onSale)}
        >
          {onSale ? "ปิดขาย" : "เปิดขาย"}
        </button>
        <div style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13, color: "#9a978c" }}>
          <span>ที่นั่ง/คน</span>
          <input
            type="number"
            min={1}
            max={20}
            value={cap}
            onChange={(ev) => setCap(Number(ev.target.value))}
            style={{ ...input, width: 64, padding: "6px 8px" }}
          />
          <button onClick={() => onPatch(e.id, { max_seats_per_order: cap })} style={btn(false)}>
            บันทึก
          </button>
        </div>
      </div>
    </div>
  );
}

function CreateEventForm({ authFetch, busy, setBusy, onCreated, setMsg }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({
    name: "",
    starts_at: "",
    rows: 10,
    seats_per_row: 20,
    price: 1500,
    premium_rows: 3,
    premium_price: 2500,
    max_seats_per_order: 4,
  });
  const set = (k) => (ev) => setF((s) => ({ ...s, [k]: ev.target.value }));

  const submit = async (ev) => {
    ev.preventDefault();
    setMsg("");
    if (!f.name || !f.starts_at) {
      setMsg("กรอกชื่องานและวันแสดงก่อน");
      return;
    }
    setBusy(true);
    try {
      const body = {
        name: f.name,
        starts_at: new Date(f.starts_at).toISOString(),
        rows: Number(f.rows),
        seats_per_row: Number(f.seats_per_row),
        price: Number(f.price),
        premium_rows: Number(f.premium_rows),
        premium_price: Number(f.premium_price),
        max_seats_per_order: Number(f.max_seats_per_order),
      };
      const res = await authFetch(`${API}/api/admin/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.status === 201) {
        setF((s) => ({ ...s, name: "", starts_at: "" }));
        setOpen(false);
        onCreated?.();
      } else {
        const d = await res.json().catch(() => ({}));
        setMsg(`สร้างงานไม่สำเร็จ: ${d.error || res.status}`);
      }
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} data-testid="new-event-btn" style={{ ...btn(true), marginTop: 18 }}>
        + สร้างงานใหม่
      </button>
    );
  }

  const field = (label, key, type = "number") => (
    <label style={{ display: "grid", gap: 4, fontSize: 12, color: "#9a978c" }}>
      {label}
      <input type={type} value={f[key]} onChange={set(key)} style={input} />
    </label>
  );

  return (
    <form
      onSubmit={submit}
      style={{ marginTop: 18, padding: "20px 22px", borderRadius: 14, background: "#141a20", border: "1px solid #2c3540", display: "grid", gap: 14 }}
    >
      <div style={{ fontSize: 15, fontWeight: 500 }}>สร้างงานใหม่ (รอบใหม่)</div>
      <label style={{ display: "grid", gap: 4, fontSize: 12, color: "#9a978c" }}>
        ชื่องาน
        <input value={f.name} onChange={set("name")} data-testid="ev-name" placeholder="เช่น Live in Bangkok 2026 — Night 2" style={input} />
      </label>
      <label style={{ display: "grid", gap: 4, fontSize: 12, color: "#9a978c" }}>
        วันเวลาแสดง
        <input type="datetime-local" value={f.starts_at} onChange={set("starts_at")} data-testid="ev-date" style={input} />
      </label>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 12 }}>
        {field("จำนวนแถว", "rows")}
        {field("ที่นั่งต่อแถว", "seats_per_row")}
        {field("ที่นั่ง/คน", "max_seats_per_order")}
        {field("ราคาปกติ (฿)", "price")}
        {field("แถวพรีเมียม", "premium_rows")}
        {field("ราคาพรีเมียม (฿)", "premium_price")}
      </div>
      <div style={{ display: "flex", gap: 10 }}>
        <button type="submit" disabled={busy} data-testid="ev-submit" style={btn(true)}>
          {busy ? "กำลังสร้าง…" : "สร้างงาน"}
        </button>
        <button type="button" onClick={() => setOpen(false)} style={btn(false)}>
          ยกเลิก
        </button>
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
    <main style={{ maxWidth: 380, margin: "80px auto", padding: "0 20px" }}>
      <p style={{ letterSpacing: 4, fontSize: 11, color: "#8a877d", margin: 0 }}>FLASH SALE</p>
      <h1 style={{ fontSize: 28, fontWeight: 500, margin: "6px 0 20px" }}>
        {mode === "register" ? "สมัครสมาชิก" : "เข้าสู่ระบบ"}
      </h1>
      <form onSubmit={submit} style={{ display: "grid", gap: 12 }}>
        <input
          type="email"
          placeholder="อีเมล"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          data-testid="auth-email"
          autoComplete="email"
          style={input}
        />
        <input
          type="password"
          placeholder="รหัสผ่าน (อย่างน้อย 8 ตัว)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          data-testid="auth-password"
          autoComplete={mode === "register" ? "new-password" : "current-password"}
          style={input}
        />
        <button type="submit" disabled={busy} data-testid="auth-submit" style={btn(true)}>
          {mode === "register" ? "สมัครและเข้าสู่ระบบ" : "เข้าสู่ระบบ"}
        </button>
      </form>
      {err && (
        <p data-testid="auth-error" style={{ marginTop: 12, color: "#e08a4f", fontSize: 13 }}>
          {err}
        </p>
      )}
      <button
        onClick={() => {
          setMode(mode === "register" ? "login" : "register");
          setErr("");
        }}
        data-testid="auth-toggle"
        style={{ marginTop: 18, background: "none", border: "none", color: "#8fd9bd", cursor: "pointer", fontSize: 13 }}
      >
        {mode === "register" ? "มีบัญชีอยู่แล้ว? เข้าสู่ระบบ" : "ยังไม่มีบัญชี? สมัครสมาชิก"}
      </button>
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
      if (x === 0) {
        bitsZero += 8;
        continue;
      }
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

const input = {
  padding: "12px 14px",
  borderRadius: 10,
  border: "1px solid #2c3540",
  background: "#141a20",
  color: "#e8e6df",
  fontSize: 15,
  outline: "none",
};

const btn = (primary) => ({
  padding: "12px 22px",
  borderRadius: 10,
  border: primary ? "none" : "1px solid #3a444f",
  background: primary ? "#2f8f6f" : "transparent",
  color: primary ? "#0c1512" : "#c9c6bb",
  fontSize: 15,
  fontWeight: 500,
  cursor: "pointer",
});
