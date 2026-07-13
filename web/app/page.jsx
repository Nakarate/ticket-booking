"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { API, loadAuth, persistAuth, logoutRequest, createAuthFetch } from "../lib/api";
import { ConfirmModal } from "../components/ConfirmModal";
import { groupEvents } from "../features/catalog/grouping";
import { ProductionListing } from "../features/catalog/ProductionListing";
import { ShowPicker } from "../features/catalog/ShowPicker";
import { AuthForm } from "../features/auth/AuthForm";
import { AdminPanel } from "../features/admin/AdminPanel";

const DEFAULT_MAX_SEATS = 4;

const LEGEND = [
  ["ว่าง", "AVAILABLE"],
  ["เลือกอยู่", "SELECTED"],
  ["มีคนถืออยู่", "HELD"],
  ["ขายแล้ว", "SOLD"],
];


export default function Page() {
  // { access, refresh, userId, email, is_admin }
  const [auth, setAuthState] = useState(null);
  const [ready, setReady] = useState(false); // localStorage read complete
  const authRef = useRef(null);

  const setAuth = useCallback((a) => {
    authRef.current = a;
    setAuthState(a);
    persistAuth(a);
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

  // authFetch attaches the access token and rotates on a 401 (see lib/api.js).
  const authFetch = useMemo(
    () => createAuthFetch({ getAuth: () => authRef.current, setAuth }),
    [setAuth]
  );

  const logout = useCallback(() => {
    logoutRequest(authRef.current?.refresh);
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
                    <div className="order__body">
                      {o.event_name && (
                        <div className="order__event">
                          {o.series_name ? `${o.series_name} · ${o.event_name}` : o.event_name}
                        </div>
                      )}
                      <div className="order__seats">{o.seat_nos || "—"}</div>
                    </div>
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


