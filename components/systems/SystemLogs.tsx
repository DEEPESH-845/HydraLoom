"use client";

import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";

const MOCK_LOGS = [
  "[INFO] Thruster calibration stable",
  "[INFO] Ethernet link established",
  "[INFO] Depth hold active",
  "[WARN] Packet jitter detected",
  "[INFO] Camera stream synchronized",
  "[INFO] AI inference engine initialized",
  "[WARN] High IMU noise reading",
  "[INFO] Battery voltage nominal",
  "[INFO] Sonar ping returned",
  "[INFO] Tether tension normal"
];

export function SystemLogs() {
  const [logs, setLogs] = useState<{ id: number; text: string; type: "INFO" | "WARN" | "ERR" }[]>([
    { id: 1, text: "[INFO] System Boot...", type: "INFO" },
  ]);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Auto scroll to bottom
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  useEffect(() => {
    let idCounter = 2;
    const interval = setInterval(() => {
      const randomLog = MOCK_LOGS[Math.floor(Math.random() * MOCK_LOGS.length)];
      const type: "WARN" | "INFO" = randomLog.includes("[WARN]") ? "WARN" : "INFO";
      
      setLogs((prev) => {
        const newLogs = [...prev, { id: idCounter++, text: randomLog, type }];
        if (newLogs.length > 15) newLogs.shift();
        return newLogs;
      });
    }, 3500);

    return () => clearInterval(interval);
  }, []);

  return (
    <div className="w-full h-full p-2 bg-black/40 overflow-hidden flex flex-col justify-end font-mono text-[9px] sm:text-[10px]">
      <div className="flex flex-col space-y-1">
        <AnimatePresence initial={false}>
          {logs.map((log) => (
            <motion.div
              key={log.id}
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0 }}
              className={`whitespace-nowrap ${
                log.type === "WARN" ? "text-tactical-red" : "text-tactical-cyan/70"
              }`}
            >
              <span className="opacity-50 mr-2">{new Date().toISOString().substring(11, 19)}</span>
              {log.text}
            </motion.div>
          ))}
        </AnimatePresence>
        <div ref={endRef} />
      </div>
    </div>
  );
}
