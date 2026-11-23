// Speed limits for an arbitrary path (e.g. a Google route) from OpenStreetMap.
//
// Google's path carries no OSM ids, so we match by geometry: fetch every highway
// within ~25 m of the path from Overpass, then for each sample pick the nearest
// way segment whose direction agrees with the route (rejects cross streets and
// frontage roads), and finally mode-filter to remove one-sample flicker.

import { MPH } from "./physics.js";

const OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];
const MATCH_RADIUS_M = 22;
const MAX_BEARING_DIFF = (35 * Math.PI) / 180;
const CELL_M = 60;

export const DEFAULT_LIMIT_MPH = {
  motorway: 65, motorway_link: 45, trunk: 55, trunk_link: 40,
  primary: 45, primary_link: 35, secondary: 40, secondary_link: 30,
  tertiary: 35, tertiary_link: 30, unclassified: 30, residential: 25,
  living_street: 15, service: 15,
};
export const FALLBACK_MPH = 35;
const ROAD_CLASSES = Object.keys(DEFAULT_LIMIT_MPH).join("|");

export function parseMaxspeed(tag) {
  if (!tag) return null;
  const m = /^(\d+(?:\.\d+)?)\s*(mph|km\/h|kmh)?$/i.exec(tag.split(";")[0].trim());
  if (!m) return null;
  const v = Number(m[1]);
  return m[2]?.toLowerCase() === "mph" ? v * MPH : v / 3.6;
}

/** Local equirectangular frame (meters) around a reference latitude. */
function frame(lat0, lon0) {
  const kx = Math.cos((lat0 * Math.PI) / 180) * 111_320, ky = 110_540;
  return (lat, lon) => [(lon - lon0) * kx, (lat - lat0) * ky];
}

function thinned(lat, lon, everyM) {
  const pts = [];
  let acc = Infinity, px = null, py = null;
  const toXY = frame(lat[0], lon[0]);
  for (let i = 0; i < lat.length; i++) {
    const [x, y] = toXY(lat[i], lon[i]);
    if (px !== null) acc += Math.hypot(x - px, y - py);
    if (acc >= everyM || i === lat.length - 1) { pts.push(`${lat[i].toFixed(5)},${lon[i].toFixed(5)}`); acc = 0; }
    px = x; py = y;
  }
  return pts.join(",");
}

/**
 * One Overpass query for several paths (e.g. all route alternatives): a union of
 * `around` linestrings, so the public server is hit once per search, not per route.
 * paths: [{lat, lon}, ...]
 */
export function overpassQuery(paths, radius = 25, everyM = 120) {
  const parts = paths.map((p) => `way(around:${radius},${thinned(p.lat, p.lon, everyM)})[highway~"^(${ROAD_CLASSES})$"];`);
  return `[out:json][timeout:90];(${parts.join("")});out tags geom;`;
}

/**
 * Fetch highways near all given paths. Public Overpass servers can hang for minutes
 * when overloaded, so every attempt has a timeout and the whole call a deadline.
 * Throws if no server answers in time (caller falls back to estimated limits).
 */
export async function fetchWays(paths, { attemptMs = 12_000, deadlineMs = 25_000 } = {}) {
  const body = new URLSearchParams({ data: overpassQuery(paths) });
  const t0 = Date.now();
  let last;
  for (const url of [...OVERPASS, OVERPASS[0]]) {
    const left = deadlineMs - (Date.now() - t0);
    if (left < 2_000) break;
    try {
      const r = await fetch(url, { method: "POST", body, signal: AbortSignal.timeout(Math.min(attemptMs, left)) });
      if (r.ok) return (await r.json()).elements ?? [];
      last = new Error(`Overpass HTTP ${r.status}`);
    } catch (e) {
      last = e.name === "TimeoutError" ? new Error(`Overpass timed out (${url})`) : e;
    }
  }
  throw last ?? new Error("Overpass unavailable");
}

/**
 * Match limits onto path samples.
 * lat/lon: sample coordinates (e.g. every 25 m along the route).
 * Returns {limitMps: Float64Array, tagged: Uint8Array, highway: string[]}.
 */
export function matchLimits(lat, lon, ways) {
  const n = lat.length;
  const toXY = frame(lat[0], lon[0]);
  // spatial grid of way segments
  const grid = new Map();
  const segs = [];
  for (const w of ways) {
    const g = w.geometry;
    if (!g || g.length < 2) continue;
    const tags = w.tags ?? {};
    const cls = tags.highway ?? "";
    const tagged = parseMaxspeed(tags.maxspeed);
    const limit = tagged ?? (DEFAULT_LIMIT_MPH[cls] ?? FALLBACK_MPH) * MPH;
    const oneway = tags.oneway === "yes" || cls === "motorway" || cls === "motorway_link";
    for (let k = 0; k < g.length - 1; k++) {
      const [ax, ay] = toXY(g[k].lat, g[k].lon), [bx, by] = toXY(g[k + 1].lat, g[k + 1].lon);
      const id = segs.length;
      segs.push({ ax, ay, bx, by, limit, tagged: tagged != null, cls, oneway });
      const x0 = Math.floor(Math.min(ax, bx) / CELL_M), x1 = Math.floor(Math.max(ax, bx) / CELL_M);
      const y0 = Math.floor(Math.min(ay, by) / CELL_M), y1 = Math.floor(Math.max(ay, by) / CELL_M);
      for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) {
        const key = cx + ":" + cy;
        (grid.get(key) ?? grid.set(key, []).get(key)).push(id);
      }
    }
  }

  const xs = new Float64Array(n), ys = new Float64Array(n);
  for (let i = 0; i < n; i++) [xs[i], ys[i]] = toXY(lat[i], lon[i]);

  const raw = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    const j0 = Math.max(0, i - 1), j1 = Math.min(n - 1, i + 1);
    const hx = xs[j1] - xs[j0], hy = ys[j1] - ys[j0];
    const hLen = Math.hypot(hx, hy) || 1;
    const cx = Math.floor(xs[i] / CELL_M), cy = Math.floor(ys[i] / CELL_M);
    let best = null, bestD = MATCH_RADIUS_M;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const id of grid.get(cx + dx + ":" + (cy + dy)) ?? []) {
        const s = segs[id];
        const ux = s.bx - s.ax, uy = s.by - s.ay, uLen = Math.hypot(ux, uy) || 1;
        // direction agreement (either way unless one-way)
        const cos = (ux * hx + uy * hy) / (uLen * hLen);
        const ang = Math.acos(Math.max(-1, Math.min(1, s.oneway ? cos : Math.abs(cos))));
        if (ang > MAX_BEARING_DIFF) continue;
        const t = Math.max(0, Math.min(1, ((xs[i] - s.ax) * ux + (ys[i] - s.ay) * uy) / (uLen * uLen)));
        const d = Math.hypot(xs[i] - (s.ax + t * ux), ys[i] - (s.ay + t * uy));
        if (d < bestD) { bestD = d; best = s; }
      }
    }
    raw[i] = best;
  }

  // Fill gaps from neighbors, then a ±3-sample mode filter on the limit value.
  const limitMps = new Float64Array(n), tagged = new Uint8Array(n), highway = new Array(n);
  let lastGood = null;
  const firstGood = raw.find((x) => x);
  for (let i = 0; i < n; i++) {
    const s = raw[i] ?? lastGood ?? firstGood;
    if (raw[i]) lastGood = raw[i];
    limitMps[i] = s ? s.limit : FALLBACK_MPH * MPH;
    tagged[i] = s?.tagged ? 1 : 0;
    highway[i] = s?.cls ?? "";
  }
  const out = Float64Array.from(limitMps);
  for (let i = 0; i < n; i++) {
    const counts = new Map();
    for (let j = Math.max(0, i - 3); j <= Math.min(n - 1, i + 3); j++) counts.set(limitMps[j], (counts.get(limitMps[j]) ?? 0) + 1);
    let mode = limitMps[i], c = 0;
    for (const [v, k] of counts) if (k > c || (k === c && v === limitMps[i])) { mode = v; c = k; }
    out[i] = mode;
  }
  return { limitMps: out, tagged, highway, matchedFrac: raw.filter(Boolean).length / n, source: "osm" };
}

/**
 * Fallback when Overpass is down: estimate limits from Google's no-traffic step speeds.
 * Deliberately conservative, because a plan must never suggest more than the real limit:
 * round DOWN to 5 mph and cap at 65 (free-flow speeds often run above the posted limit).
 * stepEnds: [{endS [m], staticSpeedMps}] in route order. s: sample distances.
 */
export function limitsFromStaticSpeed(s, stepEnds) {
  const n = s.length, limitMps = new Float64Array(n);
  let k = 0;
  for (let i = 0; i < n; i++) {
    while (k < stepEnds.length - 1 && s[i] > stepEnds[k].endS) k++;
    const mph = Math.floor(stepEnds[k].staticSpeedMps / MPH / 5) * 5;
    limitMps[i] = Math.max(25, Math.min(65, mph)) * MPH;
  }
  return { limitMps, tagged: new Uint8Array(n), highway: new Array(n).fill(""), matchedFrac: 0, source: "estimated" };
}
