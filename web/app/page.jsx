"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const API = process.env.NEXT_PUBLIC_API || "http://localhost:8080";
const DEFAULT_EVENT_ID = "00000000-0000-0000-0000-000000000001";
const DEFAULT_MAX_SEATS = 4;

const LEGEND = [
  ["ว่าง", "AVAILABLE"],
  ["เลือกอยู่", "SELECTED"],
  ["มีคนถืออยู่", "HELD"],
  ["ขายแล้ว", "SOLD"],
];

// 24-hour time slots (every 30 min) for the admin create form's time dropdown.
const TIME_OPTIONS = Array.from({ length: 48 }, (_, i) => {
  const h = String(Math.floor(i / 2)).padStart(2, "0");
  return `${h}:${i % 2 === 0 ? "00" : "30"}`;
});

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
  const [eventsLoaded, setEventsLoaded] = useState(false);
  const [eventId, setEventId] = useState(null); // set = booking view for that show
  const [production, setProduction] = useState(null); // set = show/date picker for a multi-show production
  const [eventName, setEventName] = useState("");
  const [maxSeats, setMaxSeats] = useState(DEFAULT_MAX_SEATS);
  const [adminView, setAdminView] = useState(false);

  const groups = useMemo(() => groupEvents(events), [events]);
  const onPickProduction = useCallback((g) => {
    if (g.isMulti) setProduction(g);
    else { setProduction(null); setEventId(g.shows[0].id); }
  }, []);

  const [seats, setSeats] = useState([]);
  const [seatsLoaded, setSeatsLoaded] = useState(false);
  const [selected, setSelected] = useState([]);
  const [order, setOrder] = useState(null); // {id, expiresAt, idemKey}
  const [remaining, setRemaining] = useState(0);
  const [orders, setOrders] = useState([]);
  const [msg, setMsg] = useState("");
  const [confirmState, setConfirmState] = useState(null);
  const askConfirm = useCallback((opts) => setConfirmState(opts), []);
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
    setProduction(null);
    setEventId(null);
  }, [setAuth]);

  const loadEvents = useCallback(() => {
    fetch(`${API}/api/events`)
      .then((r) => r.json())
      .then((d) => { setEvents(d.events || []); setEventsLoaded(true); })
      .catch(() => {});
  }, []);

  const loadSeats = useCallback(() => {
    if (!eventId) return;
    fetch(`${API}/api/events/${eventId}/seats`)
      .then((r) => r.json())
      .then((d) => {
        setSeats(d.seats || []);
        setSeatsLoaded(true);
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

  // On login: load the event list + my orders.
  useEffect(() => {
    if (!auth) return;
    loadEvents();
    loadOrders();
  }, [auth, loadEvents, loadOrders]);

  // Poll the seat map only while an event is open in the booking view.
  useEffect(() => {
    if (!auth || !eventId) return;
    loadSeats();
    const t = setInterval(loadSeats, 2000);
    return () => clearInterval(t);
  }, [auth, eventId, loadSeats]);

  useEffect(() => {
    setSelected([]);
    setOrder(null);
    setSeatsLoaded(false);
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

  // Price tiers derived from the seat data: rows within a tier share a price,
  // and the highest price is the "premium" tier (front rows).
  const rowNames = Object.keys(rows);
  const rowPrice = {};
  for (const rn of rowNames) rowPrice[rn] = rows[rn][0] ? Number(rows[rn][0].price) : 0;
  const distinctPrices = [...new Set(Object.values(rowPrice))].sort((a, b) => b - a);
  const premiumPrice = distinctPrices.length > 1 ? distinctPrices[0] : null;
  const rowRange = (rs) => (rs.length > 1 ? `${rs[0]}–${rs[rs.length - 1]}` : rs[0]);
  const tiers = distinctPrices.map((p) => ({
    price: p,
    premium: p === premiumPrice,
    rows: rowNames.filter((rn) => rowPrice[rn] === p),
  }));

  const fmt = (sec) =>
    `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;

  if (!ready) return null;
  if (!auth) return <AuthForm onAuthed={setAuth} />;

  const showAdmin = adminView && auth.is_admin;

  return (
    <main className="shell">
      <header className="topbar anim-rise">
        <div>
          <p className="eyebrow">
            {showAdmin
              ? "ADMIN · จัดการงาน"
              : eventId
              ? production
                ? production.name
                : "Flash Sale · เปิดจองแล้ว"
              : production
              ? "เลือกวัน / รอบ"
              : "Box Office"}
          </p>
          <h1 className="title">
            {showAdmin
              ? "แผงจัดการงานแสดง"
              : eventId
              ? eventName
              : production
              ? production.name
              : "งานที่เปิดจอง"}
          </h1>
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
          <button
            onClick={() =>
              askConfirm({
                title: "ออกจากระบบ?",
                message: order
                  ? "คุณกำลังถือที่นั่งอยู่ — ออกจากระบบแล้วต้องเริ่มเลือกใหม่"
                  : "ต้องการออกจากระบบใช่ไหม",
                confirmLabel: "ออกจากระบบ",
                tone: "danger",
                onConfirm: logout,
              })
            }
            data-testid="logout-btn"
            className="btn btn--ghost"
          >
            ออกจากระบบ
          </button>
        </div>
      </header>

      {showAdmin ? (
        <AdminPanel authFetch={authFetch} askConfirm={askConfirm} onChanged={() => { loadEvents(); loadSeats(); }} />
      ) : eventId ? (
        <>
          <button
            className="btn btn--ghost back-btn"
            data-testid="back-to-events"
            onClick={() => setEventId(null)}
          >
            {production ? "← กลับไปเลือกวัน" : "← กลับไปเลือกงาน"}
          </button>

          <div className="stage anim-rise">STAGE</div>

          {tiers.length > 1 && (
            <div className="price-guide" data-testid="price-guide">
              {tiers.map((t) => (
                <span key={t.price} className={`tier${t.premium ? " tier--premium" : ""}`}>
                  <i />
                  {t.premium ? "พรีเมียม" : "ปกติ"} · แถว {rowRange(t.rows)} · ฿{t.price.toLocaleString()}
                </span>
              ))}
            </div>
          )}

          <div className="seatmap-wrap">
            {!seatsLoaded && seats.length === 0 ? (
              <div className="seatmap seatmap--skel" aria-busy="true" aria-label="กำลังโหลดผังที่นั่ง">
                {Array.from({ length: 8 }).map((_, r) => (
                  <div key={r} className="seat-row">
                    {Array.from({ length: 14 }).map((_, c) => (
                      <span key={c} className="seat-skel" />
                    ))}
                  </div>
                ))}
              </div>
            ) : seats.length === 0 ? (
              <p className="empty-note">ยังไม่มีผังที่นั่งสำหรับงานนี้</p>
            ) : (
              <div className={`seatmap${order ? " locked" : ""}`}>
                {Object.entries(rows).map(([row, list]) => (
                  <div key={row} className={`seat-row${rowPrice[row] === premiumPrice ? " seat-row--premium" : ""}`}>
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
            )}
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
                <button
                  onClick={() =>
                    askConfirm({
                      title: "ยืนยันการชำระเงิน",
                      message: `ชำระเงินสำหรับที่นั่งที่จองไว้ · ฿${total.toLocaleString()} (mock)`,
                      confirmLabel: "ชำระเงิน",
                      onConfirm: pay,
                    })
                  }
                  className="btn btn--primary"
                >
                  ชำระเงิน (mock)
                </button>
                <button
                  onClick={() =>
                    askConfirm({
                      title: "ยกเลิกการจอง?",
                      message: "ที่นั่งที่ถืออยู่จะถูกปล่อยคืนให้คนอื่นทันที",
                      confirmLabel: "ยกเลิกการจอง",
                      tone: "danger",
                      onConfirm: cancel,
                    })
                  }
                  className="btn btn--ghost"
                >
                  ยกเลิก
                </button>
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
      ) : production ? (
        <ShowPicker
          production={production}
          onPickShow={setEventId}
          onBack={() => setProduction(null)}
        />
      ) : (
        <ProductionListing groups={groups} loaded={eventsLoaded} onPick={onPickProduction} />
      )}

      {confirmState && (
        <ConfirmModal {...confirmState} onClose={() => setConfirmState(null)} />
      )}
    </main>
  );
}

// ConfirmModal — a themed confirmation dialog. Esc / backdrop cancels, Enter
// confirms. Used for money/destructive actions (pay, cancel, logout, close sale).
function ConfirmModal({ title, message, confirmLabel, cancelLabel = "ยกเลิก", tone = "primary", onConfirm, onClose }) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "Enter") { onConfirm(); onClose(); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onConfirm, onClose]);

  return (
    <div className="modal-backdrop" data-testid="confirm-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <h3 className="modal__title">{title}</h3>
        <p className="modal__msg">{message}</p>
        <div className="modal__actions">
          <button className="btn btn--ghost" data-testid="confirm-cancel" onClick={onClose}>
            {cancelLabel}
          </button>
          <button
            className={`btn ${tone === "danger" ? "btn--danger" : "btn--primary"}`}
            data-testid="confirm-ok"
            autoFocus
            onClick={() => { onConfirm(); onClose(); }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function fmtEventDate(iso) {
  try {
    return new Date(iso).toLocaleString("th-TH", {
      day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit",
    });
  } catch {
    return "";
  }
}

// groupEvents folds shows that share a series_id into one production; a standalone
// event (series_id null) becomes its own single-show "production".
function groupEvents(events) {
  const map = new Map();
  for (const e of events) {
    const key = e.series_id || e.id;
    if (!map.has(key)) {
      map.set(key, { key, name: e.series_id ? e.series_name || "งาน" : e.name, venue: e.venue || null, shows: [] });
    }
    map.get(key).shows.push(e);
  }
  return [...map.values()].map((g) => {
    const shows = g.shows.slice().sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));
    const available = shows.reduce((s, e) => s + (e.available || 0), 0);
    const prices = shows.map((e) => Number(e.price_from)).filter((p) => p > 0);
    return { ...g, shows, isMulti: shows.length > 1, available, priceFrom: prices.length ? Math.min(...prices) : 0 };
  });
}

// groupAdminEvents — same series grouping for the admin dashboard, aggregating
// sold/total/revenue across a production's rounds.
function groupAdminEvents(events) {
  const map = new Map();
  for (const e of events) {
    const key = e.series_id || `solo-${e.id}`;
    if (!map.has(key)) {
      map.set(key, { key, seriesId: e.series_id || null, name: e.series_id ? e.series_name || "งาน" : e.name, venue: e.venue || null, shows: [] });
    }
    map.get(key).shows.push(e);
  }
  return [...map.values()].map((g) => {
    const shows = g.shows.slice().sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));
    return {
      ...g, shows,
      sold: shows.reduce((s, e) => s + (e.sold || 0), 0),
      total: shows.reduce((s, e) => s + (e.total || 0), 0),
      revenue: shows.reduce((s, e) => s + Number(e.revenue || 0), 0),
    };
  });
}

function fmtDateShort(iso) {
  try {
    return new Date(iso).toLocaleDateString("th-TH", { day: "numeric", month: "short" });
  } catch {
    return "";
  }
}
function showRangeLabel(shows) {
  if (shows.length === 0) return "";
  const first = fmtDateShort(shows[0].starts_at);
  const last = fmtDateShort(shows[shows.length - 1].starts_at);
  return first === last ? first : `${first} – ${last}`;
}

// ProductionListing — the customer landing. One card per production; a multi-show
// production opens a date/round picker, a single show opens straight to the seat map.
function ProductionListing({ groups, loaded, onPick }) {
  if (!loaded) return <p className="empty-note">กำลังโหลดงาน…</p>;
  if (groups.length === 0) return <p className="empty-note">ยังไม่มีงานที่เปิดจองตอนนี้</p>;
  return (
    <div className="event-grid">
      {groups.map((g) => {
        const soldOut = g.available === 0;
        return (
          <button key={g.key} className="ev-card anim-rise" data-testid="event-card" data-event-id={g.key} onClick={() => onPick(g)}>
            <div className="ev-card__media">
              <span className={`ev-card__badge${soldOut ? " ev-card__badge--out" : ""}`}>{soldOut ? "เต็มแล้ว" : "เปิดจองแล้ว"}</span>
              {g.isMulti && <span className="ev-card__rounds">{g.shows.length} รอบ</span>}
            </div>
            <div className="ev-card__body">
              <h3 className="ev-card__name">{g.name}</h3>
              <div className="ev-card__date">{g.isMulti ? showRangeLabel(g.shows) : fmtEventDate(g.shows[0].starts_at)}</div>
              {g.venue && <div className="ev-card__venue">📍 {g.venue}</div>}
              <div className="ev-card__meta">
                <span>🎟 เหลือ {g.available.toLocaleString()} ที่</span>
                {g.priceFrom ? <span>เริ่ม ฿{g.priceFrom.toLocaleString()}</span> : null}
              </div>
              <div className="ev-card__cta">{g.isMulti ? "เลือกวัน / รอบ →" : "เลือกที่นั่ง →"}</div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

// ShowPicker — choose a show/date within a multi-show production, then book its seats.
function ShowPicker({ production, onPickShow, onBack }) {
  return (
    <div className="anim-rise">
      <button className="btn btn--ghost back-btn" data-testid="back-to-productions" onClick={onBack}>
        ← กลับไปเลือกงาน
      </button>
      {production.venue && <p className="showpicker__venue">📍 {production.venue}</p>}
      <h2 className="section-h" style={{ marginTop: 10 }}>เลือกวัน / รอบ ({production.shows.length} รอบ)</h2>
      <div className="show-list">
        {production.shows.map((s) => {
          const out = s.available === 0;
          return (
            <button
              key={s.id}
              className="show-row"
              data-testid="show-row"
              data-event-id={s.id}
              disabled={out}
              onClick={() => onPickShow(s.id)}
            >
              <div className="show-row__main">
                <div className="show-row__name">{s.name}</div>
                <div className="show-row__date">{fmtEventDate(s.starts_at)}</div>
              </div>
              <div className="show-row__meta">
                <span className={out ? "show-row__out" : ""}>
                  {out ? "เต็มแล้ว" : `เหลือ ${Number(s.available).toLocaleString()} ที่`}
                </span>
                {s.price_from ? <span className="show-row__price">เริ่ม ฿{Number(s.price_from).toLocaleString()}</span> : null}
              </div>
              {!out && <span className="show-row__cta">เลือกที่นั่ง →</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// AdminPanel — content management for events: live sales stats, create an event
// (a show/round) with its seat map, and open/close the sale or change the
// per-order seat cap. All calls go through authFetch (admin-gated on the server).
function AdminPanel({ authFetch, askConfirm, onChanged }) {
  const [events, setEvents] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [msg, setMsg] = useState("");
  const [creating, setCreating] = useState(false);
  const [presetSeries, setPresetSeries] = useState(""); // series_id to pre-join when adding a round

  const openCreate = (seriesId = "") => {
    setPresetSeries(seriesId);
    setCreating(true);
    if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const load = useCallback(() => {
    authFetch(`${API}/api/admin/events`)
      .then((r) => (r.ok ? r.json() : { events: [] }))
      .then((d) => { setEvents(d.events || []); setLoaded(true); })
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
  const grouped = useMemo(() => groupAdminEvents(events), [events]);

  return (
    <div className="anim-rise">
      <div className="stat-grid">
        <StatTile label="งานทั้งหมด" value={events.length} />
        <StatTile label="ที่นั่งขายแล้ว" value={totals.sold.toLocaleString()} />
        <StatTile label="รายได้รวม" value={`฿${totals.revenue.toLocaleString()}`} accent />
      </div>

      {creating ? (
        <CreateEventForm
          authFetch={authFetch}
          productions={grouped.filter((g) => g.seriesId)}
          presetSeriesId={presetSeries}
          onClose={() => setCreating(false)}
          onCreated={() => { load(); onChanged?.(); setMsg("บันทึกงาน/รอบใหม่แล้ว"); }}
          setMsg={setMsg}
        />
      ) : (
        <button onClick={() => openCreate("")} data-testid="new-event-btn" className="btn btn--primary" style={{ marginTop: 18 }}>
          + สร้างงานใหม่
        </button>
      )}

      {msg && <p className="msg">{msg}</p>}

      <div className="admin-list">
        {!loaded ? (
          <p className="empty-note">กำลังโหลดข้อมูลงาน…</p>
        ) : events.length === 0 ? (
          <p className="empty-note">ยังไม่มีงาน — กด “สร้างงานใหม่” เพื่อเริ่ม</p>
        ) : (
          grouped.map((g) =>
            g.seriesId ? (
              <div key={g.key} className="admin-group">
                <div className="admin-group__head">
                  <div>
                    <div className="admin-group__name">{g.name}</div>
                    {g.venue && <div className="admin-group__venue">📍 {g.venue}</div>}
                  </div>
                  <div className="admin-group__stats">
                    <span className="badge-rounds">{g.shows.length} รอบ</span>
                    <span>ขาย {g.sold.toLocaleString()}/{g.total.toLocaleString()}</span>
                    <span className="rev">฿{g.revenue.toLocaleString()}</span>
                    <button className="btn btn--ghost admin-group__add" onClick={() => openCreate(g.seriesId)}>
                      ➕ เพิ่มรอบ
                    </button>
                  </div>
                </div>
                <div className="admin-group__rounds">
                  {g.shows.map((e) => <EventRow key={e.id} e={e} onPatch={patch} askConfirm={askConfirm} />)}
                </div>
              </div>
            ) : (
              <EventRow key={g.shows[0].id} e={g.shows[0]} onPatch={patch} askConfirm={askConfirm} />
            )
          )
        )}
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

function EventRow({ e, onPatch, askConfirm }) {
  const [cap, setCap] = useState(e.max_seats_per_order);
  const pct = e.total > 0 ? Math.round((e.sold / e.total) * 100) : 0;
  const onSale = e.status === "ON_SALE";
  const toggleSale = () =>
    onSale
      ? askConfirm({
          title: "ปิดการขาย?",
          message: `“${e.name}” — ลูกค้าจะจองไม่ได้ทันที`,
          confirmLabel: "ปิดขาย",
          tone: "danger",
          onConfirm: () => onPatch(e.id, { status: "CLOSED" }),
        })
      : onPatch(e.id, { status: "ON_SALE" });

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
        <button onClick={toggleSale} className={`btn ${onSale ? "btn--ghost" : "btn--primary"}`}>
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

// CreateEventForm — create a show/round. Pick an existing production from the
// dropdown (sends series_id — no name matching), or "create new". After a
// successful create it clears just the name/date so the admin can add the next
// round to the same production immediately.
function CreateEventForm({ authFetch, productions, presetSeriesId, onClose, onCreated, setMsg }) {
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState({
    name: "", production: presetSeriesId || "", series_name: "", venue: "",
    date: "", time: "19:00", rows: 10, seats_per_row: 20,
    price: 1500, premium_rows: 3, premium_price: 2500, max_seats_per_order: 4,
  });
  const set = (k) => (ev) => setF((s) => ({ ...s, [k]: ev.target.value }));

  const submit = async (ev) => {
    ev.preventDefault();
    setMsg("");
    if (!f.name || !f.date) { setMsg("กรอกชื่อรอบและวันแสดงก่อน"); return; }
    if (f.production === "__new__" && !f.series_name.trim()) { setMsg("ใส่ชื่อ production ใหม่ก่อน"); return; }
    setBusy(true);
    try {
      const body = {
        name: f.name,
        starts_at: new Date(`${f.date}T${f.time}`).toISOString(),
        rows: Number(f.rows), seats_per_row: Number(f.seats_per_row),
        price: Number(f.price), premium_rows: Number(f.premium_rows),
        premium_price: Number(f.premium_price), max_seats_per_order: Number(f.max_seats_per_order),
      };
      if (f.production === "__new__") { body.series_name = f.series_name; body.venue = f.venue; }
      else if (f.production) { body.series_id = f.production; }

      const res = await authFetch(`${API}/api/admin/events`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      if (res.status === 201) {
        // If we just created a new production, switch the dropdown to a joinable
        // state won't have its id yet — reset to standalone; otherwise keep the
        // production selected so the next round joins it in one click.
        setF((s) => ({ ...s, name: "", date: "", production: s.production === "__new__" ? "" : s.production, series_name: "", venue: "" }));
        onCreated?.();
      } else { const d = await res.json().catch(() => ({})); setMsg(`สร้างไม่สำเร็จ: ${d.error || res.status}`); }
    } finally { setBusy(false); }
  };

  const field = (label, key) => (
    <label className="field">
      {label}
      <input type="number" value={f[key]} onChange={set(key)} className="input" />
    </label>
  );

  return (
    <form onSubmit={submit} className="create-form">
      <h3>สร้างงาน / รอบใหม่</h3>
      <label className="field">
        Production / งานหลัก <span className="field__hint">— เลือกงานเดิมเพื่อเพิ่มรอบ หรือสร้างใหม่</span>
        <select value={f.production} onChange={set("production")} data-testid="ev-production" className="select">
          <option value="">— งานเดี่ยว (ไม่จัดกลุ่ม) —</option>
          {productions.map((p) => (
            <option key={p.seriesId} value={p.seriesId}>{p.name}</option>
          ))}
          <option value="__new__">➕ สร้าง production ใหม่…</option>
        </select>
      </label>
      {f.production === "__new__" && (
        <>
          <label className="field">
            ชื่อ production ใหม่
            <input value={f.series_name} onChange={set("series_name")} data-testid="ev-series" placeholder="เช่น Bangkok EDM Festival 2026" className="input" />
          </label>
          <label className="field">
            สถานที่
            <input value={f.venue} onChange={set("venue")} data-testid="ev-venue" placeholder="เช่น Impact Arena เมืองทองธานี" className="input" />
          </label>
        </>
      )}
      <label className="field">
        ชื่อรอบ / งาน
        <input value={f.name} onChange={set("name")} data-testid="ev-name" placeholder="เช่น รอบ Night 2" className="input" />
      </label>
      <div className="field-grid">
        <label className="field">
          วันแสดง
          <input type="date" value={f.date} onChange={set("date")} data-testid="ev-date" className="input" />
        </label>
        <label className="field">
          เวลา (24 ชม.)
          <select value={f.time} onChange={set("time")} data-testid="ev-time" className="select">
            {TIME_OPTIONS.map((t) => (
              <option key={t} value={t}>{t} น.</option>
            ))}
          </select>
        </label>
      </div>
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
          {busy ? "กำลังสร้าง…" : "สร้างรอบนี้"}
        </button>
        <button type="button" onClick={onClose} className="btn btn--ghost">ปิด</button>
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
