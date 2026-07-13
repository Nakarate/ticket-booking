import { fmtEventDate } from "../../lib/format";

// ShowPicker — choose a show/date within a multi-show production, then book its seats.
export function ShowPicker({ production, onPickShow, onBack }) {
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
