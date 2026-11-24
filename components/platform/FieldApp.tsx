"use client";

import dynamic from "next/dynamic";

/**
 * The field workspace renders on the client only: its store reads the last selection from localStorage, so a server
 * render would not match the first client render.
 */
const FieldWorkspace = dynamic(() => import("./FieldWorkspace").then((m) => m.FieldWorkspace), {
  ssr: false,
  loading: () => (
    <main className="flex h-screen w-screen items-center justify-center bg-ground">
      <span className="label">Loading field workspace</span>
    </main>
  ),
});

export function FieldApp() {
  return <FieldWorkspace />;
}
