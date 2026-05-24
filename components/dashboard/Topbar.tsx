"use client";

import { motion } from "framer-motion";
import { useTelemetryStore } from "@/lib/store/telemetryStore";
import { Activity, Wifi, Battery, BatteryFull, BatteryMedium, BatteryLow, Zap } from "lucide-react";
import { useState as useReactState, useEffect as useReactEffect } from "react";

export function Topbar() {
  const { isOnline, fps, latency, battery } = useTelemetryStore();
  const [time, setTime] = useReactState("00:00:00");

  useReactEffect(() => {
    const interval = setInterval(() => {
      const now = new Date();
      setTime(now.toISOString().split("T")[1].split(".")[0] + "Z");
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const getBatteryIcon = () => {
    if (battery > 70) return <BatteryFull className="w-4 h-4 text-tactical-green" />;
    if (battery > 30) return <BatteryMedium className="w-4 h-4 text-yellow-400" />;
    return <BatteryLow className="w-4 h-4 text-tactical-red animate-pulse" />;
  };

  return (
    <motion.div
      initial={{ y: -50, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.8, ease: "easeOut" }}
      className="glass-panel flex items-center justify-between px-6 py-3 border-b-2 border-tactical-cyan/40 shrink-0"
    >
      <div className="flex items-center space-x-6">
        {/* Logo Area */}
        <div className="flex items-center space-x-2">
          <Zap className="w-5 h-5 text-tactical-cyan" />
          <h1 className="text-xl font-mono font-bold tracking-widest text-tactical-cyan drop-shadow-[0_0_8px_rgba(0,240,255,0.8)]">
            HYDRALOOM
          </h1>
        </div>

        {/* Mission Timer */}
        <div className="font-mono text-sm tracking-wider text-tactical-text/80">
          T+ {time}
        </div>
      </div>

      <div className="flex items-center space-x-8 font-mono text-xs font-semibold tracking-wider">
        {/* Status */}
        <div className="flex items-center space-x-2">
          <div
            className={`w-2 h-2 rounded-full ${
              isOnline ? "bg-tactical-green animate-pulse-slow" : "bg-tactical-red"
            } shadow-[0_0_8px_currentColor]`}
          />
          <span className={isOnline ? "text-tactical-green" : "text-tactical-red"}>
            {isOnline ? "SYSTEM ONLINE" : "SYSTEM OFFLINE"}
          </span>
        </div>

        {/* Network */}
        <div className="flex items-center space-x-2 text-tactical-text">
          <Wifi className="w-4 h-4 text-tactical-cyan/80" />
          <span>{latency}MS</span>
        </div>

        {/* FPS */}
        <div className="flex items-center space-x-2 text-tactical-text">
          <Activity className="w-4 h-4 text-tactical-cyan/80" />
          <span>{fps} FPS</span>
        </div>

        {/* Battery */}
        <div className="flex items-center space-x-2 text-tactical-text">
          {getBatteryIcon()}
          <span>{battery.toFixed(1)}%</span>
        </div>
      </div>
    </motion.div>
  );
}
