"use client";

import { useTelemetryStore } from "@/lib/store/telemetryStore";
import { motion } from "framer-motion";

export function DepthGauge() {
  const depth = useTelemetryStore((state) => state.depth);
  const isOnline = useTelemetryStore((state) => state.isOnline);

  const maxDepth = 100;
  const depthPercent = Math.min((Math.max(depth, 0) / maxDepth) * 100, 100);

  const isCritical = depth > 80; // Warning threshold

  return (
    <div className={`relative flex flex-row items-center w-full h-full px-4 ${!isOnline ? 'grayscale opacity-50' : ''}`}>
      
      {/* Readout Block */}
      <div className="flex-1 flex flex-col items-center justify-center relative">
        {/* Holographic glowing text */}
        <span className={`text-4xl font-mono font-bold tracking-tighter ${isCritical ? 'text-tactical-red drop-shadow-[0_0_15px_rgba(255,0,0,0.8)]' : 'text-tactical-cyan drop-shadow-[0_0_15px_rgba(0,240,255,0.8)]'}`}>
          {depth.toFixed(1)}
        </span>
        <span className="text-[10px] font-mono opacity-80 uppercase tracking-widest text-tactical-cyan/60 mt-1">
          Meters (Sea)
        </span>
        
        {isCritical && (
          <div className="absolute -bottom-6 text-[8px] font-mono text-tactical-red border border-tactical-red px-1 animate-pulse">
            CRUSH_DEPTH_WARN
          </div>
        )}
      </div>

      {/* Holographic Depth Tape */}
      <div className="relative w-16 h-[90%] border-l border-tactical-cyan/30 ml-4 overflow-hidden bg-tactical-cyan/5">
        
        {/* Dynamic sliding tape */}
        <motion.div 
          className="absolute left-0 w-full"
          animate={{ y: `-${depthPercent}%` }}
          transition={{ type: "spring", stiffness: 100, damping: 20 }}
          style={{ height: '200%', top: '50%' }} // Center point shifts
        >
          {Array.from({length: 11}).map((_, i) => {
            const tickDepth = i * 10;
            return (
              <div key={i} className="absolute left-0 flex items-center" style={{ top: `${(i / 10) * 50}%` }}>
                <div className={`w-4 h-[1px] ${tickDepth > 80 ? 'bg-tactical-red/80' : 'bg-tactical-cyan/60'}`} />
                <span className={`text-[10px] font-mono ml-2 ${tickDepth > 80 ? 'text-tactical-red' : 'text-tactical-cyan/60'}`}>
                  {tickDepth}
                </span>
              </div>
            );
          })}
        </motion.div>

        {/* Center Target Indicator (Current Depth) */}
        <div className="absolute top-1/2 left-0 w-full -translate-y-1/2 z-10 pointer-events-none">
          <div className="flex items-center">
             <div className="w-0 h-0 border-y-[4px] border-y-transparent border-l-[6px] border-l-tactical-red" />
             <div className="flex-1 h-[1px] bg-tactical-red shadow-[0_0_10px_rgba(255,0,0,1)]" />
          </div>
        </div>

      </div>

    </div>
  );
}
