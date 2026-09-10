import type { Metadata } from "next";

import { OverviewExplorer } from "@/components/metrics/overview-explorer";

export const metadata: Metadata = {
  title: "Overview | AI Accountant Product Metrics",
  description: "Internal product metrics overview.",
};

export default function OverviewPage() {
  return <OverviewExplorer />;
}
