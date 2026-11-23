"""Builds a self-contained, phone-friendly HTML report (published as a Claude Artifact)."""

from __future__ import annotations

import html
import json
from dataclasses import dataclass
from datetime import date
from importlib.resources import files

import numpy as np

from .geo import Profile
from .optimize import Plan, TradeOff, lam_to_dollars_per_hour
from .vehicle import GASOLINE_G_PER_GALLON, METERS_PER_MILE, MPH, SPORTAGE, Vehicle

CHART_STEP_M = 100.0  # downsample chart series to keep the page light


@dataclass
class Stretch:
    start_mi: float
    end_mi: float
    action: str  # "Speed up to" / "Hold" / "Ease off to"
    target_mph: int
    limit_mph: int


def instructions(p: Profile, plan: Plan, min_len_m: float = 300.0, q_mph: int = 5) -> list[Stretch]:
    """Collapse a speed plan into a few readable stretches.

    Quantize speed to q_mph, merge stretches shorter than min_len_m into the
    previous one, then label each by how it changes from the one before.
    """
    vq = (np.round(plan.v / MPH / q_mph) * q_mph).astype(int)
    lim = np.round(p.limit_mps / MPH).astype(int)
    runs: list[list[int]] = []  # [start_idx, end_idx, value]
    for i, val in enumerate(vq):
        if runs and runs[-1][2] == val:
            runs[-1][1] = i
        else:
            runs.append([i, i, int(val)])
    # merge short runs into the previous run (keeps steady cruises, drops ramps)
    merged: list[list[int]] = []
    for r in runs:
        if merged and (p.s[r[1]] - p.s[r[0]]) < min_len_m:
            merged[-1][1] = r[1]
        else:
            merged.append(list(r))
    # combine neighbors that ended up with the same target
    out: list[list[int]] = []
    for r in merged:
        if out and out[-1][2] == r[2]:
            out[-1][1] = r[1]
        else:
            out.append(r)

    # The opening "0 mph" run is just pulling away from the start: fold it into the
    # first real stretch, so the first instruction is a speed, not "0".
    if len(out) > 1 and out[0][2] == 0:
        out[1][0] = out[0][0]
        out.pop(0)

    stretches = []
    prev = 0
    for a, b, raw in out:
        if raw == 0 and b == len(p.s) - 1:
            continue  # final stop
        # Sign = the limit covering most of the stretch (ties -> the lower one), not the max:
        # one on-ramp shouldn't make two miles of city streets read as a 65 zone.
        values, counts = np.unique(lim[a:b + 1], return_counts=True)
        seg_lim = int(values[np.argmax(counts)])
        val = min(int(raw), seg_lim)  # never instruct above the sign shown
        action = "Hold" if val == prev else ("Speed up to" if val > prev else "Ease off to")
        stretches.append(Stretch(p.s[a] / METERS_PER_MILE, p.s[b] / METERS_PER_MILE, action, val, seg_lim))
        prev = val
    return stretches


def _plan_dict(pl: Plan, base: Plan, gas_price: float, idx) -> dict:
    gal = pl.fuel_g / GASOLINE_G_PER_GALLON
    return {
        "name": pl.name,
        "time_min": pl.time_s / 60,
        "gallons": gal,
        "cost": gal * gas_price,
        "mpg": pl.mpg,
        "d_time": pl.time_s / base.time_s - 1,
        "d_fuel": pl.fuel_g / base.fuel_g - 1,
        "dollars_per_hour": None if pl.lam is None else lam_to_dollars_per_hour(pl.lam, gas_price),
        "v_mph": np.round(pl.v[idx] / MPH, 1).tolist(),
    }


def _suspicious_grades(p: Profile, highway_like_limit_mph: float = 50, max_grade: float = 0.06) -> list[float]:
    """Mile markers where fast roads show grades steeper than design standards allow
    (usually a bridge/overpass in the elevation data)."""
    fast = p.limit_mps[:-1] >= highway_like_limit_mph * MPH
    bad = np.where(fast & (np.abs(p.grade) > max_grade))[0]
    marks: list[float] = []
    for i in bad:
        mi = p.s[i] / METERS_PER_MILE
        if not marks or mi - marks[-1] > 0.3:
            marks.append(round(mi, 1))
    return marks


def build_report(
    p: Profile, to: TradeOff, start_label: str, end_label: str,
    gas_price: float = 3.00, veh: Vehicle = SPORTAGE,
) -> str:
    step = max(1, int(round(CHART_STEP_M / p.ds)))
    idx = np.unique(np.r_[np.arange(0, len(p.s), step), len(p.s) - 1])
    base = to.baseline

    plans = [_plan_dict(base, base, gas_price, idx)]
    for b, pl in sorted(to.budgets.items()):
        plans.append(_plan_dict(pl, base, gas_price, idx))
    rec = _plan_dict(to.recommended, base, gas_price, idx)
    plans.append(rec)

    tagged_frac = float(np.mean(p.limit_tagged))
    data = {
        "start": start_label,
        "end": end_label,
        "date": date.today().isoformat(),
        "vehicle": veh.name,
        "gas_price": gas_price,
        "distance_mi": p.s[-1] / METERS_PER_MILE,
        "s_mi": np.round(p.s[idx] / METERS_PER_MILE, 3).tolist(),
        "elev_ft": np.round(p.elevation_m[idx] * 3.28084, 1).tolist(),
        "limit_mph": np.round(p.limit_mps[idx] / MPH).tolist(),
        "lat": np.round(p.lat[idx], 5).tolist(),
        "lon": np.round(p.lon[idx], 5).tolist(),
        "climb_ft": float(np.sum(np.clip(np.diff(p.elevation_m), 0, None)) * 3.28084),
        "plans": plans,
        "recommended_index": len(plans) - 1,
        "sweep": [
            {"time_min": pl.time_s / 60, "gallons": pl.fuel_g / GASOLINE_G_PER_GALLON}
            for pl in to.sweep if pl.time_s <= base.time_s * 1.25
        ],
        "instructions": [s.__dict__ for s in instructions(p, to.recommended)],
        "caveats": {
            "limit_tagged_frac": tagged_frac,
            "suspicious_grade_mi": _suspicious_grades(p),
        },
    }
    template = files("eco_drive").joinpath("report_template.html").read_text()
    short = lambda s: s.split(",")[0].strip()  # noqa: E731
    title = f"<title>{html.escape(short(start_label))} to {html.escape(short(end_label))}</title>"
    template = template.replace("<title>Eco Drive Plan</title>", title, 1)
    return template.replace("/*__DATA__*/null", json.dumps(data, separators=(",", ":")).replace("</", "<\\/"))
