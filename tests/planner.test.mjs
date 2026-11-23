// JS planner must reproduce the Python reference (tests/golden.json, from scripts/export_golden.py).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { savgol2, driveAtLimit, SpeedDP, tradeoff, instructions } from "../docs/js/planner.js";

const G = JSON.parse(readFileSync(new URL("./golden.json", import.meta.url)));
const p = {
  s: Float64Array.from(G.profile.s),
  grade: Float64Array.from(G.profile.grade),
  limit: Float64Array.from(G.profile.limit_mps),
};
const close = (a, b, rel, what) => assert.ok(Math.abs(a - b) <= rel * Math.abs(b), `${what}: js ${a} vs py ${b}`);

test("Savitzky–Golay smoothing matches scipy (mode=interp)", () => {
  const win = Math.round(G.smooth.window_m / G.smooth.ds) | 1;
  const js = savgol2(G.smooth.raw, win);
  const worst = Math.max(...js.map((v, i) => Math.abs(v - G.smooth.smoothed[i])));
  assert.ok(worst < 1e-6, `max abs diff ${worst} m`);
});

test("baseline matches exactly", () => {
  const b = driveAtLimit(p);
  close(b.fuel, G.baseline.fuel_g, 1e-9, "fuel");
  close(b.time, G.baseline.time_s, 1e-9, "time");
});

test("DP at fixed λ matches Python within 0.1%", () => {
  const dp = new SpeedDP(p);
  for (const [lam, ref] of Object.entries(G.fixed_lambda)) {
    const r = dp.solve(Number(lam));
    close(r.fuel, ref.fuel_g, 1e-3, `fuel λ=${lam}`);
    close(r.time, ref.time_s, 1e-3, `time λ=${lam}`);
  }
});

test("trade-off budgets and recommendation match Python within 0.5%", () => {
  const t0 = Date.now();
  const to = tradeoff(p);
  const ms = Date.now() - t0;
  for (const pl of to.budgets) {
    const ref = Object.entries(G.budgets).find(([k]) => Number(k) === pl.budget)?.[1];
    assert.ok(ref, `budget ${pl.budget} missing in Python`);
    close(pl.fuel, ref.fuel_g, 5e-3, `fuel ${pl.name}`);
    close(pl.time, ref.time_s, 5e-3, `time ${pl.name}`);
  }
  close(to.recommended.fuel, G.recommended.fuel_g, 5e-3, "recommended fuel");
  console.log(`  tradeoff: ${ms} ms for ${p.s.length - 1} segments`);
});

test("instructions match Python for the recommended plan", () => {
  const to = tradeoff(p);
  const js = instructions(p, to.recommended);
  const py = G.instructions_recommended;
  assert.equal(js.length, py.length);
  js.forEach((st, i) => {
    assert.equal(st.target_mph, py[i].target_mph);
    assert.equal(st.action, py[i].action);
  });
});
