import type { Metadata } from "next";
import { LabScene } from "@/components/lab/Scene";
import { LabUI } from "@/components/ui/LabUI";

export const metadata: Metadata = {
  title: "Gantry Lab - GANTRYLAB",
  description: "The bench-top aquarium and XY gantry camera rig: controlled, repeatable computer vision and hardware experiments.",
};

export default function LabPage() {
  return (
    <main className="relative h-screen w-screen overflow-hidden bg-ground">
      <div className="absolute inset-0">
        <LabScene />
      </div>
      <LabUI />
    </main>
  );
}
