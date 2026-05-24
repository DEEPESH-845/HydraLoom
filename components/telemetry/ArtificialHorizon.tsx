"use client";

import { motion } from "framer-motion";
import { useTelemetryStore } from "@/lib/store/telemetryStore";

export function ArtificialHorizon() {
  const { pitch, roll, yaw } = useTelemetryStore();
  const isOnline = useTelemetryStore((state) => state.isOnline);

  // Aerospace HUD pitch ladder calculation
  // 1 degree of pitch = 4 pixels of translation
  const pitchScale = 4;

  return (
    <div className={`relative w-full h-full flex items-center justify-center overflow-hidden bg-tactical-bg ${!isOnline ? 'grayscale opacity-50' : ''}`}>
      {/* HUD Frame Vignette */}
      <div className="absolute inset-0 pointer-events-none shadow-[inset_0_0_50px_rgba(0,0,0,0.8)] z-20" />
      
      {/* Background Reticle Grid */}
      <div className="absolute inset-0 opacity-10 pointer-events-none">
        <div className="absolute top-1/2 w-full h-[1px] bg-tactical-cyan" />
        <div className="absolute left-1/2 w-[1px] h-full bg-tactical-cyan" />
        <div className="absolute inset-4 border border-tactical-cyan/50 rounded-full" />
      </div>

      {/* Dynamic Pitch Ladder & Roll */}
      <motion.div
        className="relative w-[300px] h-[300px] flex items-center justify-center"
        animate={{
          rotate: roll,
          y: pitch * pitchScale, 
        }}
        transition={{ type: "spring", stiffness: 120, damping: 20 }}
      >
        {/* Horizon Line */}
        <div className="absolute w-[200px] h-[2px] bg-tactical-cyan shadow-[0_0_15px_rgba(0,240,255,1)]">
           <div className="absolute -top-1 left-1/2 -translate-x-1/2 w-10 h-3 border-t-2 border-x-2 border-tactical-cyan" />
        </div>

        {/* Pitch Ladder Positive (Up) */}
        {[10, 20, 30, 40].map((deg) => (
          <div key={deg} className="absolute w-[120px] flex justify-between items-end" style={{ top: `calc(50% - ${deg * pitchScale}px)` }}>
            <span className="text-[8px] font-mono text-tactical-cyan/60">{deg}</span>
            <div className="w-[80px] border-b-2 border-x-2 border-tactical-cyan/40 h-2 mx-2" />
            <span className="text-[8px] font-mono text-tactical-cyan/60">{deg}</span>
          </div>
        ))}

        {/* Pitch Ladder Negative (Down - Dashed) */}
        {[-10, -20, -30, -40].map((deg) => (
          <div key={deg} className="absolute w-[120px] flex justify-between items-start" style={{ top: `calc(50% - ${deg * pitchScale}px)` }}>
            <span className="text-[8px] font-mono text-tactical-cyan/60">{deg}</span>
            <div className="w-[80px] border-t-2 border-x-2 border-tactical-cyan/40 border-dashed h-2 mx-2" />
            <span className="text-[8px] font-mono text-tactical-cyan/60">{deg}</span>
          </div>
        ))}
      </motion.div>

      {/* Fixed Center Reticle */}
      <div className="absolute z-10 w-24 h-24 pointer-events-none flex items-center justify-center">
        <div className="absolute left-0 w-8 h-[2px] bg-tactical-red shadow-[0_0_10px_rgba(255,0,0,0.8)]" />
        <div className="absolute right-0 w-8 h-[2px] bg-tactical-red shadow-[0_0_10px_rgba(255,0,0,0.8)]" />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-2 h-2 border-2 border-tactical-red rounded-full shadow-[0_0_10px_rgba(255,0,0,0.8)]" />
        <div className="absolute top-0 w-[2px] h-4 bg-tactical-red shadow-[0_0_10px_rgba(255,0,0,0.8)]" />
      </div>

      {/* Telemetry Readouts */}
      <div className="absolute bottom-3 left-4 bg-tactical-abyss/80 border border-tactical-cyan/20 px-2 py-1 backdrop-blur-sm">
        <div className="text-[8px] text-tactical-cyan/60 uppercase">Pitch</div>
        <div className="text-sm font-mono font-bold text-tactical-cyan">{pitch.toFixed(1)}°</div>
      </div>
      
      <div className="absolute bottom-3 right-4 bg-tactical-abyss/80 border border-tactical-cyan/20 px-2 py-1 backdrop-blur-sm text-right">
        <div className="text-[8px] text-tactical-cyan/60 uppercase">Roll</div>
        <div className="text-sm font-mono font-bold text-tactical-cyan">{roll.toFixed(1)}°</div>
      </div>
      
      <div className="absolute top-3 left-1/2 -translate-x-1/2 bg-tactical-abyss/80 border border-tactical-cyan/20 px-4 py-1 backdrop-blur-sm text-center">
        <div className="text-[8px] text-tactical-cyan/60 uppercase">Heading</div>
        <div className="text-lg font-mono font-bold text-tactical-cyan tracking-widest">{yaw.toFixed(1)}°</div>
      </div>

      {/* Warning Overlay if Offline */}
      {!isOnline && (
        <div className="absolute inset-0 flex items-center justify-center z-30">
          <div className="bg-tactical-red/20 text-tactical-red border border-tactical-red px-4 py-1 font-mono text-sm tracking-widest animate-pulse">
            IMU_OFFLINE
          </div>
        </div>
      )}
    </div>
  );
}
