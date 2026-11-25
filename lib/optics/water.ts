// Physically based water optics for the camera's three colour channels.
// Pure TypeScript, no React, no Three. Shared by the renderer (components/lab/water.ts) and, later, detection.
// Sources and licences: docs/RESOURCES.md section 2. Units: metres and m^-1 throughout.

/** A value per camera channel, in R, G, B order. */
export type RGB = readonly [number, number, number];

/**
 * Effective centre wavelengths of the camera's R, G and B channels, nm.
 * Assumption: typical Bayer CMOS response (Sony IMX708 class) peaks near these values.
 */
export const CHANNEL_NM: RGB = [610, 540, 465];

/**
 * Pure water absorption a_w at CHANNEL_NM, m^-1.
 * Pope and Fry 1997, Appl. Opt. 36, 8710, OMLC table pope97.dat (0.002644, 0.000474, 0.0001011 cm^-1).
 */
export const PURE_WATER_ABSORPTION: RGB = [0.2644, 0.0474, 0.01011];

/** Pure water scattering b_w(lambda) = 0.00288 (lambda / 500)^-4.32 m^-1. Morel 1974. Half of it is backward. */
const pureWaterScattering = (nm: number) => 0.00288 * Math.pow(nm / 500, -4.32);

/** Irradiance reflectance of optically deep water, R = f bb / (a + bb) with f = 0.33. Gordon et al. 1975; Morel and Prieur 1977. */
const REFLECTANCE_F = 0.33;

/** Kirk 1984/1991: Kd = sqrt(a^2 + G a b) / mu0, with G = 0.425 mu0 - 0.19. */
export const KIRK_DEFAULT_MU0 = 0.87;
const kirkG = (mu0: number) => 0.425 * mu0 - 0.19;

/** Koschmieder contrast threshold: an object is lost when its apparent contrast falls below 2 percent. */
export const CONTRAST_THRESHOLD = 0.02;

/** Description of a body of water in measurable terms. */
export interface WaterSpec {
  /** Nephelometric turbidity, NTU. */
  ntu: number;
  /**
   * Particle beam attenuation at 550 nm per NTU, m^-1 NTU^-1.
   * Site and particle dependent (no universal slope exists); 1.0 is an assumption until the tank calibration in
   * docs/RESOURCES.md section 8.3 replaces it.
   */
  cPerNtu: number;
  /** Particle single-scattering albedo b_p / c_p. Mineral suspensions are highly scattering. */
  particleAlbedo: number;
  /** Particle backscattering ratio bb_p / b_p. 0.019 is the Petzold average-particle value. */
  particleBackscatterRatio: number;
  /** Spectral slope of particle attenuation, c_p(lambda) = c_p(550) (lambda / 550)^-slope. */
  particleSlope: number;
  /** cosine of the sun's zenith angle in the water; absent = the default daylight geometry, 0.87 */
  mu0?: number;
  /** CDOM absorption at 440 nm, m^-1. a_g(lambda) = a_g(440) exp(-0.014 (lambda - 440)), Bricaud et al. 1981. */
  cdom440: number;
}

export interface WaterOptics {
  /** total absorption a */
  a: RGB;
  /** total scattering b */
  b: RGB;
  /** total backscattering bb */
  bb: RGB;
  /** beam attenuation c = a + b; attenuates the direct image signal and sets the backscatter build-up */
  c: RGB;
  /** diffuse attenuation of downwelling light, Kd */
  kd: RGB;
  /** reflectance of an infinitely deep water column; the colour and level of the veiling light relative to white */
  rInf: RGB;
}

const map3 = (f: (i: number) => number): RGB => [f(0), f(1), f(2)];

export function waterOptics(spec: WaterSpec): WaterOptics {
  const ntu = Math.max(0, Number.isFinite(spec.ntu) ? spec.ntu : 0);
  const a: number[] = [];
  const b: number[] = [];
  const bb: number[] = [];
  const mu0 = spec.mu0 ?? KIRK_DEFAULT_MU0;
  const g = kirkG(mu0);
  for (let i = 0; i < 3; i++) {
    const nm = CHANNEL_NM[i];
    const bw = pureWaterScattering(nm);
    const cp = spec.cPerNtu * ntu * Math.pow(nm / 550, -spec.particleSlope);
    const bp = spec.particleAlbedo * cp;
    const ap = cp - bp;
    const ag = spec.cdom440 * Math.exp(-0.014 * (nm - 440));
    a.push(PURE_WATER_ABSORPTION[i] + ap + ag);
    b.push(bw + bp);
    bb.push(0.5 * bw + spec.particleBackscatterRatio * bp);
  }
  return {
    a: map3((i) => a[i]),
    b: map3((i) => b[i]),
    bb: map3((i) => bb[i]),
    c: map3((i) => a[i] + b[i]),
    kd: map3((i) => Math.sqrt(a[i] * a[i] + g * a[i] * b[i]) / mu0),
    rInf: map3((i) => (REFLECTANCE_F * bb[i]) / (a[i] + bb[i])),
  };
}

/** Fraction of an object's contrast that survives a water path of d metres in one channel. */
export const contrastTransmittance = (c: number, d: number) => Math.exp(-c * Math.max(0, d));

/** Distance at which contrast falls to CONTRAST_THRESHOLD, m. ln(50) / c. */
export const visibilityRange = (c: number) => (c > 0 ? Math.log(1 / CONTRAST_THRESHOLD) / c : Infinity);

/** Tank turbidity range. The scenario keeps a 0..1 control; NTU grows with its square so the clear end has fine steps. */
export const TANK_MAX_NTU = 20;
export const tankNtu = (turbidity: number) => TANK_MAX_NTU * Math.min(1, Math.max(0, Number.isFinite(turbidity) ? turbidity : 0)) ** 2;

/** The lab tank: tap water clouded with kaolin clay, the usual way to add turbidity in measured steps. */
export function tankWater(turbidity: number): WaterSpec {
  return {
    ntu: tankNtu(turbidity),
    cPerNtu: 1.0,
    particleAlbedo: 0.95,
    particleBackscatterRatio: 0.019,
    particleSlope: 0.5,
    cdom440: 0.01,
  };
}

/**
 * Diffuse reflectance of the tank sand, the background every target is seen against.
 * Matches the rendered sand (#8f7d5c, linear luminance about 0.21) within the uncertainty of a real silica sand.
 */
export const SAND_REFLECTANCE = 0.25;

/** Luminance weights of the R, G, B channels (Rec. 709), for collapsing a per-channel result to one number. */
const LUMA: RGB = [0.2126, 0.7152, 0.0722];

export interface ContrastInput {
  /** water path from the lens to the object, m */
  pathM: number;
  /** depth of the object below the surface, m */
  objectDepthM: number;
  /** depth at which the veiling light is scattered, m (the renderer uses mid water) */
  veilDepthM: number;
  /** diffuse reflectance of the background the object is seen against */
  backgroundReflectance?: number;
}

/**
 * Fraction of an object's inherent contrast that survives the water, against its background, luminance-weighted.
 * Both object and background are lit by the light reaching their depth, exp(-Kd z); the camera sees them through
 * transmittance T = exp(-c d) plus the veil Binf (1 - T) (the image model in components/lab/water.ts), so
 *   C' / C0 = T / (T + k (1 - T)),  k = Binf / (rho_b E_object) = rInf exp(-Kd z_veil) / (rho_b exp(-Kd z_object)).
 * Overall light level cancels: it changes the signal-to-noise ratio, not the contrast.
 */
export function contrastRatio(o: WaterOptics, input: ContrastInput): number {
  const rho = input.backgroundReflectance ?? SAND_REFLECTANCE;
  let sum = 0;
  for (let i = 0; i < 3; i++) {
    const t = contrastTransmittance(o.c[i], input.pathM);
    const k = (o.rInf[i] * Math.exp(-o.kd[i] * input.veilDepthM)) / (rho * Math.exp(-o.kd[i] * Math.max(0, input.objectDepthM)));
    sum += LUMA[i] * (t / (t + k * (1 - t)));
  }
  return sum;
}

/**
 * How detectable the water leaves an object, 1 in perfectly clear water, 0 at the Koschmieder threshold.
 * Detection scales with log contrast: each halving of contrast costs the same, and 2 percent is the floor.
 */
export function waterDetectability(ratio: number): number {
  if (!(ratio > 0)) return 0;
  return Math.min(1, Math.max(0, 1 + Math.log(ratio) / Math.log(1 / CONTRAST_THRESHOLD)));
}

