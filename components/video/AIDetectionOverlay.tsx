"use client";

import { motion } from "framer-motion";
import { useEffect, useState } from "react";

interface Detection {
  id: string;
  label: string;
  confidence: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export function AIDetectionOverlay() {
  const [detections, setDetections] = useState<Detection[]>([
    { id: "1", label: "Corrosion", confidence: 0.94, x: 30, y: 40, width: 15, height: 20 },
    { id: "2", label: "Pipe", confidence: 0.88, x: 60, y: 55, width: 25, height: 10 },
  ]);

  // Simulate AI tracking jitter
  useEffect(() => {
    let animationFrameId: number;
    let lastTime = performance.now();

    const animate = (time: number) => {
      if (time - lastTime > 100) {
        lastTime = time;
        setDetections((prev) =>
          prev.map((d) => ({
            ...d,
            x: d.x + (Math.random() - 0.5) * 0.5,
            y: d.y + (Math.random() - 0.5) * 0.5,
            width: d.width + (Math.random() - 0.5) * 0.2,
            height: d.height + (Math.random() - 0.5) * 0.2,
          }))
        );
      }
      animationFrameId = requestAnimationFrame(animate);
    };

    animationFrameId = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animationFrameId);
  }, []);

  return (
    <div className="absolute inset-0 pointer-events-none">
      {detections.map((d) => (
        <motion.div
          key={d.id}
          className="absolute border border-tactical-red/80 bg-tactical-red/5 flex flex-col justify-start"
          style={{
            left: `${d.x}%`,
            top: `${d.y}%`,
            width: `${d.width}%`,
            height: `${d.height}%`,
          }}
          layout
          transition={{ type: "tween", ease: "linear", duration: 0.1 }}
        >
          {/* Tracking Corners */}
          <div className="absolute -top-1 -left-1 w-2 h-2 border-t-2 border-l-2 border-tactical-red" />
          <div className="absolute -top-1 -right-1 w-2 h-2 border-t-2 border-r-2 border-tactical-red" />
          <div className="absolute -bottom-1 -left-1 w-2 h-2 border-b-2 border-l-2 border-tactical-red" />
          <div className="absolute -bottom-1 -right-1 w-2 h-2 border-b-2 border-r-2 border-tactical-red" />

          {/* Label */}
          <div className="absolute -top-6 left-0 bg-tactical-red/20 border border-tactical-red/50 px-1 py-0.5 whitespace-nowrap">
            <span className="text-[10px] font-mono text-white font-bold tracking-wider drop-shadow-md">
              {d.label} {(d.confidence * 100).toFixed(0)}%
            </span>
          </div>
        </motion.div>
      ))}
    </div>
  );
}
