// Production grouping: shows that share a series_id fold into one production.
// The customer and admin views group the same way, aggregating different fields.

// groupEvents folds shows that share a series_id into one production; a standalone
// event (series_id null) becomes its own single-show "production". Customer view.
export function groupEvents(events) {
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
export function groupAdminEvents(events) {
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
