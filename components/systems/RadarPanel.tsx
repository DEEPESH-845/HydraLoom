"use client";

import { motion } from "framer-motion";
import { useEffect, useState } from "react";

export function RadarPanel() {
  const [blips, setBlips] = useState<{ id: number; r: number; theta: number }[]>([]);

  useEffect(() => {
    // Generate random radar blips
    const interval = setInterval(() => {
      setBlips((prev) => {
        const newBlips = [...prev, { id: Date.now(), r: Math.random() * 40 + 10, theta: Math.random() * 360 }];
        if (newBlips.length > 5) newBlips.shift();
        return newBlips;
      });
    }, 2000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="relative w-full h-full flex items-center justify-center bg-tactical-bg overflow-hidden p-2">
      
      {/* Radar Container */}
      <div className="relative w-40 h-40 border-[1px] border-tactical-cyan/40 rounded-full flex items-center justify-center shadow-[0_0_15px_rgba(0,240,255,0.1)]">
        
        {/* Concentric Rings */}
        <div className="absolute w-2/3 h-2/3 border-[1px] border-tactical-cyan/20 rounded-full" />
        <div className="absolute w-1/3 h-1/3 border-[1px] border-tactical-cyan/20 rounded-full" />
        
        {/* Crosshairs */}
        <div className="absolute w-full h-[1px] bg-tactical-cyan/30" />
        <div className="absolute h-full w-[1px] bg-tactical-cyan/30" />

        {/* Sweep */}
        <motion.div
          className="absolute w-1/2 h-1/2 origin-bottom-right"
          style={{ top: 0, left: 0 }}
          animate={{ rotate: 360 }}
          transition={{ repeat: Infinity, duration: 4, ease: "linear" }}
        >
          {/* Sweep Gradient */}
          <div className="w-full h-full" style={{
            background: "conic-gradient(from 180deg at 100% 100%, rgba(0, 240, 255, 0.4) 0deg, transparent 60deg)"
          }} />
        </motion.div>

        {/* Blips */}
        {blips.map((blip) => (
          <motion.div
            key={blip.id}
            className="absolute w-1.5 h-1.5 bg-tactical-red rounded-full shadow-[0_0_8px_rgba(255,42,42,0.8)]"
            style={{
              top: `calc(50% - ${Math.cos((blip.theta * Math.PI) / 180) * blip.r}%)`,
              left: `calc(50% + ${Math.sin((blip.theta * Math.PI) / 180) * blip.r}%)`,
              transform: "translate(-50%, -50%)"
            }}
            initial={{ opacity: 1, scale: 1 }}
            animate={{ opacity: 0, scale: 2 }}
            transition={{ duration: 4, ease: "circOut" }}
          />
        ))}

        {/* Center Origin */}
        <div className="absolute w-1.5 h-1.5 bg-white rounded-full shadow-[0_0_8px_white] z-10" />
      </div>

    </div>
  );
}
