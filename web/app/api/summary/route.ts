import { jsonError, jsonOk, proxyIfUpstream } from "@/lib/json-route";
import { pageSummary } from "@/lib/metrics-server";
import { parseWeekFilter } from "@/lib/week-filter";

export async function GET(request: Request) {
  const proxied = await proxyIfUpstream(request);
  if (proxied) return proxied;
  try {
    const bounds = parseWeekFilter(new URL(request.url).searchParams);
    return jsonOk(await pageSummary(bounds));
  } catch (error) {
    const message = error instanceof Error ? error.message : "summary unavailable";
    if (message.includes("from_week") || message.includes("to_week") || message.includes("YYYY-MM-DD")) {
      return jsonError(message, 400);
    }
    return jsonError("summary unavailable", 500);
  }
}
