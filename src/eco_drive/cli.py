"""eco-drive plan "<start>" "<destination>" -> report.html"""

from __future__ import annotations

import argparse
import time
from pathlib import Path

from .elevation import add_elevation
from .geo import geocode, resample, route
from .optimize import tradeoff
from .export import plan_file
from .report import build_report


def plan(args: argparse.Namespace) -> None:
    t0 = time.time()
    lat0, lon0, start_label = geocode(args.start)
    lat1, lon1, end_label = geocode(args.destination)
    print(f"from  {start_label}\nto    {end_label}")

    rt = route((lat0, lon0), (lat1, lon1))
    print(f"route {rt.distance_m / 1609.344:.1f} mi, OSRM estimate {rt.osrm_duration_s / 60:.0f} min")

    p = add_elevation(resample(rt, args.ds))
    to = tradeoff(p)

    b = to.baseline
    print(f"\n{'plan':20s} {'time':>8s} {'Δtime':>7s} {'MPG':>6s} {'Δfuel':>7s}")
    for pl in [b, *to.budgets.values(), to.recommended]:
        print(f"{pl.name:20s} {pl.time_s / 60:7.1f}m {pl.time_s / b.time_s - 1:+7.1%} "
              f"{pl.mpg:6.1f} {pl.fuel_g / b.fuel_g - 1:+7.1%}")

    if not 20 <= b.mpg <= 40:  # smell test from SCOPE.md
        print(f"\n[!] Baseline MPG {b.mpg:.1f} is outside 20–40: treat results as a bug until explained.")

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(build_report(p, to, start_label, end_label, gas_price=args.gas_price))
    print(f"\nwrote {out}")
    plan_path = Path(args.plan) if args.plan else out.with_suffix(".plan.json")
    plan_path.write_text(plan_file(p, to, start_label, end_label))
    print(f"wrote {plan_path}  <- open this in the live page on your phone  ({time.time() - t0:.1f}s)")


def main() -> None:
    ap = argparse.ArgumentParser(prog="eco-drive", description="Fuel-smart speed plan for a route.")
    sub = ap.add_subparsers(dest="cmd", required=True)
    pp = sub.add_parser("plan", help="plan speeds from start to destination")
    pp.add_argument("start", help='address, place name, or "lat,lon"')
    pp.add_argument("destination")
    pp.add_argument("--out", default="reports/report.html", help="HTML report path")
    pp.add_argument("--plan", default=None, help="plan file for the live page (default: next to --out)")
    pp.add_argument("--ds", type=float, default=25.0, help="distance step in meters")
    pp.add_argument("--gas-price", type=float, default=3.00, help="$/gallon")
    pp.set_defaults(func=plan)
    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
