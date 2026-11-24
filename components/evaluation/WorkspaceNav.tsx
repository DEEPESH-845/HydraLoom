import clsx from "clsx";
import Link from "next/link";
import type { ReactNode } from "react";

/**
 * GANTRYLAB top bar with the workspace nav, shared by every non-3D workspace.
 * Routes: 01 Environment, 02 Platform and 03 Simulation live in the field world at the root route (/),
 * 04 Model Lab at /models, 05 Analysis and 06 Reports at /reports, 07 Benchmark, 08 Autonomy and 09 Hardware, plus the
 * Gantry Lab (/lab).
 */

export type WorkspaceId = "environment" | "platform" | "simulation" | "models" | "analysis" | "reports" | "benchmark" | "autonomy" | "hardware" | "lab";

export const WORKSPACES: { id: WorkspaceId; n: string; label: string; href: string; title: string }[] = [
  { id: "environment", n: "01", label: "Environment", href: "/", title: "Environment explorer in the field 3D world" },
  { id: "platform", n: "02", label: "Platform", href: "/?ws=platform", title: "Vehicle and sensor platform" },
  { id: "simulation", n: "03", label: "Simulation", href: "/?ws=simulation", title: "Simulation control" },
  { id: "models", n: "04", label: "Model Lab", href: "/models", title: "Upload and evaluate detection models" },
  { id: "analysis", n: "05", label: "Analysis", href: "/reports", title: "Performance analysis of evaluation runs" },
  { id: "reports", n: "06", label: "Reports", href: "/reports#engineering-reports", title: "AI engineering reports" },
  { id: "benchmark", n: "07", label: "Benchmark", href: "/benchmark", title: "Compare several models: best and failing conditions, what to change" },
  { id: "autonomy", n: "08", label: "Autonomy", href: "/autonomy", title: "Learned gantry navigation and automatic model switching" },
  { id: "hardware", n: "09", label: "Hardware", href: "/hardware", title: "The physical gantry: connect, test, analyse, report" },
];

export function WorkspaceNav({ active, right }: { active: WorkspaceId | WorkspaceId[]; right?: ReactNode }) {
  const on = (id: WorkspaceId) => (Array.isArray(active) ? active.includes(id) : active === id);
  return (
    <header
      data-eval="header"
      className="sticky top-0 z-30 flex h-12 shrink-0 items-center justify-between gap-3 border-b border-line/70 bg-ground/95 px-4 max-[479px]:px-3"
    >
      <Link href="/" className="flex min-w-0 items-center gap-3" aria-label="GANTRYLAB home">
        <span className="whitespace-nowrap font-mono text-[13px] font-semibold tracking-[0.28em] text-text max-[479px]:text-[12px] max-[479px]:tracking-[0.18em]">
          GANTRYLAB
        </span>
      </Link>
      <nav aria-label="Workspaces" className="flex min-w-0 items-stretch overflow-x-auto [scrollbar-width:none]">
        {WORKSPACES.map((w) => {
          const isOn = on(w.id);
          return (
            <Link
              key={w.id}
              href={w.href}
              title={w.title}
              aria-label={`${w.n} ${w.label}`}
              aria-current={isOn ? "page" : undefined}
              className={clsx(
                "group flex h-12 items-center gap-1.5 whitespace-nowrap border-b-2 px-2 transition-colors duration-100 max-[479px]:px-1.5",
                isOn ? "border-teal" : "border-transparent hover:border-line-strong",
              )}
            >
              <span className={clsx("value text-[10px]", isOn ? "text-teal" : "text-dim")}>{w.n}</span>
              <span
                className={clsx(
                  "label",
                  isOn ? "text-teal" : "text-muted group-hover:text-text",
                  // only the active label survives on narrow screens; numbers carry the rest
                  !isOn && "max-[1399px]:hidden",
                  isOn && "max-[599px]:hidden",
                )}
              >
                {w.label}
              </span>
            </Link>
          );
        })}
        <span className="mx-1 my-3 w-px shrink-0 bg-line max-[479px]:mx-0.5" aria-hidden />
        <Link
          href="/lab"
          title="Gantry Lab: the aquarium and XY gantry digital twin"
          aria-current={on("lab") ? "page" : undefined}
          className={clsx(
            "group flex h-12 items-center whitespace-nowrap border-b-2 px-2 transition-colors duration-100 max-[479px]:px-1.5",
            on("lab") ? "border-teal" : "border-transparent hover:border-line-strong",
          )}
        >
          <span className={clsx("label", on("lab") ? "text-teal" : "text-muted group-hover:text-text")}>
            <span className="max-[599px]:hidden">Gantry Lab</span>
            <span className="hidden max-[599px]:inline">Lab</span>
          </span>
        </Link>
      </nav>
      {right && <div className="flex shrink-0 items-center gap-1.5 max-[759px]:hidden">{right}</div>}
    </header>
  );
}
