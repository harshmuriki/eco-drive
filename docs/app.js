import { buildIndex, match, pointAt, valueAt, guidance, OFF_ROUTE_M } from "./match.js";

const MPH = 0.44704;
const M_PER_MI = 1609.344;
const STORE_KEY = "eco-drive-plan-v1";
const SIM_SPEEDUP = 10;
const SIM_TICK_MS = 200;
const TRAFFIC_GAP_MPH = 12; // this much under target...
const TRAFFIC_HOLD_S = 15; // ...for this long => "drive with the flow"

const $ = (id) => document.getElementById(id);
const shortPlace = (s) => s.split(",").slice(0, 2).join(",").trim();
const pct = (x) => (x > 0 ? "+" : x < 0 ? "−" : "±") + Math.abs(x * 100).toFixed(1) + "%";

const state = {
  data: null, isDemo: true, planIdx: 0, idx: null, tCum: null,
  mode: null, watchId: null, simTimer: null, wakeLock: null,
  hint: null, offCount: 0, lastS: null, lastT: null, speedMps: null, trafficSince: null,
};

// ------------------------------------------------------------------ loading

function validate(d) {
  if (!d || d.format !== 1 || !d.route?.s_m?.length || !d.plans?.length) {
    throw new Error("This file is not an eco-drive plan (expected format 1). Make it with `eco-drive plan`.");
  }
  return d;
}

function store(text) {
  try { localStorage.setItem(STORE_KEY, text); } catch { /* storage full or blocked: plan still works this session */ }
}
function stored() {
  try { return localStorage.getItem(STORE_KEY); } catch { return null; }
}
function unstore() {
  try { localStorage.removeItem(STORE_KEY); } catch { /* ignore */ }
}

async function loadDemo() {
  const res = await fetch("plans/demo.json");
  if (!res.ok) throw new Error(`Could not load the demo route (HTTP ${res.status}).`);
  setData(validate(await res.json()), true);
}

async function init() {
  const saved = stored();
  try {
    if (saved) setData(validate(JSON.parse(saved)), false);
    else await loadDemo();
  } catch (e) {
    unstore();
    try { await loadDemo(); } catch (e2) { showLoadError(e2.message); }
  }
  if (!window.isSecureContext) {
    showLoadError("Location only works over HTTPS. Open this page from its https:// address.");
    $("btn-start").disabled = true;
  }
}

function showLoadError(msg) {
  $("load-error").textContent = msg;
  $("load-error").hidden = !msg;
}

function setData(d, isDemo) {
  state.data = d;
  state.isDemo = isDemo;
  state.idx = buildIndex(d.route);
  selectPlan(d.recommended ?? d.plans.length - 1);
  $("trip-from").textContent = shortPlace(d.meta.start);
  $("trip-to").textContent = "to " + shortPlace(d.meta.end) + (isDemo ? " · demo route" : "");
  $("trip-facts").textContent = `${d.meta.distance_mi.toFixed(1)} mi · ${d.meta.vehicle} · planned ${d.meta.created}`;
  $("btn-demo").hidden = isDemo;
  $("btn-start").disabled = !window.isSecureContext;
  $("btn-sim").disabled = false;
  showLoadError("");
}

function selectPlan(i) {
  state.planIdx = i;
  const plan = state.data.plans[i];
  // cumulative planned time along the route, for "min left"
  const S = state.data.route.s_m, v = plan.v_mph;
  const t = new Float64Array(S.length);
  for (let k = 1; k < S.length; k++) {
    const vm = Math.max(0.5, ((v[k - 1] + v[k]) / 2) * MPH);
    t[k] = t[k - 1] + (S[k] - S[k - 1]) / vm;
  }
  state.tCum = t;
  renderPlans();
}

function renderPlans() {
  const d = state.data;
  $("plans").innerHTML = "";
  d.plans.forEach((p, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "plan";
    b.id = `plan-${i}`;
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", String(i === state.planIdx));
    const meta = i === 0
      ? `${p.time_min.toFixed(1)} min · ${p.mpg.toFixed(1)} MPG · reference`
      : `${p.time_min.toFixed(1)} min · ${p.mpg.toFixed(1)} MPG · ${pct(p.d_fuel)} fuel · ${pct(p.d_time)} time`;
    b.innerHTML = `<b></b><span class="tag">${i === d.recommended && p.name !== "Recommended" ? "Recommended" : ""}</span><span class="meta">${meta}</span>`;
    b.querySelector("b").textContent = p.name;
    b.addEventListener("click", () => selectPlan(i));
    $("plans").appendChild(b);
  });
}

$("file").addEventListener("change", (ev) => {
  const f = ev.target.files?.[0];
  if (!f) return;
  const r = new FileReader();
  r.onload = () => {
    try {
      const d = validate(JSON.parse(r.result));
      store(r.result);
      setData(d, false);
    } catch (e) {
      showLoadError(e instanceof SyntaxError ? "That file isn't valid JSON." : e.message);
    }
    ev.target.value = "";
  };
  r.onerror = () => showLoadError("Couldn't read that file. Try opening it again.");
  r.readAsText(f);
});

$("btn-demo").addEventListener("click", async () => {
  unstore();
  try { await loadDemo(); } catch (e) { showLoadError(e.message); }
});

// ------------------------------------------------------------------ drive session

async function keepAwake() {
  try { state.wakeLock = await navigator.wakeLock?.request("screen"); } catch { /* not supported or refused */ }
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.mode) keepAwake();
});

function startDrive(mode) {
  Object.assign(state, { mode, hint: null, offCount: 0, lastS: null, lastT: null, speedMps: null, trafficSince: null });
  $("setup").hidden = true;
  $("drive").hidden = false;
  $("sim-badge").hidden = mode !== "sim";
  $("target").textContent = "—";
  $("you").textContent = "—";
  $("limit").textContent = "—";
  $("next").innerHTML = "&nbsp;";
  $("note").innerHTML = "&nbsp;";
  setStatus(mode === "sim" ? "Simulated GPS" : "Waiting for GPS…");
  keepAwake();

  if (mode === "gps") {
    state.watchId = navigator.geolocation.watchPosition(
      (pos) => onFix({
        lat: pos.coords.latitude, lon: pos.coords.longitude,
        speed: pos.coords.speed, accuracy: pos.coords.accuracy, t: pos.timestamp / 1000,
      }),
      (err) => setStatus(
        err.code === 1
          ? "Location is blocked. Allow it for this site in your browser settings."
          : "GPS signal lost. Targets resume when it's back.",
        true,
      ),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 },
    );
  } else {
    startSim();
  }
}

function endDrive() {
  if (state.watchId != null) navigator.geolocation.clearWatch(state.watchId);
  clearInterval(state.simTimer);
  state.wakeLock?.release?.().catch(() => {});
  Object.assign(state, { mode: null, watchId: null, simTimer: null, wakeLock: null });
  $("drive").hidden = true;
  $("setup").hidden = false;
}

$("btn-start").addEventListener("click", () => startDrive("gps"));
$("btn-sim").addEventListener("click", () => startDrive("sim"));
$("btn-end").addEventListener("click", endDrive);

// Simulator: drives the selected plan at 10x speed with ~6 m GPS noise.
function startSim() {
  const route = state.data.route, plan = state.data.plans[state.planIdx];
  let s = 0, t = 0;
  const noise = () => (Math.random() - 0.5) * 0.00012;
  state.simTimer = setInterval(() => {
    const dt = (SIM_TICK_MS / 1000) * SIM_SPEEDUP;
    const v = valueAt(route, plan.v_mph, s) * MPH;
    s = Math.min(state.idx.total, s + Math.max(v, 2) * dt);
    t += dt;
    const [lat, lon] = pointAt(route, s);
    const done = s >= state.idx.total;
    onFix({ lat: lat + noise(), lon: lon + noise(), speed: done ? 0 : v * (1 + (Math.random() - 0.5) * 0.04), accuracy: 6, t });
    if (done) clearInterval(state.simTimer);
  }, SIM_TICK_MS);
}

// ------------------------------------------------------------------ per-fix update

function setStatus(text, bad = false) {
  $("status").textContent = text;
  $("status").classList.toggle("bad", bad);
}

function onFix({ lat, lon, speed, accuracy, t }) {
  const { data, idx } = state;
  const route = data.route, plan = data.plans[state.planIdx];
  const m = match(idx, lat, lon, state.hint);

  if (m.dist > OFF_ROUTE_M) {
    state.offCount += 1;
    if (state.offCount >= 3) state.hint = null; // search the whole route next time
    setStatus(`Off route · ${Math.round(m.dist)} m from the planned road`, true);
    $("target-wrap").classList.add("dim");
    $("target").textContent = "—";
    $("next").textContent = "Targets resume when you're back on the route.";
    $("note").innerHTML = "&nbsp;";
    return;
  }
  state.offCount = 0;
  state.hint = m.seg;
  const s = m.s;

  // Speed: prefer the GPS chip's Doppler speed; otherwise derive from progress.
  let v = speed != null && speed >= 0 ? speed : null;
  if (v == null && state.lastS != null && t - state.lastT > 0.5) v = Math.max(0, (s - state.lastS) / (t - state.lastT));
  if (v != null) state.speedMps = state.speedMps == null ? v : 0.5 * state.speedMps + 0.5 * v;
  state.lastS = s; state.lastT = t;
  const mph = state.speedMps == null ? null : state.speedMps / MPH;

  // GPS lags 1-2 s: look a little ahead so changes show up on time.
  const g = guidance(plan, s, Math.max(30, (state.speedMps ?? 0) * 2));
  const limit = route.limit_mph[Math.min(m.seg, route.limit_mph.length - 1)];
  // Stretches are merged for readability and can span a short lower-limit piece:
  // never show a target above the posted limit where you actually are.
  const target = Math.min(g.current.target_mph, limit);
  const arrived = s > idx.total - 40;

  // Traffic: well under target for a while => don't nag, drive with the flow.
  if (mph != null && mph > 2 && target - mph > TRAFFIC_GAP_MPH && !arrived) {
    state.trafficSince ??= t;
  } else {
    state.trafficSince = null;
  }
  const inTraffic = state.trafficSince != null && t - state.trafficSince > TRAFFIC_HOLD_S;

  $("target-wrap").classList.toggle("dim", inTraffic || arrived);
  $("target").textContent = arrived ? "0" : String(target);
  $("target-label").textContent = inTraffic ? "Target (paused)" : "Target";
  $("limit").textContent = String(limit);
  const you = $("you");
  you.textContent = mph == null ? "—" : String(Math.round(mph));
  you.classList.toggle("over", mph != null && mph > target + 3);
  you.classList.toggle("ok", !(mph != null && mph > target + 3));

  if (arrived) {
    $("next").textContent = "You've arrived.";
  } else if (g.next) {
    const d = g.toNext;
    const dist = d < 0.1 * M_PER_MI ? `${Math.round(d * 3.28084 / 50) * 50} ft` : `${(d / M_PER_MI).toFixed(1)} mi`;
    const verb = g.next.target_mph === 0 ? "Stop ahead" : `${g.next.action} ${g.next.target_mph}`;
    $("next").innerHTML = `${verb} <span class="dist">in ${dist}</span>`;
  } else {
    $("next").textContent = `Hold ${target} to the destination`;
  }
  $("note").innerHTML = inTraffic ? "Traffic is slower than the plan. Drive with the flow." : "&nbsp;";

  const left = Math.max(0, state.tCum[state.tCum.length - 1] - valueAt(route, state.tCum, s)) / 60;
  $("bar").style.width = `${Math.min(100, (100 * s) / idx.total).toFixed(1)}%`;
  $("progress").textContent = `mi ${(s / M_PER_MI).toFixed(1)} of ${(idx.total / M_PER_MI).toFixed(1)} · ${left.toFixed(0)} min left on plan`;
  if (state.mode === "gps") setStatus(`GPS ±${Math.round(accuracy)} m`);
}

init();
