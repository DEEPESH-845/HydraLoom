"use client";

import clsx from "clsx";
import { useState } from "react";

export type BoxKind = "gt" | "pred" | "focus-gt" | "focus-pred";

export interface FrameBox {
  xyxy: [number, number, number, number];
  kind: BoxKind;
  label?: string;
}

const STROKE: Record<BoxKind, string> = {
  gt: "var(--color-teal)",
  "focus-gt": "var(--color-teal)",
  pred: "var(--color-amber)",
  "focus-pred": "var(--color-amber)",
};

/**
 * One dataset frame with boxes drawn in image pixel space.
 * Ground truth (from the instance-ID render pass) is teal, model detections are amber.
 */
export function FrameView({
  src,
  width,
  height,
  boxes,
  alt,
  className,
  showLabels = true,
}: {
  src: string;
  width: number;
  height: number;
  boxes: FrameBox[];
  alt: string;
  className?: string;
  showLabels?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const fs = Math.max(10, width / 48);
  return (
    <div className={clsx("relative overflow-hidden bg-ground", className)} style={{ aspectRatio: `${width} / ${height}` }}>
      {failed ? (
        <div className="absolute inset-0 flex items-center justify-center text-[11px] text-dim">Frame image unavailable</div>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element -- frames come from the backend at runtime
        <img src={src} alt={alt} loading="lazy" decoding="async" className="absolute inset-0 h-full w-full object-fill" onError={() => setFailed(true)} />
      )}
      <svg viewBox={`0 0 ${width} ${height}`} className="absolute inset-0 h-full w-full" preserveAspectRatio="none" aria-hidden>
        {boxes.map((b, i) => {
          const [x1, y1, x2, y2] = b.xyxy;
          const focus = b.kind.startsWith("focus");
          const isPred = b.kind.endsWith("pred");
          return (
            <g key={i}>
              {focus && <rect x={x1} y={y1} width={x2 - x1} height={y2 - y1} fill="none" stroke="#0b1219" strokeWidth={5} opacity={0.7} vectorEffect="non-scaling-stroke" />}
              <rect
                x={x1}
                y={y1}
                width={Math.max(1, x2 - x1)}
                height={Math.max(1, y2 - y1)}
                fill={focus ? (isPred ? "rgba(242,169,59,0.12)" : "rgba(61,185,176,0.12)") : "none"}
                stroke={STROKE[b.kind]}
                strokeWidth={focus ? 2.5 : 1.5}
                strokeDasharray={isPred && !focus ? "5 3" : undefined}
                vectorEffect="non-scaling-stroke"
              />
              {showLabels && b.label && (() => {
                const lw = b.label.length * fs * 0.62 + fs * 0.6;
                const lh = fs * 1.35;
                // keep the tag inside the frame: shift left at the right edge, drop inside the box at the top edge
                const lx = Math.max(0, Math.min(x1, width - lw));
                const ly = y1 - lh >= 0 ? y1 - lh : Math.min(height - lh, y1);
                return (
                  <g>
                    <rect x={lx} y={ly} width={lw} height={lh} fill={STROKE[b.kind]} />
                    <text x={lx + fs * 0.3} y={ly + fs * 1.02} fontSize={fs} fontFamily="var(--font-plex-mono), monospace" fill="#0b1219">
                      {b.label}
                    </text>
                  </g>
                );
              })()}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export function BoxLegend({ className }: { className?: string }) {
  return (
    <div className={clsx("flex flex-wrap items-center gap-3", className)}>
      <span className="flex items-center gap-1.5">
        <span className="h-2.5 w-3.5 border-2 border-teal" aria-hidden />
        <span className="label text-[9px]">Ground truth</span>
      </span>
      <span className="flex items-center gap-1.5">
        <span className="h-2.5 w-3.5 border-2 border-dashed border-amber" aria-hidden />
        <span className="label text-[9px]">Prediction</span>
      </span>
    </div>
  );
}

export const xywhToXyxy = (b: [number, number, number, number]): [number, number, number, number] => [b[0], b[1], b[0] + b[2], b[1] + b[3]];
