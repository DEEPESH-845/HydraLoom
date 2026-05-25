"use client";

import { useEffect, useRef } from "react";
import { useTelemetryStore } from "@/lib/store/telemetryStore";

export function AIDetectionOverlay() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    let animationFrameId: number;
    // Map to keep track of smoothed bounding boxes
    const smoothedBoxes = new Map<number, { x: number, y: number, w: number, h: number, lockedAt: number }>();

    const renderLoop = (time: number) => {
      // Clear canvas
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      
      // Get latest state without triggering a React re-render
      const store = useTelemetryStore.getState();
      if (!store.isOnline) {
        animationFrameId = requestAnimationFrame(renderLoop);
        return;
      }
      
      const detections = store.detections;
      
      const width = canvas.width;
      const height = canvas.height;

      // Clean up old boxes
      const currentIds = new Set(detections.map(d => d.id));
      for (const id of smoothedBoxes.keys()) {
        if (!currentIds.has(id)) smoothedBoxes.delete(id);
      }

      for (const d of detections) {
         // Telemetry bbox is normalized [x, y, w, h] from center
         const targetX = d.bbox[0] * width;
         const targetY = d.bbox[1] * height;
         const targetW = d.bbox[2] * width;
         const targetH = d.bbox[3] * height;

         let box = smoothedBoxes.get(d.id);
         if (!box) {
           box = { x: targetX, y: targetY, w: targetW, h: targetH, lockedAt: time };
           smoothedBoxes.set(d.id, box);
         } else {
           // Simple interpolation (lerp) towards target for fluid motion
           box.x += (targetX - box.x) * 0.2;
           box.y += (targetY - box.y) * 0.2;
           box.w += (targetW - box.w) * 0.2;
           box.h += (targetH - box.h) * 0.2;
         }

         const isCritical = d.class.toLowerCase().includes("crack") || d.class.toLowerCase().includes("leak") || d.class.toLowerCase().includes("anomaly");
         const color = isCritical ? "rgba(255, 42, 42, 1)" : "rgba(0, 240, 255, 1)";
         const glowColor = isCritical ? "rgba(255, 42, 42, 0.8)" : "rgba(0, 240, 255, 0.8)";
         
         const isLocked = (time - box.lockedAt) > 600;

         // Draw Box Corners
         ctx.save();
         ctx.translate(box.x, box.y);
         
         if (!isLocked) {
             ctx.globalAlpha = 0.5 + Math.sin(time * 0.01) * 0.5;
             const scale = 1.0 + Math.max(0, 1.0 - (time - box.lockedAt)/600.0) * 0.5;
             ctx.scale(scale, scale);
         }
         
         ctx.shadowColor = glowColor;
         ctx.shadowBlur = 15;
         ctx.strokeStyle = color;
         ctx.lineWidth = 2;
         
         // Top Left
         ctx.beginPath();
         ctx.moveTo(-box.w/2, -box.h/2 + 20);
         ctx.lineTo(-box.w/2, -box.h/2);
         ctx.lineTo(-box.w/2 + 20, -box.h/2);
         ctx.stroke();

         // Top Right
         ctx.beginPath();
         ctx.moveTo(box.w/2 - 20, -box.h/2);
         ctx.lineTo(box.w/2, -box.h/2);
         ctx.lineTo(box.w/2, -box.h/2 + 20);
         ctx.stroke();

         // Bottom Right
         ctx.beginPath();
         ctx.moveTo(box.w/2, box.h/2 - 20);
         ctx.lineTo(box.w/2, box.h/2);
         ctx.lineTo(box.w/2 - 20, box.h/2);
         ctx.stroke();

         // Bottom Left
         ctx.beginPath();
         ctx.moveTo(-box.w/2 + 20, box.h/2);
         ctx.lineTo(-box.w/2, box.h/2);
         ctx.lineTo(-box.w/2, box.h/2 - 20);
         ctx.stroke();

         // Draw Target Center
         ctx.shadowBlur = 0;
         const centerPulse = Math.sin(time * 0.005) * 2;
         ctx.beginPath();
         ctx.arc(0, 0, 3 + centerPulse, 0, Math.PI * 2);
         ctx.strokeStyle = "rgba(255, 255, 255, 0.8)";
         ctx.stroke();
         
         // Scanline
         const scanY = ((time * 0.05) % box.h) - box.h/2;
         ctx.shadowBlur = 10;
         ctx.shadowColor = color;
         ctx.beginPath();
         ctx.moveTo(-box.w/2, scanY);
         ctx.lineTo(box.w/2, scanY);
         ctx.strokeStyle = color;
         ctx.globalAlpha = 0.4;
         ctx.stroke();
         ctx.globalAlpha = 1.0;

         // Draw Text Background
         if (isLocked) {
             const isTop = (box.y - box.h/2) < 50;
             const labelY = isTop ? box.h/2 + 5 : -box.h/2 - 40;
             
             ctx.fillStyle = "rgba(1, 5, 8, 0.8)";
             ctx.fillRect(-box.w/2, labelY, box.w, 35);
             ctx.beginPath();
             ctx.moveTo(-box.w/2, isTop ? labelY : labelY + 35);
             ctx.lineTo(-box.w/2 + box.w, isTop ? labelY : labelY + 35);
             ctx.strokeStyle = color;
             ctx.lineWidth = 1;
             ctx.stroke();

             ctx.fillStyle = "white";
             ctx.font = "bold 10px monospace";
             ctx.fillText(`TRK_ID:${d.id}  ${d.class}`, -box.w/2 + 5, labelY + 15);
             
             ctx.fillStyle = color;
             ctx.fillText(`[${(d.confidence * 100).toFixed(1)}%]`, -box.w/2 + 5, labelY + 30);
         }

         ctx.restore();
      }

      animationFrameId = requestAnimationFrame(renderLoop);
    };

    const resize = () => {
      // Match parent size
      const parent = canvas.parentElement;
      if (parent) {
        canvas.width = parent.clientWidth;
        canvas.height = parent.clientHeight;
      }
    };

    window.addEventListener("resize", resize);
    resize();
    animationFrameId = requestAnimationFrame(renderLoop);

    return () => {
      window.removeEventListener("resize", resize);
      cancelAnimationFrame(animationFrameId);
    };
  }, []);

  return (
    <div className="absolute inset-0 pointer-events-none z-30">
      {/* Outer Tactical Frame */}
      <div className="absolute inset-4 border border-white/5 rounded-3xl" />
      <canvas ref={canvasRef} className="w-full h-full" />
    </div>
  );
}
