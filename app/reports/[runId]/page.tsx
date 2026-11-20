import type { Metadata } from "next";
import { RunReport } from "@/components/evaluation/report/RunReport";

type Props = { params: Promise<{ runId: string }>; searchParams: Promise<{ report?: string | string[] }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { runId } = await params;
  return { title: `${runId} - Analysis - GANTRYLAB`, description: "Performance analysis and AI engineering report for one evaluation run." };
}

export default async function RunReportPage({ params, searchParams }: Props) {
  const { runId } = await params;
  const { report } = await searchParams;
  return <RunReport runId={runId} initialReportId={typeof report === "string" ? report : null} />;
}
