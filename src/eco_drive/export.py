"""Plan file for the live phone page (docs/): route points + target speeds per plan.

Format (version 1):
  meta:   start, end, created, vehicle, distance_mi, ds_m
  route:  s_m[], lat[], lon[], limit_mph[]       (one entry per ds_m)
  plans:  [{name, time_min, mpg, d_time, d_fuel, v_mph[], stretches[]}]
  recommended: index into plans

Stretches are the human-readable instructions (same as the report), with
start/end in meters so the page can look up "where am I in the plan".
"""

from __future__ import annotations

import json
from datetime import date

import numpy as np

from .geo import Profile
from .optimize import Plan, TradeOff
from .report import instructions
from .vehicle import METERS_PER_MILE, MPH, SPORTAGE, Vehicle

FORMAT_VERSION = 1


def _plan(p: Profile, pl: Plan, base: Plan) -> dict:
    return {
        "name": pl.name,
        "time_min": round(pl.time_s / 60, 2),
        "mpg": round(pl.mpg, 1),
        "d_time": round(pl.time_s / base.time_s - 1, 4),
        "d_fuel": round(pl.fuel_g / base.fuel_g - 1, 4),
        "v_mph": np.round(pl.v / MPH, 1).tolist(),
        "stretches": [
            {
                "start_m": round(st.start_mi * METERS_PER_MILE, 1),
                "end_m": round(st.end_mi * METERS_PER_MILE, 1),
                "action": st.action,
                "target_mph": st.target_mph,
                "limit_mph": st.limit_mph,
            }
            for st in instructions(p, pl)
        ],
    }


def plan_file(p: Profile, to: TradeOff, start_label: str, end_label: str, veh: Vehicle = SPORTAGE) -> str:
    base = to.baseline
    plans = [_plan(p, base, base)]
    plans += [_plan(p, pl, base) for _, pl in sorted(to.budgets.items())]
    plans.append(_plan(p, to.recommended, base))
    data = {
        "format": FORMAT_VERSION,
        "meta": {
            "start": start_label,
            "end": end_label,
            "created": date.today().isoformat(),
            "vehicle": veh.name,
            "distance_mi": round(p.s[-1] / METERS_PER_MILE, 2),
            "ds_m": round(p.ds, 3),
        },
        "route": {
            "s_m": np.round(p.s, 1).tolist(),
            "lat": np.round(p.lat, 6).tolist(),
            "lon": np.round(p.lon, 6).tolist(),
            "limit_mph": np.round(p.limit_mps / MPH).astype(int).tolist(),
        },
        "plans": plans,
        "recommended": len(plans) - 1,
    }
    return json.dumps(data, separators=(",", ":"))
