/**
 * HYDRALOOM Cinematic Motion Profiles
 * 
 * Defines unified "Heavy Machinery" Framer Motion springs.
 * This prevents arcade-like snapping and forces the UI to feel physically weighted.
 */

// Used for heavy mechanical dials, pitch ladders, and robust telemetry
export const heavySpring = {
  type: "spring",
  stiffness: 120,
  damping: 25,
  mass: 1.5,
  restDelta: 0.001
};

// Used for the AI Bounding Box tracking interpolation (acts as visual Kalman filter)
export const trackingSpring = {
  type: "spring",
  stiffness: 180,
  damping: 30,
  mass: 0.8,
};

// Used for subtle UI glows and cinematic reveals
export const cinematicEase = [0.25, 0.1, 0.25, 1.0]; // Custom cubic-bezier

// Used for tactical glitch and error states
export const alarmPulse = {
  duration: 0.8,
  repeat: Infinity,
  ease: "easeInOut"
};
