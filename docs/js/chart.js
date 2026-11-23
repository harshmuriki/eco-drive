// Elevation + speed chart with a scrubber that reports the route index under the finger.
const NS = "http://www.w3.org/2000/svg";
const MPH = 0.44704, M_PER_MI = 1609.344, FT = 3.28084;
const el = (tag, attrs, parent) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  parent?.appendChild(e);
  return e;
};
const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

function niceTicks(lo, hi, n = 4) {
  const span = hi - lo || 1, raw = span / n, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const out = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi + 1e-9; t += step) out.push(+t.toFixed(6));
  return out;
}

/**
 * draw(svg, {profile, base, plan, onScrub}) -> {highlight(i)}
 * profile: {s, elev, postedLimit, trafficCat}; base/plan: {v} in m/s per profile point.
 */
export function drawChart(svg, { profile, base, plan, onScrub }) {
  const W = Math.max(280, svg.clientWidth || svg.parentNode.clientWidth || 360), H = 190;
  const m = { l: 30, r: 34, t: 8, b: 30 };
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.innerHTML = "";
  const n = profile.s.length, step = Math.max(1, Math.floor(n / 420));
  const idx = [];
  for (let i = 0; i < n; i += step) idx.push(i);
  if (idx[idx.length - 1] !== n - 1) idx.push(n - 1);

  const xmax = profile.s[n - 1] / M_PER_MI;
  let vmax = 0, emin = Infinity, emax = -Infinity;
  for (const i of idx) {
    vmax = Math.max(vmax, profile.postedLimit[i] / MPH);
    emin = Math.min(emin, profile.elev[i] * FT); emax = Math.max(emax, profile.elev[i] * FT);
  }
  vmax = Math.ceil((vmax + 5) / 10) * 10;
  const ePad = Math.max(15, (emax - emin) * 0.15);
  const x = (s) => m.l + (s / M_PER_MI / xmax) * (W - m.l - m.r);
  const yv = (mph) => H - m.b - (mph / vmax) * (H - m.t - m.b);
  const ye = (ft) => H - m.b - ((ft - (emin - ePad)) / (emax - emin + 2 * ePad)) * (H - m.t - m.b) * 0.75;

  const g = el("g", {}, svg);
  // grid + axes
  for (const t of niceTicks(0, vmax, 4)) {
    el("line", { x1: m.l, x2: W - m.r, y1: yv(t), y2: yv(t), stroke: css("--line"), "stroke-width": 1, opacity: 0.6 }, g);
    el("text", { x: m.l - 5, y: yv(t) + 3, "text-anchor": "end" }, g).textContent = t;
  }
  for (const t of niceTicks(0, xmax, 4)) el("text", { x: x(t * M_PER_MI), y: H - m.b + 13, "text-anchor": "middle" }, g).textContent = `${t} mi`;
  el("text", { x: m.l - 5, y: m.t + 2, "text-anchor": "end" }, g).textContent = "mph";
  el("text", { x: W - m.r + 4, y: ye(emax) + 3 }, g).textContent = `${Math.round(emax)}′`;
  el("text", { x: W - m.r + 4, y: ye(emin) + 3 }, g).textContent = `${Math.round(emin)}′`;

  // elevation area
  let d = `M${x(0)},${H - m.b}`;
  for (const i of idx) d += `L${x(profile.s[i])},${ye(profile.elev[i] * FT)}`;
  d += `L${x(profile.s[n - 1])},${H - m.b}Z`;
  el("path", { d, fill: css("--terrain"), stroke: "none" }, g);

  // traffic strip
  let run = null;
  const strip = (a, b, c) => el("rect", { x: x(profile.s[a]), y: H - m.b - 4, width: Math.max(1.5, x(profile.s[b]) - x(profile.s[a])), height: 4, fill: c === 2 ? css("--jam") : css("--slow") }, g);
  for (let i = 0; i < n; i++) {
    const c = profile.trafficCat?.[i] ?? 0;
    if (c && !run) run = { a: i, c };
    else if (run && c !== run.c) { strip(run.a, i, run.c); run = c ? { a: i, c } : null; }
  }
  if (run) strip(run.a, n - 1, run.c);

  const line = (arr, scale, attrs) => {
    let p = "";
    idx.forEach((i, k) => { p += `${k ? "L" : "M"}${x(profile.s[i])},${yv(arr[i] / scale)}`; });
    el("path", { d: p, fill: "none", ...attrs }, g);
  };
  line(profile.postedLimit, MPH, { stroke: css("--fg"), "stroke-width": 1.3, "stroke-dasharray": "4 3", opacity: 0.8 });
  if (base) line(base.v, MPH, { stroke: css("--base"), "stroke-width": 1.6 });
  if (plan) line(plan.v, MPH, { stroke: css("--accent"), "stroke-width": 2.4, "stroke-linejoin": "round" });

  // scrubber
  const cursor = el("line", { y1: m.t, y2: H - m.b, stroke: css("--fg"), "stroke-width": 1, opacity: 0 }, g);
  const dot = el("circle", { r: 4, fill: css("--accent"), stroke: css("--surface"), "stroke-width": 2, opacity: 0 }, g);
  const highlight = (i) => {
    if (i == null) { cursor.setAttribute("opacity", 0); dot.setAttribute("opacity", 0); return; }
    const X = x(profile.s[i]);
    cursor.setAttribute("x1", X); cursor.setAttribute("x2", X); cursor.setAttribute("opacity", 0.5);
    dot.setAttribute("cx", X); dot.setAttribute("cy", yv((plan ?? base).v[i] / MPH)); dot.setAttribute("opacity", 1);
  };
  const pick = (ev) => {
    const r = svg.getBoundingClientRect();
    const px = ((ev.clientX - r.left) / r.width) * W;
    const s = Math.max(0, Math.min(1, (px - m.l) / (W - m.l - m.r))) * profile.s[n - 1];
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (profile.s[mid] <= s) lo = mid; else hi = mid; }
    highlight(lo);
    onScrub?.(lo);
  };
  svg.onpointerdown = (ev) => { svg.setPointerCapture(ev.pointerId); pick(ev); };
  svg.onpointermove = (ev) => { if (ev.buttons || ev.pointerType === "mouse") pick(ev); };
  svg.onpointerleave = (ev) => { if (ev.pointerType === "mouse") { highlight(null); onScrub?.(null); } };
  return { highlight };
}
