// Runs the planner off the main thread so the map stays smooth.
import { tradeoff, instructions, lamToDollarsPerHour } from "./planner.js";
import { G_PER_GALLON } from "./physics.js";

const plainPlan = (p, pl, base, gasPrice) => ({
  name: pl.name,
  budget: pl.budget ?? null,
  lam: pl.lam,
  v: pl.v,
  fuelG: pl.fuel,
  timeS: pl.time,
  mpg: pl.mpg,
  gallons: pl.fuel / G_PER_GALLON,
  cost: (pl.fuel / G_PER_GALLON) * gasPrice,
  dTime: pl.time / base.time - 1,
  dFuel: pl.fuel / base.fuel - 1,
  dollarsPerHour: pl.lam == null ? null : lamToDollarsPerHour(pl.lam, gasPrice),
  stretches: instructions(p, pl),
});

self.onmessage = ({ data }) => {
  const { id, profile, gasPrice } = data;
  try {
    const p = { s: profile.s, grade: profile.grade, limit: profile.limit };
    let last = 0;
    const to = tradeoff(p, {
      onProgress: (f) => {
        if (f - last > 0.05 || f === 1) { last = f; self.postMessage({ id, progress: f }); }
      },
    });
    const base = to.baseline;
    const plans = [base, ...to.budgets, to.recommended].map((pl) => plainPlan(p, pl, base, gasPrice));
    self.postMessage({
      id,
      result: {
        plans,
        recommended: plans.length - 1,
        sweep: to.sweep.filter((pl) => pl.time <= base.time * 1.25).map((pl) => ({ timeS: pl.time, fuelG: pl.fuel })),
      },
    });
  } catch (e) {
    self.postMessage({ id, error: e.message });
  }
};
