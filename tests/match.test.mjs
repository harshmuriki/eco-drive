// node --test tests/   (uses the demo plan in docs/plans)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildIndex, match, pointAt, guidance, OFF_ROUTE_M } from "../docs/match.js";

const plan = JSON.parse(readFileSync(new URL("../docs/plans/demo.json", import.meta.url)));
const route = plan.route;
const idx = buildIndex(route);

test("points on the route match back to their own distance", () => {
  let hint = null;
  for (let s = 0; s < idx.total; s += 137) {
    const [lat, lon] = pointAt(route, s);
    const m = match(idx, lat, lon, hint);
    assert.ok(m.dist < 1, `dist ${m.dist} at s=${s}`);
    assert.ok(Math.abs(m.s - s) < 2, `s ${m.s} vs ${s}`);
    hint = m.seg;
  }
});

test("GPS noise of ~10 m still tracks progress monotonically", () => {
  let hint = null, prev = -Infinity, rng = 42;
  const rand = () => ((rng = (rng * 1103515245 + 12345) % 2 ** 31) / 2 ** 31 - 0.5);
  for (let s = 0; s < idx.total; s += 60) {
    const [lat, lon] = pointAt(route, s);
    const m = match(idx, lat + rand() * 0.00018, lon + rand() * 0.00022, hint);
    assert.ok(m.dist < OFF_ROUTE_M);
    assert.ok(m.s > prev - 40, `went backwards: ${m.s} after ${prev}`);
    assert.ok(Math.abs(m.s - s) < 60, `off by ${m.s - s} at ${s}`);
    prev = m.s; hint = m.seg;
  }
});

test("a point 500 m away is reported off route", () => {
  const [lat, lon] = pointAt(route, 5000);
  const m = match(idx, lat + 0.0045, lon, null);
  assert.ok(m.dist > OFF_ROUTE_M);
});

test("guidance gives the next change ahead of the current position", () => {
  const p = plan.plans[plan.recommended];
  const g = guidance(p, 100);
  assert.equal(g.current, p.stretches[0]);
  assert.ok(g.next && g.toNext > 0);
  const end = guidance(p, idx.total);
  assert.equal(end.next, null);
});
