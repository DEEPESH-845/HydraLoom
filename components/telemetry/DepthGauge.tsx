"use client";

import { useTelemetryStore } from "@/lib/store/telemetryStore";
import { motion } from "framer-motion";

export function DepthGauge() {
  const depth = useTelemetryStore((state) => state.depth);

  // We map depth (0 to 100m) to a percentage for the visual bar
  const maxDepth = 100;
  const depthPercent = Math.min((depth / maxDepth) * 100, 100);

  return (
    <div className="relative flex flex-row items-center w-full h-full px-4 text-tactical-cyan">
      
      {/* Left side: The depth number readout */}
      <div className="flex-1 flex flex-col items-center justify-center space-y-2">
        <span className="text-3xl font-mono font-bold tracking-tighter drop-shadow-[0_0_8px_currentColor]">
          {depth.toFixed(1)}
        </span>
        <span className="text-xs font-mono opacity-80 uppercase tracking-widest">
          Meters
        </span>
      </div>

      {/* Right side: The vertical tape gauge */}
      <div className="relative w-12 h-full border-l-2 border-tactical-cyan/40 ml-4 overflow-hidden py-4">
        
        {/* Ticks representation */}
        <div className="absolute top-0 bottom-0 left-0 w-full flex flex-col justify-between py-4">
          {[0, 20, 40, 60, 80, 100].map((tick) => (
            <div key={tick} className="flex items-center">
              <div className="w-3 h-[2px] bg-tactical-cyan/60" />
              <span className="text-[9px] font-mono ml-1 opacity-50">{tick}</span>
            </div>
          ))}
        </div>

        {/* The moving cursor indicating current depth */}
        <motion.div
          className="absolute left-0 right-0 h-4 border-y-2 border-tactical-red bg-tactical-red/20 flex items-center justify-start z-10"
          animate={{ top: `${depthPercent}%` }}
          transition={{ type: "spring", stiffness: 80, damping: 20 }}
          style={{ translateY: "-50%" }}
        >
          <div className="w-4 h-[2px] bg-tactical-red" />
        </motion.div>

        {/* Fill from top to current depth */}
        <motion.div 
          className="absolute top-0 left-0 w-full bg-tactical-cyan/10"
          animate={{ height: `${depthPercent}%` }}
        />
      </div>

    </div>
  );
}
