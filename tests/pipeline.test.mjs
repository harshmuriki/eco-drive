// End-to-end: a Google-shaped route -> profile -> plans, with Google and Overpass mocked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resamplePath, buildProfile } from "../docs/js/routeplan.js";
import { tradeoff, instructions } from "../docs/js/planner.js";
import { MPH } from "../docs/js/physics.js";

const demo = JSON.parse(readFileSync(new URL("./fixtures/demo_plan.json", import.meta.url)));
const n = demo.route.lat.length;
// Google returns a coarser path than our 25 m resample; thin it like a real polyline.
const path = [];
for (let i = 0; i < n; i += 4) path.push({ lat: demo.route.lat[i], lng: demo.route.lon[i] });
path.push({ lat: demo.route.lat[n - 1], lng: demo.route.lon[n - 1] });

const totalM = demo.route.s_m[n - 1];
const fakeRoute = {
  path,
  distanceMeters: totalM,
  durationMillis: 33 * 60_000,
  staticDurationMillis: 28 * 60_000,
  legs: [{ steps: [
    { distanceMeters: totalM * 0.3, staticDurationMillis: 9 * 60_000 },
    { distanceMeters: totalM * 0.7, staticDurationMillis: 19 * 60_000 },
  ] }],
  travelAdvisory: { speedReadingIntervals: [
    { startPolylinePointIndex: 0, endPolylinePointIndex: 60, speed: "NORMAL" },
    { startPolylinePointIndex: 60, endPolylinePointIndex: 120, speed: "SLOW" },
    { startPolylinePointIndex: 120, endPolylinePointIndex: 140, speed: "TRAFFIC_JAM" },
    { startPolylinePointIndex: 140, endPolylinePointIndex: path.length - 1, speed: "NORMAL" },
  ] },
};

// Elevation mock: rolling hills, honoring the 512-sample cap.
let elevCalls = 0;
const elevationService = {
  async getElevationAlongPath({ path: p, samples }) {
    elevCalls++;
    assert.ok(samples <= 512 && p.length <= 512, `request too large: ${samples} samples, ${p.length} points`);
    return { results: Array.from({ length: samples }, (_, j) => ({ elevation: 280 + 25 * Math.sin((j / samples) * 6 + elevCalls) })) };
  },
};

test("elevation requests never index past the path, for many route lengths", async () => {
  const { elevationAlong } = await import("../docs/js/routeplan.js");
  const strict = {
    async getElevationAlongPath({ path: p, samples }) {
      for (const pt of p) assert.ok(Number.isFinite(pt.lat) && Number.isFinite(pt.lng), "bad point in request");
      return { results: Array.from({ length: samples }, () => ({ elevation: 300 })) };
    },
  };
  for (let km = 1; km <= 60; km += 0.37) {
    const pts = Array.from({ length: 50 }, (_, i) => ({ lat: 33.7, lng: -84.4 + (i / 49) * (km / 92.6) }));
    await elevationAlong(strict, resamplePath(pts));
  }
});

test("pipeline produces a sane, limit-respecting plan without Overpass", async () => {
  const rs = resamplePath(path);
  const prof = await buildProfile(fakeRoute, rs, null, elevationService);
  assert.equal(prof.limitSource, "estimated");
  assert.ok(prof.trafficCat.some((c) => c === 1) && prof.trafficCat.some((c) => c === 2));
  assert.ok(prof.trafficK < 1);
  for (let i = 0; i < prof.limit.length; i++) assert.ok(prof.limit[i] <= prof.postedLimit[i] + 1e-9);

  const to = tradeoff({ s: prof.s, grade: prof.grade, limit: prof.limit });
  const base = to.baseline, rec = to.recommended;
  assert.ok(base.mpg > 18 && base.mpg < 45, `baseline mpg ${base.mpg}`);
  assert.ok(rec.fuel <= base.fuel * 1.0001);
  for (let i = 0; i < rec.v.length; i++) assert.ok(rec.v[i] <= prof.limit[i] + 1e-6, `over cap at ${i}`);
  const st = instructions(prof, rec);
  assert.ok(st.length > 0 && st[0].target_mph > 0);
  // traffic delay should show up in the baseline time vs. no-traffic
  const noTraffic = tradeoff({ s: prof.s, grade: prof.grade, limit: prof.postedLimit }).baseline;
  assert.ok(base.time > noTraffic.time + 60, `traffic adds ${base.time - noTraffic.time} s`);
  console.log(`  ${(prof.s.at(-1) / 1609).toFixed(1)} mi, ${elevCalls} elevation calls, baseline ${base.mpg.toFixed(1)} MPG, rec ${rec.mpg.toFixed(1)} MPG, k=${prof.trafficK.toFixed(2)}, posted ${[...new Set(Array.from(prof.postedLimit, (v) => Math.round(v / MPH)))].join("/")} mph`);
});
