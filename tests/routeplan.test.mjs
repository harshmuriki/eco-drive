import { test } from "node:test";
import assert from "node:assert/strict";
import { resamplePath, trafficCaps } from "../docs/js/routeplan.js";
import { matchLimits, limitsFromStaticSpeed, parseMaxspeed } from "../docs/js/limits.js";
import { MPH } from "../docs/js/physics.js";

// A 3 km straight road heading east from Atlanta-ish coordinates.
const path = Array.from({ length: 31 }, (_, i) => ({ lat: 33.77, lng: -84.39 + i * 0.001077 }));

test("resamplePath gives ~25 m uniform spacing and matching total", () => {
  const rs = resamplePath(path);
  const ds = rs.s[1] - rs.s[0];
  assert.ok(Math.abs(ds - 25) < 1, `ds ${ds}`);
  assert.ok(Math.abs(rs.total - 3000) < 30, `total ${rs.total}`);
});

test("parseMaxspeed handles mph, km/h and junk", () => {
  assert.ok(Math.abs(parseMaxspeed("45 mph") - 45 * MPH) < 1e-9);
  assert.ok(Math.abs(parseMaxspeed("70") - 70 / 3.6) < 1e-9);
  assert.equal(parseMaxspeed("US:urban"), null);
});

test("matchLimits prefers the road going our way over a crossing road", () => {
  const rs = resamplePath(path);
  const along = { tags: { highway: "primary", maxspeed: "45 mph" }, geometry: path.map((p) => ({ lat: p.lat + 0.00005, lon: p.lng })) };
  // a perpendicular residential street crossing at the midpoint, closer to the route there
  const midLon = path[15].lng;
  const cross = { tags: { highway: "residential", maxspeed: "25 mph" }, geometry: [{ lat: 33.765, lon: midLon }, { lat: 33.775, lon: midLon }] };
  const m = matchLimits(rs.lat, rs.lon, [along, cross]);
  const mph = Array.from(m.limitMps, (v) => Math.round(v / MPH));
  assert.ok(mph.every((v) => v === 45), `got ${[...new Set(mph)]}`);
  assert.ok(m.matchedFrac > 0.95);
});

test("traffic calibration reproduces Google's delay", () => {
  const rs = resamplePath(path);
  const limit = new Float64Array(rs.s.length).fill(20); // m/s
  // second half of the path is SLOW
  const intervals = [{ startPolylinePointIndex: 15, endPolylinePointIndex: 30, speed: "SLOW" }];
  const delay = 60; // s
  const { capMps, k } = trafficCaps(rs, limit, intervals, delay);
  let tFree = 0, tCap = 0;
  for (let i = 0; i < rs.s.length - 1; i++) {
    const d = rs.s[i + 1] - rs.s[i];
    tFree += d / limit[i]; tCap += d / capMps[i];
  }
  assert.ok(k < 1);
  assert.ok(Math.abs(tCap - tFree - delay) < 3, `extra ${tCap - tFree} s vs ${delay}`);
  assert.equal(capMps[0], 20);
});

test("no traffic data leaves limits untouched", () => {
  const rs = resamplePath(path);
  const limit = new Float64Array(rs.s.length).fill(20);
  assert.deepEqual(Array.from(trafficCaps(rs, limit, [], 0).capMps), Array.from(limit));
});

test("fallback limits are conservative: rounded down, capped at 65", () => {
  const s = Float64Array.from([0, 100, 200, 300]);
  const r = limitsFromStaticSpeed(s, [
    { endS: 150, staticSpeedMps: 13 }, // 29.1 mph -> 25
    { endS: 250, staticSpeedMps: 40 }, // 89 mph -> capped 65
    { endS: 400, staticSpeedMps: 26 }, // 58.2 mph -> 55, never rounded up to 60
  ]);
  const mph = Array.from(r.limitMps, (v) => Math.round(v / MPH));
  assert.deepEqual(mph, [25, 25, 65, 55]);
});
