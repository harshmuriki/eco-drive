# eco-drive

Fuel-smart speed plans for a driving route. Give it a start and a destination; it pulls
the route, speed limits and elevation, then finds the speed for each stretch that trades
fuel against trip time, for a 2026 Kia Sportage EX (2.5L, FWD).

```bash
uv run eco-drive plan "Georgia Institute of Technology, Atlanta" "Stone Mountain Park, GA" --out reports/trip.html
```

Options: `--gas-price 3.00` ($/gal), `--ds 25` (distance step in m). Start/destination
accept addresses, place names, or `"lat,lon"`. Each run writes an HTML report and a
`.plan.json` for the live page. Both go to `reports/`, which is gitignored because
they contain your trip's coordinates.

## Live page (phone)

**https://harshmuriki.github.io/eco-drive/** (static, served from `docs/` by GitHub Pages)

1. Plan the trip on your laptop (above). AirDrop or save the `.plan.json` to your phone.
2. Open the page, tap **Open plan file**, pick the plan. It's stored on the phone only.
3. Mount the phone and tap **Start drive**. The page follows your GPS along the route and
   shows the target speed, your speed, the posted limit, and the next change.

**Simulate** replays the selected plan at 10× with noisy GPS, so you can try it at a desk.
The demo route (Georgia Tech → Stone Mountain Park) loads by default.

How it follows you: GPS fixes are projected onto the route in a window around the last
match (`docs/match.js`). That stops a fix from snapping to a nearby road or the other side
of the highway. More than 75 m away means off route, and targets pause. Targets look a
couple of seconds ahead to cover GPS lag, never exceed the posted limit where you are, and
pause ("drive with the flow") when you've been well under target for 15 s.

Local testing: `python3 -m http.server 8765 --directory docs`, then open http://127.0.0.1:8765.
Location needs HTTPS (or localhost).

Pipeline: Nominatim (geocode) → OSRM (route + OSM node ids) → Overpass (OSM `maxspeed`)
→ OpenTopoData USGS 10 m (elevation) → smoothed grade → distance-domain DP over speed
→ λ sweep (fuel vs. time) → knee = recommended plan → phone-friendly HTML report.

All services are free and keyless; responses are cached in `~/.cache/eco-drive`.
See [SCOPE.md](SCOPE.md) for the formulation, assumptions and known gaps.

```bash
uv run pytest                        # physics, optimizer, instructions
node --test tests/match.test.mjs     # GPS route matching
```
