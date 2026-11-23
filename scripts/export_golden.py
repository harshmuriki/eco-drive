"""Write tests/golden.json: Python reference results the JS planner must reproduce.

Uses the demo route (served from cache after the first run) so JS and Python are
compared on real terrain and real speed limits, not just synthetic hills.

    uv run python scripts/export_golden.py
"""

import json
from pathlib import Path

import numpy as np

from eco_drive.elevation import add_elevation, smooth_elevation
from eco_drive.geo import geocode, resample, route
from eco_drive.optimize import SpeedDP, drive_at_limit, tradeoff
from eco_drive.report import instructions

OUT = Path(__file__).resolve().parents[1] / "tests" / "golden.json"


def main():
    a = geocode("Georgia Institute of Technology, Atlanta")
    b = geocode("Stone Mountain Park, GA")
    p = add_elevation(resample(route(a[:2], b[:2]), 25.0))

    base = drive_at_limit(p)
    dp = SpeedDP(p)
    fixed = {}
    for lam in (0.3, 1.0, 3.0):
        pl = dp.solve(lam)
        fixed[str(lam)] = {"fuel_g": pl.fuel_g, "time_s": pl.time_s, "v": pl.v.tolist()}
    to = tradeoff(p)

    raw_win = 11
    smooth_case = {
        "raw": p.elevation_raw_m[:400].tolist(),
        "ds": p.ds,
        "window_m": raw_win * p.ds,
        "smoothed": smooth_elevation(p.elevation_raw_m[:400], p.ds, raw_win * p.ds).tolist(),
    }

    data = {
        "profile": {
            "s": p.s.tolist(),
            "grade": p.grade.tolist(),
            "limit_mps": p.limit_mps.tolist(),
        },
        "baseline": {"fuel_g": base.fuel_g, "time_s": base.time_s, "v": base.v.tolist()},
        "fixed_lambda": fixed,
        "budgets": {str(k): {"fuel_g": v.fuel_g, "time_s": v.time_s} for k, v in to.budgets.items()},
        "recommended": {"fuel_g": to.recommended.fuel_g, "time_s": to.recommended.time_s, "lam": to.recommended.lam},
        "instructions_recommended": [s.__dict__ for s in instructions(p, to.recommended)],
        "smooth": smooth_case,
    }
    OUT.write_text(json.dumps(data))
    print(f"wrote {OUT} ({OUT.stat().st_size // 1024} KB), N={len(p.s) - 1}")
    print("baseline", round(base.fuel_g, 1), "g", round(base.time_s, 1), "s; rec lam", to.recommended.lam)


if __name__ == "__main__":
    np.set_printoptions(precision=4)
    main()
