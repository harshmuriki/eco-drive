"""Speed planning along a fixed route.

Distance-domain dynamic programming:
  state      v_i  in a speed grid (0 .. v_max, step dv)
  transition v_i -> v_{i+1} over ds meters at constant acceleration
  stage cost fuel + lam * dt + mu * a^2 * dt
  constraints v_i <= limit_i, a_min <= a <= a_max, wheel power <= P_max,
              v_0 = v_N = 0

lam [g/s] is the price of time in grams of fuel per second. mu is a small comfort
weight that discourages "pulse and glide" sawtooth plans.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .geo import Profile
from .vehicle import GASOLINE_G_PER_GALLON, SPORTAGE, Vehicle, mpg, segment_cost


@dataclass
class Plan:
    name: str
    v: np.ndarray  # (N+1,) speed at each node [m/s]
    fuel_g: float
    time_s: float
    distance_m: float
    seg_fuel_g: np.ndarray  # (N,)
    seg_time_s: np.ndarray  # (N,)
    accel: np.ndarray  # (N,)
    lam: float | None = None

    @property
    def mpg(self) -> float:
        return mpg(self.fuel_g, self.distance_m)


def evaluate(p: Profile, v: np.ndarray, name: str, veh: Vehicle = SPORTAGE, lam=None) -> Plan:
    fuel, dt, a, _ = segment_cost(veh, v[:-1], v[1:], p.ds, p.grade)
    return Plan(name, v, float(fuel.sum()), float(dt.sum()), float(p.s[-1]), fuel, dt, a, lam)


# --------------------------------------------------------------------------- baseline

def drive_at_limit(p: Profile, a_acc: float = 1.2, a_dec: float = 1.5, veh: Vehicle = SPORTAGE) -> Plan:
    """Reference driver: goes to the speed limit as soon as they comfortably can,
    and only slows down where the limit (or the destination) requires it."""
    lim = p.limit_mps.copy()
    lim[0] = lim[-1] = 0.0
    v = lim.copy()
    for i in range(len(v) - 1):  # forward: acceleration-limited
        v[i + 1] = min(v[i + 1], np.sqrt(v[i] ** 2 + 2 * a_acc * p.ds))
    for i in range(len(v) - 2, -1, -1):  # backward: braking-limited
        v[i] = min(v[i], np.sqrt(v[i + 1] ** 2 + 2 * a_dec * p.ds))
    return evaluate(p, v, "Drive at the limit", veh)


# --------------------------------------------------------------------------- DP

class SpeedDP:
    """Precomputes per-segment fuel/time tensors once; each solve(lam) is cheap."""

    def __init__(self, p: Profile, veh: Vehicle = SPORTAGE, dv: float = 0.5,
                 a_min: float = -2.0, a_max: float = 1.5, mu: float = 0.3):
        self.p, self.veh, self.mu = p, veh, mu
        v_max = float(p.limit_mps.max())
        # Grid includes each posted limit exactly, so "drive at the limit" is reachable.
        self.V = np.unique(np.r_[np.arange(0.0, v_max + dv / 2, dv), p.limit_mps])
        nV, N = len(self.V), len(p.s) - 1
        v0 = self.V[:, None]
        v1 = self.V[None, :]

        self.fuel = np.empty((N, nV, nV), dtype=np.float32)
        self.dt = np.empty((N, nV, nV), dtype=np.float32)
        self.comfort = np.empty((N, nV, nV), dtype=np.float32)
        for i in range(N):
            fuel, dt, a, power = segment_cost(veh, v0, v1, p.ds, p.grade[i])
            bad = (
                ~np.isfinite(dt)
                | (a < a_min) | (a > a_max)
                | (power > veh.max_wheel_power_w)
                | (v0 > p.limit_mps[i] + 1e-6)
                | (v1 > p.limit_mps[i + 1] + 1e-6)
            )
            self.fuel[i] = np.where(bad, np.inf, fuel)
            self.dt[i] = np.where(bad, np.inf, dt)
            self.comfort[i] = np.where(bad, 0.0, mu * a**2 * np.where(bad, 0.0, dt))

    def solve(self, lam: float) -> Plan:
        N, nV = self.fuel.shape[0], len(self.V)
        J = np.full(nV, np.inf)
        J[0] = 0.0  # must end stopped
        choice = np.empty((N, nV), dtype=np.int16)
        for i in range(N - 1, -1, -1):
            total = self.fuel[i] + lam * self.dt[i] + self.comfort[i] + J[None, :]
            choice[i] = np.argmin(total, axis=1)
            J = total[np.arange(nV), choice[i]]
        if not np.isfinite(J[0]):
            raise RuntimeError("No feasible speed plan (check limits / accel bounds / ds)")
        idx = np.empty(N + 1, dtype=int)
        idx[0] = 0  # start stopped
        for i in range(N):
            idx[i + 1] = choice[i, idx[i]]
        return evaluate(self.p, self.V[idx], f"Optimal (λ={lam:.3g} g/s)", self.veh, lam)


# --------------------------------------------------------------------------- trade-off

@dataclass
class TradeOff:
    baseline: Plan
    sweep: list[Plan]  # sorted by time ascending
    budgets: dict[float, Plan]  # extra-time fraction -> best plan within it
    recommended: Plan
    recommended_extra: float  # time vs baseline, fraction


def lam_to_dollars_per_hour(lam_g_per_s: float, gas_price_per_gal: float) -> float:
    return lam_g_per_s * 3600.0 / GASOLINE_G_PER_GALLON * gas_price_per_gal


def _knee(times: np.ndarray, fuels: np.ndarray) -> int:
    """Kneedle: point farthest below the chord of the normalized (time, fuel) curve."""
    t = (times - times.min()) / max(np.ptp(times), 1e-9)
    f = (fuels - fuels.min()) / max(np.ptp(fuels), 1e-9)
    # chord from (0, 1) [fastest, most fuel] to (1, 0) [slowest, least fuel]
    dist = 1.0 - t - f
    return int(np.argmax(dist))


def tradeoff(p: Profile, veh: Vehicle = SPORTAGE, budgets=(0.0, 0.03, 0.05, 0.10),
             max_extra: float = 0.20, **dp_kw) -> TradeOff:
    base = drive_at_limit(p, veh=veh)
    dp = SpeedDP(p, veh, **dp_kw)

    lams = np.geomspace(0.02, 30.0, 28)
    sweep = sorted((dp.solve(l) for l in lams), key=lambda pl: pl.time_s)

    def best_within(t_max: float) -> Plan | None:
        # smallest lam (least fuel) whose time fits; time(lam) is monotone decreasing
        lo, hi = np.log(0.005), np.log(200.0)
        if dp.solve(np.exp(hi)).time_s > t_max:
            return None
        for _ in range(18):
            mid = 0.5 * (lo + hi)
            if dp.solve(np.exp(mid)).time_s <= t_max:
                hi = mid
            else:
                lo = mid
        return dp.solve(np.exp(hi))

    budget_plans = {}
    for b in budgets:
        pl = best_within(base.time_s * (1 + b))
        if pl is not None:
            pl.name = f"+{b:.0%} time" if b > 0 else "Same time"
            budget_plans[b] = pl

    window = [pl for pl in sweep if pl.time_s <= base.time_s * (1 + max_extra)]
    k = _knee(np.array([pl.time_s for pl in window]), np.array([pl.fuel_g for pl in window]))
    rec = dp.solve(window[k].lam)
    rec.name = "Recommended"
    return TradeOff(base, sweep, budget_plans, rec, rec.time_s / base.time_s - 1)
