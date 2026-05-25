"use client";

import { useState } from "react";
import { useTelemetryStore } from "@/lib/store/telemetryStore";
import { Topbar } from "@/components/dashboard/Topbar";
import { GlassPanel } from "@/components/core/GlassPanel";
import { useTelemetryBridge } from "@/lib/hooks/useTelemetryBridge";
import { ArtificialHorizon } from "@/components/telemetry/ArtificialHorizon";
import { DepthGauge } from "@/components/telemetry/DepthGauge";
import { ThrusterPanel } from "@/components/propulsion/ThrusterPanel";
import { VideoFeed } from "@/components/video/VideoFeed";
import { RadarPanel } from "@/components/systems/RadarPanel";
import { SystemLogs } from "@/components/systems/SystemLogs";
import { BootSequence } from "@/components/core/BootSequence";
import { ControlCenter } from "@/components/dashboard/ControlCenter";

export default function Dashboard() {
  const [isBooted, setIsBooted] = useState(false);
  useTelemetryBridge();
  const leakDetected = useTelemetryStore((state) => state.leakDetected);

  return (
    <>
      {!isBooted && <BootSequence onComplete={() => setIsBooted(true)} />}
      
      {/* Leak Detection Global Overlay */}
      {leakDetected && (
        <div className="fixed inset-0 z-50 pointer-events-none flex items-center justify-center">
          <div className="absolute inset-0 border-[8px] border-tactical-red animate-pulse" />
          <div className="absolute inset-0 bg-tactical-red/10 animate-pulse" />
          <div className="bg-tactical-red/90 text-black font-black font-mono text-4xl px-8 py-4 tracking-[0.5em] shadow-[0_0_50px_rgba(255,0,0,0.8)] border-4 border-black uppercase text-center animate-bounce">
            CRITICAL HULL BREACH DETECTED<br/>
            <span className="text-xl tracking-widest opacity-80 mt-2 block">IMMEDIATE SURFACE REQUIRED</span>
          </div>
        </div>
      )}

      <div className={`flex flex-col h-screen w-screen overflow-hidden p-4 space-y-4 transition-opacity duration-1000 ${isBooted ? "opacity-100" : "opacity-0"}`}>
        {/* TOPBAR */}
        <Topbar />
        
        {/* DIGITAL TWIN CONTROL CENTER */}
        <ControlCenter />

        {/* MAIN GRID */}
        <div className="flex-1 grid grid-cols-12 grid-rows-6 gap-4 min-h-0">
          
          {/* LEFT COLUMN - TELEMETRY */}
          <div className="col-span-3 row-span-6 flex flex-col space-y-4">
            <GlassPanel title="Orientation" className="flex-1 p-0">
              <ArtificialHorizon />
            </GlassPanel>
            <GlassPanel title="Depth Profile" className="flex-1 p-0">
              <DepthGauge />
            </GlassPanel>
          </div>

          {/* CENTER COLUMN - CAMERA & AI OVERLAY */}
          <div className="col-span-6 row-span-4 relative flex flex-col">
            <GlassPanel title="Camera Feed 01 - Forward" className="flex-1 p-0 overflow-hidden">
              <VideoFeed />
            </GlassPanel>
          </div>

          {/* CENTER BOTTOM - THRUSTERS */}
          <div className="col-span-6 row-span-2">
            <GlassPanel title="Propulsion Diagnostics" className="p-0">
              <ThrusterPanel />
            </GlassPanel>
          </div>

          {/* RIGHT COLUMN - SYSTEMS */}
          <div className="col-span-3 row-span-6 flex flex-col space-y-4">
            <GlassPanel title="Acoustic Sonar" className="flex-1 p-0">
              <RadarPanel />
            </GlassPanel>
            <GlassPanel title="System Logs" className="flex-1 p-0">
              <SystemLogs />
            </GlassPanel>
          </div>

        </div>
      </div>
    </>
  );
}
