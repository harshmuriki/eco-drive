# eco-drive — Milestone 1 scope

> Give it a start and a destination. It pulls the route and the elevation along it,
> and tells me how fast to drive on each stretch so I get high MPG without wasting
> much time.

Source brief: `~/Downloads/Trash/eco_driving_research_and_agent_brief.docx` (Oct 2026).

## Decisions (2026-11-23)

| Question | Decision | Why / consequence |
|---|---|---|
| Problem | **Speed plan along a fixed route** (not route choice) | The physics model is the foundation that route choice would reuse later. |
| First milestone | **Real route end-to-end** | Faster to get real feedback. Risk: data bugs and physics bugs look the same (see "Smell test"). |
| Vehicle | **2026 Kia Sportage EX, gas 2.5L, FWD, 8AT** | Lets results be checked against my own trip MPG. |
| EPA validation first | **Skipped** | Replaced with a free smell test: print the implied MPG for every run. |
| Data | **Free, no API keys** | No live traffic, so the plan assumes free-flowing roads. |
| Output | **Claude Artifact (mobile-friendly HTML)** | Opens on my phone. |
| Env | Python 3.11+, `uv` | Per global preferences. |

## Problem formulation

Split the route into distance steps of length Δs ≈ 25–50 m, indexed i = 0..N.

- **State:** speed vᵢ, discretized into bins of about 0.5 m/s.
- **Control:** the speed change between steps, which sets the acceleration
  aᵢ = (vᵢ₊₁² − vᵢ²) / (2Δs).
- **Dynamics (longitudinal):**
  `F_wheel = m·a + m·g·sin θ + C_rr·m·g·cos θ + ½·ρ·CdA·v²`
- **Fuel for one step:** fuel(F_wheel, v, Δt), using a Willans-line approximation:
  - F_wheel > 0: `ṁ_f = ṁ_idle + P_wheel / (η_eff · LHV)`
  - F_wheel ≤ 0: fuel cut-off (ṁ_f ≈ 0) when coasting above about 20 km/h, otherwise idle
  - braking energy is lost (no regeneration on a gas car)
- **Objective:** `J = Σ fuelᵢ + λ · Σ Δtᵢ`
- **Constraints:** v ≤ posted limit (OSM maxspeed, with a fallback by road class);
  a_min ≤ a ≤ a_max (comfort, for example −2 to +1.5 m/s²); v₀ = v_N = 0.
- **Solver:** backward dynamic programming over (i, v). The cost is O(N · V²), which is
  fine for routes up to about 50 km.

### The "good balance" knob

λ is the price of one second in grams of fuel. Rather than asking me for λ, the tool:

1. Computes the **baseline**: drive at the speed limit with comfortable acceleration.
2. Sweeps λ and solves the DP each time, which traces out a **fuel vs. trip-time curve**.
3. Reports the plans at **+0%, +3%, +5% and +10%** trip time relative to the baseline,
   and marks the **knee** (the point where extra fuel savings per extra minute drop off)
   as the recommended plan.

## Data pipeline (no keys)

1. **Geocode:** Nominatim (OSM), at most 1 request/s, generic User-Agent.
2. **Route:** OSRM public server, `overview=full`, `annotations=distance,duration,speed,maxspeed`.
   Light use only, per OSRM's usage policy.
3. **Resample** the route polyline every Δs meters.
4. **Elevation:** OpenTopoData `ned10m` (USGS 10 m), 100 points per request, 1 request/s,
   1000 requests/day. Cache on disk.
5. **Grade:** smooth the elevation (Savitzky–Golay over about 150–250 m), then differentiate
   and clip to |θ| ≤ 15%. Raw DEM data differentiated directly gives meaningless grade.
6. **Speed limits:** OSRM maxspeed annotations, with a fallback table by road class when missing.

## Vehicle parameters (approximate, need checking against Kia specs)

| Param | Initial value | Note |
|---|---|---|
| mass | ~1,650 kg curb + 80 kg driver | check the EX FWD curb weight |
| CdA | ~0.85 m² | Cd ≈ 0.33 × A ≈ 2.6 m², estimate |
| C_rr | 0.009 | typical all-season tire |
| η_eff (tank to wheel, while driving) | ~0.25 | calibrate later |
| idle fuel | ~0.25 g/s | estimate for a 2.5L engine |
| EPA rating | about 25 city / 32 highway | check the 2026 FWD sticker |

## Smell test (in place of the EPA check)

Every run prints **implied MPG** for the baseline and the recommended plan. If the baseline
falls outside about 20–40 MPG, treat the result as a bug until shown otherwise.

## Output: Artifact report (phone-first)

- Summary card: distance, baseline vs. recommended time / fuel / MPG, savings
- Trade-off curve (fuel vs. time) with the knee marked; tap to switch between plans
- Elevation + grade profile vs. distance
- Speed limit vs. baseline vs. recommended speed vs. distance
- Route drawn as an SVG polyline (no external map tiles, which may be blocked in Artifacts)
- A segment table you can read at a glance: "km 3.2–4.1: hold 55 mph, ease off before the crest"
- All data embedded inline; Plotly loaded from cdnjs

## Explicitly out of scope for M1

Live traffic, traffic lights and stop signs (no signal data, so the plan assumes free flow),
route choice, MPC replanning, phone GPS/OBD input, any vehicle actuation.

**Known gap:** without stops, the plan is idealized. On city routes it will overstate
savings. This should be shown in the report, not hidden.

## Repo layout

```
eco-drive/
  pyproject.toml  uv.lock
  src/eco_drive/
    geo.py          # geocode, route, resample (Nominatim + OSRM)
    elevation.py    # OpenTopoData client + cache + grade smoothing
    vehicle.py      # Sportage params, force + fuel model
    baseline.py     # drive-at-limit profile
    dp.py           # distance-domain DP
    tradeoff.py     # λ sweep, knee detection
    report.py       # Artifact HTML
    cli.py          # `eco-drive plan "A" "B"`
  tests/            # physics sanity: flat cruise, energy balance, grade sign, DP ≤ baseline fuel
```

## Done when

`uv run eco-drive plan "<start>" "<destination>"` produces a report.html that I can
publish as an Artifact, the baseline's implied MPG passes the smell test, and the
recommended plan uses less fuel than the baseline while staying within the time budget.
