"use client";

import { useTelemetryStore } from "@/lib/store/telemetryStore";
import { motion } from "framer-motion";

function Thruster({ id, pwm, x, y, rotate }: { id: string, pwm: number, x: string, y: string, rotate: number }) {
  // PWM 0-100 mapped to scale and glow intensity
  const scale = 0.5 + (pwm / 100) * 0.5;
  const opacity = 0.3 + (pwm / 100) * 0.7;
  
  return (
    <div className={`absolute flex flex-col items-center`} style={{ left: x, top: y, transform: `rotate(${rotate}deg)` }}>
      <div className="text-[9px] font-mono mb-1 text-tactical-cyan opacity-80">{id}</div>
      <div className="relative flex items-center justify-center w-8 h-8 rounded-full border border-tactical-cyan/40 bg-tactical-bg">
        <div className="absolute inset-0 rounded-full bg-tactical-cyan/10" />
        
        {/* The active thrust visual */}
        <motion.div 
          className="absolute rounded-full bg-tactical-cyan blur-sm"
          style={{ width: "80%", height: "80%" }}
          animate={{ scale, opacity }}
          transition={{ type: "spring", stiffness: 200, damping: 10 }}
        />
        
        {/* Core */}
        <div className="w-2 h-2 rounded-full bg-white z-10" />
      </div>
      
      {/* Thrust Vector Arrow */}
      <motion.div 
        className="w-[2px] bg-tactical-cyan mt-1 origin-top shadow-[0_0_8px_currentColor]"
        animate={{ height: `${(pwm / 100) * 30}px`, opacity }}
      />
    </div>
  );
}

export function ThrusterPanel() {
  const { t1, t2, t3, t4 } = useTelemetryStore((state) => state.thrusters);

  return (
    <div className="relative w-full h-full flex items-center justify-center bg-tactical-bg p-4 overflow-hidden">
      
      {/* ROV Chassis Outline */}
      <div className="relative w-40 h-24 border-2 border-tactical-cyan/30 rounded-lg flex items-center justify-center">
        <div className="w-full h-[1px] bg-tactical-cyan/20 absolute" />
        <div className="h-full w-[1px] bg-tactical-cyan/20 absolute" />
        <div className="text-tactical-cyan/40 font-mono tracking-widest text-xs rotate-90">
          FRONT
        </div>
        
        {/* Forward indicator */}
        <div className="absolute -right-6 top-1/2 -translate-y-1/2 w-4 h-4 border-t-2 border-r-2 border-tactical-cyan/40 rotate-45" />
      </div>

      {/* Thrusters Placed Around Chassis */}
      {/* Assuming ROV faces Right based on "FRONT" layout */}
      <Thruster id="T1 (FL)" pwm={t1} x="20%" y="15%" rotate={-90} />
      <Thruster id="T2 (FR)" pwm={t2} x="80%" y="15%" rotate={-90} />
      <Thruster id="T3 (RL)" pwm={t3} x="20%" y="60%" rotate={90} />
      <Thruster id="T4 (RR)" pwm={t4} x="80%" y="60%" rotate={90} />
      
      {/* Data Table */}
      <div className="absolute top-2 left-2 text-[9px] font-mono text-tactical-cyan/70 space-y-1">
        <div className="flex justify-between w-16"><span>T1:</span><span>{Math.round(t1)}%</span></div>
        <div className="flex justify-between w-16"><span>T2:</span><span>{Math.round(t2)}%</span></div>
      </div>
      <div className="absolute bottom-2 right-2 text-[9px] font-mono text-tactical-cyan/70 space-y-1">
        <div className="flex justify-between w-16"><span>T3:</span><span>{Math.round(t3)}%</span></div>
        <div className="flex justify-between w-16"><span>T4:</span><span>{Math.round(t4)}%</span></div>
      </div>

    </div>
  );
}
