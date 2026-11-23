"""Elevation along the route (OpenTopoData, USGS NED 10 m) and road grade.

Why smoothing matters: a DEM is ~10 m resolution with ~1 m vertical noise. Taking
d(elev)/ds over 25 m steps turns 1 m of noise into +/-4% fake grade. We sample
elevation, smooth over a few hundred meters, then differentiate.

Known limitation: a DEM gives *ground* height, so bridges and overpasses look like
dips into the valley below and cuts look like bumps. Smoothing + clipping softens
this but doesn't fix it.
"""

from __future__ import annotations

import time

import numpy as np
from scipy.signal import savgol_filter

from .geo import Profile, _cached, _get

OPENTOPODATA_URL = "https://api.opentopodata.org/v1/{dataset}"
BATCH = 100  # public API max locations per request
MAX_GRADE = 0.12


def fetch_elevation(lat: np.ndarray, lon: np.ndarray, dataset: str = "ned10m") -> np.ndarray:
    out = np.empty(len(lat))
    for start in range(0, len(lat), BATCH):
        la, lo = lat[start:start + BATCH], lon[start:start + BATCH]
        locs = "|".join(f"{a:.6f},{b:.6f}" for a, b in zip(la, lo))
        url = OPENTOPODATA_URL.format(dataset=dataset)

        def fetch():
            res = _get(url, params={"locations": locs})
            time.sleep(1.05)  # public API: max 1 call/s
            return res

        res = _cached(f"elev-{dataset}", locs, fetch)
        if res.get("status") != "OK":
            raise RuntimeError(f"OpenTopoData: {res}")
        vals = [r["elevation"] for r in res["results"]]
        if any(v is None for v in vals):
            raise RuntimeError(f"No {dataset} elevation for part of the route (outside the US?)")
        out[start:start + len(vals)] = vals
    return out


def add_elevation(p: Profile, sample_every_m: float = 50.0, smooth_window_m: float = 250.0) -> Profile:
    """Sample elevation every ~50 m, interpolate onto the profile, smooth, compute grade."""
    step = max(1, int(round(sample_every_m / p.ds)))
    idx = np.unique(np.r_[np.arange(0, len(p.s), step), len(p.s) - 1])
    elev_samples = fetch_elevation(p.lat[idx], p.lon[idx])
    raw = np.interp(p.s, p.s[idx], elev_samples)
    p.elevation_raw_m = raw
    p.elevation_m = smooth_elevation(raw, p.ds, smooth_window_m)
    p.grade = grade_from_elevation(p.elevation_m, p.ds)
    return p


def smooth_elevation(elev: np.ndarray, ds: float, window_m: float) -> np.ndarray:
    win = int(round(window_m / ds)) | 1  # odd
    if win < 5 or len(elev) <= win:
        return elev.copy()
    return savgol_filter(elev, window_length=win, polyorder=2, mode="interp")


def grade_from_elevation(elev: np.ndarray, ds: float) -> np.ndarray:
    return np.clip(np.diff(elev) / ds, -MAX_GRADE, MAX_GRADE)
