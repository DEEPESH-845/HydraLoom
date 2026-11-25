"use client";

import clsx from "clsx";
import { memo, useEffect, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { targetBox } from "@/lib/field/detection";
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
          <DetectionBoxes />
        </div>
      </div>
    </div>
  );
}

/**
 * Detection boxes. Which targets are detected, and their labels, come from the 10 Hz detector; where each box is drawn
 * is reprojected every frame from the live camera pose, so a box stays on its object while the platform moves.
 */
export const DetectionBoxes = memo(function DetectionBoxes({ full = false }: { full?: boolean }) {
  const detections = useFieldStore((s) => s.detections);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const el = root.current;
      if (!el || !el.childElementCount) return;
      const engine = useFieldStore.getState().engine;
      let cam = engine.cameraPose(true);
      if (full) {
        // the pilot view keeps the platform camera's vertical field of view at the window's aspect
        const aspect = el.clientWidth / Math.max(1, el.clientHeight);
        cam = { ...cam, aspect, hfovDeg: (2 * Math.atan((Math.tan((cam.hfovDeg * Math.PI) / 360) / cam.aspect) * aspect) * 180) / Math.PI };
      }
      for (const child of Array.from(el.children) as HTMLElement[]) {
        const t = engine.targets.find((x) => x.id === child.dataset.target);
        const b = t ? targetBox(cam, t) : null;
        // empty, not "visible": the feed itself may be hidden (explore mode)
        child.style.visibility = b ? "" : "hidden";
        if (!b) continue;
        child.style.left = `${b[0] * 100}%`;
        child.style.top = `${b[1] * 100}%`;
        child.style.width = `${b[2] * 100}%`;
        child.style.height = `${b[3] * 100}%`;
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [full]);
  return (
    <div ref={root} className="pointer-events-none absolute inset-0" data-testid={full ? "pilot-boxes" : "feed-boxes"}>
      {detections.map((d) => {
        const [u, v, w, h] = d.bbox;
        const labelInside = v < 0.1;
        const right = u + w > 0.7;
        const coasting = d.state === "COASTING";
        return (
          <div key={d.targetId} className={clsx("absolute", coasting && "opacity-60")} style={{ left: `${u * 100}%`, top: `${v * 100}%`, width: `${w * 100}%`, height: `${h * 100}%` }} data-target={d.targetId}>
            <span className="absolute -left-px -top-px h-2 w-2 border-l border-t border-amber" />
            <span className="absolute -right-px -top-px h-2 w-2 border-r border-t border-amber" />
            <span className="absolute -bottom-px -left-px h-2 w-2 border-b border-l border-amber" />
            <span className="absolute -bottom-px -right-px h-2 w-2 border-b border-r border-amber" />
            <div className={clsx("value absolute whitespace-nowrap bg-ground/75 px-1 py-px text-[9px] leading-none text-amber", labelInside ? "top-0.5" : "-top-3.5", right ? "right-0" : "left-0")}>
              {d.class} {pct(d.confidence, 0)} <span className="text-muted">{coasting ? "TRACK" : "ANALYTICAL"}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
});

/** What the platform camera detects right now, shown in every view and with the panels hidden. */
export function DetectionStrip() {
  const detections = useFieldStore((s) => s.detections);
  const guarded = useFieldStore((s) => s.telemetry.guarded);
  const exploring = useFieldStore((s) => s.exploring);
  const list = [...detections].sort((a, b) => b.confidence - a.confidence).slice(0, 4);
  // nothing detected: say whether that is the water's doing
  const ahead = useFieldStore(useShallow((s) => (s.detections.length || !s.engine.vehicle || s.telemetry.time < 0 ? null : s.engine.nearestAhead())));
  const hint = ahead && ahead.distanceM < Math.max(6, 2 * ahead.reachM) ? ahead : null;
  if (!list.length && !guarded && !hint) return null;
  return (
    <div role="status" aria-label="Detected now" data-testid="detection-strip" className={clsx("pointer-events-none absolute left-1/2 top-[6.25rem] z-10 flex -translate-x-1/2 flex-wrap justify-center gap-1.5", exploring ? "max-w-[calc(100%-2rem)]" : "max-w-[calc(100%-760px)] max-[999px]:hidden")}>
      {list.map((d) => (
        <span key={d.targetId} className={clsx("value border bg-ground/85 px-2 py-1 text-[11px]", d.class === "UNKNOWN" ? "border-line-strong text-muted" : "border-amber/70 text-text", d.state === "COASTING" && "opacity-60")}>
          {d.class} {pct(d.confidence, 0)} <span className="text-dim">{f1(d.distance)} m</span>
        </span>
      ))}
      {hint && (
        <span className="value border border-line-strong bg-ground/85 px-2 py-1 text-[11px] text-muted" data-testid="out-of-range">
          {hint.class} {f1(hint.distanceM)} m ahead, not readable: {hint.distanceM > hint.reachM ? `the camera reads ${f1(hint.reachM)} m in this water` : "too little of it in view"}
        </span>
      )}
      {guarded && <span className="value border border-line-strong bg-ground/85 px-2 py-1 text-[11px] text-muted">Holding off an edge or obstacle</span>}
    </div>
  );
}
