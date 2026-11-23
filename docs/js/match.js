// Pure route-following logic (no DOM). Tested in tests/match.test.mjs.

const M_PER_DEG_LAT = 110_540;
const M_PER_DEG_LON_EQ = 111_320;
export const OFF_ROUTE_M = 75;
const WINDOW_BACK = 8; // segments (~200 m) behind the last match
const WINDOW_AHEAD = 120; // segments (~3 km) ahead

/** Precompute a local metric frame for the route. */
export function buildIndex(route) {
  const n = route.lat.length;
  const lat0 = route.lat.reduce((a, b) => a + b, 0) / n;
  const lon0 = route.lon.reduce((a, b) => a + b, 0) / n;
  const kx = Math.cos((lat0 * Math.PI) / 180) * M_PER_DEG_LON_EQ;
  const x = new Float64Array(n), y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    x[i] = (route.lon[i] - lon0) * kx;
    y[i] = (route.lat[i] - lat0) * M_PER_DEG_LAT;
  }
  return { n, x, y, s: route.s_m, lat0, lon0, kx, total: route.s_m[n - 1] };
}

export function toLocal(idx, lat, lon) {
  return [(lon - idx.lon0) * idx.kx, (lat - idx.lat0) * M_PER_DEG_LAT];
}

/**
 * Project a GPS fix onto the route.
 * hint: segment index of the previous match, or null for a global search.
 * Returns {seg, s, dist}: segment index, distance along route [m], off-route distance [m].
 */
export function match(idx, lat, lon, hint = null) {
  const [px, py] = toLocal(idx, lat, lon);
  const lo = hint == null ? 0 : Math.max(0, hint - WINDOW_BACK);
  const hi = hint == null ? idx.n - 2 : Math.min(idx.n - 2, hint + WINDOW_AHEAD);
  let best = { seg: lo, s: idx.s[lo], dist: Infinity };
  for (let i = lo; i <= hi; i++) {
    const ax = idx.x[i], ay = idx.y[i];
    const dx = idx.x[i + 1] - ax, dy = idx.y[i + 1] - ay;
    const len2 = dx * dx + dy * dy || 1e-9;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
    const qx = ax + t * dx, qy = ay + t * dy;
    const d = Math.hypot(px - qx, py - qy);
    if (d < best.dist) best = { seg: i, s: idx.s[i] + t * (idx.s[i + 1] - idx.s[i]), dist: d };
  }
  return best;
}

/** Position (lat, lon) at distance s along the route — used by the simulator. */
export function pointAt(route, s) {
  const S = route.s_m;
  if (s <= S[0]) return [route.lat[0], route.lon[0]];
  if (s >= S[S.length - 1]) return [route.lat[S.length - 1], route.lon[S.length - 1]];
  let lo = 0, hi = S.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (S[mid] <= s) lo = mid; else hi = mid; }
  const t = (s - S[lo]) / (S[hi] - S[lo]);
  return [route.lat[lo] + t * (route.lat[hi] - route.lat[lo]), route.lon[lo] + t * (route.lon[hi] - route.lon[lo])];
}

/** Linear interpolation of a per-route-point array at distance s. */
export function valueAt(route, arr, s) {
  const S = route.s_m;
  if (s <= S[0]) return arr[0];
  if (s >= S[S.length - 1]) return arr[arr.length - 1];
  let lo = 0, hi = S.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (S[mid] <= s) lo = mid; else hi = mid; }
  const t = (s - S[lo]) / (S[hi] - S[lo]);
  return arr[lo] + t * (arr[hi] - arr[lo]);
}

/** The instruction stretch containing s (stretches are sorted and contiguous). */
export function stretchIndexAt(stretches, s) {
  for (let i = stretches.length - 1; i >= 0; i--) if (s >= stretches[i].start_m) return i;
  return 0;
}

/** Current instruction, next change and distance to it, looking ahead `leadM` for GPS lag. */
export function guidance(plan, s, leadM = 30) {
  const st = plan.stretches;
  const i = stretchIndexAt(st, s + leadM);
  const next = st[i + 1] || null;
  return {
    current: st[i],
    next,
    toNext: next ? Math.max(0, next.start_m - s) : null,
  };
}
