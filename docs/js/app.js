// Eco Drive: Google Maps search + routes, browser-side fuel planning, live navigation.
import { resamplePath, buildProfile, waysForRoutes } from "./routeplan.js";
import { drawChart } from "./chart.js";
import { buildIndex, match, pointAt, valueAt, guidance, OFF_ROUTE_M } from "./match.js";
import { MPH, M_PER_MILE, G_PER_GALLON } from "./physics.js";
import { lamToDollarsPerHour } from "./planner.js";

const $ = (id) => document.getElementById(id);
const KEY_STORE = "eco-drive-gmaps-key";
const GAS_STORE = "eco-drive-gas-price";
const ROUTE_COLORS = { alt: "#8F9A94", altOutline: "#5F6B65", outline: "#00492F", slow: "#E8890C", jam: "#C9302C" };
const pct = (x) => (x > 0 ? "+" : x < 0 ? "−" : "±") + Math.abs(x * 100).toFixed(1) + "%";
const fmtMin = (s) => { const m = Math.round(s / 60); return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`; };

// ------------------------------------------------------------------ storage

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); return true; } catch { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};
const gasPrice = () => Number(store.get(GAS_STORE)) || 3.0;

// ------------------------------------------------------------------ toast

let toastTimer;
function toast(msg, { error = false, ms = 5000 } = {}) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.toggle("error", error);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

// ------------------------------------------------------------------ Google loader (official bootstrap)

function loadGoogle(key) {
  /* eslint-disable */
  (g=>{var h,a,k,p="The Google Maps JavaScript API",c="google",l="importLibrary",q="__ib__",m=document,b=window;b=b[c]||(b[c]={});var d=b.maps||(b.maps={}),r=new Set,e=new URLSearchParams,u=()=>h||(h=new Promise(async(f,n)=>{await (a=m.createElement("script"));e.set("libraries",[...r]+"");for(k in g)e.set(k.replace(/[A-Z]/g,t=>"_"+t[0].toLowerCase()),g[k]);e.set("callback",c+".maps."+q);a.src=`https://maps.${c}apis.com/maps/api/js?`+e;d[q]=f;a.onerror=()=>h=n(Error(p+" could not load."));a.nonce=m.querySelector("script[nonce]")?.nonce||"";m.head.append(a)}));d[l]?console.warn(p+" only loads once. Ignoring:",g):d[l]=(f,...n)=>r.add(f)&&u().then(()=>d[l](f,...n))})({ key, v: "weekly" });
  /* eslint-enable */
}

window.gm_authFailure = () => {
  toast("Google rejected this API key. Check that it's correct, the four APIs are enabled, and this site is allowed in its restrictions.", { error: true, ms: 15000 });
  openSettings();
};

// ------------------------------------------------------------------ state

const S = {
  map: null, G: {}, elevation: null, worker: null, jobId: 0,
  origin: null, dest: null,
  routes: [], // {google, rs, profile, result, polylines[], status, progress}
  sel: 0, planSel: null,
  markers: { start: null, end: null, scrub: null, me: null },
  nav: null,
};

// ------------------------------------------------------------------ boot

async function boot() {
  const key = store.get(KEY_STORE);
  if (!key) { $("onboard").hidden = false; return; }
  $("app").hidden = false;
  loadGoogle(key);
  try {
    const [maps, marker, places, routes, elevation, core] = await Promise.all([
      google.maps.importLibrary("maps"), google.maps.importLibrary("marker"), google.maps.importLibrary("places"),
      google.maps.importLibrary("routes"), google.maps.importLibrary("elevation"), google.maps.importLibrary("core"),
    ]);
    // "maps" holds Map and Polyline; spread it last so nothing else shadows them.
    S.G = { ...core, ...marker, ...places, ...routes, ...elevation, ...maps };
    if (typeof S.G.Polyline !== "function") S.G.Polyline = google.maps.Polyline;
  } catch (e) {
    toast(`Couldn't load Google Maps: ${e.message}`, { error: true, ms: 15000 });
    return;
  }
  const opts = {
    center: { lat: 33.7756, lng: -84.3963 }, zoom: 11, mapId: "DEMO_MAP_ID",
    disableDefaultUI: true, zoomControl: false, clickableIcons: false, gestureHandling: "greedy",
  };
  if (S.G.ColorScheme) opts.colorScheme = S.G.ColorScheme.FOLLOW_SYSTEM;
  S.map = new S.G.Map($("map"), opts);
  S.elevation = new S.G.ElevationService();
  S.worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  S.worker.onmessage = onWorker;
  setupSearch();
  setupSheet();
}

$("key-form").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const k = $("key-input").value.trim();
  if (!k) return;
  if (!store.set(KEY_STORE, k)) { $("key-input").setCustomValidity("This browser blocked storage. Allow site data and try again."); $("key-input").reportValidity(); return; }
  location.reload();
});

// ------------------------------------------------------------------ settings

function openSettings() {
  const k = store.get(KEY_STORE) ?? "";
  $("set-key").value = k;
  $("set-gas").value = gasPrice().toFixed(2);
  $("settings").showModal();
}
$("btn-settings").addEventListener("click", openSettings);
$("settings").addEventListener("close", () => {
  if ($("settings").returnValue !== "save") return;
  const oldKey = store.get(KEY_STORE);
  const k = $("set-key").value.trim();
  const g = Number($("set-gas").value);
  if (g > 0) store.set(GAS_STORE, String(g));
  if (k && k !== oldKey) { store.set(KEY_STORE, k); location.reload(); return; }
  renderRoutes();
  renderDetail();
});
$("set-clear").addEventListener("click", () => { store.del(KEY_STORE); location.reload(); });

// ------------------------------------------------------------------ search

function makeAutocomplete(box, placeholder, onPick) {
  const ac = new S.G.PlaceAutocompleteElement({ includedRegionCodes: ["us"] });
  try { ac.placeholder = placeholder; } catch { /* older builds */ }
  ac.setAttribute("placeholder", placeholder);
  box.appendChild(ac);
  ac.addEventListener("gmp-select", async ({ placePrediction }) => {
    try {
      const place = placePrediction.toPlace();
      await place.fetchFields({ fields: ["displayName", "formattedAddress", "location"] });
      onPick({ label: place.displayName || place.formattedAddress, lat: place.location.lat(), lng: place.location.lng() });
    } catch (e) {
      toast(`Couldn't look up that place: ${e.message}`, { error: true });
    }
  });
  ac.addEventListener("gmp-error", () => toast("Place search failed. Is Places API (New) enabled for your key?", { error: true, ms: 9000 }));
  return ac;
}

function setupSearch() {
  makeAutocomplete($("from-box"), "Start", (p) => { S.origin = p; $("btn-here").hidden = true; placePins(); maybeRoute(); });
  makeAutocomplete($("to-box"), "Destination", (p) => { S.dest = p; placePins(); maybeRoute(); });
  $("btn-here").addEventListener("click", () => {
    if (!navigator.geolocation) return toast("This browser can't share location.", { error: true });
    $("btn-here").disabled = true;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        S.origin = { label: "My location", lat: pos.coords.latitude, lng: pos.coords.longitude };
        $("btn-here").innerHTML = "✓ Starting from your location";
        placePins(); maybeRoute();
      },
      (err) => {
        $("btn-here").disabled = false;
        toast(err.code === 1 ? "Location is blocked for this site. Type a start address instead." : "Couldn't get your location.", { error: true });
      },
      { enableHighAccuracy: true, timeout: 15000 },
    );
  });
}

function pin(cls) { const d = document.createElement("div"); d.className = cls; return d; }

function placePins() {
  const { AdvancedMarkerElement } = S.G;
  for (const [k, p, cls] of [["start", S.origin, "pin pin-start"], ["end", S.dest, "pin pin-end"]]) {
    if (!p) continue;
    if (!S.markers[k]) S.markers[k] = new AdvancedMarkerElement({ map: S.map, content: pin(cls) });
    S.markers[k].position = { lat: p.lat, lng: p.lng };
  }
  if (S.origin && !S.dest) S.map.panTo(S.origin);
  if (S.dest && !S.origin) S.map.panTo(S.dest);
}

// ------------------------------------------------------------------ routing + planning

async function maybeRoute() {
  if (!S.origin || !S.dest) return;
  const job = ++S.jobId;
  clearRoutes();
  setSheet("half");
  $("sheet-empty").textContent = "Finding routes…";
  $("sheet-empty").hidden = false;

  let routes;
  try {
    ({ routes } = await S.G.Route.computeRoutes({
      origin: { lat: S.origin.lat, lng: S.origin.lng },
      destination: { lat: S.dest.lat, lng: S.dest.lng },
      travelMode: "DRIVING",
      routingPreference: "TRAFFIC_AWARE",
      computeAlternativeRoutes: true,
      extraComputations: ["TRAFFIC_ON_POLYLINE"],
      fields: ["path", "distanceMeters", "durationMillis", "staticDurationMillis", "legs", "travelAdvisory"],
    }));
  } catch (e) {
    $("sheet-empty").textContent = "Couldn't get routes.";
    toast(`Routes failed: ${e.message}. Is the Routes API enabled for your key?`, { error: true, ms: 12000 });
    return;
  }
  if (job !== S.jobId) return;
  if (!routes?.length) { $("sheet-empty").textContent = "No driving route found between those places."; return; }
  $("sheet-empty").hidden = true;

  S.routes = routes.slice(0, 3).map((g) => ({ google: g, rs: resamplePath(g.path), status: "terrain", progress: 0 }));
  S.sel = 0;
  S.planSel = null;
  drawRoutes();
  fitRoutes();
  renderRoutes();
  renderDetail();

  // One Overpass request covers every alternative; it runs alongside the elevation requests.
  const waysP = waysForRoutes(S.routes.map((r) => r.rs));
  waysP.then((ways) => {
    if (!ways && job === S.jobId) toast("OpenStreetMap speed limits aren't responding, so limits are estimated from Google's road speeds.", { ms: 9000 });
  });

  for (const r of S.routes) {
    try {
      r.profile = await buildProfile(r.google, r.rs, waysP, S.elevation);
    } catch (e) {
      r.status = "error";
      r.error = /elevation/i.test(e.message) || e.code ? `Elevation failed (${e.message}). Is the Elevation API enabled?` : e.message;
      renderRoutes();
      continue;
    }
    if (job !== S.jobId) return;
    r.status = "planning";
    drawRoutes();
    renderRoutes();
    r.result = await planInWorker(r.profile, (f) => { r.progress = f; renderProgress(); });
    if (job !== S.jobId) return;
    r.status = r.result ? "done" : "error";
    renderRoutes();
    if (S.routes[S.sel] === r) renderDetail();
  }
}

const pending = new Map();
let msgId = 0; // worker message ids; separate from S.jobId, which marks stale searches
function planInWorker(profile, onProgress) {
  return new Promise((resolve) => {
    const id = ++msgId;
    pending.set(id, { resolve, onProgress });
    S.worker.postMessage({ id, gasPrice: gasPrice(), profile: { s: profile.s, grade: profile.grade, limit: profile.limit } });
  });
}
function onWorker({ data }) {
  const p = pending.get(data.id);
  if (!p) return;
  if (data.progress != null) p.onProgress(data.progress);
  if (data.result) { pending.delete(data.id); p.resolve(data.result); }
  if (data.error) { pending.delete(data.id); toast(`Planning failed: ${data.error}`, { error: true }); p.resolve(null); }
}

function clearRoutes() {
  for (const r of S.routes) for (const pl of r.polylines ?? []) pl.setMap(null);
  S.routes = [];
  $("routes").innerHTML = "";
  $("detail").hidden = true;
  $("sheet-actions").hidden = true;
  S.markers.scrub && (S.markers.scrub.map = null);
}

// ------------------------------------------------------------------ map drawing

function drawRoutes() {
  const { Polyline } = S.G;
  S.routes.forEach((r, k) => {
    for (const pl of r.polylines ?? []) pl.setMap(null);
    r.polylines = [];
    const path = Array.from(r.rs.lat, (la, i) => ({ lat: la, lng: r.rs.lon[i] }));
    const selected = k === S.sel;
    const add = (pts, color, weight, z) => {
      const pl = new Polyline({ map: S.map, path: pts, strokeColor: color, strokeWeight: weight, strokeOpacity: 1, zIndex: z, clickable: true });
      pl.addListener("click", () => selectRoute(k));
      r.polylines.push(pl);
    };
    if (!selected) {
      add(path, ROUTE_COLORS.altOutline, 9, 1);
      add(path, ROUTE_COLORS.alt, 6, 2);
      return;
    }
    const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#00704A";
    add(path, ROUTE_COLORS.outline, 10, 10);
    // traffic-colored runs on top
    const cat = r.profile?.trafficCat;
    let start = 0;
    const colorOf = (c) => (c === 2 ? ROUTE_COLORS.jam : c === 1 ? ROUTE_COLORS.slow : accent);
    for (let i = 1; i <= path.length; i++) {
      if (i === path.length || (cat && cat[i] !== cat[start])) {
        add(path.slice(start, Math.min(i + 1, path.length)), colorOf(cat ? cat[start] : 0), 7, 11);
        start = i;
      }
    }
  });
}

function fitRoutes() {
  const { LatLngBounds } = S.G;
  const b = new LatLngBounds();
  for (const r of S.routes) for (let i = 0; i < r.rs.lat.length; i += 20) b.extend({ lat: r.rs.lat[i], lng: r.rs.lon[i] });
  const sheetH = $("sheet").getBoundingClientRect().height;
  const wide = innerWidth >= 900;
  S.map.fitBounds(b, { top: 150, bottom: wide ? 30 : sheetH + 20, left: wide ? 450 : 30, right: 30 });
}

function selectRoute(k) {
  if (k === S.sel) return;
  S.sel = k;
  S.planSel = null;
  drawRoutes();
  renderRoutes();
  renderDetail();
}

// ------------------------------------------------------------------ sheet

function setSheet(state) { $("sheet").dataset.state = state; }
function setupSheet() {
  const order = ["peek", "half", "full"];
  let y0 = null;
  const h = $("sheet-handle");
  h.addEventListener("pointerdown", (e) => { y0 = e.clientY; h.setPointerCapture(e.pointerId); });
  h.addEventListener("pointerup", (e) => {
    const dy = e.clientY - (y0 ?? e.clientY);
    const i = order.indexOf($("sheet").dataset.state);
    if (Math.abs(dy) < 8) setSheet(order[(i + 1) % order.length]);
    else setSheet(order[Math.max(0, Math.min(2, i + (dy < 0 ? 1 : -1)))]);
    y0 = null;
  });
  addEventListener("resize", () => { if (S.routes[S.sel]?.profile) renderChart(); });
}

function bestOf(r) { return r.result ? r.result.plans[r.result.recommended] : null; }

function renderRoutes() {
  const box = $("routes");
  const fastest = S.routes.reduce((b, r, i) => (r.google.durationMillis < S.routes[b].google.durationMillis ? i : b), 0);
  let bestMpg = -1, bestIdx = -1;
  S.routes.forEach((r, i) => { const p = bestOf(r); if (p && p.mpg > bestMpg) { bestMpg = p.mpg; bestIdx = i; } });
  box.innerHTML = "";
  S.routes.forEach((r, i) => {
    const g = r.google, rec = bestOf(r), base = r.result?.plans[0];
    const b = document.createElement("button");
    b.type = "button"; b.className = "route"; b.id = `route-${i}`;
    b.setAttribute("role", "radio"); b.setAttribute("aria-checked", String(i === S.sel));
    const traffic = g.durationMillis - g.staticDurationMillis > 120_000;
    const tags = [i === fastest ? "Fastest" : "", i === bestIdx && S.routes.length > 1 ? "Best MPG" : ""].filter(Boolean).join(" · ");
    let sub;
    if (r.status === "error") sub = `<span>${r.error ?? "Couldn't plan this route."}</span>`;
    else if (!rec) sub = `<span>${(g.distanceMeters / M_PER_MILE).toFixed(1)} mi</span><span>${r.status === "terrain" ? "Reading terrain and limits…" : "Planning speeds…"}</span>`;
    else sub = `<span>${(g.distanceMeters / M_PER_MILE).toFixed(1)} mi</span><span>${rec.gallons.toFixed(2)} gal</span><span>${pct(rec.dFuel)} fuel vs. ${base.mpg.toFixed(1)} MPG at the limit</span>`;
    b.innerHTML = `<span class="time${traffic ? " slow" : ""}">${fmtMin(g.durationMillis / 1000)}</span>
      <span class="mpg">${rec ? `${rec.mpg.toFixed(1)} MPG` : ""}</span>
      <span class="sub">${tags ? `<span class="tag">${tags}</span>` : ""}${sub}</span>
      ${r.status === "planning" ? `<span class="bar"><i style="width:${Math.round(r.progress * 100)}%"></i></span>` : ""}`;
    b.addEventListener("click", () => selectRoute(i));
    box.appendChild(b);
  });
}

function renderProgress() {
  S.routes.forEach((r, i) => {
    const bar = document.querySelector(`#route-${i} .bar i`);
    if (bar) bar.style.width = `${Math.round(r.progress * 100)}%`;
  });
}

let chartApi = null;
function renderChart() {
  const r = S.routes[S.sel], res = r.result, p = r.profile;
  const planIdx = S.planSel ?? res?.recommended;
  chartApi = drawChart($("chart"), {
    profile: { s: p.s, elev: p.elev, postedLimit: p.postedLimit, trafficCat: p.trafficCat },
    base: res?.plans[0],
    plan: res && planIdx > 0 ? res.plans[planIdx] : null,
    onScrub: (i) => scrubTo(i),
  });
}

function scrubTo(i) {
  const r = S.routes[S.sel], p = r?.profile;
  if (!p) return;
  if (i == null) { $("readout").textContent = "Drag across the chart"; if (S.markers.scrub) S.markers.scrub.map = null; return; }
  const res = r.result, plan = res ? res.plans[S.planSel ?? res.recommended] : null;
  const g = i < p.grade.length ? p.grade[i] : p.grade[p.grade.length - 1];
  $("readout").textContent = `mi ${(p.s[i] / M_PER_MILE).toFixed(1)} · ${Math.round(p.elev[i] * 3.28084)} ft · ${(g * 100).toFixed(1)}%` +
    (plan ? ` · ${Math.round(plan.v[i] / MPH)} mph (limit ${Math.round(p.postedLimit[i] / MPH)})` : "");
  if (!S.markers.scrub) S.markers.scrub = new S.G.AdvancedMarkerElement({ content: pin("scrub"), zIndex: 50 });
  S.markers.scrub.map = S.map;
  S.markers.scrub.position = { lat: p.lat[i], lng: p.lon[i] };
}

function renderDetail() {
  const r = S.routes[S.sel];
  if (!r?.profile) { $("detail").hidden = true; $("sheet-actions").hidden = true; return; }
  $("detail").hidden = false;
  const res = r.result, p = r.profile;
  renderChart();
  $("legend-traffic").hidden = !p.trafficCat.some((c) => c > 0);
  if (!res) {
    $("verdict").innerHTML = `<p class="headline">Planning speeds for this route…</p>`;
    $("plans").innerHTML = ""; $("steps").innerHTML = ""; $("notes").innerHTML = "";
    $("sheet-actions").hidden = true;
    return;
  }
  const base = res.plans[0], rec = res.plans[res.recommended];
  const gas = gasPrice();
  const extra = (rec.timeS - base.timeS) / 60;
  const dph = rec.lam != null ? lamToDollarsPerHour(rec.lam, gas) : null;
  $("verdict").innerHTML = `
    <p class="headline">${extra >= 0.1 ? `${extra.toFixed(1)} extra minutes` : "Same arrival time"}, ${Math.abs(rec.dFuel * 100).toFixed(0)}% less gas</p>
    <div class="stats">
      <div><b>${rec.mpg.toFixed(1)}</b><span>MPG (vs ${base.mpg.toFixed(1)})</span></div>
      <div><b>${rec.gallons.toFixed(2)}</b><span>gal (saves ${(base.gallons - rec.gallons).toFixed(2)})</span></div>
      <div><b>$${((base.gallons - rec.gallons) * gas).toFixed(2)}</b><span>saved at $${gas.toFixed(2)}/gal</span></div>
    </div>
    ${dph != null ? `<p class="worth">Best plan if your driving time is worth about $${dph.toFixed(2)}/hour.</p>` : ""}`;

  const planIdx = S.planSel ?? res.recommended;
  $("plans").innerHTML = "";
  res.plans.forEach((pl, i) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "plan"; b.id = `plan-${i}`;
    b.setAttribute("role", "radio"); b.setAttribute("aria-checked", String(i === planIdx));
    b.innerHTML = `${pl.name}${i ? ` <small>${pct(pl.dFuel)}</small>` : ""}`;
    b.addEventListener("click", () => { S.planSel = i; renderDetail(); });
    $("plans").appendChild(b);
  });

  const plan = res.plans[planIdx];
  const est = p.limitSource !== "osm";
  $("steps").innerHTML = plan.stretches.map((st) => {
    const under = st.limit_mph - st.target_mph;
    return `<li><span class="mi">mi ${st.start_mi.toFixed(1)}–${st.end_mi.toFixed(1)}</span>
      <span class="act">${st.action} <b>${st.target_mph} mph</b><small>${under >= 5 ? `${under} under the limit` : "at the limit"}</small></span>
      <span class="sign" aria-label="${est ? "Estimated speed" : "Speed"} limit ${st.limit_mph}"><span>${est ? "EST.<br>LIMIT" : "SPEED<br>LIMIT"}</span><b>${st.limit_mph}</b></span></li>`;
  }).join("");

  const notes = [];
  notes.push(p.limitSource === "osm"
    ? `Speed limits from OpenStreetMap: ${Math.round(p.limitTaggedFrac * 100)}% posted, the rest typical for the road type.`
    : "OpenStreetMap didn't respond, so limits (marked EST.) are conservative estimates from Google's road speeds, capped at 65. Always follow the posted signs.");
  if (p.trafficCat.some((c) => c > 0)) notes.push(`Traffic now: slow stretches are capped so the plan matches Google's delay of ${fmtMin(p.google.durationS - p.google.staticS)}.`);
  else notes.push("No traffic slowdowns reported right now. Lights and stop signs aren't modeled.");
  notes.push("Fuel comes from a physics model of a 2026 Sportage with estimated parameters.");
  $("notes").innerHTML = notes.map((t) => `<li>${t}</li>`).join("");
  $("sheet-actions").hidden = false;
}

// ------------------------------------------------------------------ navigation

$("btn-go").addEventListener("click", () => startNav("gps"));
$("btn-sim").addEventListener("click", () => startNav("sim"));
$("btn-end").addEventListener("click", endNav);

async function keepAwake() { try { S.nav && (S.nav.wake = await navigator.wakeLock?.request("screen")); } catch { /* unsupported */ } }
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && S.nav) keepAwake(); });

function startNav(mode) {
  const r = S.routes[S.sel];
  if (!r?.result) return;
  const p = r.profile, res = r.result;
  const plan = res.plans[S.planSel ?? res.recommended];
  const route = { s_m: p.s, lat: p.lat, lon: p.lon, limit_mph: Array.from(p.postedLimit, (v) => Math.round(v / MPH)) };
  const tCum = new Float64Array(p.s.length);
  for (let k = 1; k < p.s.length; k++) tCum[k] = tCum[k - 1] + (p.s[k] - p.s[k - 1]) / Math.max(0.5, (plan.v[k - 1] + plan.v[k]) / 2);
  S.nav = { mode, route, idx: buildIndex(route), plan, profile: p, tCum, hint: null, off: 0, lastS: null, lastT: null, v: null, trafficSince: null, follow: true };

  $("search").hidden = true; $("sheet").hidden = true; $("nav").hidden = false;
  $("nav-sim").hidden = mode !== "sim";
  document.querySelector("#nav .sign span").innerHTML = p.limitSource === "osm" ? "SPEED<br>LIMIT" : "EST.<br>LIMIT";
  $("nav-status").textContent = mode === "sim" ? "Simulated GPS" : "Waiting for GPS…";
  S.routes.forEach((rr, k) => { if (k !== S.sel) for (const pl of rr.polylines ?? []) pl.setMap(null); });
  if (S.markers.scrub) S.markers.scrub.map = null;
  if (!S.markers.me) S.markers.me = new S.G.AdvancedMarkerElement({ content: pin("me"), zIndex: 100 });
  S.markers.me.map = S.map;
  S.map.setZoom(16);
  S.nav.dragListener = S.map.addListener("dragstart", () => { if (S.nav) S.nav.follow = false; });
  keepAwake();

  if (mode === "gps") {
    S.nav.watch = navigator.geolocation.watchPosition(
      (pos) => onFix({ lat: pos.coords.latitude, lon: pos.coords.longitude, speed: pos.coords.speed, accuracy: pos.coords.accuracy, heading: pos.coords.heading, t: pos.timestamp / 1000 }),
      (err) => { $("nav-status").textContent = err.code === 1 ? "Location is blocked. Allow it for this site in browser settings." : "GPS signal lost. Targets resume when it's back."; $("nav-status").classList.add("bad"); },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 },
    );
  } else {
    let s = 0, t = 0;
    const noise = () => (Math.random() - 0.5) * 0.00012;
    S.nav.sim = setInterval(() => {
      const dt = 2; // 0.2 s real x 10
      const v = valueAt(route, plan.v, s);
      s = Math.min(S.nav.idx.total, s + Math.max(v, 2) * dt);
      t += dt;
      const [la, lo] = pointAt(route, s);
      const done = s >= S.nav.idx.total;
      onFix({ lat: la + noise(), lon: lo + noise(), speed: done ? 0 : v * (1 + (Math.random() - 0.5) * 0.04), accuracy: 6, t });
      if (done) clearInterval(S.nav.sim);
    }, 200);
  }
}

function endNav() {
  if (!S.nav) return;
  if (S.nav.watch != null) navigator.geolocation.clearWatch(S.nav.watch);
  clearInterval(S.nav.sim);
  S.nav.wake?.release?.().catch(() => {});
  S.nav.dragListener?.remove();
  S.nav = null;
  if (S.markers.me) S.markers.me.map = null;
  $("nav").hidden = true; $("search").hidden = false; $("sheet").hidden = false;
  drawRoutes();
  fitRoutes();
}

function onFix({ lat, lon, speed, accuracy, t }) {
  const N = S.nav;
  if (!N) return;
  S.markers.me.position = { lat, lng: lon };
  if (N.follow) S.map.panTo({ lat, lng: lon });

  const m = match(N.idx, lat, lon, N.hint);
  if (m.dist > OFF_ROUTE_M) {
    if (++N.off >= 3) N.hint = null;
    $("nav-status").textContent = `Off route · ${Math.round(m.dist)} m from the planned road`;
    $("nav-status").classList.add("bad");
    $("nav-target-wrap").classList.add("dim");
    $("nav-target").textContent = "—";
    $("nav-next").textContent = "Targets resume when you're back on the route.";
    return;
  }
  N.off = 0; N.hint = m.seg;
  const s = m.s;
  let v = speed != null && speed >= 0 ? speed : null;
  if (v == null && N.lastS != null && t - N.lastT > 0.5) v = Math.max(0, (s - N.lastS) / (t - N.lastT));
  if (v != null) N.v = N.v == null ? v : 0.5 * N.v + 0.5 * v;
  N.lastS = s; N.lastT = t;
  const mph = N.v == null ? null : N.v / MPH;

  const g = guidance(N.plan, s, Math.max(30, (N.v ?? 0) * 2));
  const posted = N.route.limit_mph[Math.min(m.seg, N.route.limit_mph.length - 1)];
  const cap = Math.round(N.profile.limit[Math.min(m.seg, N.profile.limit.length - 1)] / MPH);
  // never show a target above the posted limit or the current traffic cap
  const target = Math.min(g.current.target_mph, posted, Math.max(cap, 5));
  const arrived = s > N.idx.total - 40;

  if (mph != null && mph > 2 && target - mph > 12 && !arrived) N.trafficSince ??= t; else N.trafficSince = null;
  const inTraffic = N.trafficSince != null && t - N.trafficSince > 15;

  $("nav-target-wrap").classList.toggle("dim", inTraffic || arrived);
  $("nav-label").textContent = inTraffic ? "Target (paused)" : "Target";
  $("nav-target").textContent = arrived ? "0" : String(target);
  $("nav-limit").textContent = String(posted);
  $("nav-you").textContent = mph == null ? "—" : String(Math.round(mph));
  $("nav-you").classList.toggle("over", mph != null && mph > target + 3);
  if (arrived) $("nav-next").textContent = "You've arrived.";
  else if (g.next) {
    const d = g.toNext;
    const dist = d < 0.1 * M_PER_MILE ? `${Math.round((d * 3.28084) / 50) * 50} ft` : `${(d / M_PER_MILE).toFixed(1)} mi`;
    $("nav-next").innerHTML = `${g.next.target_mph === 0 ? "Stop ahead" : `${g.next.action} ${Math.min(g.next.target_mph, g.next.limit_mph)}`}<span class="dist">in ${dist}</span>`;
  } else $("nav-next").textContent = `Hold ${target} to the destination`;
  $("nav-note").innerHTML = inTraffic ? "Traffic is slower than the plan. Drive with the flow." : "&nbsp;";
  const left = Math.max(0, N.tCum[N.tCum.length - 1] - valueAt(N.route, N.tCum, s));
  $("nav-left").textContent = fmtMin(left);
  if (N.mode === "gps") { $("nav-status").textContent = `GPS ±${Math.round(accuracy)} m`; $("nav-status").classList.remove("bad"); }
}

boot();
