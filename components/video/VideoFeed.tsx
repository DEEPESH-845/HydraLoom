"use client";

import { AIDetectionOverlay } from "./AIDetectionOverlay";
import { useTelemetryStore } from "@/lib/store/telemetryStore";
import { motion } from "framer-motion";

export function VideoFeed() {
  const isOnline = useTelemetryStore((state) => state.isOnline);

  return (
    <div className="relative w-full h-full bg-black overflow-hidden flex flex-col justify-center items-center">
      
      {/* Video Source Placeholder / Background */}
      {/* Replace this div with a <video> element for actual footage */}
      <div className="absolute inset-0 bg-gradient-to-b from-[#0a1b2a] to-[#010810] opacity-80" />
      
      {/* Simulated particulate matter / underwater noise */}
      <div className="absolute inset-0 opacity-10 bg-[url('https://grainy-gradients.vercel.app/noise.svg')] mix-blend-overlay" />

      {/* HUD Elements */}
      <div className="absolute inset-0 pointer-events-none p-4 flex flex-col justify-between z-10">
        
        {/* Top HUD */}
        <div className="flex justify-between items-start w-full text-[10px] font-mono text-white/80">
          <div className="flex items-center space-x-2">
            <motion.div 
              className="w-2 h-2 rounded-full bg-red-600 shadow-[0_0_8px_rgba(220,38,38,0.8)]"
              animate={{ opacity: [1, 0.2, 1] }}
              transition={{ repeat: Infinity, duration: 1.5 }}
            />
            <span className="tracking-widest font-bold">REC</span>
          </div>
          <div className="text-right">
            <div>CAM-01 FWD</div>
            <div>IR FILTER: OFF</div>
          </div>
        </div>

        {/* Center Crosshair */}
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-12 h-12 pointer-events-none opacity-40">
          <div className="absolute top-1/2 left-0 w-4 h-[1px] bg-white" />
          <div className="absolute top-1/2 right-0 w-4 h-[1px] bg-white" />
          <div className="absolute top-0 left-1/2 w-[1px] h-4 bg-white" />
          <div className="absolute bottom-0 left-1/2 w-[1px] h-4 bg-white" />
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[2px] h-[2px] rounded-full bg-red-500" />
        </div>

        {/* Bottom HUD */}
        <div className="flex justify-between items-end w-full text-[10px] font-mono text-white/60">
          <div>
            <div>AZIMUTH 142.4</div>
            <div>EXP: AUTO</div>
          </div>
          <div className="text-right">
            <div>MISSION: OMEGA-7</div>
            <div>TARGET: PIPELINE_BETA</div>
          </div>
        </div>
      </div>

      {/* AI Detections */}
      {isOnline && <AIDetectionOverlay />}

      {/* CRT Scanline Overlay */}
      <div className="absolute inset-0 crt-overlay pointer-events-none opacity-30 mix-blend-overlay" />
    </div>
  );
}
