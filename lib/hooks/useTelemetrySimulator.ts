"use client";

import { useEffect, useRef } from "react";
import { useTelemetryStore } from "../store/telemetryStore";

export function useTelemetrySimulator() {
  const updateTelemetry = useTelemetryStore((state) => state.updateTelemetry);
  const animationRef = useRef<number>(null);
  const timeRef = useRef<number>(0);

  useEffect(() => {
    let lastTime = performance.now();

    const simulate = (time: number) => {
      const dt = (time - lastTime) / 1000;
      lastTime = time;
      timeRef.current += dt;

      const t = timeRef.current;

      // Depth: slow sine wave representing ocean swell
      const depth = 45.2 + Math.sin(t * 0.5) * 1.5;
      
      // Orientation: stabilized but drifting
      const yaw = Math.sin(t * 0.2) * 5;
      const pitch = Math.sin(t * 0.8) * 3;
      const roll = Math.cos(t * 0.6) * 2;

      // Thrusters reacting to stabilize
      // If yaw > 0, T1 needs to push right. Just a pseudo-calculation for visuals.
      const t1 = Math.abs(Math.sin(t * 0.3) * 60 + 20);
      const t2 = Math.abs(Math.cos(t * 0.3) * 60 + 20);
      const t3 = Math.abs(Math.sin(t * 0.5) * 40 + 10);
      const t4 = Math.abs(Math.cos(t * 0.5) * 40 + 10);

      // System vitals with slight jitter
      const fps = 58 + Math.random() * 2;
      const latency = 18 + Math.sin(t * 2) * 4 + Math.random() * 2;
      
      // Battery drain
      const currentBattery = useTelemetryStore.getState().battery;
      const battery = Math.max(0, currentBattery - (dt * 0.01)); // Drains slowly

      updateTelemetry({
        depth,
        yaw,
        pitch,
        roll,
        thrusters: { t1, t2, t3, t4 },
        fps: Math.round(fps),
        latency: Math.round(latency),
        battery,
      });

      animationRef.current = requestAnimationFrame(simulate);
    };

    animationRef.current = requestAnimationFrame(simulate);

    return () => {
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
    };
  }, [updateTelemetry]);
}
