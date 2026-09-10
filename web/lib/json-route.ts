import { NextResponse } from "next/server";

export function jsonOk(payload: unknown, status = 200) {
  return NextResponse.json(payload, { status });
}

export function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function proxyIfUpstream(request: Request) {
  const origin = process.env.PRODUCT_METRICS_API_URL?.replace(/\/+$/, "");
  if (!origin) return null;
  const url = new URL(request.url);
  const response = await fetch(`${origin}${url.pathname}${url.search}`, {
    method: "GET",
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  return new NextResponse(await response.text(), {
    status: response.status,
    headers: {
      "Content-Type": response.headers.get("content-type") || "application/json",
    },
  });
}
