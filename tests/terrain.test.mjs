import { test } from "node:test";
import assert from "node:assert/strict";
import { flattenStructures } from "../docs/js/terrain.js";
import { savgol2, gradeFrom } from "../docs/js/planner.js";

const DS = 25;
const maxAbsGrade = (elev, a, b) => {
  const g = gradeFrom(savgol2(elev, 11), DS);
  let m = 0;
  for (let i = a; i < b; i++) m = Math.max(m, Math.abs(g[i]));
  return m;
};

test("bridge over a valley: fake dip is removed, grade stays gentle", () => {
  const n = 120;
  // road on a gentle 1% climb; terrain drops 15 m into a creek under a 200 m bridge
  const road = Float64Array.from({ length: n }, (_, i) => 300 + 0.01 * DS * i);
  const dem = Float64Array.from(road, (h, i) => (i >= 50 && i <= 58 ? h - 15 * Math.sin((Math.PI * (i - 49)) / 10) : h));
  const flags = new Uint8Array(n);
  for (let i = 50; i <= 58; i++) flags[i] = 1;
  flags[54] = 0; // matching flicker inside the span
  const before = maxAbsGrade(dem, 40, 70);
  const { elev, spans } = flattenStructures(dem, flags);
  const after = maxAbsGrade(elev, 40, 70);
  assert.equal(spans.length, 1, "flicker gap should be merged into one span");
  assert.equal(spans[0].kind, "bridge");
  assert.ok(before > 0.05, `DEM grade under bridge should look steep, got ${before}`);
  assert.ok(after < 0.015, `after fix grade ${after}`);
  assert.ok(spans[0].deltaM > 10);
});

test("tunnel under a hill: fake hump is removed", () => {
  const n = 100;
  const road = new Float64Array(n).fill(250);
  const dem = Float64Array.from(road, (h, i) => (i >= 30 && i <= 45 ? h + 30 * Math.sin((Math.PI * (i - 29)) / 17) : h));
  const flags = new Uint8Array(n);
  for (let i = 30; i <= 45; i++) flags[i] = 2;
  const { elev, spans } = flattenStructures(dem, flags);
  assert.equal(spans[0].kind, "tunnel");
  assert.ok(maxAbsGrade(elev, 20, 60) < 0.005);
});

test("no structures: elevation untouched; real hills are kept", () => {
  const n = 80;
  const hill = Float64Array.from({ length: n }, (_, i) => 280 + 20 * Math.sin(i / 12));
  const { elev, spans } = flattenStructures(hill, new Uint8Array(n));
  assert.equal(spans.length, 0);
  assert.deepEqual(Array.from(elev), Array.from(hill));
});

test("single-sample flags (likely mismatches) are ignored", () => {
  const n = 40;
  const e = Float64Array.from({ length: n }, (_, i) => 300 + (i === 20 ? -8 : 0));
  const f = new Uint8Array(n); f[20] = 1;
  assert.equal(flattenStructures(e, f).spans.length, 0);
});
