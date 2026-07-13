// Date/label formatting helpers shared across the UI (Thai locale).

// Full event datetime, e.g. "5 กรกฎาคม 2026 20:00".
export function fmtEventDate(iso) {
  try {
    return new Date(iso).toLocaleString("th-TH", {
      day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit",
    });
  } catch {
    return "";
  }
}

// Short day+month, e.g. "5 ก.ค." — used internally by showRangeLabel.
function fmtDateShort(iso) {
  try {
    return new Date(iso).toLocaleDateString("th-TH", { day: "numeric", month: "short" });
  } catch {
    return "";
  }
}

// Collapse a production's shows into a date range label ("5 – 7 ก.ค." or a
// single date when they fall on the same day).
export function showRangeLabel(shows) {
  if (shows.length === 0) return "";
  const first = fmtDateShort(shows[0].starts_at);
  const last = fmtDateShort(shows[shows.length - 1].starts_at);
  return first === last ? first : `${first} – ${last}`;
}
