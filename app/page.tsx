import type { Metadata } from "next";
import { FieldApp } from "@/components/platform/FieldApp";

export const metadata: Metadata = {
  title: "GANTRYLAB - Underwater Digital Twin",
  description: "Multi-environment underwater robotics digital twin: environments, vehicles, water and current, missions, synthetic datasets and model evaluation. Simulated.",
};

export default function Page() {
  return <FieldApp />;
}
