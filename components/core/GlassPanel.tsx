"use client";

import { motion, HTMLMotionProps } from "framer-motion";
import { cn } from "@/lib/utils";

interface GlassPanelProps extends HTMLMotionProps<"div"> {
  title?: string;
  className?: string;
  children: React.ReactNode;
}

export function GlassPanel({ title, className, children, ...props }: GlassPanelProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 100, damping: 20 }}
      className={cn(
        "glass-panel rounded-xl overflow-hidden flex flex-col h-full relative",
        className
      )}
      {...props}
    >
      {/* Tactical Corner Accents */}
      <div className="absolute top-0 left-0 w-4 h-4 border-t-2 border-l-2 border-tactical-cyan/60 rounded-tl-xl" />
      <div className="absolute top-0 right-0 w-4 h-4 border-t-2 border-r-2 border-tactical-cyan/60 rounded-tr-xl" />
      <div className="absolute bottom-0 left-0 w-4 h-4 border-b-2 border-l-2 border-tactical-cyan/60 rounded-bl-xl" />
      <div className="absolute bottom-0 right-0 w-4 h-4 border-b-2 border-r-2 border-tactical-cyan/60 rounded-br-xl" />

      {title && (
        <div className="px-4 py-2 border-b border-tactical-cyan/20 bg-tactical-cyan/5">
          <h2 className="text-xs font-mono font-bold tracking-widest text-tactical-cyan uppercase">
            {title}
          </h2>
        </div>
      )}
      <div className="p-4 flex-1 overflow-hidden relative">
        {children}
      </div>
    </motion.div>
  );
}
