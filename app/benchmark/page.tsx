import type { Metadata } from "next";
import { Benchmark } from "@/components/bench/Benchmark";

export const metadata: Metadata = {
  title: "Model benchmark - GANTRYLAB",
  description: "Compare vision models across underwater conditions: where each performs best, where it fails, and what to change.",
};

export default function BenchmarkPage() {
  return <Benchmark />;
}
