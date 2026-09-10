export const MAX_NON_EMPTY_LINES = 100_000;
export const EVENT_PROPERTIES_VERSION = "event_properties.v1";

export const EVENT_PROPERTY_KEYS = [
  "companyName",
  "type",
  "subType",
  "status",
  "fileType",
  "source",
  "entityType",
  "transactionType",
  "action",
  "productCode",
  "widgetName",
  "flow",
  "method",
  "viewSource",
  "isReactivation",
  "items_count",
] as const;

export type JsonObject = Record<string, unknown>;

export interface EventRow {
  insert_id: string;
  event_name: string;
  event_time: string;
  distinct_id: string;
  user_id: string | null;
  uc_uuid: string | null;
  email: string | null;
  company_id: string | null;
  company: string | null;
  properties: JsonObject;
}

export interface ParseResult {
  rows: EventRow[];
  nonEmptyLines: number;
  synthesized: number;
}

function asText(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "boolean") return value ? "True" : "False";
  return String(value);
}

function scalarText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "True" : "False";
  return null;
}

function trimmedText(value: unknown): string | null {
  const text = scalarText(value)?.trim() ?? "";
  return text || null;
}

function normalizedType(value: unknown): string | null {
  const text = trimmedText(value)?.toLowerCase() ?? null;
  if (text === "gst2b") return "gstr2b";
  return text;
}

const UPLOAD_SUBTYPES = new Set(["bulk", "single", "gst_reconciliation"]);

function normalizedSubtype(value: unknown, eventName: string): string | null {
  const text = trimmedText(value)?.toLowerCase() ?? null;
  if (text === null) return null;
  if (eventName === "Upload") {
    return UPLOAD_SUBTYPES.has(text) ? text : "bank";
  }
  return text;
}

function normalizedStatus(value: unknown): string | null {
  const text = trimmedText(value);
  if (text === "success") return "Success";
  if (text === "failed") return "Failed";
  return text;
}

const UUID_VALUE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizedTransactionType(value: unknown): string | null {
  const text = trimmedText(value);
  if (!text || UUID_VALUE.test(text)) return text;
  return text.toLowerCase();
}

function normalizedNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  return null;
}

function escapedJsonString(value: string): string {
  // Python json.dumps defaults to ensure_ascii=True. JSON.stringify already
  // handles quotes and control characters, so only non-ASCII code points need
  // the Python-compatible escaping pass.
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, (character) => {
    return `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
}

function pythonJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return escapedJsonString(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "null";
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => pythonJson(item)).join(", ")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${
      Object.keys(record).sort().map((key) =>
        `${escapedJsonString(key)}: ${pythonJson(record[key])}`
      ).join(", ")
    }}`;
  }
  return escapedJsonString(String(value));
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function eventTime(properties: JsonObject): string {
  const rawTime = properties.time;
  if (rawTime === null || rawTime === undefined || rawTime === "") {
    throw new Error("event properties.time is required");
  }
  const timestamp = typeof rawTime === "number" ? rawTime : Number(rawTime);
  if (!Number.isFinite(timestamp)) {
    throw new Error("event properties.time must be numeric");
  }
  const seconds = timestamp > 1e12 ? timestamp / 1000 : timestamp;
  const result = new Date(seconds * 1000);
  if (Number.isNaN(result.getTime())) {
    throw new Error(
      "event properties.time is outside the supported date range",
    );
  }
  return result.toISOString();
}

async function synthesizedInsertId(
  eventName: string,
  properties: JsonObject,
): Promise<string> {
  const distinctId = asText(properties.distinct_id) ?? "";
  const userId = properties.userId || properties.$user_id;
  const canonical = pythonJson({
    event: eventName,
    distinct_id: distinctId,
    time: properties.time,
    companyId: properties.companyId,
    userId,
  });
  return `syn_${(await sha256Hex(canonical)).slice(0, 24)}`;
}

export async function parseJsonlLine(line: string): Promise<EventRow> {
  const payload = JSON.parse(line) as JsonObject;
  const eventName = asText(payload.event) ?? "";
  const rawProperties = payload.properties;
  const properties = (
      rawProperties && typeof rawProperties === "object" &&
      !Array.isArray(rawProperties)
    )
    ? rawProperties as JsonObject
    : {};
  const rawInsertId = properties.$insert_id;
  const hasInsertId = Boolean(rawInsertId);
  const insertId = hasInsertId
    ? asText(rawInsertId) as string
    : await synthesizedInsertId(eventName, properties);

  return {
    insert_id: insertId,
    event_name: eventName,
    event_time: eventTime(properties),
    distinct_id: asText(properties.distinct_id) ?? "",
    user_id: asText(properties.$user_id) ?? asText(properties.userId),
    uc_uuid: asText(properties.ucUuid),
    email: asText(properties.email),
    company_id: asText(properties.companyId),
    company: asText(properties.company),
    properties: warehouseProperties(properties, eventName),
  };
}

export function warehouseProperties(
  properties: JsonObject,
  eventName = "",
): JsonObject {
  const output: JsonObject = {};
  const companyName = trimmedText(properties.companyName);
  if (companyName !== null) output.companyName = companyName;

  const type = normalizedType(properties.type);
  if (type !== null) output.type = type;

  const subtype = normalizedSubtype(properties.subType, eventName);
  if (subtype !== null) output.subType = subtype;

  const status = normalizedStatus(properties.status);
  if (status !== null) output.status = status;

  const fileType = trimmedText(properties.fileType);
  if (fileType !== null) output.fileType = fileType;

  for (
    const key of [
      "source",
      "entityType",
      "action",
      "productCode",
      "widgetName",
      "flow",
      "method",
      "viewSource",
    ]
  ) {
    const value = trimmedText(properties[key]);
    if (value !== null) output[key] = value;
  }

  const transactionType = normalizedTransactionType(properties.transactionType);
  if (transactionType !== null) output.transactionType = transactionType;

  if (typeof properties.isReactivation === "boolean") {
    output.isReactivation = properties.isReactivation;
  }

  const itemsCount = normalizedNumber(properties.items_count);
  if (itemsCount !== null) output.items_count = itemsCount;

  return output;
}

export async function parseJsonl(text: string): Promise<ParseResult> {
  const rows: EventRow[] = [];
  let nonEmptyLines = 0;
  let synthesized = 0;

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    nonEmptyLines += 1;
    if (nonEmptyLines >= MAX_NON_EMPTY_LINES) {
      throw new Error(
        `Mixpanel export has ${nonEmptyLines} non-empty lines; maximum is ${
          MAX_NON_EMPTY_LINES - 1
        }`,
      );
    }
    const row = await parseJsonlLine(line);
    if (!row.insert_id.startsWith("syn_")) {
      rows.push(row);
    } else {
      synthesized += 1;
      rows.push(row);
    }
  }

  return { rows, nonEmptyLines, synthesized };
}
