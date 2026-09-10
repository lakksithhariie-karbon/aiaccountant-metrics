import { parseJsonl, type ParseResult } from "./parse.ts";

const EXPORT_URL = "https://data.mixpanel.com/api/2.0/export";
const MAX_RETRIES_429 = 5;
const REQUEST_TIMEOUT_MS = 120_000;

export interface DayExport {
  day: string;
  rows: number;
  inserted: number;
  requests: number;
  parsed: ParseResult;
}

export class MixpanelExportError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "MixpanelExportError";
    this.status = status;
  }
}

interface ExportOptions {
  fetchImpl?: typeof fetch;
  sleepImpl?: (milliseconds: number) => Promise<void>;
  timeoutMs?: number;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function basicAuth(username: string, password: string): string {
  return `Basic ${btoa(`${username}:${password}`)}`;
}

function responseErrorBody(body: string): string {
  const compact = body.trim().replace(/\s+/g, " ");
  return compact ? `: ${compact.slice(0, 200)}` : "";
}

export async function exportDay(
  day: string,
  options: ExportOptions = {},
): Promise<DayExport> {
  const projectId = Deno.env.get("MIXPANEL_PROJECT_ID") || "3490984";
  const username = Deno.env.get("MIXPANEL_SA_USERNAME");
  const password = Deno.env.get("MIXPANEL_SA_SECRET");
  if (!username || !password) {
    throw new MixpanelExportError("Mixpanel service account is not configured");
  }

  const url = new URL(EXPORT_URL);
  url.searchParams.set("project_id", projectId);
  url.searchParams.set("from_date", day);
  url.searchParams.set("to_date", day);
  url.searchParams.set("time_in_ms", "true");

  const fetchImpl = options.fetchImpl ?? fetch;
  const sleepImpl = options.sleepImpl ?? sleep;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  let requests = 0;

  for (let attempt = 0; ; attempt += 1) {
    requests += 1;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers: {
          Authorization: basicAuth(username, password),
          "Accept-Encoding": "gzip",
        },
        signal: controller.signal,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new MixpanelExportError(
        message === "The operation was aborted." || message === "Aborted"
          ? `Mixpanel export timed out for ${day}`
          : `Mixpanel export failed for ${day}: ${message}`,
      );
    } finally {
      clearTimeout(timeout);
    }

    if (response.ok) {
      const parsed = await parseJsonl(await response.text());
      return {
        day,
        rows: parsed.rows.length,
        inserted: 0,
        requests,
        parsed,
      };
    }

    const body = await response.text().catch(() => "");
    if (response.status === 401 || response.status === 403) {
      throw new MixpanelExportError(
        `Mixpanel credentials rejected for ${day}`,
        response.status,
      );
    }
    if (response.status === 429 && attempt < MAX_RETRIES_429) {
      const backoffSeconds = Math.min(30, 2 ** attempt);
      await sleepImpl(backoffSeconds * 1000);
      continue;
    }
    throw new MixpanelExportError(
      `Mixpanel export returned HTTP ${response.status} for ${day}${responseErrorBody(body)}`,
      response.status,
    );
  }
}
