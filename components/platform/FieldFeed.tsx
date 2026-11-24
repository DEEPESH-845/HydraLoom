"use client";

import clsx from "clsx";
import { memo } from "react";
import { useShallow } from "zustand/react/shallow";
import { useFieldStore } from "@/lib/field/store";
import { PLATFORMS } from "@/lib/platforms";
import { FIELD_FEED_ELEMENT_ID } from "@/components/field/common";
import { SimTag, f1, pct } from "./ui";

/**
 * The platform camera feed. The body is transparent: the field renderer paints the platform camera's view into the
 * #field-camera-feed rect of the canvas underneath (components/field/FieldScene.tsx Passes). Detection boxes are the
 * ANALYTICAL detector's (lib/field/detection.ts), not a trained network.
 */
export function FieldFeed() {
  const platformId = useFieldStore((s) => s.platformId);
  const cam = PLATFORMS[platformId].camera;
  const { depth, alt, hdg } = useFieldStore(useShallow((s) => ({ depth: s.telemetry.depthM, alt: s.telemetry.altitudeM, hdg: s.telemetry.headingDeg })));
  return (
    <div className="border border-line-strong bg-transparent">
      <div className="flex items-center justify-between gap-2 border-b border-line bg-panel/92 px-2.5 py-1.5">
        <div className="flex min-w-0 items-center gap-2 whitespace-nowrap">
          <span className="label text-text max-[759px]:hidden">Platform camera</span>
          <SimTag />
        </div>
        <span className="value truncate whitespace-nowrap text-[9px] text-muted max-[999px]:hidden">
          {cam.width}x{cam.height} {cam.hfovDeg}° HFOV {cam.fps} FPS
        </span>
      </div>
      <div className="p-1.5">
        <div
          id={FIELD_FEED_ELEMENT_ID}
          data-testid="field-feed"
          className="relative w-full overflow-hidden border border-line"
          style={{ aspectRatio: `${cam.width} / ${cam.height}`, background: "transparent", boxShadow: "0 0 0 6px color-mix(in oklab, var(--color-panel) 92%, transparent)" }}
        >
          <div className="pointer-events-none absolute inset-0" style={{ background: "radial-gradient(ellipse at center, transparent 58%, rgba(0,0,0,0.35) 100%)" }} />
          <div className="pointer-events-none absolute left-1/2 top-1/2 h-4 w-px -translate-x-1/2 -translate-y-1/2 bg-teal/60" />
          <div className="pointer-events-none absolute left-1/2 top-1/2 h-px w-4 -translate-x-1/2 -translate-y-1/2 bg-teal/60" />
          <div className="value pointer-events-none absolute bottom-1 left-1.5 bg-ground/70 px-1 text-[9px] text-teal max-[759px]:hidden">
            D {f1(depth)} m  ALT {f1(alt)} m  HDG {Math.round(hdg)}°
          </div>
          <Boxes />
        </div>
      </div>
    </div>
  );
}

const Boxes = memo(function Boxes() {
  const detections = useFieldStore((s) => s.detections);
  return (
    <div className="pointer-events-none absolute inset-0" data-testid="feed-boxes">
      {detections.map((d) => {
        const [u, v, w, h] = d.bbox;
        const labelInside = v < 0.1;
        const right = u + w > 0.7;
        return (
          <div key={d.targetId} className="absolute" style={{ left: `${u * 100}%`, top: `${v * 100}%`, width: `${w * 100}%`, height: `${h * 100}%` }} data-target={d.targetId}>
            <span className="absolute -left-px -top-px h-2 w-2 border-l border-t border-amber" />
            <span className="absolute -right-px -top-px h-2 w-2 border-r border-t border-amber" />
            <span className="absolute -bottom-px -left-px h-2 w-2 border-b border-l border-amber" />
            <span className="absolute -bottom-px -right-px h-2 w-2 border-b border-r border-amber" />
            <div className={clsx("value absolute whitespace-nowrap bg-ground/75 px-1 py-px text-[9px] leading-none text-amber", labelInside ? "top-0.5" : "-top-3.5", right ? "right-0" : "left-0")}>
              {d.class} {pct(d.confidence, 0)} <span className="text-muted">ANALYTICAL</span>
            </div>
          </div>
        );
      })}
    </div>
  );
});
