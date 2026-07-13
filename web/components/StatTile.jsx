// Small labelled metric tile used in the admin dashboard stat row.
export function StatTile({ label, value, accent }) {
  return (
    <div className="stat">
      <div className="stat__label">{label}</div>
      <div className={`stat__value${accent ? " accent" : ""}`}>{value}</div>
    </div>
  );
}
