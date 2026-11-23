// Speed planning in the browser. Mirrors src/eco_drive/{elevation,optimize,report}.py.
//
// Profile: {s: Float64Array(N+1) [m], grade: Float64Array(N), limit: Float64Array(N+1) [m/s]}
// Plan:    {name, v, fuel, time, lam, segFuel, segTime, accel}

import { SPORTAGE, segmentCost, mpg, MPH, M_PER_MILE } from "./physics.js"; // segmentCost: evaluate() only

// ------------------------------------------------------------------ terrain

/** Savitzky–Golay, polyorder 2, edges fit like scipy's mode="interp". */
export function savgol2(y, win) {
  const n = y.length;
  if (win % 2 === 0) win += 1;
  if (win < 5 || n <= win) return Float64Array.from(y);
  const m = (win - 1) / 2;
  const out = new Float64Array(n);
  // interior: closed-form quadratic SG smoothing coefficients
  const denom = (2 * m - 1) * (2 * m + 1) * (2 * m + 3);
  const c = new Float64Array(win);
  for (let j = -m; j <= m; j++) c[j + m] = (3 * (3 * m * m + 3 * m - 1) - 15 * j * j) / denom;
  for (let i = m; i < n - m; i++) {
    let acc = 0;
    for (let j = 0; j < win; j++) acc += c[j] * y[i - m + j];
    out[i] = acc;
  }
  // edges: least-squares quadratic over the first/last window, evaluated in place
  const fitEval = (start, idxs) => {
    let S0 = 0, S1 = 0, S2 = 0, S3 = 0, S4 = 0, T0 = 0, T1 = 0, T2 = 0;
    for (let k = 0; k < win; k++) {
      const x = k, yy = y[start + k], x2 = x * x;
      S0 += 1; S1 += x; S2 += x2; S3 += x2 * x; S4 += x2 * x2;
      T0 += yy; T1 += x * yy; T2 += x2 * yy;
    }
    // solve [[S4,S3,S2],[S3,S2,S1],[S2,S1,S0]] [a,b,c] = [T2,T1,T0]
    const A = [[S4, S3, S2, T2], [S3, S2, S1, T1], [S2, S1, S0, T0]];
    for (let col = 0; col < 3; col++) {
      for (let r = col + 1; r < 3; r++) {
        const f = A[r][col] / A[col][col];
        for (let k = col; k < 4; k++) A[r][k] -= f * A[col][k];
      }
    }
    const cc = A[2][3] / A[2][2];
    const bb = (A[1][3] - A[1][2] * cc) / A[1][1];
    const aa = (A[0][3] - A[0][2] * cc - A[0][1] * bb) / A[0][0];
    for (const i of idxs) { const x = i - start; out[i] = aa * x * x + bb * x + cc; }
  };
  fitEval(0, Array.from({ length: m }, (_, k) => k));
  fitEval(n - win, Array.from({ length: m }, (_, k) => n - m + k));
  return out;
}

export const MAX_GRADE = 0.12;

export function gradeFrom(elev, ds) {
  const g = new Float64Array(elev.length - 1);
  for (let i = 0; i < g.length; i++) g[i] = Math.max(-MAX_GRADE, Math.min(MAX_GRADE, (elev[i + 1] - elev[i]) / ds));
  return g;
}

// ------------------------------------------------------------------ evaluation

export function evaluate(p, v, name, veh = SPORTAGE, lam = null) {
  const N = v.length - 1, ds = p.s[1] - p.s[0];
  const segFuel = new Float64Array(N), segTime = new Float64Array(N), accel = new Float64Array(N);
  let fuel = 0, time = 0;
  for (let i = 0; i < N; i++) {
    const c = segmentCost(veh, v[i], v[i + 1], ds, p.grade[i]);
    segFuel[i] = c.fuel; segTime[i] = c.dt; accel[i] = c.a;
    fuel += c.fuel; time += c.dt;
  }
  return { name, v, fuel, time, distance: p.s[N], lam, segFuel, segTime, accel, get mpg() { return mpg(this.fuel, this.distance); } };
}

/** Reference driver: up to the limit at a_acc, down for lower limits / the destination at a_dec. */
export function driveAtLimit(p, veh = SPORTAGE, aAcc = 1.2, aDec = 1.5) {
  const ds = p.s[1] - p.s[0];
  const v = Float64Array.from(p.limit);
  v[0] = 0; v[v.length - 1] = 0;
  for (let i = 0; i < v.length - 1; i++) v[i + 1] = Math.min(v[i + 1], Math.sqrt(v[i] ** 2 + 2 * aAcc * ds));
  for (let i = v.length - 2; i >= 0; i--) v[i] = Math.min(v[i], Math.sqrt(v[i + 1] ** 2 + 2 * aDec * ds));
  return evaluate(p, v, "Drive at the limit", veh);
}

// ------------------------------------------------------------------ dynamic programming

export class SpeedDP {
  /** Banded DP: from speed v0 only speeds reachable within [aMin, aMax] over ds are considered. */
  constructor(p, { veh = SPORTAGE, dv = 0.5, aMin = -2.0, aMax = 1.5, mu = 0.3 } = {}) {
    Object.assign(this, { p, veh, aMin, aMax, mu });
    this.ds = p.s[1] - p.s[0];
    this.N = p.s.length - 1;
    let vmax = 0;
    for (const x of p.limit) vmax = Math.max(vmax, x);
    const grid = [];
    for (let x = 0; x <= vmax + dv / 2; x += dv) grid.push(x);
    for (const x of p.limit) grid.push(x);
    // unique + sorted, like np.unique (exact float equality)
    this.V = Float64Array.from([...new Set(grid)].sort((a, b) => a - b));
    const nV = this.V.length, V = this.V, ds = this.ds;
    this.lo = new Int32Array(nV); this.hi = new Int32Array(nV);
    for (let a = 0; a < nV; a++) {
      const vLo2 = V[a] * V[a] + 2 * ds * aMin, vHi2 = V[a] * V[a] + 2 * ds * aMax;
      let lo = 0; while (lo < nV && (V[lo] * V[lo] - V[a] * V[a]) / (2 * ds) < aMin) lo++;
      let hi = nV - 1; while (hi >= 0 && (V[hi] * V[hi] - V[a] * V[a]) / (2 * ds) > aMax) hi--;
      this.lo[a] = lo; this.hi[a] = hi;
      void vLo2; void vHi2;
    }
    // Per speed pair (a -> b), everything except the grade term is segment-independent:
    // dt, mean speed, comfort cost, and the inertia + aero part of the wheel force.
    const m = veh.massKg, mEff = m * veh.rotFactor, kAero = 0.5 * 1.2 * veh.cdaM2;
    const pairs = [];
    for (let a = 0; a < nV; a++) for (let b = this.lo[a]; b <= this.hi[a]; b++) pairs.push([a, b]);
    this.pairOffset = new Int32Array(nV + 1);
    const P = pairs.length;
    this.pDt = new Float64Array(P); this.pVm = new Float64Array(P);
    this.pForce = new Float64Array(P); this.pComfort = new Float64Array(P); this.pB = new Int32Array(P);
    let k = 0;
    for (let a = 0; a < nV; a++) {
      this.pairOffset[a] = k;
      for (let b = this.lo[a]; b <= this.hi[a]; b++, k++) {
        const v0 = V[a], v1 = V[b], vs = v0 + v1;
        const dt = vs > 0 ? (2 * ds) / vs : Infinity;
        const acc = (v1 * v1 - v0 * v0) / (2 * ds), vm = 0.5 * vs;
        this.pB[k] = b; this.pDt[k] = dt; this.pVm[k] = vm;
        this.pForce[k] = mEff * acc + kAero * vm * vm;
        this.pComfort[k] = dt === Infinity ? 0 : mu * acc * acc * dt;
      }
    }
    this.pairOffset[nV] = k;
    // Per segment: grade force (gravity + rolling), computed once.
    this.segForce = new Float64Array(this.N);
    for (let i = 0; i < this.N; i++) {
      const th = Math.atan(p.grade[i]);
      this.segForce[i] = m * 9.81 * Math.sin(th) + veh.crr * m * 9.81 * Math.cos(th);
    }
    this.solves = 0;
  }

  solve(lam) {
    const { N, V, veh, p, pairOffset, pB, pDt, pVm, pForce, pComfort, segForce } = this;
    const nV = V.length;
    const idle = veh.idleGps, invEta = 1 / (veh.etaMarginal * 43_400), fEb = -veh.engineBrakeN;
    const vCut = veh.fuelCutMinMps, pMax = veh.maxWheelPowerW;
    let J = new Float64Array(nV).fill(Infinity);
    J[0] = 0; // must end stopped
    let Jn = new Float64Array(nV);
    const choice = new Int16Array(N * nV);
    const eps = 1e-6;
    for (let i = N - 1; i >= 0; i--) {
      const fg = segForce[i], lim0 = p.limit[i] + eps, lim1 = p.limit[i + 1] + eps;
      for (let a = 0; a < nV; a++) {
        let best = Infinity, arg = 0;
        if (V[a] <= lim0) {
          for (let k = pairOffset[a], end = pairOffset[a + 1]; k < end; k++) {
            const b = pB[k];
            if (V[b] > lim1) break; // V sorted
            const jb = J[b], dt = pDt[k];
            if (jb === Infinity || dt === Infinity) continue;
            const vm = pVm[k], f = pForce[k] + fg, power = f * vm;
            if (power > pMax) continue;
            const rate = f <= fEb && vm >= vCut ? 0 : idle + (power > 0 ? power * invEta : 0);
            // float32 rounding mirrors the Python tensors closely enough for argmin parity
            const total = Math.fround(rate * dt) + lam * Math.fround(dt) + Math.fround(pComfort[k]) + jb;
            if (total < best) { best = total; arg = b; }
          }
        }
        Jn[a] = best;
        choice[i * nV + a] = arg;
      }
      [J, Jn] = [Jn, J];
    }
    this.solves++;
    if (!Number.isFinite(J[0])) throw new Error("No feasible speed plan for this route.");
    const v = new Float64Array(N + 1);
    let k = 0;
    for (let i = 0; i < N; i++) { k = choice[i * nV + k]; v[i + 1] = V[k]; }
    return evaluate(p, v, `Optimal (λ=${lam.toPrecision(3)} g/s)`, veh, lam);
  }
}

// ------------------------------------------------------------------ trade-off

export function lamToDollarsPerHour(lam, gasPrice) {
  return (lam * 3600) / 2820 * gasPrice;
}

function knee(times, fuels) {
  const tMin = Math.min(...times), tMax = Math.max(...times), fMin = Math.min(...fuels), fMax = Math.max(...fuels);
  let best = -Infinity, arg = 0;
  times.forEach((t, i) => {
    const d = 1 - (t - tMin) / Math.max(tMax - tMin, 1e-9) - (fuels[i] - fMin) / Math.max(fMax - fMin, 1e-9);
    if (d > best) { best = d; arg = i; }
  });
  return arg;
}

const geomspace = (a, b, n) => Array.from({ length: n }, (_, i) => a * (b / a) ** (i / (n - 1)));

/** Baseline, λ sweep, best plan within each extra-time budget, and the knee recommendation. */
export function tradeoff(p, { veh = SPORTAGE, budgets = [0, 0.03, 0.05, 0.10], maxExtra = 0.2, onProgress } = {}) {
  const base = driveAtLimit(p, veh);
  const dp = new SpeedDP(p, { veh });
  const lams = geomspace(0.02, 30, 28);
  const total = lams.length + budgets.length * 19;
  const tick = () => onProgress?.(Math.min(1, dp.solves / total));

  const sweep = lams.map((l) => { const r = dp.solve(l); tick(); return r; }).sort((a, b) => a.time - b.time);

  const bestWithin = (tMax) => {
    let lo = Math.log(0.005), hi = Math.log(200);
    if (dp.solve(Math.exp(hi)).time > tMax) return null;
    for (let k = 0; k < 18; k++) {
      const mid = 0.5 * (lo + hi);
      if (dp.solve(Math.exp(mid)).time <= tMax) hi = mid; else lo = mid;
      tick();
    }
    return dp.solve(Math.exp(hi));
  };

  const budgetPlans = [];
  for (const b of budgets) {
    const pl = bestWithin(base.time * (1 + b));
    if (pl) { pl.name = b > 0 ? `+${Math.round(b * 100)}% time` : "Same time"; pl.budget = b; budgetPlans.push(pl); }
  }
  const win = sweep.filter((pl) => pl.time <= base.time * (1 + maxExtra));
  const k = knee(win.map((x) => x.time), win.map((x) => x.fuel));
  const rec = dp.solve(win[k].lam);
  rec.name = "Recommended";
  onProgress?.(1);
  return { baseline: base, sweep, budgets: budgetPlans, recommended: rec };
}

// ------------------------------------------------------------------ instructions

/** Readable stretches: quantize to 5 mph, merge < 300 m runs, fold the pull-away into the first stretch. */
export function instructions(p, plan, minLenM = 300, q = 5) {
  const n = plan.v.length;
  const vq = Array.from(plan.v, (v) => Math.round(v / MPH / q) * q);
  const lim = Array.from(p.limit, (v) => Math.round(v / MPH));
  const runs = [];
  for (let i = 0; i < n; i++) {
    const last = runs[runs.length - 1];
    if (last && last[2] === vq[i]) last[1] = i; else runs.push([i, i, vq[i]]);
  }
  const merged = [];
  for (const r of runs) {
    const last = merged[merged.length - 1];
    if (last && p.s[r[1]] - p.s[r[0]] < minLenM) last[1] = r[1]; else merged.push([...r]);
  }
  const out = [];
  for (const r of merged) {
    const last = out[out.length - 1];
    if (last && last[2] === r[2]) last[1] = r[1]; else out.push(r);
  }
  if (out.length > 1 && out[0][2] === 0) { out[1][0] = out[0][0]; out.shift(); }
  const res = [];
  let prev = 0;
  for (const [a, b, raw] of out) {
    if (raw === 0 && b === n - 1) continue;
    // Sign = the limit covering most of the stretch (ties -> the lower one), not the max:
    // one on-ramp shouldn't make two miles of city streets read as a 65 zone.
    const counts = new Map();
    for (let k = a; k <= b; k++) counts.set(lim[k], (counts.get(lim[k]) ?? 0) + 1);
    let segLim = Infinity, best = -1;
    for (const [v, c] of [...counts].sort((x, y) => x[0] - y[0])) if (c > best) { best = c; segLim = v; }
    const val = Math.min(raw, segLim); // never instruct above the sign shown
    res.push({
      start_m: p.s[a], end_m: p.s[b],
      start_mi: p.s[a] / M_PER_MILE, end_mi: p.s[b] / M_PER_MILE,
      action: val === prev ? "Hold" : val > prev ? "Speed up to" : "Ease off to",
      target_mph: val, limit_mph: segLim,
    });
    prev = val;
  }
  return res;
}
