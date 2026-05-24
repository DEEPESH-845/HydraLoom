"use client";

import { motion, useSpring, useTransform } from "framer-motion";
import { useEffect, useState } from "react";
import { useTelemetryStore } from "@/lib/store/telemetryStore";

interface Detection {
  id: number;
  class: string;
  confidence: number;
  bbox: [number, number, number, number]; 
}

function TrackingBox({ detection }: { detection: Detection }) {
  // Ultra-smooth mechanical stabilization springs
  const springConfig = { stiffness: 150, damping: 25, mass: 0.8 };
  
  const targetX = detection.bbox[0] * 100;
  const targetY = detection.bbox[1] * 100;
  const targetW = detection.bbox[2] * 100;
  const targetH = detection.bbox[3] * 100;

  const xSpring = useSpring(targetX, springConfig);
  const ySpring = useSpring(targetY, springConfig);
  const wSpring = useSpring(targetW, springConfig);
  const hSpring = useSpring(targetH, springConfig);

  useEffect(() => {
    xSpring.set(targetX);
    ySpring.set(targetY);
    wSpring.set(targetW);
    hSpring.set(targetH);
  }, [targetX, targetY, targetW, targetH, xSpring, ySpring, wSpring, hSpring]);

  const left = useTransform(xSpring, (v) => `${v}%`);
  const top = useTransform(ySpring, (v) => `${v}%`);
  const width = useTransform(wSpring, (v) => `${v}%`);
  const height = useTransform(hSpring, (v) => `${v}%`);

  const [isLocked, setIsLocked] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setIsLocked(true), 600); // Lock-on delay
    return () => clearTimeout(timer);
  }, []);

  const isCritical = detection.class.toLowerCase().includes("crack") || detection.class.toLowerCase().includes("leak") || detection.class.toLowerCase().includes("anomaly");
  const color = isCritical ? "border-tactical-red text-tactical-red" : "border-tactical-cyan text-tactical-cyan";
  const glow = isCritical ? "shadow-[0_0_20px_rgba(255,42,42,0.8)]" : "shadow-[0_0_20px_rgba(0,240,255,0.6)]";
  const bgFill = isCritical ? "bg-tactical-red/5" : "bg-tactical-cyan/5";

  return (
    <motion.div
      className={`absolute flex flex-col justify-start pointer-events-none ${isLocked ? '' : 'opacity-50 scale-110'}`}
      style={{ left, top, width, height }}
      animate={isLocked ? { scale: 1, opacity: 1 } : {}}
      transition={{ type: "spring", bounce: 0, duration: 0.4 }}
    >
      {/* Target Fill Grid */}
      <div className={`absolute inset-0 ${bgFill} radar-grid opacity-20`} />

      {/* Holographic Corners */}
      <div className={`absolute -top-1 -left-1 w-6 h-6 border-t-2 border-l-2 ${color} ${glow} transition-all duration-300`} />
      <div className={`absolute -top-1 -right-1 w-6 h-6 border-t-2 border-r-2 ${color} ${glow} transition-all duration-300`} />
      <div className={`absolute -bottom-1 -left-1 w-6 h-6 border-b-2 border-l-2 ${color} ${glow} transition-all duration-300`} />
      <div className={`absolute -bottom-1 -right-1 w-6 h-6 border-b-2 border-r-2 ${color} ${glow} transition-all duration-300`} />

      {/* Crosshair Center */}
      <motion.div 
        className={`absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-3 h-3 rounded-full border border-white/80`}
        animate={{ scale: [1, 1.5, 1], opacity: [0.5, 1, 0.5] }}
        transition={{ repeat: Infinity, duration: 2 }}
      />

      {/* Animated Scanline passing over target */}
      <motion.div 
        className={`absolute left-0 w-full h-[2px] ${isCritical ? "bg-tactical-red" : "bg-tactical-cyan"} opacity-40 shadow-[0_0_10px_currentColor]`}
        animate={{ top: ["0%", "100%", "0%"] }}
        transition={{ repeat: Infinity, duration: 3, ease: "linear" }}
      />

      {/* Tactical Label Dropdown */}
      <motion.div 
        initial={{ height: 0, opacity: 0 }}
        animate={isLocked ? { height: 'auto', opacity: 1 } : {}}
        className={`absolute -top-10 left-0 bg-[#010508]/80 backdrop-blur-md border border-b-0 ${isCritical ? "border-tactical-red/50" : "border-tactical-cyan/50"} px-3 py-1 flex flex-col whitespace-nowrap overflow-hidden`}
      >
        <span className="text-[10px] font-mono font-bold tracking-widest uppercase">
          {isLocked ? "TRK_LOCKED" : "ACQUIRING..."}
        </span>
        <div className="flex items-center space-x-2">
          <span className="text-xs font-mono font-bold tracking-widest uppercase text-white drop-shadow-md">
            {detection.class}
          </span>
          <span className={`text-[10px] font-mono ${isCritical ? "text-tactical-red" : "text-tactical-cyan"}`}>
            [{(detection.confidence * 100).toFixed(1)}%]
          </span>
        </div>
      </motion.div>
      
      {/* Downward predictive vector line */}
      <motion.div 
        className={`absolute top-full left-1/2 w-[1px] h-16 origin-top opacity-50 ${isCritical ? "bg-gradient-to-b from-tactical-red to-transparent" : "bg-gradient-to-b from-tactical-cyan to-transparent"}`} 
        initial={{ scaleY: 0 }}
        animate={{ scaleY: 1 }}
        transition={{ delay: 0.5, duration: 1 }}
      />
    </motion.div>
  );
}

export function AIDetectionOverlay() {
  const detections = useTelemetryStore((state) => state.detections);

  return (
    <div className="absolute inset-0 pointer-events-none z-30 overflow-hidden">
      {/* Outer Tactical Frame */}
      <div className="absolute inset-4 border border-white/5 rounded-3xl" />
      
      {detections?.map((d) => (
        <TrackingBox key={d.id} detection={d} />
      ))}
    </div>
  );
}
