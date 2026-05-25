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
  mode: "SIMULATION" | "HARDWARE";
  battery: number;
  fps: number;
  latency: number;
  isOnline: boolean;
  leakDetected: boolean;
  detections: Array<{
    id: number;
    class: string;
    confidence: number;
    bbox: [number, number, number, number];
  }>;
  
  // Actions
  updateTelemetry: (data: Partial<TelemetryState>) => void;
  sendCommand: (cmd: object) => void;
}

export const useTelemetryStore = create<TelemetryState>((set) => ({
  depth: 0.0,
  temperature: 15.2,
  yaw: 0,
  pitch: 0,
  roll: 0,
  thrusters: { t1: 0, t2: 0, t3: 0, t4: 0 },
  mode: "SIMULATION",
  battery: 100,
  fps: 60,
  latency: 12,
  isOnline: true,
  leakDetected: false,
  detections: [],
  updateTelemetry: (data) => set((state) => ({ ...state, ...data })),
  sendCommand: (cmd) => console.warn("sendCommand not initialized yet", cmd),
}));
