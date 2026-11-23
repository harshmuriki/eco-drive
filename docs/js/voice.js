// Spoken cues while navigating. Phrasing is pure (tested in node); Speaker wraps
// the browser's built-in speechSynthesis with muting and rate limiting.

const M_PER_MI = 1609.344;

/** "In half a mile" style distance phrase, rounded the way people say it. */
export function distancePhrase(m) {
  const ft = m * 3.28084;
  if (ft < 1000) return `In ${Math.max(100, Math.round(ft / 100) * 100)} feet`;
  const mi = m / M_PER_MI;
  if (mi < 0.375) return "In a quarter mile";
  if (mi < 0.625) return "In half a mile";
  if (mi < 0.875) return "In three quarters of a mile";
  if (mi < 1.25) return "In 1 mile";
  return `In ${(Math.round(mi * 2) / 2).toString()} miles`;
}

/** Mean grade over [s, s + lookM] from per-segment grades. */
export function gradeAhead(s, grade, ds, lookM = 400) {
  const i0 = Math.max(0, Math.floor(s / ds)), i1 = Math.min(grade.length, Math.ceil((s + lookM) / ds));
  if (i1 <= i0) return 0;
  let sum = 0;
  for (let i = i0; i < i1; i++) sum += grade[i];
  return sum / (i1 - i0);
}

/** Cue for an upcoming stretch change. next: {action, target_mph, limit_mph}. */
export function changeCue(next, distM, gradeAfter = 0) {
  const target = Math.min(next.target_mph, next.limit_mph);
  const verb = next.target_mph === 0 ? "prepare to stop" : `${next.action.toLowerCase()} ${target}`;
  let hint = "";
  if (gradeAfter > 0.02) hint = " Hill ahead.";
  else if (gradeAfter < -0.02) hint = " Downhill ahead.";
  return `${distancePhrase(distM)}, ${verb}.${hint}`;
}

/** How far ahead to announce: ~12 s of travel, between 150 m and 800 m. */
export function leadDistance(speedMps) {
  return Math.max(150, Math.min(800, (speedMps ?? 0) * 12));
}

export class Speaker {
  constructor({ storageKey = "eco-drive-voice", minGapMs = 4000 } = {}) {
    this.synth = typeof window !== "undefined" ? window.speechSynthesis : null;
    this.storageKey = storageKey;
    this.minGapMs = minGapMs;
    this.lastAt = 0;
    try { this.muted = localStorage.getItem(storageKey) === "off"; } catch { this.muted = false; }
  }

  get available() { return !!this.synth; }

  setMuted(m) {
    this.muted = m;
    try { localStorage.setItem(this.storageKey, m ? "off" : "on"); } catch { /* ignore */ }
    if (m) this.synth?.cancel();
  }

  /** Speak unless muted or too soon after the last cue (priority cues skip the gap). */
  say(text, { priority = false } = {}) {
    if (!this.synth || this.muted) return false;
    const now = Date.now();
    if (!priority && now - this.lastAt < this.minGapMs) return false;
    this.lastAt = now;
    this.synth.cancel(); // newest cue wins; stale ones are useless while driving
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "en-US";
    u.rate = 1.05;
    this.synth.speak(u);
    return true;
  }
}
