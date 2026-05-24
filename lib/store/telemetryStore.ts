import { create } from "zustand";

interface TelemetryState {
  // Environment
  depth: number;
  temperature: number;
  // Orientation
  yaw: number;
  pitch: number;
  roll: number;
  // Thrusters (PWM 0-100)
  thrusters: {
    t1: number;
    t2: number;
    t3: number;
    t4: number;
  };
  // System Status
  battery: number;
  fps: number;
  latency: number;
  isOnline: boolean;
  leakDetected: boolean;
  
  // Actions
  updateTelemetry: (data: Partial<TelemetryState>) => void;
}

export const useTelemetryStore = create<TelemetryState>((set) => ({
  depth: 0.0,
  temperature: 15.2,
  yaw: 0,
  pitch: 0,
  roll: 0,
  thrusters: { t1: 0, t2: 0, t3: 0, t4: 0 },
  battery: 100,
  fps: 60,
  latency: 12,
  isOnline: true,
  leakDetected: false,
  
  updateTelemetry: (data) => set((state) => ({ ...state, ...data })),
}));
