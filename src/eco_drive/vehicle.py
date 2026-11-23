"""Longitudinal vehicle + fuel model for a 2026 Kia Sportage EX (2.5L gas, FWD, 8AT).

All parameters are estimates (see SCOPE.md) and live in one dataclass so they can
be calibrated later against real trip MPG.

Units: SI throughout (kg, m, s, N, W); fuel in grams.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

G = 9.81  # m/s^2
RHO_AIR = 1.2  # kg/m^3, sea-level-ish
GASOLINE_LHV_J_PER_G = 43_400.0  # lower heating value
GASOLINE_G_PER_GALLON = 2_820.0  # 3.785 L * ~0.745 kg/L
METERS_PER_MILE = 1609.344
MPH = 0.44704  # m/s per mph


@dataclass(frozen=True)
class Vehicle:
    name: str = "2026 Kia Sportage EX 2.5L FWD"
    mass_kg: float = 1_650.0 + 80.0  # curb (estimate) + driver
    rotational_mass_factor: float = 1.04  # wheels/driveline inertia folded into m_eff
    cda_m2: float = 0.85  # Cd ~0.33 x A ~2.6 m^2 (estimate)
    crr: float = 0.009  # all-season tire rolling resistance
    # Willans-line fuel model: fuel_rate = idle + P_wheel / (eta * LHV)
    idle_fuel_g_per_s: float = 0.30
    marginal_efficiency: float = 0.30  # tank-to-wheel, marginal (engine x driveline)
    # Decelerating in gear: injectors cut fuel, but the engine drags the car.
    engine_brake_force_n: float = 400.0
    fuel_cut_min_speed_mps: float = 5.0  # below this the engine idles instead
    max_wheel_power_w: float = 120_000.0  # 187 hp at crank, minus driveline losses

    @property
    def m_eff(self) -> float:
        return self.mass_kg * self.rotational_mass_factor


SPORTAGE = Vehicle()


def tractive_force(veh: Vehicle, v, a, grade):
    """Force needed at the wheels [N]. Positive = engine must push.

    v: speed [m/s], a: acceleration [m/s^2], grade: rise/run (tan theta).
    """
    theta = np.arctan(grade)
    f_inertia = veh.m_eff * a
    f_grade = veh.mass_kg * G * np.sin(theta)
    f_roll = veh.crr * veh.mass_kg * G * np.cos(theta)
    f_aero = 0.5 * RHO_AIR * veh.cda_m2 * np.asarray(v) ** 2
    return f_inertia + f_grade + f_roll + f_aero


def fuel_rate(veh: Vehicle, force_n, v):
    """Fuel mass flow [g/s] for the required wheel force at speed v.

    Three regimes:
      F > 0                      : idle + P / (eta * LHV)
      -F_engine_brake < F <= 0   : light throttle / in-gear coasting -> idle
      F <= -F_engine_brake       : decelerating at least as hard as engine braking
                                   -> fuel cut (0), if above the fuel-cut speed
    """
    force_n = np.asarray(force_n, dtype=float)
    v = np.asarray(v, dtype=float)
    power = force_n * v
    driving = veh.idle_fuel_g_per_s + np.maximum(power, 0.0) / (
        veh.marginal_efficiency * GASOLINE_LHV_J_PER_G
    )
    cut = (force_n <= -veh.engine_brake_force_n) & (v >= veh.fuel_cut_min_speed_mps)
    return np.where(cut, 0.0, driving)


def segment_cost(veh: Vehicle, v0, v1, ds, grade):
    """Fuel [g], time [s], accel [m/s^2], power [W] for moving ds meters from v0 to v1.

    Constant acceleration over the segment: a = (v1^2 - v0^2) / (2 ds),
    dt = 2 ds / (v0 + v1). Forces evaluated at the mean speed.
    Broadcasts over v0, v1 arrays.
    """
    v0 = np.asarray(v0, dtype=float)
    v1 = np.asarray(v1, dtype=float)
    vsum = v0 + v1
    with np.errstate(divide="ignore", invalid="ignore"):
        dt = np.where(vsum > 0, 2.0 * ds / vsum, np.inf)
    a = (v1**2 - v0**2) / (2.0 * ds)
    v_mean = 0.5 * vsum
    f = tractive_force(veh, v_mean, a, grade)
    with np.errstate(invalid="ignore"):
        fuel = fuel_rate(veh, f, v_mean) * dt
    return fuel, dt, a, f * v_mean


def mpg(fuel_g: float, distance_m: float) -> float:
    if fuel_g <= 0:
        return float("inf")
    return (distance_m / METERS_PER_MILE) / (fuel_g / GASOLINE_G_PER_GALLON)


def steady_mpg(veh: Vehicle, speed_mps: float, grade: float = 0.0) -> float:
    """MPG when holding a constant speed on a constant grade."""
    f = tractive_force(veh, speed_mps, 0.0, grade)
    rate = float(fuel_rate(veh, f, speed_mps))
    return mpg(rate, speed_mps)  # per 1 s: travel speed_mps meters, burn rate grams
