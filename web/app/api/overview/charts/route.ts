import { jsonError, jsonOk, proxyIfUpstream } from "@/lib/json-route";
import { overviewCharts } from "@/lib/metrics-server";

export async function GET(request: Request) {
  const proxied = await proxyIfUpstream(request);
  if (proxied) return proxied;
  try {
    return jsonOk(await overviewCharts());
  } catch {
    return jsonError("overview charts unavailable", 500);
  }
}
