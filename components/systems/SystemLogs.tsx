"use client";

import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useTelemetryStore } from "@/lib/store/telemetryStore";

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
  const [now, setNow] = useState("--:--:--");
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Auto scroll to bottom
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  useEffect(() => {
    const tick = () => setNow(new Date().toISOString().substring(11, 19));
    const id = setInterval(tick, 1000);
    tick();
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let idCounter = 2;
    
    // Add periodic mock logs just to keep it alive
    const interval = setInterval(() => {
      const randomLog = MOCK_LOGS[Math.floor(Math.random() * MOCK_LOGS.length)];
      setLogs((prev) => {
        const newLogs = [...prev, { id: idCounter++, text: randomLog, type: "INFO" as const }];
        if (newLogs.length > 20) newLogs.shift();
        return newLogs;
      });
    }, 4500);

    // Subscribe to YOLO event bus
    const unsub = useTelemetryStore.subscribe((state, prevState) => {
      // Find new detections that weren't in the previous state by ID
      const newDetections = state.detections.filter(
        d => !prevState.detections.some(pd => pd.id === d.id)
      );

      if (newDetections.length > 0) {
        setLogs(prev => {
          let updated = [...prev];
          newDetections.forEach(d => {
             const typeStr = (d.class.includes("ANOMALY") || d.class.includes("DEBRIS")) ? "ERR" : "WARN";
             updated.push({
               id: idCounter++,
               text: `[YOLO] ACQUIRED: ${d.class} | CONF: ${(d.confidence*100).toFixed(1)}% | TRK_ID: ${d.id}`,
               type: typeStr as "ERR" | "WARN"
             });
          });
          if (updated.length > 20) updated = updated.slice(updated.length - 20);
          return updated;
        });
      }
    });

    return () => {
       clearInterval(interval);
       unsub();
    };
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
                log.type === "ERR" ? "text-tactical-red" :
                log.type === "WARN" ? "text-yellow-400" :
                "text-tactical-cyan/70"
              }`}
            >
              <span className="opacity-50 mr-2">
                {now}
              </span>
              {log.text}
            </motion.div>
          ))}
        </AnimatePresence>
        <div ref={endRef} />
      </div>
    </div>
  );
}
