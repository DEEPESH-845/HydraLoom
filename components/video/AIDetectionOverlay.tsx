"use client";

import { motion, useSpring, useMotionValue, useTransform } from "framer-motion";
import { useEffect, useState } from "react";
import { useTelemetryStore } from "@/lib/store/telemetryStore";

interface Detection {
  id: string;
  label: string;
  confidence: number;
  x: number; // percentage 0-100
  y: number;
  width: number;
  height: number;
  isCritical: boolean;
}

// Mechanically stabilized tracking box
function TrackingBox({ detection }: { detection: Detection }) {
  // Use Framer Motion Springs to simulate mechanical stabilization / Kalman filter delay
  const springConfig = { stiffness: 120, damping: 20, mass: 1 };
  
  const xSpring = useSpring(detection.x, springConfig);
  const ySpring = useSpring(detection.y, springConfig);
  const wSpring = useSpring(detection.width, springConfig);
  const hSpring = useSpring(detection.height, springConfig);

  useEffect(() => {
    xSpring.set(detection.x);
    ySpring.set(detection.y);
    wSpring.set(detection.width);
    hSpring.set(detection.height);
  }, [detection, xSpring, ySpring, wSpring, hSpring]);

  const left = useTransform(xSpring, (v) => `${v}%`);
  const top = useTransform(ySpring, (v) => `${v}%`);
  const width = useTransform(wSpring, (v) => `${v}%`);
  const height = useTransform(hSpring, (v) => `${v}%`);

  const color = detection.isCritical ? "border-tactical-red" : "border-tactical-cyan";
  const glow = detection.isCritical 
    ? "shadow-[0_0_15px_rgba(255,42,42,0.6)]" 
    : "shadow-[0_0_15px_rgba(0,240,255,0.4)]";
  const bgColor = detection.isCritical ? "bg-tactical-red/10" : "bg-tactical-cyan/5";

  return (
    <motion.div
      className={`absolute ${color} ${bgColor} flex flex-col justify-start pointer-events-none`}
      style={{ left, top, width, height }}
    >
      {/* Tactical Corners */}
      <div className={`absolute -top-1 -left-1 w-3 h-3 border-t-2 border-l-2 ${color} ${glow}`} />
      <div className={`absolute -top-1 -right-1 w-3 h-3 border-t-2 border-r-2 ${color} ${glow}`} />
      <div className={`absolute -bottom-1 -left-1 w-3 h-3 border-b-2 border-l-2 ${color} ${glow}`} />
      <div className={`absolute -bottom-1 -right-1 w-3 h-3 border-b-2 border-r-2 ${color} ${glow}`} />

      {/* Crosshair Projection */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-2 h-2 rounded-full border border-white/50" />

      {/* Label Box */}
      <div className={`absolute -top-7 left-0 ${detection.isCritical ? "bg-tactical-red/20 border-tactical-red/50" : "bg-tactical-cyan/20 border-tactical-cyan/50"} border px-2 py-0.5 whitespace-nowrap backdrop-blur-sm`}>
        <span className="text-[10px] font-mono text-white font-bold tracking-widest drop-shadow-md uppercase">
          {detection.label} <span className="opacity-70 ml-1">{(detection.confidence * 100).toFixed(0)}%</span>
        </span>
      </div>
      
      {/* Trajectory Vector line */}
      <div className={`absolute bottom-0 left-1/2 w-[1px] h-12 ${detection.isCritical ? "bg-gradient-to-b from-tactical-red/80 to-transparent" : "bg-gradient-to-b from-tactical-cyan/80 to-transparent"} origin-top opacity-50`} />
    </motion.div>
  );
}

export function AIDetectionOverlay() {
  const [detections, setDetections] = useState<Detection[]>([
    { id: "1", label: "Struct_Crack", confidence: 0.94, x: 30, y: 40, width: 12, height: 18, isCritical: true },
    { id: "2", label: "Pipeline_B", confidence: 0.88, x: 60, y: 55, width: 20, height: 10, isCritical: false },
  ]);

  // Simulate raw, noisy AI pipeline output
  useEffect(() => {
    const interval = setInterval(() => {
      setDetections((prev) =>
        prev.map((d) => ({
          ...d,
          // Inject raw noise. The TrackingBox spring will smooth this out.
          x: d.x + (Math.random() - 0.5) * 2,
          y: d.y + (Math.random() - 0.5) * 2,
        }))
      );
    }, 150); // AI inference running at ~6.6 FPS
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="absolute inset-0 pointer-events-none z-30">
      {detections.map((d) => (
        <TrackingBox key={d.id} detection={d} />
      ))}
    </div>
  );
}
