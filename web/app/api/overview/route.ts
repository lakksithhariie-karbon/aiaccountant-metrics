import { jsonError, jsonOk, proxyIfUpstream } from "@/lib/json-route";
import { overview } from "@/lib/metrics-server";

export async function GET(request: Request) {
  const proxied = await proxyIfUpstream(request);
  if (proxied) return proxied;
  try {
    return jsonOk(await overview());
  } catch {
    return jsonError("overview unavailable", 500);
  }
}
