import { test } from "node:test";
import assert from "node:assert/strict";
import { distancePhrase, changeCue, gradeAhead, leadDistance } from "../docs/js/voice.js";

test("distances are phrased the way people say them", () => {
  assert.equal(distancePhrase(60), "In 200 feet");
  assert.equal(distancePhrase(20), "In 100 feet");
  assert.equal(distancePhrase(450), "In a quarter mile");
  assert.equal(distancePhrase(800), "In half a mile");
  assert.equal(distancePhrase(1200), "In three quarters of a mile");
  assert.equal(distancePhrase(1700), "In 1 mile");
  assert.equal(distancePhrase(4000), "In 2.5 miles");
});

test("change cues name the speed, cap it at the limit, and mention hills", () => {
  const next = { action: "Ease off to", target_mph: 45, limit_mph: 55 };
  assert.equal(changeCue(next, 800, 0), "In half a mile, ease off to 45.");
  assert.equal(changeCue(next, 800, 0.03), "In half a mile, ease off to 45. Hill ahead.");
  assert.equal(changeCue(next, 800, -0.03), "In half a mile, ease off to 45. Downhill ahead.");
  assert.equal(changeCue({ action: "Speed up to", target_mph: 60, limit_mph: 55 }, 200, 0), "In 700 feet, speed up to 55.");
  assert.equal(changeCue({ action: "Ease off to", target_mph: 0, limit_mph: 25 }, 150, 0), "In 500 feet, prepare to stop.");
});

test("gradeAhead averages the right window", () => {
  const grade = Float64Array.from({ length: 100 }, (_, i) => (i >= 40 && i < 56 ? 0.04 : 0));
  assert.ok(Math.abs(gradeAhead(1000, grade, 25, 400) - 0.04) < 1e-9);
  assert.equal(gradeAhead(0, grade, 25, 400), 0);
});

test("lead distance scales with speed within bounds", () => {
  assert.equal(leadDistance(0), 150);
  assert.equal(leadDistance(25), 300);
  assert.equal(leadDistance(100), 800);
});
