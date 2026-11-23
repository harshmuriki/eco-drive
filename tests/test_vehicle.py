import numpy as np

from eco_drive.vehicle import (
    MPH,
    SPORTAGE,
    fuel_rate,
    segment_cost,
    steady_mpg,
    tractive_force,
)


def test_highway_mpg_in_plausible_band():
    # EPA highway for this car is ~32; steady 65 mph should be in that neighborhood.
    assert 27 <= steady_mpg(SPORTAGE, 65 * MPH) <= 36


def test_mpg_decreases_at_high_speed():
    assert steady_mpg(SPORTAGE, 55 * MPH) > steady_mpg(SPORTAGE, 75 * MPH)


def test_uphill_costs_more_than_flat():
    assert steady_mpg(SPORTAGE, 50 * MPH, 0.03) < steady_mpg(SPORTAGE, 50 * MPH, 0.0)


def test_grade_force_sign():
    up = tractive_force(SPORTAGE, 20.0, 0.0, 0.05)
    down = tractive_force(SPORTAGE, 20.0, 0.0, -0.05)
    flat = tractive_force(SPORTAGE, 20.0, 0.0, 0.0)
    assert up > flat > down


def test_fuel_cut_only_when_braking_harder_than_engine_brake():
    v = 20.0
    assert fuel_rate(SPORTAGE, -1000.0, v) == 0.0  # hard decel -> fuel cut
    assert fuel_rate(SPORTAGE, -100.0, v) == SPORTAGE.idle_fuel_g_per_s  # gentle coast
    assert fuel_rate(SPORTAGE, -1000.0, 2.0) == SPORTAGE.idle_fuel_g_per_s  # too slow


def test_segment_energy_balance_on_flat():
    # Accelerating 0->20 m/s needs at least the kinetic energy at the wheels.
    ds = 200.0
    _, dt, a, p = segment_cost(SPORTAGE, 0.0, 20.0, ds, 0.0)
    wheel_energy = p * dt
    ke = 0.5 * SPORTAGE.m_eff * 20.0**2
    assert wheel_energy >= ke
    assert np.isclose(a, 1.0)
    assert np.isclose(dt, 20.0)


def test_zero_speed_segment_is_infeasible():
    _, dt, _, _ = segment_cost(SPORTAGE, 0.0, 0.0, 25.0, 0.0)
    assert np.isinf(dt)
