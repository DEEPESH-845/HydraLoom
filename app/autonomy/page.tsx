import type { Metadata } from "next";
import { Autonomy } from "@/components/autonomy/Autonomy";

export const metadata: Metadata = {
  title: "Autonomy - GANTRYLAB",
  description: "Learned gantry navigation and automatic vision-model switching as the water changes.",
};

export default function AutonomyPage() {
  return <Autonomy />;
}
