"use client";

import { motion } from "framer-motion";
import { useTelemetryStore } from "@/lib/store/telemetryStore";

export function ArtificialHorizon() {
  const { pitch, roll, yaw } = useTelemetryStore();

  return (
    <div className="relative w-full h-full flex items-center justify-center overflow-hidden bg-tactical-bg">
      {/* Background Reticle */}
      <div className="absolute inset-0 opacity-20 pointer-events-none border-[1px] border-tactical-cyan/30 rounded-full scale-[0.8]" />
      
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <div className="w-[1px] h-full bg-tactical-cyan/10" />
        <div className="absolute w-full h-[1px] bg-tactical-cyan/10" />
      </div>

      {/* Moving Horizon Line */}
      <motion.div
        className="relative w-48 h-48 border-2 border-tactical-cyan/40 rounded-full flex items-center justify-center"
        animate={{
          rotate: roll,
          y: pitch * 2, // Scale pitch for visual effect
        }}
        transition={{ type: "spring", stiffness: 100, damping: 30 }}
      >
        <div className="w-[120%] h-[2px] bg-tactical-cyan shadow-[0_0_10px_rgba(0,240,255,0.8)] relative">
          <div className="absolute -top-3 left-1/2 -translate-x-1/2 w-4 h-4 border-t-2 border-tactical-cyan" />
        </div>
      </motion.div>

      {/* Fixed Center Crosshair */}
      <div className="absolute z-10 w-8 h-8 pointer-events-none">
        <div className="absolute top-1/2 left-0 w-3 h-[2px] bg-tactical-red" />
        <div className="absolute top-1/2 right-0 w-3 h-[2px] bg-tactical-red" />
        <div className="absolute top-0 left-1/2 w-[2px] h-3 bg-tactical-red" />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-1 h-1 bg-tactical-red rounded-full" />
      </div>

      {/* Readouts */}
      <div className="absolute bottom-2 left-2 text-[10px] font-mono text-tactical-cyan">
        P: {pitch.toFixed(1)}°
      </div>
      <div className="absolute bottom-2 right-2 text-[10px] font-mono text-tactical-cyan">
        R: {roll.toFixed(1)}°
      </div>
      <div className="absolute top-2 left-2 text-[10px] font-mono text-tactical-cyan">
        Y: {yaw.toFixed(1)}°
      </div>
    </div>
  );
}
