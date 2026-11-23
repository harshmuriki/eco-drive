// Elevation corrections that need road knowledge, applied before smoothing.

/**
 * Replace elevation over bridges and tunnels with a straight line between the
 * road heights at each end. Terrain models measure the ground: under a bridge
 * that's the valley floor (a fake dip), over a tunnel it's the hill (a fake hump).
 *
 * elev: Float64Array of raw elevations per sample
 * structure: Uint8Array per sample, 0 ground / 1 bridge / 2 tunnel
 * mergeGap: join spans separated by <= this many ground samples (matching flicker)
 * pad: also replace this many samples on each side (DEM blur at the abutments)
 * Returns {elev, spans: [{a, b, kind, deltaM}]}; deltaM = largest correction in the span.
 */
export function flattenStructures(elev, structure, { mergeGap = 2, pad = 1, minLen = 2 } = {}) {
  const n = elev.length;
  const out = Float64Array.from(elev);
  // collect runs
  const runs = [];
  for (let i = 0; i < n; i++) {
    if (!structure[i]) continue;
    const last = runs[runs.length - 1];
    if (last && i - last.b - 1 <= mergeGap) last.b = i;
    else runs.push({ a: i, b: i, kind: structure[i] === 2 ? "tunnel" : "bridge" });
  }
  const spans = [];
  for (const r of runs) {
    if (r.b - r.a + 1 < minLen) continue;
    const a = Math.max(0, r.a - pad - 1), b = Math.min(n - 1, r.b + pad + 1); // anchors on solid ground
    if (b - a < 2) continue;
    let deltaM = 0;
    for (let i = a + 1; i < b; i++) {
      const v = elev[a] + ((elev[b] - elev[a]) * (i - a)) / (b - a);
      deltaM = Math.max(deltaM, Math.abs(v - elev[i]));
      out[i] = v;
    }
    spans.push({ a, b, kind: r.kind, deltaM });
  }
  return { elev: out, spans };
}
