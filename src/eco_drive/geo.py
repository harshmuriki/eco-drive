"""Geocoding (Nominatim), routing (OSRM) and speed limits (Overpass / OSM tags).

All free public services; be polite: small requests, generic User-Agent, retries
with backoff, and a disk cache so repeated runs don't hit them again.
"""

from __future__ import annotations

import hashlib
import json
import re
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import requests

from .vehicle import MPH

USER_AGENT = "eco-drive/0.1 (personal research prototype)"
CACHE_DIR = Path.home() / ".cache" / "eco-drive"

NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
OSRM_URL = "https://router.project-osrm.org/route/v1/driving"
OVERPASS_URLS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]

# Fallback posted limits (mph) by OSM highway class when maxspeed is untagged.
# Rough Georgia/US urban defaults.
DEFAULT_LIMIT_MPH = {
    "motorway": 65, "motorway_link": 45,
    "trunk": 55, "trunk_link": 40,
    "primary": 45, "primary_link": 35,
    "secondary": 40, "secondary_link": 30,
    "tertiary": 35, "tertiary_link": 30,
    "unclassified": 30, "residential": 25, "living_street": 15,
    "service": 15,
}
FALLBACK_LIMIT_MPH = 35


# --------------------------------------------------------------------------- cache

def _cached(kind: str, key: str, fetch):
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    path = CACHE_DIR / f"{kind}-{hashlib.sha1(key.encode()).hexdigest()[:16]}.json"
    if path.exists():
        return json.loads(path.read_text())
    data = fetch()
    path.write_text(json.dumps(data))
    return data


def _get(url, *, params=None, data=None, tries=4, timeout=60):
    delay = 2.0
    last = None
    for _ in range(tries):
        try:
            if data is not None:
                r = requests.post(url, data=data, headers={"User-Agent": USER_AGENT}, timeout=timeout)
            else:
                r = requests.get(url, params=params, headers={"User-Agent": USER_AGENT}, timeout=timeout)
            if r.status_code == 200:
                return r.json()
            last = f"HTTP {r.status_code}"
        except (requests.RequestException, ValueError) as e:  # ValueError: bad JSON
            last = repr(e)
        time.sleep(delay)
        delay *= 2
    raise RuntimeError(f"{url} failed after {tries} tries: {last}")


# --------------------------------------------------------------------------- geocode

_LATLON = re.compile(r"^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$")


def geocode(query: str) -> tuple[float, float, str]:
    """Return (lat, lon, display_name). Accepts 'lat,lon' directly."""
    m = _LATLON.match(query)
    if m:
        return float(m.group(1)), float(m.group(2)), query.strip()

    def fetch():
        res = _get(NOMINATIM_URL, params={"q": query, "format": "json", "limit": 1, "countrycodes": "us"})
        time.sleep(1.0)  # Nominatim policy: max 1 req/s
        return res

    res = _cached("geocode", query.lower().strip(), fetch)
    if not res:
        raise ValueError(f"Could not geocode: {query!r}")
    return float(res[0]["lat"]), float(res[0]["lon"]), res[0]["display_name"]


# --------------------------------------------------------------------------- route

@dataclass
class Route:
    lat: np.ndarray  # (n,) OSM node coordinates along the route
    lon: np.ndarray
    seg_dist: np.ndarray  # (n-1,) meters between consecutive nodes
    seg_limit_mps: np.ndarray  # (n-1,) posted (or estimated) speed limit
    seg_limit_tagged: np.ndarray  # (n-1,) bool: True if from an OSM maxspeed tag
    seg_highway: list[str]  # (n-1,) OSM highway class ("" if unknown)
    osrm_duration_s: float

    @property
    def distance_m(self) -> float:
        return float(self.seg_dist.sum())


def _parse_maxspeed(tag: str | None) -> float | None:
    """OSM maxspeed tag -> m/s. Handles '45 mph', '70' (km/h), 'US:urban', etc."""
    if not tag:
        return None
    tag = tag.split(";")[0].strip().lower()
    m = re.match(r"^(\d+(?:\.\d+)?)\s*(mph|km/h|kmh)?$", tag)
    if not m:
        return None
    val = float(m.group(1))
    return val * MPH if m.group(2) == "mph" else val / 3.6


def _overpass_ways(node_ids: list[int]) -> list[dict]:
    ids = ",".join(map(str, node_ids))
    q = f"[out:json][timeout:60];node(id:{ids});way(bn)[highway];out body;"

    def fetch():
        last = None
        for url in OVERPASS_URLS:
            try:
                return _get(url, data={"data": q}, tries=2, timeout=75)["elements"]
            except RuntimeError as e:
                last = e
        raise RuntimeError(f"All Overpass servers failed: {last}")

    return _cached("overpass", ids, fetch)


def route(start: tuple[float, float], end: tuple[float, float]) -> Route:
    """Fastest driving route via OSRM, annotated with OSM speed limits."""
    (lat0, lon0), (lat1, lon1) = start, end
    url = f"{OSRM_URL}/{lon0},{lat0};{lon1},{lat1}"
    params = {"overview": "full", "geometries": "geojson", "annotations": "distance,speed,nodes"}
    data = _cached("osrm", url + json.dumps(params), lambda: _get(url, params=params))
    if data.get("code") != "Ok" or not data.get("routes"):
        raise RuntimeError(f"OSRM: {data.get('code')} {data.get('message', '')}")
    r = data["routes"][0]
    leg = r["legs"][0]
    ann = leg["annotation"]
    coords = np.array(r["geometry"]["coordinates"])  # (n, 2) lon, lat
    seg_dist = np.array(ann["distance"], dtype=float)
    osrm_speed = np.array(ann["speed"], dtype=float)
    nodes = ann["nodes"]
    assert len(seg_dist) == len(coords) - 1 == len(nodes) - 1

    # Map each (node_a, node_b) pair to the way that has them adjacent.
    pair_tags: dict[tuple[int, int], dict] = {}
    try:
        for way in _overpass_ways(nodes):
            wn = way.get("nodes", [])
            for a, b in zip(wn[:-1], wn[1:]):
                pair_tags[(a, b)] = way.get("tags", {})
                pair_tags[(b, a)] = way.get("tags", {})
    except RuntimeError as e:
        print(f"[warn] speed-limit lookup failed, estimating from OSRM speeds: {e}")

    limits, tagged, hw = [], [], []
    for i in range(len(seg_dist)):
        tags = pair_tags.get((nodes[i], nodes[i + 1]), {})
        cls = tags.get("highway", "")
        v = _parse_maxspeed(tags.get("maxspeed"))
        if v is not None:
            limits.append(v)
            tagged.append(True)
        elif cls in DEFAULT_LIMIT_MPH:
            limits.append(DEFAULT_LIMIT_MPH[cls] * MPH)
            tagged.append(False)
        else:
            # OSRM's car profile drives ~80% of the limit; invert and round to 5 mph.
            est = np.clip(np.round(osrm_speed[i] / 0.8 / MPH / 5) * 5, 15, 70)
            limits.append(float(est) * MPH if osrm_speed[i] > 0 else FALLBACK_LIMIT_MPH * MPH)
            tagged.append(False)
        hw.append(cls)

    return Route(
        lat=coords[:, 1], lon=coords[:, 0], seg_dist=seg_dist,
        seg_limit_mps=np.array(limits), seg_limit_tagged=np.array(tagged),
        seg_highway=hw, osrm_duration_s=float(r["duration"]),
    )


# --------------------------------------------------------------------------- resample

@dataclass
class Profile:
    """Route resampled at uniform spacing ds. Arrays have length N+1 (nodes)."""
    s: np.ndarray  # distance from start [m]
    lat: np.ndarray
    lon: np.ndarray
    limit_mps: np.ndarray  # speed limit at each node
    limit_tagged: np.ndarray  # bool
    elevation_m: np.ndarray | None = None  # smoothed
    elevation_raw_m: np.ndarray | None = None
    grade: np.ndarray | None = None  # (N,) per segment i -> i+1

    @property
    def ds(self) -> float:
        return float(self.s[1] - self.s[0])


def resample(rt: Route, ds: float = 25.0) -> Profile:
    cum = np.concatenate([[0.0], np.cumsum(rt.seg_dist)])
    n = max(2, int(np.ceil(cum[-1] / ds)))
    s = np.linspace(0.0, cum[-1], n + 1)  # spacing ~ds, ends exactly on the route
    lat = np.interp(s, cum, rt.lat)
    lon = np.interp(s, cum, rt.lon)
    # Segment index for each sample (which original segment contains s).
    seg = np.clip(np.searchsorted(cum, s, side="right") - 1, 0, len(rt.seg_dist) - 1)
    limit = rt.seg_limit_mps[seg]
    # Be conservative near limit changes: a node takes the lower of its two neighbors.
    seg_prev = np.clip(np.searchsorted(cum, s, side="left") - 1, 0, len(rt.seg_dist) - 1)
    limit = np.minimum(limit, rt.seg_limit_mps[seg_prev])
    return Profile(s=s, lat=lat, lon=lon, limit_mps=limit, limit_tagged=rt.seg_limit_tagged[seg])
