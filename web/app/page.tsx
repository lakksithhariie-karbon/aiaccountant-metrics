import type { Metadata } from "next";

import { RetentionExplorer } from "@/components/metrics/retention-explorer";

export const metadata: Metadata = {
  title: "Retention | AI Accountant Product Metrics",
};

export default function Page() {
  return <RetentionExplorer />;
}
