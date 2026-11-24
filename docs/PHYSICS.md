# GANTRYLAB Physics and Simulation Models

This document states every physical model in the simulation, its units, its assumptions and its sources.
It is the reference for `lib/physics/`, `lib/world/`, `lib/field/` and the water optics in `lib/optics/water.ts`.
Nothing here is calibrated against a real site or vehicle yet.
Every value that is representative rather than measured is listed as an assumption in the environment definitions (`assumptions` field) and in section 8.

## 1. Frames, units and conventions

All physics uses SI units: metres, seconds, kilograms, newtons, radians internally.
The UI shows degrees, centimetres for the gantry and NTU for turbidity.

| Frame | Axes | Notes |
|---|---|---|
| World | +X east, +Y up, +Z south (so -Z is north) | Three.js metres, right-handed. Field sites put the sea surface at y = 0, so the seabed height is minus the depth. |
| Body (vehicles) | +X forward (surge), +Y up (heave), +Z starboard (sway) | Right-handed. Quaternions `[x, y, z, w]` rotate body vectors into the world. |
| Gantry | x along the tank, y across, cm from the home corner | Unchanged; `docs/BLUEPRINT.md` section 3. |

Rotations in the body frame:

| Rate | Axis | Positive sense |
|---|---|---|
| Roll | body +X | starboard side goes down |
| Yaw | body +Y | nose turns to port (counterclockwise seen from above) |
| Pitch | body +Z | nose goes up |

Compass heading is degrees clockwise from north.
`headingToYaw(h) = 90 - h` in degrees, so heading 090 (east) is yaw 0.
Current direction follows the oceanographic convention: the direction the water flows TOWARD.
A "090 current" moves water toward the east, `[+speed, 0, 0]` in the world frame.

## 2. Water current field (`lib/physics/current.ts`)

WATER CURRENT VELOCITY IS NOT VEHICLE VELOCITY.
The field returns the velocity of the water at a point and time.
Vehicles feel forces from the relative velocity, vehicle minus water.
Particles and free-floating targets are carried by the water velocity itself.

Fidelity: an analytical kinematic field, deterministic and seeded.
It is not computational fluid dynamics, it does not conserve momentum, and the obstacle term is a superposition that is only accurate for well-separated obstacles.
A CFD export can replace it through the same `sample(point, time)` interface.

Terms, summed:

1. Mean flow at the reference height `speedMps` toward `headingDeg`.
2. Vertical profile.
   `log`: the law of the wall, `u(z) / u(zref) = ln(z / z0) / ln(zref / z0)`, zero at the roughness height `z0`, capped at 1.25 times the reference speed.
   Roughness lengths: mud 2e-4 m, sand 1e-3 m, gravel 5e-3 m, reef 3e-2 m (representative values for hydraulically rough beds).
   `uniform`: constant above the bed.
3. Channel profile (river): `(1 - d^2)^(1/7)` of the centreline speed, with `d` the normalised distance to the bank; zero at and beyond the banks.
4. Temporal variability: two slow sinusoids (periods 37 s and 11.3 s) scale the speed by up to `variability`, and a 53 s sinusoid turns the direction by up to 15 degrees times `variability`.
5. Obstacles (vertical cylinders: pilings, piers): two-dimensional potential flow around a cylinder of radius R in a uniform stream U,
   `u_s = U (1 - R^2 (s^2 - n^2) / r^4)`, `u_n = -2 U R^2 s n / r^4`, in a frame with s downstream and n across.
   Speed abeam is `U (1 + R^2 / r^2)`, twice the free stream at the surface of the cylinder; the upstream stagnation point has zero speed.
   Downstream an empirical Gaussian wake deficit `0.9 / sqrt(1 + s / 2R)` of width `R sqrt(1 + s / 4R)` is subtracted, and vortex shedding is represented by a cross-flow oscillation at the Strouhal frequency `f = 0.2 U / D`, travelling at 0.85 U.
   The wake terms are empirical shapes, not a solution of the Navier-Stokes equations.
6. Turbulence: twelve random Fourier modes with wavelengths 0.6 to 12 m, amplitudes falling as `k^(-5/6)` (a Kolmogorov-like spectrum), each with its amplitude vector perpendicular to its wavevector, so the field is exactly divergence-free.
   Modes are frozen into the mean flow (Taylor's hypothesis): the phase uses `x - U t`.
   The amplitude is normalised so each horizontal component has RMS `turbulence * speed` (a current-meter definition of turbulence intensity); the vertical component is weaker because the modes are flattened, as near-bed turbulence is.

Tested invariants (`lib/physics/physics.test.ts`): heading convention, log-profile monotonicity and zero at the bed, zero flow at channel banks, the analytical abeam speed and stagnation point, zero flow inside a solid, numerical divergence below 1e-5 s^-1, horizontal RMS within 25 percent of the target, determinism and input sanitising.

## 3. Water properties (`lib/physics/seawater.ts`)

Density uses a linear equation of state about 10 C, 35 PSU, with a bulk modulus for pressure:
`rho = 1027 (1 - 1.7e-4 (T - 10) + 7.6e-4 (S - 35)) (1 + p / 2.2e9)`.
It gives 998.8 kg/m^3 for fresh water at 15 C and 1026.1 for sea water at 15 C (true values 999.1 and 1025.9).
It is an approximation, adequate for buoyancy (errors under 0.1 percent of displacement), not a substitute for TEOS-10.
Kinematic viscosity is a fit to tabulated fresh-water values (1.79e-6 m^2/s at 0 C, 1.0e-6 at 20 C), raised 5 percent at 35 PSU; it is used only for the Reynolds number in telemetry.
Lake stratification interpolates temperature across the thermocline and adds particles inside the metalimnion layer.

Consequence that is tested: a vehicle trimmed neutral in sea water is about 2.6 percent heavy in fresh water and sinks unless re-ballasted.
The platform setting `ballast: auto` re-ballasts as an operator would; `sea` keeps the sea-water trim so the effect can be studied.

## 4. Vehicle dynamics (`lib/physics/vehicle.ts`)

Six degrees of freedom, after Fossen (2011), Handbook of Marine Craft Hydrodynamics and Motion Control, chapters 6 to 8, simplified to diagonal mass and damping matrices:

```
(m + A_lin) dv/dt = F - w x (m v + A_lin v_r) - A_lin (w x v_c)
(I + A_ang) dw/dt = M - w x ((I + A_ang) w) - v_r x (A_lin v_r)
```

- `v` is the body velocity over ground, `v_c` the water velocity in the body frame, `v_r = v - v_c` the velocity relative to the water, `w` the angular rate.
- Rigid-body inertia uses `v`; added mass, damping, fin and hull lift use `v_r`.
  The current is assumed irrotational and slowly varying across the hull, so `dv_c/dt = -w x v_c` in the body frame.
- The last angular term is the Munk moment of the added mass.
  It makes slender hulls directionally unstable and an open frame pitch-unstable at speed; the pilots hold attitude, as real ones do.
- `F` and `M` are thrust (first-order actuator lag, saturated per axis at the allocation limit), linear plus quadratic damping on `v_r` and `w`, fin lift, hull lift, and restoring forces from weight at the centre of gravity and buoyancy `rho g V` at the centre of buoyancy.
- Integration: semi-implicit Euler at 1/120 s.
  A non-finite state is reset to rest rather than propagated.
- Constraints: the hull cannot rise through the surface, go below the seabed (the lowest point of its box, for its attitude) or enter a solid cylinder; the normal velocity component into the contact is removed and bed contact adds sliding friction.
  A rigid-body library is deliberately not used: contacts here are simple and hydrodynamics dominate.

Parameter sets, representative of the vehicle class, not calibrated:

| Vehicle | Source | Notes |
|---|---|---|
| Observation ROV (BlueROV2 Heavy class) | von Benzon et al. 2022, "An Open-Source Benchmark Simulator: Control of a BlueROV2 Underwater Robot", J. Mar. Sci. Eng. 10, 1898 | m 13.5 kg; added mass 6.36 / 18.68 / 7.12 kg (surge / heave / sway); quadratic damping 141 / 190 / 217 N s^2/m^2; eight T200 thrusters, about 127 N surge and sway, 180 N heave; trimmed 0.6 percent positive. |
| Survey AUV (REMUS 100 class) | Prestero 2001, "Verification of a six-degree of freedom simulation model for the REMUS autonomous underwater vehicle", MIT/WHOI thesis | m 30.48 kg; Xu\|u\| 1.62, Yv\|v\| = Zw\|w\| 131; fin lift 9.64 N s^2/(m^2 rad) at x = -0.638 m (so N_uudr = -6.15 follows); hull lift 18.96 at x = -0.235 m so the combined Z_uw = -28.6 and M_uw = 24.0 match Prestero; trimmed 0.5 percent positive (Prestero's vehicle was 2.3 percent, which the elevator cannot trim at survey speed in this simplified model). |

Tested invariants: drag opposes relative motion (and pushes forward when the water is faster than the vehicle), an unpowered vehicle drifts to the water velocity without overshoot, top speed equals the analytic balance of thrust and drag, fresh-water sinking and re-ballasting, no penetration of seabed or cylinders, bit-identical determinism.

## 5. Guidance and control (`lib/physics/autopilot.ts`)

Conventional, hand-tuned controllers; not trained policies.

- ROV: position error to a desired velocity saturated at the cruise speed, velocity error to force with drag feedforward and an integral that learns the steady load (current, buoyancy), heading PD, roll and pitch self-levelling.
  Tested: holds station within 5 cm in a 0.4 m/s cross current, and drifts away when the current exceeds its thrust (about 1.6 m/s).
- AUV: speed PI through the water; line-of-sight path following with a 6 m lookahead; heading to turn-rate command to rudder; depth or altitude to pitch to pitch-rate command to elevator, with integrals for trim.
  It cannot hover: HOLD means loiter.
  Tested: completes a lawnmower survey in a cross current with depth error under 1.5 m after the initial transient.

## 6. Environments (`lib/world/`)

Each environment is a versioned data file validated by `validateEnvironment` (schema version 1).
They differ in water type and optics, temperature and salinity (so density), light source, seabed material and reflectance, terrain kind, current regime, scenery and targets; `lib/field/field.test.ts` asserts no two share the same physical signature.

| Environment | Water | NTU range | CDOM a_g(440) | Light | Depth | Current (default) | Seabed |
|---|---|---|---|---|---|---|---|
| Harbor / Port | sea, 14 C, 30 PSU | 1 to 40 | 0.12 | daylight | 7 to 9 m berth | 0.25 m/s toward 070, tidal | mud, rho 0.12 |
| River / Bridge | fresh, 12 C | 2 to 150 | 0.9 | daylight | 4 m channel | 0.8 m/s toward 090, bank profile, pier wakes | gravel, rho 0.18 |
| Deep Sea / Abyssal | sea, 2 C, 34.7 PSU | 0.02 to 2 | 0.005 | lamps only | 1500 m | 0.05 m/s toward 200 | ooze, rho 0.3 |
| Coastal / Coral Reef | sea, 26 C, 35 PSU | 0.1 to 5 | 0.02 | sunlight, caustics | 9 m with coral heads | 0.2 m/s toward 030, surge | coral sand, rho 0.35 |
| Lake / Reservoir | fresh, 18 C over 8 C, thermocline at 7 m | 1 to 30 (+3 in the metalimnion) | 0.5 | daylight | 14 m basin | 0.03 m/s toward 180 | silt, rho 0.1 |
| Open Ocean Shelf | sea, 12 C, 35 PSU | 0.02 to 1 | 0.01 | daylight | 60 m shelf | 0.35 m/s toward 045 | sand, rho 0.25 |

The harbor, river and deep-sea optics are the same values as the Gantry Lab's in-tank emulations (`lib/sim/environments.ts`), so a lab result and a field result in the same water class are comparable.

## 7. Analytical detector (`lib/field/detection.ts`)

This is not a neural network.
It estimates whether a reasonable detector could see an object from the current pose through the current water.
Real model evaluation uses rendered frames and the backend (`docs/ARCHITECTURE.md` section 5).

`confidence = detectability * geometry * evidence * size * blur * (1 - occluded)^1.5 +- 0.01 seeded jitter`

- geometry: `1 - 0.30 r^2 - 0.15 burial`, the lab's term.
- evidence: the mean of `water * light` over the best-seen 35 percent of the surface patches that face the camera, each with its own path; patches out of frame count as zero.
  In murky water the only readable views are close ones, where a 5 m wreck can never show 35 percent of itself, so the evidence is the larger of that and `0.95 *` the readable share of the picture over 30 percent (ray grid against the target's exposed box).
  Until 2026-11-25 the whole box had to be in front of the lens with 30 percent of it in frame, and the path was measured to the box centre: a wreck was rejected at every range at which 2 m visibility could show it.
- water: `contrastSignal(contrastRatio(...))` with the lab's optics (`lib/optics/water.ts`): per-channel attenuation `c` over the lens-to-patch path and veiling light from `rInf`, with the environment's seabed as the background.
  Linear in log contrast from 0 at 2 percent (Koschmieder) to 1 at 20 percent; the 20 percent saturation is an assumption to calibrate against a real model.
  Daylight paths: object lit at its depth, veil lit at the path midpoint; lamp paths: object lit over the viewing distance, veil half way.
  Stratified layers add their particles over the part of the path inside the layer.
- light: shot-noise-limited signal, the square root of daylight at the object's depth (`exp(-Kd z)`, normalised to 5 percent of surface irradiance) plus lamp irradiance `power exp(-Kd d) (d_ref / d)^2`, with `d_ref = 2.5 m * sqrt(lumens / 6000)`.
  Lamp light and the veil it causes are not separated in this term; contrast is computed from the daylight model, which overestimates contrast for lamp light in turbid surface water.
- size: smoothstep of the projected size from 6 to 28 px.
- blur: `1 / (1 + (b / 8)^2)` with `b = exposure * f * (lateral speed / distance + turn rate)` in pixels.
- occlusion: up to five of the patches used, traced to the lens against the terrain and solid structures.
- Class: true class at or above 0.65 (with 0.03 hysteresis), else a deterministic confusion (TIRE and PIPELINE read as DEBRIS, others as UNKNOWN).

The survey altitude and the stand-off come from `workingRange`: the longest range at which 85 percent of that same signal survives, projected through the camera tilt and measured from the target's near surface.
Confidence is a track: each 10 Hz reading enters with weight 0.5, and a track below the threshold coasts for up to 0.6 s while its object is still in the picture, keeping its label.
A mission holds for 2 s at its last viewpoint before it completes, and finds made while piloting by hand are recorded (`engine.finds()`).

Tested invariants: the ROV detection mission classifies the wreck in every environment; every target can reach its true class in ideal conditions; nothing is found at maximum harbor turbidity; confidence never rises with turbidity at a fixed pose; lamp light falls with distance and is zero with the lamps off; the on-axis point projects to the image centre for any attitude.

## 8. Fidelity levels and open assumptions

| Subsystem | Fidelity level | Main assumptions to replace with measurements |
|---|---|---|
| Water optics | Physically based IOPs, single-scattering image formation | Particle `c` per NTU is 1.0 m^-1 everywhere; no forward-scatter blur; no lamp beam pattern. |
| Current | Analytical kinematic field | No momentum conservation; obstacle superposition; empirical wake. |
| Vehicle | 6-DOF lumped-parameter (Fossen), diagonal matrices | Representative coefficients from the literature; no thruster interaction, tether drag or ground effect. |
| Contacts | Kinematic constraint | No impact dynamics or friction model beyond a sliding factor. |
| Detector (field) | Analytical | Not a learned model; use the backend for real inference. |
| Hardware performance | Measured on the host where run; estimated otherwise | Raspberry Pi figures are estimates until measured on the device. |
