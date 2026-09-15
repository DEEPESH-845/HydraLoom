"use client";

import clsx from "clsx";
import { memo } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useShallow } from "zustand/react/shallow";
import { CAMERA } from "@/lib/sim/constants";
import { FEED_ELEMENT_ID, useSimStore } from "@/lib/sim/store";
import { f1, isTargetClass, pct } from "./shared";

/**
 * Camera feed frame. The body is fully transparent: the 3D renderer paints the gantry
 * camera view into the #gantry-camera-feed rectangle on the WebGL canvas underneath.
 * Only the header has a background; the body is a 1 px border plus DOM overlays.
 */
/** Smallest rendered feed height (220 px column, 4:3); only used to decide where a box label goes, so the label never clips at any column width. */
const FEED_H = 165;

export function CameraFeed() {
  const { frame, x, y } = useSimStore(useShallow((s) => ({ frame: s.telemetry.camera.frame, x: s.telemetry.gantry.x, y: s.telemetry.gantry.y })));

  return (
    <div className="panel border-line-strong">
      <div className="flex items-center justify-between gap-2 border-b border-line px-2.5 py-1.5">
        <div className="flex items-center gap-2 whitespace-nowrap">
          <span className="label text-text">Camera feed</span>
          <span className="sim-tag">SIMULATED</span>
        </div>
        <span className="value whitespace-nowrap text-[9px] text-muted max-[999px]:hidden">
          {CAMERA.fps} FPS f{frame} {CAMERA.resolution.replace(" (simulated)", "")}
        </span>
        {/* compact column: the readout moves up here so it cannot collide with box tags in a 176 or 220 px feed */}
        <span className="value whitespace-nowrap text-[10px] text-teal min-[1000px]:hidden">
          X {f1(x)}&nbsp;&nbsp;Y {f1(y)}
        </span>
      </div>

      {/* The render is inset in the opaque panel so the feed reads as an instrument, not a hole into the 3D room. */}
      <div className="p-1.5">
        <div id={FEED_ELEMENT_ID} className="relative w-full overflow-hidden border border-line" style={{ aspectRatio: "4 / 3", background: "transparent" }}>
          {/* a shade darker than the lab view, plus lens fall-off, so the inset reads as a camera, not a viewport */}
          <div className="pointer-events-none absolute inset-0" style={{ background: "radial-gradient(ellipse at center, rgba(0,0,0,0.22) 50%, rgba(0,0,0,0.55) 100%)" }} />
          {/* crosshair */}
          <div className="pointer-events-none absolute left-1/2 top-1/2 h-4 w-px -translate-x-1/2 -translate-y-1/2 bg-teal/70" />
          <div className="pointer-events-none absolute left-1/2 top-1/2 h-px w-4 -translate-x-1/2 -translate-y-1/2 bg-teal/70" />
          {/* frame corners */}
          <div className="pointer-events-none absolute left-1 top-1 h-2 w-2 border-l border-t border-line-strong" />
          <div className="pointer-events-none absolute right-1 top-1 h-2 w-2 border-r border-t border-line-strong" />
          <div className="pointer-events-none absolute bottom-1 left-1 h-2 w-2 border-b border-l border-line-strong" />
          <div className="pointer-events-none absolute bottom-1 right-1 h-2 w-2 border-b border-r border-line-strong" />
          {/* position readout */}
          <div className="value pointer-events-none absolute bottom-1.5 left-2 bg-ground/70 px-1 text-[10px] text-teal max-[999px]:hidden">
            X {f1(x)}&nbsp;&nbsp;Y {f1(y)} cm
          </div>
          <div className="label pointer-events-none absolute right-2 top-1.5 bg-ground/70 px-1 text-[9px]">CAM D</div>
          <BoundingBoxes />
        </div>
      </div>
    </div>
  );
}

// Memoised so the 20 Hz frame counter in the header does not re-render six animated boxes.
const BoundingBoxes = memo(function BoundingBoxes() {
  const detections = useSimStore((s) => s.detections);
  return (
    <div className="pointer-events-none absolute inset-0">
      <AnimatePresence>
        {detections.map((d) => {
          const target = isTargetClass(d.class);
          const color = target ? "border-amber" : "border-teal";
          const text = target ? "text-amber" : "text-teal";
          const [u, v, w, h] = d.bbox;
          // Label sits above the box unless the box touches the frame top; clamp right so it never leaves the feed.
          const labelInside = v * FEED_H < 14;
          const labelRight = u + w > 0.72;
          const tagInside = v + h > 0.94;
          return (
            <motion.div
              key={d.objectId}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="absolute"
              style={{ left: `${u * 100}%`, top: `${v * 100}%`, width: `${w * 100}%`, height: `${h * 100}%` }}
            >
              <span className={clsx("absolute -left-px -top-px h-2.5 w-2.5 border-l border-t", color)} />
              <span className={clsx("absolute -right-px -top-px h-2.5 w-2.5 border-r border-t", color)} />
              <span className={clsx("absolute -bottom-px -left-px h-2.5 w-2.5 border-b border-l", color)} />
              <span className={clsx("absolute -bottom-px -right-px h-2.5 w-2.5 border-b border-r", color)} />
              <div
                className={clsx(
                  "value absolute whitespace-nowrap bg-ground/70 px-1 py-px text-[10px] leading-none",
                  labelInside ? (labelRight ? "top-5" : "top-0.5") : "-top-4",
                  labelRight ? "right-0" : "left-0",
                  text,
                )}
              >
                {d.class} {pct(d.confidence)}
              </div>
              <div
                className={clsx(
                  "value absolute right-0 whitespace-nowrap bg-ground/70 px-1 py-px text-[9px] leading-none tracking-[0.1em]",
                  tagInside ? "bottom-0.5" : "-bottom-4",
                  d.state === "LOCKED" ? text : "animate-pulse text-muted motion-reduce:animate-none",
                )}
              >
                {d.state}
              </div>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
});
