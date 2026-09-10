import { jsonError, jsonOk, proxyIfUpstream } from "@/lib/json-route";
import { heatmapCell } from "@/lib/metrics-server";

export async function GET(request: Request) {
  const proxied = await proxyIfUpstream(request);
  if (proxied) return proxied;
  const params = new URL(request.url).searchParams;
  const cohortWeek = params.get("cohort_week");
  const relRaw = params.get("rel_week");
  if (!cohortWeek || !/^\d{4}-\d{2}-\d{2}$/.test(cohortWeek)) {
    return jsonError("cohort_week must be YYYY-MM-DD", 400);
  }
  const relWeek = Number(relRaw);
  if (!Number.isInteger(relWeek) || relWeek < 0 || relWeek > 8) {
    return jsonError("rel_week must be an integer 0..8", 400);
  }
  try {
    return jsonOk(await heatmapCell(cohortWeek, relWeek));
  } catch {
    return jsonError("cell unavailable", 500);
  }
}
