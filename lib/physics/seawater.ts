// Physical properties of the water a vehicle moves through. SI units.
// These are deliberately simple, documented approximations (docs/PHYSICS.md section 3), good to well under one
// percent in density over the ranges the environments use; they are not TEOS-10.

export const G = 9.80665; // m/s^2, standard gravity

export interface WaterState {
  /** in-situ temperature, deg C */
  temperatureC: number;
  /** practical salinity, PSU (0 for fresh water, about 35 for the open ocean) */
  salinityPsu: number;
  /** depth below the surface, m */
  depthM: number;
}

/**
 * Density, kg/m^3. Linear equation of state about (10 C, 35 PSU, surface) plus a bulk compressibility term:
 *   rho = rho0 (1 - alpha (T - T0) + beta (S - S0)) (1 + p / K)
 * alpha = 1.7e-4 /K, beta = 7.6e-4 /PSU, K = 2.2e9 Pa. Gives 998.8 for fresh water at 15 C and 1026.1 for 35 PSU at
 * 15 C at the surface; real values are 999.1 and 1025.9. Representative, not a substitute for TEOS-10.
 */
export function waterDensity(s: WaterState): number {
  const rho0 = 1027;
  const T = Number.isFinite(s.temperatureC) ? s.temperatureC : 10;
  const S = Math.max(0, Number.isFinite(s.salinityPsu) ? s.salinityPsu : 35);
  const p = Math.max(0, Number.isFinite(s.depthM) ? s.depthM : 0) * rho0 * G; // gauge pressure, Pa
  return rho0 * (1 - 1.7e-4 * (T - 10) + 7.6e-4 * (S - 35)) * (1 + p / 2.2e9);
}

/** Absolute pressure at depth, Pa (atmosphere 101325 Pa plus hydrostatic head). */
export const pressureAt = (depthM: number, rho: number) => 101325 + rho * G * Math.max(0, depthM);

/**
 * Kinematic viscosity of water, m^2/s. Fit to tabulated fresh-water values from 0 to 40 C (1.79e-6 at 0 C, 1.00e-6 at
 * 20 C), with salinity raising it by about 5 percent at 35 PSU. Used only for Reynolds numbers in telemetry.
 */
export function kinematicViscosity(s: WaterState): number {
  const T = Math.min(40, Math.max(0, Number.isFinite(s.temperatureC) ? s.temperatureC : 10));
  const fresh = 1.79e-6 / (1 + 0.0337 * T + 0.000221 * T * T);
  return fresh * (1 + 0.0014 * Math.max(0, s.salinityPsu));
}
