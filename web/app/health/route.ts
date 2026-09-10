import { jsonOk } from "@/lib/json-route";

export async function GET() {
  return jsonOk({ ok: true });
}
