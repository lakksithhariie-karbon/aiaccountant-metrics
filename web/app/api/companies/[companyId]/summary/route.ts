import { jsonError, jsonOk, proxyIfUpstream } from "@/lib/json-route";
import { companySummary } from "@/lib/metrics-server";

export async function GET(
  request: Request,
  context: { params: Promise<{ companyId: string }> },
) {
  const proxied = await proxyIfUpstream(request);
  if (proxied) return proxied;
  const { companyId } = await context.params;
  try {
    const payload = await companySummary(decodeURIComponent(companyId));
    if (!payload) return jsonError("unknown company", 404);
    return jsonOk(payload);
  } catch {
    return jsonError("summary unavailable", 500);
  }
}
