import numpy as np
import pytest

from eco_drive.geo import Profile
from eco_drive.elevation import grade_from_elevation
from eco_drive.optimize import SpeedDP, drive_at_limit, tradeoff
from eco_drive.vehicle import MPH


def synthetic(length_m=4000.0, ds=25.0, limit_mph=55.0, hill_m=0.0):
    s = np.arange(0.0, length_m + ds / 2, ds)
    elev = hill_m * np.sin(np.pi * s / length_m) ** 2  # one smooth hill
    p = Profile(
        s=s, lat=np.zeros_like(s), lon=np.zeros_like(s),
        limit_mps=np.full_like(s, limit_mph * MPH), limit_tagged=np.ones_like(s, bool),
    )
    p.elevation_m = elev
    p.grade = grade_from_elevation(elev, ds)
    return p


@pytest.mark.parametrize("hill_m", [0.0, 40.0])
def test_dp_never_exceeds_limit_and_starts_ends_stopped(hill_m):
    p = synthetic(hill_m=hill_m)
    plan = SpeedDP(p).solve(1.0)
    assert np.all(plan.v <= p.limit_mps + 1e-6)
    assert plan.v[0] == 0.0 and plan.v[-1] == 0.0


def test_same_time_plan_uses_no_more_fuel_than_baseline():
    p = synthetic(hill_m=40.0)
    to = tradeoff(p, budgets=(0.0,))
    assert 0.0 in to.budgets
    same = to.budgets[0.0]
    assert same.time_s <= to.baseline.time_s * (1 + 1e-9)
    assert same.fuel_g <= to.baseline.fuel_g


def test_more_time_means_less_fuel():
    to = tradeoff(synthetic(hill_m=40.0), budgets=(0.0, 0.05, 0.10))
    fuels = [to.budgets[b].fuel_g for b in (0.0, 0.05, 0.10)]
    assert fuels[0] >= fuels[1] >= fuels[2]


def test_cheap_time_slows_down_on_flat_road():
    p = synthetic()
    slow = SpeedDP(p).solve(0.05)
    fast = SpeedDP(p).solve(50.0)
    assert slow.time_s > fast.time_s
    assert slow.fuel_g < fast.fuel_g


def test_baseline_reaches_limit_on_long_road():
    p = synthetic(length_m=6000.0)
    b = drive_at_limit(p)
    assert np.isclose(b.v.max(), 55 * MPH)


def test_instructions_start_with_a_real_speed_and_cover_the_route():
    from eco_drive.report import instructions

    p = synthetic(length_m=6000.0, hill_m=40.0)
    plan = SpeedDP(p).solve(1.0)
    st = instructions(p, plan)
    assert st[0].start_mi == 0.0
    assert st[0].target_mph > 0
    assert all(a.end_mi == b.start_mi for a, b in zip(st, st[1:]))
