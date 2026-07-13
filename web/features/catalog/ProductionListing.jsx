import { fmtEventDate, showRangeLabel } from "../../lib/format";

// ProductionListing — the customer landing. One card per production; a multi-show
// production opens a date/round picker, a single show opens straight to the seat map.
export function ProductionListing({ groups, loaded, onPick }) {
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
