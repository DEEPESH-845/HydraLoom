"use client";

import { useTelemetryStore } from "@/lib/store/telemetryStore";
import { useState } from "react";

export function ControlCenter() {
  const isOnline = useTelemetryStore((state) => state.isOnline);
  const [activeFault, setActiveFault] = useState<string | null>(null);
  
  // Quick dirty WebSocket command sender
  const sendCommand = (cmd: object) => {
    try {
      const ws = new WebSocket("ws://127.0.0.1:8000/ws/command");
      ws.onopen = () => {
        ws.send(JSON.stringify(cmd));
        setTimeout(() => ws.close(), 100);
      };
    } catch(e) {
      console.error(e);
    }
  };

  const triggerFault = (fault: string) => {
    setActiveFault(fault);
    sendCommand({ type: "INJECT_FAULT", fault });
    setTimeout(() => setActiveFault(null), 3000); // UI visual reset
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
              onClick={() => sendCommand({ type: "SET_MODE", mode: "HARDWARE" })}
              className="flex-1 py-1 border border-tactical-cyan/40 hover:bg-tactical-cyan/20 transition-colors"
            >
              HARDWARE
            </button>
            <button 
              onClick={() => sendCommand({ type: "SET_MODE", mode: "SIMULATION" })}
              className="flex-1 py-1 bg-tactical-cyan/20 border border-tactical-cyan shadow-[0_0_10px_rgba(0,240,255,0.2)] text-tactical-cyan font-bold"
            >
              SIMULATION
            </button>
          </div>
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
