import { jsonError, jsonOk, proxyIfUpstream } from "@/lib/json-route";
import { companyTimeline, TIMELINE_MAX_LIMIT } from "@/lib/metrics-server";

export async function GET(
  request: Request,
  context: { params: Promise<{ companyId: string }> },
) {
  const proxied = await proxyIfUpstream(request);
  if (proxied) return proxied;
  const { companyId } = await context.params;
  const params = new URL(request.url).searchParams;
  const limitRaw = params.get("limit") ?? "100";
  const offsetRaw = params.get("offset") ?? "0";
  const limit = Number(limitRaw);
  const offset = Number(offsetRaw);
  if (!Number.isInteger(limit) || limit < 1) {
    return jsonError("limit must be an integer 1..500", 400);
  }
  if (!Number.isInteger(offset) || offset < 0) {
    return jsonError("offset must be a non-negative integer", 400);
  }
  const clamped = Math.min(limit, TIMELINE_MAX_LIMIT);
  try {
    return jsonOk(
      await companyTimeline(decodeURIComponent(companyId), clamped, offset),
    );
  } catch {
    return jsonError("timeline unavailable", 500);
  }
}
