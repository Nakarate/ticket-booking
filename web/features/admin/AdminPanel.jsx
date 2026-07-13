import { useState, useEffect, useMemo, useCallback } from "react";
import { API } from "../../lib/api";
import { StatTile } from "../../components/StatTile";
import { groupAdminEvents } from "../catalog/grouping";

// 24-hour time slots (every 30 min) for the create form's time dropdown.
const TIME_OPTIONS = Array.from({ length: 48 }, (_, i) => {
  const h = String(Math.floor(i / 2)).padStart(2, "0");
  return `${h}:${i % 2 === 0 ? "00" : "30"}`;
});

// AdminPanel — content management for events: live sales stats, create an event
// (a show/round) with its seat map, and open/close the sale or change the
// per-order seat cap. All calls go through authFetch (admin-gated on the server).
export function AdminPanel({ authFetch, askConfirm, onChanged }) {
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
          key={presetSeries || "new"} /* remount so a new preset re-inits the dropdown */
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
