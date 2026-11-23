// Longitudinal vehicle + fuel model. Mirrors src/eco_drive/vehicle.py exactly;
// tests/planner.test.mjs checks parity against Python's golden output.

export const G = 9.81;
export const RHO_AIR = 1.2;
export const LHV_J_PER_G = 43_400;
export const G_PER_GALLON = 2_820;
export const M_PER_MILE = 1609.344;
export const MPH = 0.44704;

export const SPORTAGE = Object.freeze({
  name: "2026 Kia Sportage EX 2.5L FWD",
  massKg: 1650 + 80,
  rotFactor: 1.04,
  cdaM2: 0.85,
  crr: 0.009,
  idleGps: 0.30,
  etaMarginal: 0.30,
  engineBrakeN: 400,
  fuelCutMinMps: 5.0,
  maxWheelPowerW: 120_000,
});

/** Wheel force [N] at speed v, accel a, grade (rise/run). */
export function tractiveForce(veh, v, a, grade) {
  const th = Math.atan(grade);
  return veh.massKg * veh.rotFactor * a
    + veh.massKg * G * Math.sin(th)
    + veh.crr * veh.massKg * G * Math.cos(th)
    + 0.5 * RHO_AIR * veh.cdaM2 * v * v;
}

/** Fuel flow [g/s]: Willans line when pushing, fuel cut when braking past engine drag, else idle. */
export function fuelRate(veh, force, v) {
  if (force <= -veh.engineBrakeN && v >= veh.fuelCutMinMps) return 0;
  const p = force * v;
  return veh.idleGps + (p > 0 ? p / (veh.etaMarginal * LHV_J_PER_G) : 0);
}

/**
 * Moving ds meters from v0 to v1 at constant acceleration.
 * Returns {fuel [g], dt [s], a [m/s^2], power [W]}; dt = Infinity if both speeds are 0.
 */
export function segmentCost(veh, v0, v1, ds, grade) {
  const vsum = v0 + v1;
  if (vsum <= 0) return { fuel: Infinity, dt: Infinity, a: 0, power: 0 };
  const dt = (2 * ds) / vsum;
  const a = (v1 * v1 - v0 * v0) / (2 * ds);
  const vm = 0.5 * vsum;
  const f = tractiveForce(veh, vm, a, grade);
  return { fuel: fuelRate(veh, f, vm) * dt, dt, a, power: f * vm };
}

export function mpg(fuelG, distanceM) {
  return fuelG <= 0 ? Infinity : (distanceM / M_PER_MILE) / (fuelG / G_PER_GALLON);
}
