import { jsonError, jsonOk, proxyIfUpstream } from "@/lib/json-route";
import { overviewSlice } from "@/lib/metrics-server";

export async function GET(request: Request) {
  const proxied = await proxyIfUpstream(request);
  if (proxied) return proxied;
  try {
    return jsonOk(await overviewSlice(new URL(request.url).searchParams));
  } catch (error) {
    const message = error instanceof Error ? error.message : "overview slice unavailable";
    return jsonError(message, message.startsWith("invalid") || message.includes("required") || message.includes("must be") ? 400 : 500);
  }
}
