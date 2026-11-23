# eco-drive

Fuel-smart speed plans for a driving route, for a 2026 Kia Sportage EX (2.5L, FWD).
Search a start and a destination; it compares Google's route options, reads the hills,
speed limits and live traffic, and finds the speed for each stretch that saves the most
gas for the time it costs. Then it guides you along the route with GPS.

## Web app

**https://harshmuriki.github.io/eco-drive/**

Static site in `docs/`, served by GitHub Pages. Everything runs in your browser.

### Your Google Maps API key

The app uses your own key. You type it once into the page; it's kept in that browser's
storage and is never committed or sent anywhere except Google.

1. In Google Cloud Console, create a project and an API key.
2. Enable **Maps JavaScript API**, **Places API (New)**, **Routes API** and **Elevation API**.
3. Restrict the key to these websites: `https://harshmuriki.github.io/*` (and
   `http://localhost:*/*` and `http://127.0.0.1:*/*` for local testing). Also restrict it
   to those four APIs.
4. Set a budget alert. Traffic-aware routes bill as Compute Routes Pro (5k free per
   month), and Elevation has 5k free per month. Personal use stays well inside both.

A browser key is always visible to someone inspecting the page. The website restriction
is what keeps others from using it.

### How a search works

1. **Routes:** Google `Route.computeRoutes` with live traffic and alternatives.
2. **Elevation:** Google Elevation every ~50 m, then Savitzky–Golay smoothing over 250 m,
   then grade.
3. **Speed limits:** OpenStreetMap via Overpass, with one query for all alternatives.
   Limits are matched to Google's path by geometry: the nearest road heading the same way
   as the route, within 35°. Cross streets and frontage roads don't steal the match.
   If Overpass is down, limits are estimated from Google's no-traffic road speeds, and the
   app says so.
4. **Traffic:** Google labels stretches NORMAL / SLOW / TRAFFIC_JAM but gives no speeds.
   SLOW is capped at k × limit and JAM at k/2 × limit. k is solved so the caps reproduce
   Google's total traffic delay.
5. **Planning** runs in a Web Worker (`docs/js/planner.js`): distance-domain DP over
   speed, a λ sweep for the fuel-vs-time curve, and the knee as the recommendation. It is
   a port of the Python planner and is tested number-for-number against it.

**Bridges and tunnels:** terrain data measures the ground, so it shows a dip under every
bridge and a hump over every tunnel. Where the matched OSM road is tagged `bridge` or
`tunnel`, elevation is replaced with a straight line between the two ends before
smoothing (`docs/js/terrain.js`). On the demo route this removed a 6.6 m fake dip at
mi 1.1 that had been showing up as a >6% grade on a fast road.

**Start** follows your GPS along the chosen plan: target speed, your speed, the posted
limit, the next change, and time left. **Spoken cues** (`docs/js/voice.js`, the browser's
built-in speech) announce each change about 12 s ahead, e.g. "In half a mile, ease off to
45. Hill ahead." They also cover going off route, slow traffic and arrival. There's at
most one cue per 4 s, each cue is phrased relative to the last one spoken so they never
contradict, and there's a mute button. **Simulate** replays the drive at 10× for testing
at a desk.

Local dev server with caching off: `python3 scripts/serve.py`, then open http://localhost:8765.


## Python planner (reference + CLI)

```bash
uv run eco-drive plan "Georgia Institute of Technology, Atlanta" "Stone Mountain Park, GA" --out reports/trip.html
```

This uses free keyless services (Nominatim, OSRM, Overpass, OpenTopoData USGS 10 m) and
writes an HTML report to `reports/`, which is gitignored because it holds your trip's
coordinates. It is the reference implementation. `scripts/export_golden.py` writes
`tests/golden.json`, which the JS planner must reproduce.

See [SCOPE.md](SCOPE.md) for the formulation, assumptions and known gaps.

## Tests

```bash
uv run pytest            # Python physics, optimizer, instructions
node --test tests/*.mjs  # JS parity with Python, limit matching, traffic calibration,
                         # end-to-end pipeline with mocked Google, GPS route matching
```
