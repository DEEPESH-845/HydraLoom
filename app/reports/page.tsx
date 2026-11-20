import type { Metadata } from "next";
import { ReportsIndex } from "@/components/evaluation/ReportsIndex";

export const metadata: Metadata = {
  title: "Analysis and Reports - GANTRYLAB",
  description: "Performance analysis of evaluation runs, environment comparisons and AI engineering reports.",
};

export default function ReportsPage() {
  return <ReportsIndex />;
}
