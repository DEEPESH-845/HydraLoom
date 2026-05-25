"use client";

import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { synth } from "@/lib/audio/SynthEngine";

export function BootSequence({ onComplete }: { onComplete: () => void }) {
  const [stage, setStage] = useState(0); // 0 = awaiting interaction, 1+ = booting

  const handleInitiate = () => {
    synth.init();
    synth.playGenerator();
    setStage(1);
  };

  useEffect(() => {
    if (stage !== 1) return; // Only trigger the sequence ONCE when user clicks initiate

    const sequence = async () => {
      await new Promise((r) => setTimeout(r, 800));
      setStage(2); // Establishing Tether
      
      await new Promise((r) => setTimeout(r, 1200));
      setStage(3); // Connecting IMU
      
      await new Promise((r) => setTimeout(r, 900));
      setStage(4); // Initializing Camera
      
      await new Promise((r) => setTimeout(r, 1500));
      setStage(5); // Boot Complete
      
      await new Promise((r) => setTimeout(r, 1000));
      onComplete();
    };
    sequence();
  }, [stage, onComplete]);

  return (
    <AnimatePresence>
      <motion.div
        key="boot"
        className="fixed inset-0 z-[100] bg-black flex flex-col items-center justify-center font-mono text-tactical-cyan selection:bg-tactical-cyan selection:text-black"
        exit={{ opacity: 0, scale: 1.05 }}
        transition={{ duration: 1.5, ease: "easeInOut" }}
      >
        <div className="w-[500px] flex flex-col space-y-6">
          
          <div className="flex flex-col items-center border-b border-tactical-cyan/30 pb-6 mb-4">
            <div className="text-4xl font-bold tracking-[0.5em] text-transparent bg-clip-text bg-gradient-to-r from-tactical-cyan to-tactical-blue mb-2">
              HYDRALOOM
            </div>
            <div className="text-xs tracking-widest opacity-60">
              SUPREME TACTICAL INTELLIGENCE
            </div>
          </div>
          
          {stage === 0 ? (
            <motion.div 
              className="flex flex-col items-center justify-center space-y-8"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.5 }}
            >
              <div className="text-sm opacity-50 tracking-widest text-center uppercase">
                Warning: Classified System<br/>
                Unauthorized access is strictly prohibited.
              </div>
              
              <button 
                onClick={handleInitiate}
                className="group relative px-8 py-4 bg-tactical-cyan/5 border border-tactical-cyan/30 hover:bg-tactical-cyan/20 hover:border-tactical-cyan hover:shadow-[0_0_30px_rgba(0,240,255,0.3)] transition-all duration-300"
              >
                <div className="absolute inset-0 w-full h-full border-2 border-tactical-cyan opacity-0 group-hover:opacity-100 group-hover:scale-110 transition-all duration-300" />
                <span className="text-lg tracking-[0.2em] font-bold text-tactical-cyan group-hover:text-white">
                  [ INITIATE SECURE UPLINK ]
                </span>
              </button>
            </motion.div>
          ) : (
            <div className="space-y-4">
              <div className="space-y-2 text-sm opacity-80">
                <div className="flex justify-between">
                  <span>KERNEL_LOAD</span>
                  <span>[OK]</span>
                </div>
                {stage >= 2 && (
                  <div className="flex justify-between">
                    <span>ESTABLISHING_TETHER_LINK</span>
                    <span className="text-tactical-green">[OK]</span>
                  </div>
                )}
                {stage >= 3 && (
                  <div className="flex justify-between">
                    <span>IMU_CALIBRATION</span>
                    <span className="text-tactical-green">[OK]</span>
                  </div>
                )}
                {stage >= 4 && (
                  <div className="flex justify-between">
                    <span>VIDEO_STREAM_SYNC</span>
                    <span className="text-tactical-green">[OK]</span>
                  </div>
                )}
              </div>

              <div className="mt-8 h-[2px] w-full bg-tactical-cyan/10 overflow-hidden relative">
                <motion.div
                  className="absolute top-0 left-0 h-full bg-tactical-cyan shadow-[0_0_10px_rgba(0,240,255,0.8)]"
                  initial={{ width: "0%" }}
                  animate={{ width: `${((stage - 1) / 4) * 100}%` }}
                  transition={{ ease: "easeInOut", duration: 0.5 }}
                />
              </div>
              
              {stage >= 5 && (
                <motion.div 
                  className="text-center mt-8 text-tactical-green font-bold tracking-[0.3em] text-xl animate-pulse"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                >
                  SYSTEM ONLINE
                </motion.div>
              )}
            </div>
          )}

        </div>
        
        {/* Cinematic Scanline */}
        <div className="absolute inset-0 bg-[linear-gradient(rgba(1,5,8,0)_50%,rgba(0,0,0,0.25)_50%)] bg-[length:100%_4px] pointer-events-none opacity-40" />
      </motion.div>
    </AnimatePresence>
  );
}
