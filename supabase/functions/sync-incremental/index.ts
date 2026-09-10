import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { exportDay, type DayExport } from "./export.ts";
import type { EventRow } from "./parse.ts";

const IST = "Asia/Kolkata";
const BATCH_SIZE = 500;

interface RefreshCounts {
  n_activation: number;
  n_week: number;
  n_cells: number;
  n_client: number;
  n_profile: number;
  n_week_action: number;
}

interface DayResult {
  day: string;
  rows: number;
  inserted: number;
  updated: number;
  identity_mismatches: number;
  requests: number;
}

interface UpsertResult {
  inserted: number;
  updated: number;
  identity_mismatches: number;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function istToday(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: IST,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(
    parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

function shiftDate(day: string, days: number): string {
  const value = new Date(`${day}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function validDate(day: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const value = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(value.getTime()) && value.toISOString().slice(0, 10) === day;
}

function base64UrlDecode(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function isServiceRoleJwt(request: Request): boolean {
  const authorization = request.headers.get("Authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return false;
  const token = authorization.slice("Bearer ".length).trim();
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  try {
    const claims = JSON.parse(base64UrlDecode(parts[1])) as {
      role?: string;
      app_metadata?: { role?: string };
    };
    return claims.role === "service_role" || claims.app_metadata?.role === "service_role";
  } catch {
    return false;
  }
}

function sameSecret(actual: string | null, expected: string | undefined): boolean {
  if (!actual || !expected || actual.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < actual.length; index += 1) {
    difference |= actual.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

async function requestedToday(request: Request): Promise<string> {
  if (request.method === "GET") return istToday();
  const body = await request.text();
  if (!body.trim()) return istToday();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("request body must be JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("request body must be an object");
  }
  const requested = (parsed as { today?: unknown }).today;
  if (requested === undefined) return istToday();
  if (typeof requested !== "string" || !validDate(requested)) {
    throw new Error("today must be YYYY-MM-DD");
  }
  return requested;
}

function requiredEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 500);
  return String(error).slice(0, 500);
}

function rpcError(name: string, error: { message?: string }): Error {
  return new Error(`${name} RPC failed${error.message ? `: ${error.message}` : ""}`);
}

async function upsertRows(
  client: SupabaseClient,
  rows: EventRow[],
): Promise<UpsertResult> {
  let inserted = 0;
  let updated = 0;
  let identityMismatches = 0;
  for (let start = 0; start < rows.length; start += BATCH_SIZE) {
    const batch = rows.slice(start, start + BATCH_SIZE);
    const { data, error } = await client.rpc("upsert_mixpanel_events_detail", {
      p_rows: batch,
    });
    if (error) throw rpcError("upsert_mixpanel_events_detail", error);
    const row = Array.isArray(data) ? data[0] : data;
    if (!row || typeof row !== "object") {
      throw new Error("upsert_mixpanel_events_detail returned no counts");
    }
    const counts = row as Record<string, unknown>;
    const batchInserted = Number(counts.inserted);
    const batchUpdated = Number(counts.updated);
    const batchMismatches = Number(counts.identity_mismatches);
    if (![batchInserted, batchUpdated, batchMismatches].every(Number.isFinite)) {
      throw new Error("upsert_mixpanel_events_detail returned invalid counts");
    }
    inserted += batchInserted;
    updated += batchUpdated;
    identityMismatches += batchMismatches;
    if (identityMismatches > 10) {
      throw new Error(`identity mismatches exceed 10: ${identityMismatches}`);
    }
  }
  return {
    inserted,
    updated,
    identity_mismatches: identityMismatches,
  };
}

function refreshCounts(data: unknown): RefreshCounts {
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== "object") {
    throw new Error("refresh_retention returned no counts");
  }
  const value = row as Record<string, unknown>;
  const counts = {
    n_activation: Number(value.n_activation),
    n_week: Number(value.n_week),
    n_cells: Number(value.n_cells),
    n_client: Number(value.n_client),
    n_profile: Number(value.n_profile),
    n_week_action: Number(value.n_week_action),
  };
  if (Object.values(counts).some((count) => !Number.isFinite(count))) {
    throw new Error("refresh_retention returned invalid counts");
  }
  return counts;
}

async function finish(
  client: SupabaseClient,
  ok: boolean,
  day: string | null,
  detail: string,
): Promise<void> {
  const { error } = await client.rpc("finish_incremental", {
    p_ok: ok,
    p_day: day,
    p_detail: detail,
  });
  if (error) throw rpcError("finish_incremental", error);
}

export async function handler(request: Request): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST") {
    return jsonResponse({ ok: false }, 405);
  }
  if (!isServiceRoleJwt(request) ||
      !sameSecret(request.headers.get("x-cron-secret"), Deno.env.get("CRON_SECRET"))) {
    return jsonResponse({ ok: false }, 401);
  }

  let today: string;
  try {
    today = await requestedToday(request);
  } catch (error) {
    return jsonResponse({ ok: false, error: errorMessage(error) }, 400);
  }
  const yesterday = shiftDate(today, -1);

  let client: SupabaseClient;
  try {
    client = createClient(
      requiredEnv("SUPABASE_URL"),
      requiredEnv("SUPABASE_SERVICE_ROLE_KEY"),
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
  } catch (error) {
    return jsonResponse({ ok: false, error: errorMessage(error) }, 500);
  }

  let claimed = false;
  try {
    const { data, error } = await client.rpc("try_begin_incremental");
    if (error) throw rpcError("try_begin_incremental", error);
    if (!data) return jsonResponse({ ok: false, reason: "lease" }, 409);
    claimed = true;

    const days: DayResult[] = [];
    for (const day of [yesterday, today]) {
      const exported: DayExport = await exportDay(day);
      const upserted = await upsertRows(client, exported.parsed.rows);
      days.push({
        day,
        rows: exported.rows,
        inserted: upserted.inserted,
        updated: upserted.updated,
        identity_mismatches: upserted.identity_mismatches,
        requests: exported.requests,
      });
    }

    const { data: refreshData, error: refreshError } = await client.rpc(
      "refresh_retention",
      { p_source: "public.events" },
    );
    if (refreshError) throw rpcError("refresh_retention", refreshError);
    const refresh = refreshCounts(refreshData);
    const detail = JSON.stringify({ days, refresh });
    await finish(client, true, today, detail);
    claimed = false;
    return jsonResponse({ ok: true, today, yesterday, days, refresh });
  } catch (error) {
    if (claimed) {
      try {
        await finish(client, false, null, errorMessage(error));
      } catch {
        // Preserve the original failure. The lease expiry remains the fallback.
      }
    }
    return jsonResponse({ ok: false, error: errorMessage(error) }, 503);
  }
}

if (import.meta.main) {
  Deno.serve(handler);
}
