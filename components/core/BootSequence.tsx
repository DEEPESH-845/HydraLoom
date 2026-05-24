"use client";

import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";

export function BootSequence({ onComplete }: { onComplete: () => void }) {
  const [stage, setStage] = useState(0);

  useEffect(() => {
    const sequence = async () => {
      await new Promise((r) => setTimeout(r, 800));
      setStage(1); // Establishing Tether
      await new Promise((r) => setTimeout(r, 1200));
      setStage(2); // Connecting IMU
      await new Promise((r) => setTimeout(r, 900));
      setStage(3); // Initializing Camera
      await new Promise((r) => setTimeout(r, 1500));
      setStage(4); // Boot Complete
      await new Promise((r) => setTimeout(r, 500));
      onComplete();
    };
    sequence();
  }, [onComplete]);

  return (
    <AnimatePresence>
      <motion.div
        key="boot"
        className="fixed inset-0 z-[100] bg-black flex flex-col items-center justify-center font-mono text-tactical-cyan"
        exit={{ opacity: 0, scale: 1.05 }}
        transition={{ duration: 1, ease: "easeInOut" }}
      >
        <div className="w-96 flex flex-col space-y-4">
          <div className="text-2xl font-bold tracking-widest border-b border-tactical-cyan/40 pb-2 mb-4">
            HYDRALOOM OS v2.4
          </div>
          
          <div className="space-y-2 text-sm opacity-80">
            <div className="flex justify-between">
              <span>KERNEL_LOAD</span>
              <span>[OK]</span>
            </div>
            {stage >= 1 && (
              <div className="flex justify-between">
                <span>ESTABLISHING_TETHER_LINK</span>
                <span className="text-tactical-green">[OK]</span>
              </div>
            )}
            {stage >= 2 && (
              <div className="flex justify-between">
                <span>IMU_CALIBRATION</span>
                <span className="text-tactical-green">[OK]</span>
              </div>
            )}
            {stage >= 3 && (
              <div className="flex justify-between">
                <span>VIDEO_STREAM_SYNC</span>
                <span className="text-tactical-green">[OK]</span>
              </div>
            )}
          </div>

          <div className="mt-8 h-1 w-full bg-tactical-cyan/20 overflow-hidden relative">
            <motion.div
              className="absolute top-0 left-0 h-full bg-tactical-cyan"
              initial={{ width: "0%" }}
              animate={{ width: `${(stage / 4) * 100}%` }}
              transition={{ ease: "easeInOut", duration: 0.5 }}
            />
          </div>
          
          {stage >= 4 && (
            <motion.div 
              className="text-center mt-4 text-tactical-green font-bold tracking-widest animate-pulse"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
            >
              SYSTEM ONLINE
            </motion.div>
          )}
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
