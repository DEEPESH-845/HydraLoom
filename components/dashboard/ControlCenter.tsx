"use client";

import { useTelemetryStore } from "@/lib/store/telemetryStore";
import { useState } from "react";

export function ControlCenter() {
  const isOnline = useTelemetryStore((state) => state.isOnline);
  const sendCommand = useTelemetryStore((state) => state.sendCommand);
  const mode = useTelemetryStore((state) => state.mode);
  const transitioning = useTelemetryStore((state) => state.transitioning);
  const transitionError = useTelemetryStore((state) => state.transitionError);
  const [activeFault, setActiveFault] = useState<string | null>(null);

  const triggerFault = (fault: string) => {
    setActiveFault(fault);
    sendCommand({ type: "INJECT_FAULT", fault });
    const duration = fault === "LEAK_DETECT" ? 10000 : 8000;
    setTimeout(() => setActiveFault(null), duration);
  };

  const switchMode = (newMode: "SIMULATION" | "HARDWARE") => {
    if (transitioning || mode === newMode) return;
    sendCommand({ type: "SET_MODE", mode: newMode });
  };

  return (
    <div className="absolute top-20 right-4 w-64 bg-tactical-panel backdrop-blur-xl border border-tactical-cyan/20 rounded-md p-3 font-mono text-[10px] z-50 text-tactical-text shadow-2xl">
      <div className="flex justify-between items-center mb-3 border-b border-tactical-cyan/30 pb-2">
        <span className="font-bold tracking-widest text-tactical-cyan">DIGITAL TWIN SIM_CTRL</span>
        <div className={`w-2 h-2 rounded-full ${isOnline ? "bg-tactical-green shadow-[0_0_8px_#00FF66]" : "bg-tactical-red"}`} />
      </div>

      <div className="space-y-4">
        {/* Mode Switcher */}
        <div>
          <div className="text-tactical-cyan/60 mb-1">HAL_ORCHESTRATOR_MODE</div>
          <div className="flex space-x-2">
            <button
              onClick={() => switchMode("HARDWARE")}
              disabled={transitioning}
              className={`flex-1 py-1 transition-all ${
                mode === "HARDWARE"
                  ? "bg-tactical-cyan/20 border border-tactical-cyan shadow-[0_0_10px_rgba(0,240,255,0.2)] text-tactical-cyan font-bold"
                  : "border border-tactical-cyan/40 hover:bg-tactical-cyan/20 text-tactical-cyan/60"
              } ${transitioning ? "opacity-50 cursor-not-allowed" : ""}`}
            >
              HARDWARE
            </button>
            <button
              onClick={() => switchMode("SIMULATION")}
              disabled={transitioning}
              className={`flex-1 py-1 transition-all ${
                mode === "SIMULATION"
                  ? "bg-tactical-cyan/20 border border-tactical-cyan shadow-[0_0_10px_rgba(0,240,255,0.2)] text-tactical-cyan font-bold"
                  : "border border-tactical-cyan/40 hover:bg-tactical-cyan/20 text-tactical-cyan/60"
              } ${transitioning ? "opacity-50 cursor-not-allowed" : ""}`}
            >
              SIMULATION
            </button>
          </div>
          {transitioning && (
            <div className="mt-1 text-tactical-yellow text-[9px] animate-pulse">
              Transitioning to {mode === "SIMULATION" ? "HARDWARE" : "SIMULATION"}...
            </div>
          )}
          {transitionError && (
            <div className="mt-1 text-tactical-red text-[9px]">
              {transitionError}
            </div>
          )}
        </div>

        {/* Fault Injection */}
        <div>
          <div className="text-tactical-cyan/60 mb-1">ANOMALY_INJECTION</div>
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => triggerFault("SENSOR_LOSS")}
              className={`py-1 border ${activeFault === "SENSOR_LOSS" ? "bg-tactical-red/30 border-tactical-red" : "border-tactical-red/40 hover:bg-tactical-red/10 text-tactical-red/80"} transition-colors`}
            >
              SENSOR_LOSS
            </button>
            <button
              onClick={() => triggerFault("LEAK_DETECT")}
              className={`py-1 border ${activeFault === "LEAK_DETECT" ? "bg-tactical-red/30 border-tactical-red" : "border-tactical-red/40 hover:bg-tactical-red/10 text-tactical-red/80"} transition-colors`}
            >
              LEAK_DETECT
            </button>
            <button
              onClick={() => triggerFault("THRUSTER_OVERLOAD")}
              className="col-span-2 py-1 border border-tactical-red/40 hover:bg-tactical-red/10 text-tactical-red/80 transition-colors"
            >
              THRUSTER_OVERLOAD
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
