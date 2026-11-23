// Turns a Google Maps `Route` into a planner profile: resampled path, elevation
// (Google Elevation), smoothed grade, OSM speed limits, and traffic caps.

import { savgol2, gradeFrom } from "./planner.js";
import { fetchWays, matchLimits, limitsFromStaticSpeed } from "./limits.js";
import { flattenStructures } from "./terrain.js";

export const DS_M = 25;
const SMOOTH_WINDOW_M = 250;
const ELEV_SAMPLE_M = 50;
const ELEV_CHUNK_M = 24_000; // 480 samples per request, under the 512 cap
const MIN_CAP_MPS = 3;

const latOf = (p) => (typeof p.lat === "function" ? p.lat() : p.lat);
const lngOf = (p) => (typeof p.lng === "function" ? p.lng() : p.lng);

function haversine(a1, o1, a2, o2) {
  const R = 6_371_000, r = Math.PI / 180;
  const dLat = (a2 - a1) * r, dLon = (o2 - o1) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a1 * r) * Math.cos(a2 * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Path -> uniform samples every ~DS_M meters, plus cumulative distance of each original vertex. */
export function resamplePath(path) {
  const lat = path.map(latOf), lon = path.map(lngOf);
  const cum = new Float64Array(lat.length);
  for (let i = 1; i < lat.length; i++) cum[i] = cum[i - 1] + haversine(lat[i - 1], lon[i - 1], lat[i], lon[i]);
  const total = cum[cum.length - 1];
  const n = Math.max(2, Math.ceil(total / DS_M));
  const s = new Float64Array(n + 1), sl = new Float64Array(n + 1), so = new Float64Array(n + 1);
  let k = 0;
  for (let i = 0; i <= n; i++) {
    const si = (total * i) / n;
    while (k < cum.length - 2 && cum[k + 1] < si) k++;
    const t = cum[k + 1] > cum[k] ? (si - cum[k]) / (cum[k + 1] - cum[k]) : 0;
    s[i] = si;
    sl[i] = lat[k] + t * (lat[k + 1] - lat[k]);
    so[i] = lon[k] + t * (lon[k + 1] - lon[k]);
  }
  return { s, lat: sl, lon: so, vertexS: cum, total };
}

/** Elevation every ~50 m via ElevationService, chunked under the per-request limits. */
export async function elevationAlong(elevationService, rs) {
  const { s, lat, lon, total } = rs;
  const sampleS = [], sampleE = [];
  for (let start = 0; start < total - 1; start += ELEV_CHUNK_M) {
    const end = Math.min(total, start + ELEV_CHUNK_M);
    const last = s.length - 1;
    // clamp: float rounding in end/step can land one index past the array
    const i0 = Math.min(last, Math.floor(start / (total / last)));
    const i1 = Math.min(last, Math.ceil(end / (total / last)));
    const idx = [];
    const step = Math.max(1, Math.ceil((i1 - i0 + 1) / 300)); // keep the request path short
    for (let i = i0; i <= i1; i += step) idx.push(i);
    if (idx[idx.length - 1] !== i1) idx.push(i1);
    const path = idx.map((i) => ({ lat: lat[i], lng: lon[i] }));
    const samples = Math.min(512, Math.max(2, Math.ceil((s[i1] - s[i0]) / ELEV_SAMPLE_M) + 1));
    const { results } = await elevationService.getElevationAlongPath({ path, samples });
    results.forEach((r, j) => {
      sampleS.push(s[i0] + ((s[i1] - s[i0]) * j) / (samples - 1));
      sampleE.push(r.elevation);
    });
  }
  // interpolate onto the uniform grid
  const elev = new Float64Array(s.length);
  let k = 0;
  for (let i = 0; i < s.length; i++) {
    while (k < sampleS.length - 2 && sampleS[k + 1] < s[i]) k++;
    const a = sampleS[k], b = sampleS[k + 1] ?? a;
    const t = b > a ? Math.max(0, Math.min(1, (s[i] - a) / (b - a))) : 0;
    elev[i] = sampleE[k] + t * ((sampleE[k + 1] ?? sampleE[k]) - sampleE[k]);
  }
  return elev;
}

/**
 * Traffic caps from speedReadingIntervals, calibrated to Google's total delay.
 * SLOW stretches run at k x limit, TRAFFIC_JAM at k/2 x limit; k is solved so
 * the extra time over those stretches equals (traffic duration - static duration).
 */
export function trafficCaps(rs, limitMps, intervals, delayS) {
  const n = rs.s.length;
  const cat = new Uint8Array(n); // 0 normal, 1 slow, 2 jam
  if (!intervals?.length || !(delayS > 0)) return { capMps: Float64Array.from(limitMps), cat, k: 1 };
  for (const iv of intervals) {
    const c = iv.speed === "TRAFFIC_JAM" ? 2 : iv.speed === "SLOW" ? 1 : 0;
    if (!c) continue;
    const a = rs.vertexS[iv.startPolylinePointIndex ?? 0];
    const b = rs.vertexS[Math.min(iv.endPolylinePointIndex ?? rs.vertexS.length - 1, rs.vertexS.length - 1)];
    for (let i = 0; i < n; i++) if (rs.s[i] >= a && rs.s[i] <= b) cat[i] = Math.max(cat[i], c);
  }
  let tSlow = 0, tJam = 0;
  for (let i = 0; i < n - 1; i++) {
    const dt = (rs.s[i + 1] - rs.s[i]) / Math.max(limitMps[i], 1);
    if (cat[i] === 1) tSlow += dt; else if (cat[i] === 2) tJam += dt;
  }
  if (tSlow + tJam === 0) return { capMps: Float64Array.from(limitMps), cat, k: 1 };
  const k = Math.max(0.15, Math.min(1, (tSlow + 2 * tJam) / (delayS + tSlow + tJam)));
  const capMps = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const f = cat[i] === 2 ? k / 2 : cat[i] === 1 ? k : 1;
    capMps[i] = f === 1 ? limitMps[i] : Math.min(limitMps[i], Math.max(MIN_CAP_MPS, f * limitMps[i]));
  }
  return { capMps, cat, k };
}

/** Fetch OSM ways once for all alternatives; null if Overpass is unavailable. */
export async function waysForRoutes(resampled) {
  try {
    return await fetchWays(resampled.map((r) => ({ lat: r.lat, lon: r.lon })));
  } catch {
    return null;
  }
}

/**
 * Build the full profile for one Google route.
 * ways: OSM ways, null (use estimates), or a promise of either, so the speed-limit
 * lookup can run while elevation is being fetched.
 */
export async function buildProfile(route, rs, waysOrPromise, elevationService) {
  const [elevRaw, ways] = await Promise.all([elevationAlong(elevationService, rs), waysOrPromise]);

  let lim;
  if (ways) {
    lim = matchLimits(rs.lat, rs.lon, ways);
  } else {
    // fallback: Google per-step static speeds
    const stepEnds = [];
    let acc = 0;
    for (const leg of route.legs ?? []) for (const st of leg.steps ?? []) {
      acc += st.distanceMeters ?? 0;
      const sec = (st.staticDurationMillis ?? 0) / 1000;
      stepEnds.push({ endS: acc, staticSpeedMps: sec > 0 ? st.distanceMeters / sec : 15 });
    }
    lim = limitsFromStaticSpeed(rs.s, stepEnds.length ? stepEnds : [{ endS: Infinity, staticSpeedMps: 15 }]);
  }

  // Bridges/tunnels (known only from OSM) are straightened before smoothing.
  const structures = lim.structure ? flattenStructures(elevRaw, lim.structure) : { elev: elevRaw, spans: [] };
  const elev = savgol2(structures.elev, Math.round(SMOOTH_WINDOW_M / DS_M) | 1);
  const ds = rs.s[1] - rs.s[0];
  const grade = gradeFrom(elev, ds);

  const delayS = ((route.durationMillis ?? 0) - (route.staticDurationMillis ?? 0)) / 1000;
  const traffic = trafficCaps(rs, lim.limitMps, route.travelAdvisory?.speedReadingIntervals, delayS);

  return {
    s: rs.s, lat: rs.lat, lon: rs.lon,
    elev, elevRaw, grade,
    structureSpans: structures.spans, // [{a, b, kind, deltaM}] sample indices
    postedLimit: lim.limitMps, // shown on the sign
    limit: traffic.capMps, // what the planner may not exceed
    limitTaggedFrac: lim.tagged.reduce((a, b) => a + b, 0) / lim.tagged.length,
    limitSource: lim.source,
    trafficCat: traffic.cat, trafficK: traffic.k,
    google: { distanceM: route.distanceMeters, durationS: (route.durationMillis ?? 0) / 1000, staticS: (route.staticDurationMillis ?? 0) / 1000 },
  };
}
