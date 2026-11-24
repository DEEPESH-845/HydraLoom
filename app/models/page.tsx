import type { Metadata } from "next";
import { ModelLab } from "@/components/evaluation/ModelLab";

export const metadata: Metadata = {
  title: "Model Lab - GANTRYLAB",
  description: "Upload a trained detector, map its classes and evaluate it against synthetic ground truth from the digital twin.",
};

export default function ModelsPage() {
  return <ModelLab />;
}
