import type { Metadata } from "next";
import { HardwareBench } from "@/components/hardware/HardwareBench";

export const metadata: Metadata = {
  title: "Hardware bench - GANTRYLAB",
  description: "Connect the physical gantry, run acceptance tests against the digital twin, analyse and report.",
};

export default function HardwarePage() {
  return <HardwareBench />;
}
