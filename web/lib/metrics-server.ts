import { isInternalEmail } from "@/lib/internal-email";
import { sql } from "@/lib/db";
import type { WeekBounds } from "@/lib/week-filter";
import type { OverviewFeatureType, OverviewStageBreakdown, OverviewWindow } from "@/lib/types";

const TIMEZONE = "Asia/Kolkata";
const VALUE_EVENTS = ["Accounting Sync", "Recon Processed"] as const;
const INTEGRATION_EVENT = "Integration status";
const READY_EVENTS = ["Invoice Created", "Transaction Ledger Updated"] as const;
const LEDGER_EVENTS = [
  "Transaction Ledger Updated",
  "Transaction Status",
  "Transaction Type Updated",
  "Transaction Configuration Edited",
  "Vendor Mismatch Resolved",
] as const;
const UPLOAD_TYPE_ORDER = [
  "invoice",
  "bill",
  "statement",
  "gstr2b",
  "purchase_register",
  "unknown",
] as const;
const ACTION_EVENTS = [
  "Upload",
  "Mapping Completed",
  "Saved Template Loaded",
  "Invoice Created",
  "Invoice Bulk Edited",
  "Download-Inv",
  "Preview",
  "Transaction Ledger Updated",
  "Transaction Status",
  "Transaction Type Updated",
  "Transaction Configuration Edited",
  "Vendor Mismatch Resolved",
  "Accounting Sync",
  "Recon Processed",
  "Entity Created",
  "Delete",
  "Download",
  "Export",
] as const;
const PRODUCT_SPLIT_FLAGS = [
  { key: "had_bill_upload", label: "Bill" },
  { key: "had_invoice_upload", label: "Invoice" },
  { key: "had_statement_upload", label: "Statement" },
  { key: "had_ap_active", label: "AP" },
  { key: "had_txn_active", label: "Txn" },
  { key: "had_gst_recon", label: "GST" },
] as const;
const PRODUCT_SPLIT_KEYS = new Set(PRODUCT_SPLIT_FLAGS.map((item) => item.key));
const CELL_COMPANY_LIMIT = 5000;
const BY_EVENT_LIMIT = 40;
const TIMELINE_MAX_LIMIT = 500;
const CHAIN_PROPERTY_KEYS = [
  "type",
  "subType",
  "status",
  "action",
  "source",
  "transactionType",
  "items_count",
  "entityType",
  "fileType",
  "productCode",
  "flow",
  "method",
] as const;
const CHAIN_BRANCH_ORDER = ["txn", "ap", "ar", "gst", "other"] as const;
const CHAIN_BRANCH_LABELS: Record<string, string> = {
  txn: "Txn",
  ap: "AP",
  ar: "AR",
  gst: "GST",
  other: "Other",
};
const CHAIN_READY_EVENTS: Record<string, string> = {
  txn: "Transaction Ledger Updated",
  ap: "Invoice Created",
};
const CHAIN_EVENT_NAMES = Array.from(new Set([
  "Sign Up",
  INTEGRATION_EVENT,
  ...ACTION_EVENTS,
]));
const CHAIN_EVENT_ORDER = [
  "Upload",
  "Mapping Completed",
  "Saved Template Loaded",
  "Entity Created",
  "Transaction Type Updated",
  "Transaction Configuration Edited",
  "Transaction Status",
  "Transaction Ledger Updated",
  "Vendor Mismatch Resolved",
  "Invoice Bulk Edited",
  "Download-Inv",
  "Preview",
  "Invoice Created",
  "Download",
  "Delete",
  "Export",
];

function isoDate(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value.slice(0, 10);
  if (value instanceof Date) {
    const year = value.getUTCFullYear();
    const month = String(value.getUTCMonth() + 1).padStart(2, "0");
    const day = String(value.getUTCDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  return String(value).slice(0, 10);
}

function isoStamp(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function asNumber(value: unknown): number {
  return Number(value ?? 0);
}

function eventProperty(properties: unknown, key: string): unknown {
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return null;
  const value = (properties as Record<string, unknown>)[key];
  if (typeof value === "string") return value.trim() || null;
  return value ?? null;
}

function uploadType(properties: unknown): string {
  const value = eventProperty(properties, "type");
  return value == null ? "unknown" : String(value).trim().toLowerCase() || "unknown";
}

function failedUpload(properties: unknown): boolean {
  const value = eventProperty(properties, "status");
  return typeof value === "string" && value.toLowerCase() === "failed";
}

function uuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function uploadTypeLabel(value: string): string {
  if (value === "unknown") return "Unknown";
  return value.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function durationHours(startAt: Date | null, endAt: Date | null): number | null {
  if (!startAt || !endAt) return null;
  const seconds = (endAt.getTime() - startAt.getTime()) / 1000;
  if (seconds < 0) return null;
  return Math.round((seconds / 3600) * 10) / 10;
}

function perWeek(lifetimeActions: number, activeWeeks: number): number {
  if (!activeWeeks) return 0;
  return Math.round((lifetimeActions / activeWeeks) * 10) / 10;
}

function asDate(value: unknown): Date | null {
  if (value == null) return null;
  if (value instanceof Date) return value;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function istMonday(): Date {
  const now = new Date(
    new Date().toLocaleString("en-US", { timeZone: TIMEZONE }),
  );
  const day = now.getDay();
  const offset = day === 0 ? -6 : 1 - day;
  now.setDate(now.getDate() + offset);
  now.setHours(0, 0, 0, 0);
  return now;
}

function addDays(iso: string, days: number): string {
  const value = new Date(`${iso}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

const FEATURE_USAGE_MODULES = [
  { key: "txn", label: "Txn", nodes: [
    ["upload_statement", "Statement upload"],
    ["ledger", "Transaction Ledger Updated"],
    ["type_updated", "Transaction Type Updated"],
    ["status", "Transaction Status"],
    ["configuration", "Transaction Configuration Edited"],
    ["vendor_mismatch", "Vendor Mismatch Resolved"],
    ["sync", "Accounting Sync"],
  ] },
  { key: "ap", label: "AP", nodes: [
    ["upload_bill", "Bill upload"],
    ["entity_bill", "Entity Created"],
    ["invoice_created", "Invoice Created"],
    ["invoice_bulk", "Invoice Bulk Edited"],
    ["preview", "Preview"],
    ["download_inv", "Download-Inv"],
    ["sync", "Accounting Sync"],
  ] },
  { key: "ar", label: "AR", note: "Warehouse has invoice uploads. AR work events are not defined yet.", nodes: [
    ["upload_invoice", "Invoice upload"],
    ["sync", "Accounting Sync"],
  ] },
  { key: "gst", label: "GST", nodes: [
    ["upload_gst", "GST upload"],
    ["download_recon", "Download reconciled"],
    ["export", "Export"],
    ["recon", "Recon Processed"],
  ] },
] as const;

function normEventType(value: unknown): string | null {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return null;
  return text === "gst2b" ? "gstr2b" : text;
}

function featureNodeKey(eventName: string, typeValue: string | null, status: unknown, entityType: unknown): string | null {
  const failed = String(status ?? "") === "Failed";
  if (eventName === "Upload" && !failed) {
    if (typeValue === "statement") return "txn.upload_statement";
    if (typeValue === "bill") return "ap.upload_bill";
    if (typeValue === "invoice") return "ar.upload_invoice";
    if (typeValue === "gstr2b" || typeValue === "purchase_register") return "gst.upload_gst";
  }
  if (eventName === "Transaction Ledger Updated") return "txn.ledger";
  if (eventName === "Transaction Type Updated") return "txn.type_updated";
  if (eventName === "Transaction Status") return "txn.status";
  if (eventName === "Transaction Configuration Edited") return "txn.configuration";
  if (eventName === "Vendor Mismatch Resolved") return "txn.vendor_mismatch";
  if (eventName === "Entity Created" && String(entityType ?? "").trim().toLowerCase() === "bill") return "ap.entity_bill";
  if (eventName === "Invoice Created") return "ap.invoice_created";
  if (eventName === "Invoice Bulk Edited") return "ap.invoice_bulk";
  if (eventName === "Preview") return "ap.preview";
  if (eventName === "Download-Inv") return "ap.download_inv";
  if (eventName === "Download" && typeValue === "reconciled_excel") return "gst.download_recon";
  if (eventName === "Export" && typeValue === "gst_reconciliation") return "gst.export";
  if (eventName === "Recon Processed") return "gst.recon";
  if (eventName === "Accounting Sync") return "sync.raw";
  return null;
}

async function featureUsage(week: string) {
  const db = sql();
  const weekEnd = addDays(week, 7);
  const rows = await db`
    SELECT e.company_id, e.event_name,
           e.properties->>'type' AS type,
           e.properties->>'status' AS status,
           e.properties->>'entityType' AS entity_type
    FROM public.events e
    WHERE EXISTS (SELECT 1 FROM client_company c WHERE c.company_id = e.company_id)
      AND e.event_time >= (${week}::date AT TIME ZONE ${TIMEZONE})
      AND e.event_time < (${weekEnd}::date AT TIME ZONE ${TIMEZONE})
  `;
  const nodeCompanies = new Map<string, Set<string>>();
  const nodeEvents = new Map<string, number>();
  const nodeTypes = new Map<string, Map<string, { events: number; companies: Set<string> }>>();
  const pathIds: Record<string, Set<string>> = { txn: new Set(), ap: new Set(), ar: new Set(), gst: new Set() };
  const syncIds = new Set<string>();
  for (const row of rows) {
    const companyId = String(row.company_id);
    const typeValue = normEventType(row.type);
    const nodeKey = featureNodeKey(String(row.event_name), typeValue, row.status, row.entity_type);
    if (!nodeKey) continue;
    if (nodeKey === "sync.raw") {
      syncIds.add(companyId);
      continue;
    }
    const moduleKey = nodeKey.split(".")[0];
    pathIds[moduleKey]?.add(companyId);
    if (!nodeCompanies.has(nodeKey)) nodeCompanies.set(nodeKey, new Set());
    nodeCompanies.get(nodeKey)!.add(companyId);
    nodeEvents.set(nodeKey, (nodeEvents.get(nodeKey) ?? 0) + 1);
    if (typeValue) {
      if (!nodeTypes.has(nodeKey)) nodeTypes.set(nodeKey, new Map());
      const types = nodeTypes.get(nodeKey)!;
      const bucket = types.get(typeValue) ?? { events: 0, companies: new Set<string>() };
      bucket.events += 1;
      bucket.companies.add(companyId);
      types.set(typeValue, bucket);
    }
  }
  const syncEvents = rows.filter((row) => String(row.event_name) === "Accounting Sync");
  return {
    week_start: week,
    modules: FEATURE_USAGE_MODULES.map((module) => {
      const path = pathIds[module.key];
      const synced = new Set([...path].filter((id) => syncIds.has(id)));
      return {
        key: module.key,
        label: module.label,
        companies: path.size,
        note: "note" in module ? module.note : null,
        nodes: module.nodes.map(([nodeKey, label]) => {
          if (nodeKey === "sync") {
            const typeMap = new Map<string, { events: number; companies: Set<string> }>();
            let events = 0;
            for (const row of syncEvents) {
              if (!synced.has(String(row.company_id))) continue;
              events += 1;
              const typeValue = normEventType(row.type);
              if (!typeValue) continue;
              const bucket = typeMap.get(typeValue) ?? { events: 0, companies: new Set<string>() };
              bucket.events += 1;
              bucket.companies.add(String(row.company_id));
              typeMap.set(typeValue, bucket);
            }
            return {
              key: nodeKey,
              label,
              companies: synced.size,
              events,
              types: [...typeMap.entries()].map(([value, bucket]) => ({
                value, events: bucket.events, companies: bucket.companies.size,
              })),
            };
          }
          const full = `${module.key}.${nodeKey}`;
          const types = [...(nodeTypes.get(full)?.entries() ?? [])]
            .map(([value, bucket]) => ({ value, events: bucket.events, companies: bucket.companies.size }))
            .sort((a, b) => b.events - a.events || a.value.localeCompare(b.value));
          return {
            key: nodeKey,
            label,
            companies: nodeCompanies.get(full)?.size ?? 0,
            events: nodeEvents.get(full) ?? 0,
            types,
          };
        }),
      };
    }),
  };
}

type ModuleUsageRow = {
  company_id: unknown;
  distinct_id: unknown;
  email: unknown;
  event_name: unknown;
  event_time: unknown;
  properties: unknown;
};

function moduleNodeKey(moduleKey: string, row: ModuleUsageRow): string | null {
  const node = featureNodeKey(
    String(row.event_name),
    normEventType(eventProperty(row.properties, "type")),
    eventProperty(row.properties, "status"),
    eventProperty(row.properties, "entityType"),
  );
  if (node === "sync.raw") return `${moduleKey}.sync`;
  return node?.startsWith(`${moduleKey}.`) ? node : null;
}

function propertyValue(value: unknown, key: string): string | null {
  const result = eventProperty(value, key);
  if (result == null) return null;
  const normalized = key === "type" ? normEventType(result) : String(result).trim();
  return normalized || null;
}

function moduleBreakdown(rows: ModuleUsageRow[]): OverviewStageBreakdown[] {
  const buckets = new Map<string, { key: string; value: string; events: number; companies: Set<string> }>();
  for (const row of rows) {
    const companyId = String(row.company_id);
    for (const key of CHAIN_PROPERTY_KEYS) {
      const value = propertyValue(row.properties, key);
      if (!value) continue;
      const bucketKey = `${key}\u0000${value}`;
      const bucket = buckets.get(bucketKey) ?? { key, value, events: 0, companies: new Set<string>() };
      bucket.events += 1;
      bucket.companies.add(companyId);
      buckets.set(bucketKey, bucket);
    }
  }
  return [...buckets.values()]
    .map((bucket) => ({
      key: bucket.key,
      label: bucket.key,
      value: bucket.value,
      events: bucket.events,
      count: bucket.events,
      companies: bucket.companies.size,
    }))
    .sort((a, b) => Number(b.events ?? 0) - Number(a.events ?? 0)
      || String(a.key).localeCompare(String(b.key))
      || String(a.value).localeCompare(String(b.value)));
}

function moduleTypes(rows: ModuleUsageRow[]): OverviewFeatureType[] {
  return moduleBreakdown(rows)
    .filter((item) => item.key === "type" && item.value)
    .map((item) => ({
      value: String(item.value),
      events: Number(item.events ?? item.count ?? 0),
      companies: Number(item.companies ?? 0),
    }));
}

function failedModuleNodeKey(row: ModuleUsageRow): string | null {
  if (String(row.event_name) !== "Upload" || !failedUpload(row.properties)) return null;
  const typeValue = normEventType(eventProperty(row.properties, "type"));
  if (typeValue === "bill") return "ap.upload_bill";
  if (typeValue === "invoice") return "ar.upload_invoice";
  if (typeValue === "statement") return "txn.upload_statement";
  if (["gstr2b", "purchase_register"].includes(typeValue || "")) return "gst.upload_gst";
  return null;
}

function modulePropertyGroups(rows: ModuleUsageRow[]) {
  const grouped = new Map<string, Map<string, { events: number; companies: Set<string> }>>();
  for (const row of rows) {
    const companyId = String(row.company_id);
    for (const key of CHAIN_PROPERTY_KEYS) {
      const value = propertyValue(row.properties, key);
      if (!value) continue;
      const values = grouped.get(key) ?? new Map<string, { events: number; companies: Set<string> }>();
      const bucket = values.get(value) ?? { events: 0, companies: new Set<string>() };
      bucket.events += 1;
      bucket.companies.add(companyId);
      values.set(value, bucket);
      grouped.set(key, values);
    }
  }
  return [...grouped.entries()].map(([key, values]) => ({
    key,
    values: [...values.entries()]
      .map(([value, bucket]) => ({ value, events: bucket.events, companies: bucket.companies.size }))
      .sort((a, b) => b.events - a.events || a.value.localeCompare(b.value))
      .slice(0, 8),
  }));
}

async function moduleUsage(start: string, end: string, granularity: "week" | "month") {
  const db = sql();
  const rows = await db<ModuleUsageRow[]>`
    SELECT e.company_id, e.distinct_id, e.email, e.event_name, e.event_time, e.properties
    FROM public.events e
    WHERE EXISTS (SELECT 1 FROM client_company c WHERE c.company_id = e.company_id)
      AND e.event_time >= (${start}::date::timestamp AT TIME ZONE ${TIMEZONE})
      AND e.event_time < (${end}::date::timestamp AT TIME ZONE ${TIMEZONE})
  `;
  const byCompany = new Map<string, ModuleUsageRow[]>();
  for (const row of rows) {
    const companyId = String(row.company_id);
    const companyRows = byCompany.get(companyId) ?? [];
    companyRows.push(row);
    byCompany.set(companyId, companyRows);
  }
  const failedByStage = new Map<string, ModuleUsageRow[]>();
  for (const row of rows) {
    const failedNode = failedModuleNodeKey(row);
    if (!failedNode) continue;
    const failedRows = failedByStage.get(failedNode) ?? [];
    failedRows.push(row);
    failedByStage.set(failedNode, failedRows);
  }

  const modules = FEATURE_USAGE_MODULES.map((definition) => {
    const stageRows = new Map<string, ModuleUsageRow[]>();
    const moduleRows: ModuleUsageRow[] = [];
    for (const companyRows of byCompany.values()) {
      const nonSyncRows = companyRows.filter((row) => {
        const key = moduleNodeKey(definition.key, row);
        return key != null && key !== `${definition.key}.sync`;
      });
      if (nonSyncRows.length) {
        moduleRows.push(...nonSyncRows);
        for (const row of nonSyncRows) {
          const key = moduleNodeKey(definition.key, row)!;
          const bucket = stageRows.get(key) ?? [];
          bucket.push(row);
          stageRows.set(key, bucket);
        }
      }
    }

    const entryByCompany = new Map<string, Date>();
    for (const row of moduleRows) {
      const companyId = String(row.company_id);
      const timestamp = asDate(row.event_time);
      if (!timestamp) continue;
      const current = entryByCompany.get(companyId);
      if (!current || timestamp < current) entryByCompany.set(companyId, timestamp);
    }

    const syncRows: ModuleUsageRow[] = [];
    for (const companyRows of byCompany.values()) {
      const companyId = String(companyRows[0]?.company_id ?? "");
      const entry = entryByCompany.get(companyId);
      if (!entry) continue;
      for (const row of companyRows) {
        if (String(row.event_name) !== "Accounting Sync") continue;
        const timestamp = asDate(row.event_time);
        if (timestamp && timestamp >= entry) syncRows.push(row);
      }
    }
    if (syncRows.length) stageRows.set(`${definition.key}.sync`, syncRows);

    const stageAccumulators = definition.nodes.map(([nodeKey, label]) => {
      const rowsForStage = stageRows.get(`${definition.key}.${nodeKey}`) ?? [];
      const companies = new Set(rowsForStage.map((row) => String(row.company_id)));
      const people = new Set(
        rowsForStage
          .filter((row) => !isInternalEmail(row.email == null ? null : String(row.email)))
          .map((row) => String(row.distinct_id))
          .filter(Boolean),
      );
      return {
        nodeKey,
        label,
        rows: rowsForStage,
        companies,
        people,
      };
    });
    const entryCompanies = stageAccumulators[0]?.companies.size ?? 0;
    const stages = stageAccumulators.map((stage, index) => {
      const previous = index > 0 ? stageAccumulators[index - 1] : null;
      const reached = stage.companies.size;
      const previousReached = previous?.companies.size ?? entryCompanies;
      const conversion = previousReached ? reached / previousReached : null;
      const first = stage.rows
        .map((row) => asDate(row.event_time))
        .filter((value): value is Date => value != null)
        .sort((a, b) => a.getTime() - b.getTime())[0];
      const last = stage.rows
        .map((row) => asDate(row.event_time))
        .filter((value): value is Date => value != null)
        .sort((a, b) => b.getTime() - a.getTime())[0];
      const breakdown = moduleBreakdown(stage.rows);
      const propertyGroups = modulePropertyGroups(stage.rows);
      const eventCounts = new Map<string, number>();
      for (const row of stage.rows) {
        const eventName = String(row.event_name);
        eventCounts.set(eventName, (eventCounts.get(eventName) ?? 0) + 1);
      }
      return {
        key: stage.nodeKey,
        label: stage.label,
        event_names: [...eventCounts.entries()].map(([event_name, count]) => ({ event_name, count })),
        reached,
        reach: reached,
        previous_reached: index ? previousReached : null,
        dropped: index ? Math.max(previousReached - reached, 0) : 0,
        companies: reached,
        people: stage.people.size,
        events: stage.rows.length,
        first_at: isoStamp(first),
        last_at: isoStamp(last),
        conversion_rate: index ? conversion : reached ? 1 : 0,
        conversion: index ? conversion : reached ? 1 : 0,
        breakdown,
        property_breakdown: breakdown,
        properties: propertyGroups,
        failed_events: failedByStage.get(`${definition.key}.${stage.nodeKey}`)?.length ?? 0,
        types: moduleTypes(stage.rows),
      };
    });
    const modulePeople = new Set(
      moduleRows
        .filter((row) => !isInternalEmail(row.email == null ? null : String(row.email)))
        .map((row) => String(row.distinct_id))
        .filter(Boolean),
    );
    const moduleCompanies = new Set(moduleRows.map((row) => String(row.company_id)));
    return {
      key: definition.key,
      label: definition.label,
      window_start: start,
      window_end: end,
      granularity,
      companies: moduleCompanies.size,
      people: modulePeople.size,
      note: "note" in definition ? definition.note : null,
      stages,
      property_breakdown: moduleBreakdown([...moduleRows, ...syncRows]),
      nodes: stages.map((stage) => ({
        key: stage.key,
        label: stage.label,
        companies: stage.companies,
        events: stage.events,
        types: stage.types,
      })),
    };
  });
  return { window_start: start, window_end: end, granularity, modules };
}

async function adoptionWindow(
  start: string,
  end: string,
  key: "week" | "month",
  label: string,
) {
  const db = sql();
  const [counts] = await db`
    WITH clocks AS (
      SELECT c.company_id,
             COALESCE(
               MIN(e.event_time) FILTER (WHERE e.event_name = 'Company Created'),
               MIN(e.event_time)
             ) AS first_seen_at,
             MIN(e.event_time) FILTER (WHERE e.event_name = ${INTEGRATION_EVENT}) AS integration_at,
             MIN(e.event_time) FILTER (WHERE e.event_name = 'Accounting Sync') AS sync_at
      FROM client_company c
      LEFT JOIN public.events e ON e.company_id = c.company_id
      GROUP BY c.company_id
    ), cohort AS (
      SELECT * FROM clocks
      WHERE first_seen_at >= (${start}::date::timestamp AT TIME ZONE ${TIMEZONE})
        AND first_seen_at < (${end}::date::timestamp AT TIME ZONE ${TIMEZONE})
    )
    SELECT COUNT(*)::int AS new_companies,
           COUNT(*) FILTER (
             WHERE integration_at IS NOT NULL
               AND integration_at >= first_seen_at
               AND integration_at < (${end}::date::timestamp AT TIME ZONE ${TIMEZONE})
           )::int AS integrated,
           COUNT(*) FILTER (
             WHERE EXISTS (
               SELECT 1 FROM public.events upload_event
               WHERE upload_event.company_id = cohort.company_id
                 AND upload_event.event_name = 'Upload'
                 AND upload_event.event_time >= first_seen_at
             )
           )::int AS uploaded,
           COUNT(*) FILTER (
             WHERE EXISTS (
               SELECT 1 FROM public.events ready_event
               WHERE ready_event.company_id = cohort.company_id
                 AND ready_event.event_name = ANY(${[...READY_EVENTS]})
                 AND ready_event.event_time >= first_seen_at
             )
           )::int AS ready,
           COUNT(*) FILTER (
             WHERE integration_at IS NOT NULL
               AND sync_at IS NOT NULL
               AND sync_at >= integration_at
               AND sync_at < (${end}::date::timestamp AT TIME ZONE ${TIMEZONE})
           )::int AS activated,
           COUNT(*) FILTER (
             WHERE integration_at IS NOT NULL
               AND sync_at IS NOT NULL
               AND sync_at >= integration_at
               AND EXISTS (
                 SELECT 1 FROM public.events active_event
                 WHERE active_event.company_id = cohort.company_id
                   AND active_event.event_name = ANY(${[...ACTION_EVENTS]})
                   AND active_event.event_time >= (${start}::date::timestamp AT TIME ZONE ${TIMEZONE})
                   AND active_event.event_time < (${end}::date::timestamp AT TIME ZONE ${TIMEZONE})
                   AND active_event.event_time >= sync_at
               )
           )::int AS active
    FROM cohort
  `;
  const [peopleRow] = await db`
    WITH clocks AS (
      SELECT c.company_id,
             COALESCE(
               MIN(e.event_time) FILTER (WHERE e.event_name = 'Company Created'),
               MIN(e.event_time)
             ) AS first_seen_at,
             MIN(e.event_time) FILTER (WHERE e.event_name = ${INTEGRATION_EVENT}) AS integration_at,
             MIN(e.event_time) FILTER (WHERE e.event_name = 'Accounting Sync') AS sync_at
      FROM client_company c
      LEFT JOIN public.events e ON e.company_id = c.company_id
      GROUP BY c.company_id
    ), cohort AS (
      SELECT * FROM clocks
      WHERE first_seen_at >= (${start}::date::timestamp AT TIME ZONE ${TIMEZONE})
        AND first_seen_at < (${end}::date::timestamp AT TIME ZONE ${TIMEZONE})
        AND integration_at IS NOT NULL
        AND sync_at IS NOT NULL
        AND sync_at >= integration_at
    )
    SELECT COUNT(DISTINCT e.distinct_id)::int AS active_people
    FROM public.events e
    JOIN cohort c ON c.company_id = e.company_id
    WHERE e.event_name = ANY(${[...ACTION_EVENTS]})
      AND e.distinct_id IS NOT NULL
      AND NOT public.is_internal_email(e.email)
      AND e.event_time >= (${start}::date::timestamp AT TIME ZONE ${TIMEZONE})
      AND e.event_time < (${end}::date::timestamp AT TIME ZONE ${TIMEZONE})
      AND e.event_time >= c.sync_at
  `;
  const values = [
    asNumber(counts?.new_companies),
    asNumber(counts?.integrated),
    asNumber(counts?.uploaded),
    asNumber(counts?.ready),
    asNumber(counts?.activated),
    asNumber(counts?.active),
  ];
  const keys = ["signup", "integration", "upload", "ready", "sync", "active"] as const;
  const labels = ["Signup", "Integration status", "Upload", "Ready", "First Accounting Sync", "Active after sync"];
  const stages = keys.map((stage, index) => {
    const previous = index ? values[index - 1] : null;
    const reached = values[index];
    const conversion = previous ? reached / previous : reached ? 1 : 0;
    return {
      key: stage,
      label: labels[index],
      companies: reached,
      reached,
      reach: reached,
      previous_reached: previous,
      dropped: previous == null ? 0 : Math.max(previous - reached, 0),
      conversion_rate: conversion,
      conversion,
      window_start: start,
      window_end: end,
    };
  });
  const journeyIndexes = [0, 1, 4, 5];
  const journey = journeyIndexes.map((stageIndex, index) => {
    const stage = stages[stageIndex];
    const previous = index ? values[journeyIndexes[index - 1]] : null;
    const conversion = previous ? stage.reached / previous : stage.reached ? 1 : 0;
    return {
      ...stage,
      previous_reached: previous,
      dropped: previous == null ? 0 : Math.max(previous - stage.reached, 0),
      conversion_rate: conversion,
      conversion,
    };
  });
  return {
    key,
    label,
    granularity: key,
    window_start: start,
    window_end: end,
    cohort_size: values[0],
    new_companies: values[0],
    active_people: asNumber(peopleRow?.active_people),
    active_companies: values[5],
    stages,
    funnel: stages,
    journey,
  };
}

async function adoptionPayload(stamps: {
  weekStart: string;
  monthStart: string;
}) {
  const [week, month] = await Promise.all([
    adoptionWindow(stamps.weekStart, addDays(stamps.weekStart, 7), "week", "This week"),
    adoptionWindow(stamps.monthStart, addMonths(stamps.monthStart, 1), "month", "This month"),
  ]);
  return {
    default_period: "month",
    periods: { week, month },
    windows: [week, month],
    week,
    month,
  };
}

async function overviewAdoptionSlice(params: URLSearchParams) {
  const key = params.get("key") || "";
  const mode = params.get("mode") || "reached";
  const granularity = params.get("granularity") === "month" || params.get("month") ? "month" : "week";
  const rawStart = params.get("window_start") || params.get(granularity);
  const start = requiredDate(rawStart, granularity === "month" ? "month" : "week", {
    monday: granularity === "week",
    monthStart: granularity === "month",
  });
  const end = params.get("window_end") || (granularity === "month" ? addMonths(start, 1) : addDays(start, 7));
  requiredDate(end, "window_end");
  const conditions: Record<string, string> = {
    signup: "TRUE",
    integration: `EXISTS (SELECT 1 FROM public.events e WHERE e.company_id = f.company_id AND e.event_name = '${INTEGRATION_EVENT}' AND e.event_time >= f.first_at)`,
    upload: `EXISTS (SELECT 1 FROM public.events e WHERE e.company_id = f.company_id AND e.event_name = 'Upload' AND e.event_time >= f.first_at)`,
    ready: `EXISTS (SELECT 1 FROM public.events e WHERE e.company_id = f.company_id AND e.event_name = ANY($4::text[]) AND e.event_time >= f.first_at)`,
    sync: "f.integration_at IS NOT NULL AND f.sync_at IS NOT NULL AND f.sync_at >= f.integration_at",
    activation: "f.integration_at IS NOT NULL AND f.sync_at IS NOT NULL AND f.sync_at >= f.integration_at",
    active: `f.integration_at IS NOT NULL AND f.sync_at IS NOT NULL AND f.sync_at >= f.integration_at AND EXISTS (SELECT 1 FROM public.events e WHERE e.company_id = f.company_id AND e.event_name = ANY($2::text[]) AND e.event_time >= ($1::date::timestamp AT TIME ZONE '${TIMEZONE}') AND e.event_time < ($3::date::timestamp AT TIME ZONE '${TIMEZONE}') AND e.event_time >= f.sync_at AND NOT public.is_internal_email(e.email))`,
  };
  const ordered = ["signup", "integration", "upload", "ready", "sync", "active"];
  if (!conditions[key] || !["reached", "dropped"].includes(mode)) {
    throw new Error("invalid adoption slice");
  }
  if (mode === "dropped" && key === "signup") throw new Error("invalid adoption slice");
  const current = conditions[key];
  const previous = mode === "dropped" ? conditions[ordered[ordered.indexOf(key) - 1]] : null;
  const where = mode === "dropped" ? `(${previous}) AND NOT (${current})` : current;
  const db = sql();
  const rows = await db.unsafe<{ company_id: string }[]>(
    `WITH query_params AS (
       SELECT $1::date AS window_start,
              $2::text[] AS action_names,
              $3::date AS window_end,
              $4::text[] AS ready_names
     ), first_seen AS (
       SELECT c.company_id,
              COALESCE(
                MIN(e.event_time) FILTER (WHERE e.event_name = 'Company Created'),
                MIN(e.event_time)
              ) AS first_at,
              MIN(e.event_time) FILTER (WHERE e.event_name = '${INTEGRATION_EVENT}') AS integration_at,
              MIN(e.event_time) FILTER (WHERE e.event_name = 'Accounting Sync') AS sync_at
       FROM client_company c
       JOIN public.events e ON e.company_id = c.company_id
       GROUP BY c.company_id
     )
     SELECT f.company_id
     FROM first_seen f
     WHERE f.first_at >= ($1::date AT TIME ZONE '${TIMEZONE}')
       AND f.first_at < ($3::date AT TIME ZONE '${TIMEZONE}')
       AND ${where}
     ORDER BY f.company_id`,
    [start, [...ACTION_EVENTS], end, [...READY_EVENTS]],
  );
  const adoption = await adoptionWindow(start, end, granularity, granularity === "week" ? "This week" : "This month");
  return {
    ...(await overviewSlicePayload(rows.map((row) => String(row.company_id)))),
    adoption: {
      key,
      mode,
      granularity,
      window_start: start,
      window_end: end,
      stage: adoption.stages.find((stage) => stage.key === key) ?? null,
    },
  };
}

function moduleStagePredicate(moduleKey: string, stageKey: string | null, alias = "e"): string {
  const type = `lower(btrim(COALESCE(${alias}.properties->>'type', ''))) `;
  const status = `lower(btrim(COALESCE(${alias}.properties->>'status', ''))) `;
  const upload = `${alias}.event_name = 'Upload' AND ${status} <> 'failed'`;
  const predicates: Record<string, string> = {
    "txn.upload_statement": `${upload} AND ${type} = 'statement'`,
    "txn.ledger": `${alias}.event_name = 'Transaction Ledger Updated'`,
    "txn.type_updated": `${alias}.event_name = 'Transaction Type Updated'`,
    "txn.status": `${alias}.event_name = 'Transaction Status'`,
    "txn.configuration": `${alias}.event_name = 'Transaction Configuration Edited'`,
    "txn.vendor_mismatch": `${alias}.event_name = 'Vendor Mismatch Resolved'`,
    "ap.upload_bill": `${upload} AND ${type} = 'bill'`,
    "ap.entity_bill": `${alias}.event_name = 'Entity Created' AND lower(btrim(COALESCE(${alias}.properties->>'entityType', ''))) = 'bill'`,
    "ap.invoice_created": `${alias}.event_name = 'Invoice Created'`,
    "ap.invoice_bulk": `${alias}.event_name = 'Invoice Bulk Edited'`,
    "ap.preview": `${alias}.event_name = 'Preview'`,
    "ap.download_inv": `${alias}.event_name = 'Download-Inv'`,
    "ar.upload_invoice": `${upload} AND ${type} = 'invoice'`,
    "gst.upload_gst": `${upload} AND ${type} IN ('gstr2b', 'gst2b', 'purchase_register')`,
    "gst.download_recon": `${alias}.event_name = 'Download' AND ${type} = 'reconciled_excel'`,
    "gst.export": `${alias}.event_name = 'Export' AND ${type} = 'gst_reconciliation'`,
    "gst.recon": `${alias}.event_name = 'Recon Processed'`,
  };
  if (stageKey) {
    if (stageKey === "sync") {
      const path = FEATURE_USAGE_MODULES.find((module) => module.key === moduleKey)?.nodes
        .filter(([node]) => node !== "sync")
        .map(([node]) => predicates[`${moduleKey}.${node}`])
        .filter(Boolean);
      if (!path?.length) throw new Error("invalid module key");
      return `${alias}.event_name = 'Accounting Sync' AND EXISTS (SELECT 1 FROM public.events prior_event WHERE prior_event.company_id = ${alias}.company_id AND (${path.join(" OR ")}))`;
    }
    const predicate = predicates[`${moduleKey}.${stageKey}`];
    if (!predicate) throw new Error("invalid module stage");
    return predicate;
  }
  const path = FEATURE_USAGE_MODULES.find((module) => module.key === moduleKey)?.nodes
    .map(([node]) => node === "sync" ? `${alias}.event_name = 'Accounting Sync'` : predicates[`${moduleKey}.${node}`])
    .filter(Boolean);
  if (!path?.length) throw new Error("invalid module key");
  return `(${path.join(" OR ")})`;
}

async function overviewModuleSlice(params: URLSearchParams) {
  const key = params.get("key") || "";
  const moduleKey = params.get("module") || key.split(".")[0];
  const stageKey = params.get("stage") || (key.includes(".") ? key.split(".").slice(1).join(".") : null);
  if (!FEATURE_USAGE_MODULES.some((module) => module.key === moduleKey)) {
    throw new Error("invalid module key");
  }
  const granularity = params.get("granularity") === "month" || params.get("month") ? "month" : "week";
  const rawStart = params.get("window_start") || params.get(granularity);
  const start = requiredDate(rawStart, granularity === "month" ? "month" : "week", {
    monday: granularity === "week",
    monthStart: granularity === "month",
  });
  const end = params.get("window_end") || (granularity === "month" ? addMonths(start, 1) : addDays(start, 7));
  requiredDate(end, "window_end");
  const propertyKey = params.get("property");
  if (propertyKey && !CHAIN_PROPERTY_KEYS.includes(propertyKey as typeof CHAIN_PROPERTY_KEYS[number])) {
    throw new Error("invalid module property");
  }
  const propertyValueParam = params.get("value");
  const db = sql();
  const rows = await db`
    SELECT e.company_id, e.distinct_id, e.email, e.event_name, e.event_time, e.properties
    FROM public.events e
    WHERE EXISTS (SELECT 1 FROM client_company c WHERE c.company_id = e.company_id)
      AND e.event_name = ANY(${[...ACTION_EVENTS]})
      AND e.event_time >= (${start}::date::timestamp AT TIME ZONE ${TIMEZONE})
      AND e.event_time < (${end}::date::timestamp AT TIME ZONE ${TIMEZONE})
    ORDER BY e.company_id, e.event_time
  ` as ModuleUsageRow[];
  const definition = FEATURE_USAGE_MODULES.find((module) => module.key === moduleKey);
  if (!definition || (stageKey && !definition.nodes.some(([node]) => node === stageKey))) {
    throw new Error("invalid module stage");
  }
  const entryKey = definition?.nodes[0]?.[0];
  const byCompany = new Map<string, typeof rows>();
  for (const row of rows) {
    const companyId = String(row.company_id);
    const bucket = byCompany.get(companyId) ?? [];
    bucket.push(row);
    byCompany.set(companyId, bucket);
  }
  const companyIds: string[] = [];
  for (const [companyId, companyRows] of byCompany) {
    const classified = companyRows.map((row) => ({
      row,
      node: moduleNodeKey(moduleKey, row),
      time: asDate(row.event_time),
    }));
    const entry = classified
      .filter((item) => item.node === `${moduleKey}.${entryKey}` && item.time)
      .map((item) => item.time as Date)
      .sort((left, right) => left.getTime() - right.getTime())[0];
    if (!entry) continue;
    const matches = classified.some((item) => {
      if (!item.time || item.time < entry || !item.node) return false;
      if (propertyKey && propertyValueParam != null && propertyValue(item.row, propertyKey) !== propertyValueParam) return false;
      if (stageKey) return item.node === `${moduleKey}.${stageKey}`;
      return item.node.startsWith(`${moduleKey}.`);
    });
    if (matches) companyIds.push(companyId);
  }
  const usage = await moduleUsage(start, end, granularity);
  const usageModule = usage.modules.find((item) => item.key === moduleKey) ?? null;
  const stage = stageKey && usageModule
    ? usageModule.stages.find((item) => item.key === stageKey) ?? null
    : null;
  const payload = await overviewSlicePayload(companyIds);
  return {
    ...payload,
    module: usageModule,
    module_key: moduleKey,
    module_stage: stageKey,
    property_breakdown: stage?.property_breakdown ?? usageModule?.property_breakdown ?? [],
    module_slice: {
      module_key: moduleKey,
      stage_key: stageKey,
      window_start: start,
      window_end: end,
      stage,
      property_breakdown: stage?.property_breakdown ?? usageModule?.property_breakdown ?? [],
    },
  };
}

function featureMatches(key: string, eventName: string, typeValue: string | null, status: unknown, entityType: unknown, companyId: string, pathIds: Record<string, Set<string>>, syncIds: Set<string>) {
  if (!key.includes(".")) return pathIds[key]?.has(companyId) ?? false;
  const [moduleKey, nodeKey] = key.split(".");
  if (nodeKey === "sync") return String(eventName) === "Accounting Sync" && (pathIds[moduleKey]?.has(companyId) ?? false) && syncIds.has(companyId);
  return featureNodeKey(eventName, typeValue, status, entityType) === key;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

type ChainRow = {
  company_id?: string;
  event_name: string;
  event_time: unknown;
  properties: unknown;
};

function chainPropertyValue(value: unknown): string | null {
  if (value == null || typeof value === "object") return null;
  if (typeof value === "boolean") return value ? "true" : "false";
  const text = String(value).trim();
  return text || null;
}

function chainBranch(eventName: string, properties: unknown): string | null {
  if (["Sign Up", INTEGRATION_EVENT, "Accounting Sync", "Recon Processed"].includes(eventName)) {
    return null;
  }
  if (eventName === "Upload") {
    return {
      statement: "txn",
      bill: "ap",
      invoice: "ar",
      gstr2b: "gst",
      purchase_register: "gst",
    }[uploadType(properties)] || "other";
  }
  if (eventName === "Download") {
    const value = eventProperty(properties, "type");
    const type = value == null ? "" : String(value).trim().toLowerCase();
    return {
      statement: "txn",
      bill: "ap",
      invoice: "ar",
      reconciled_excel: "gst",
    }[type] || "other";
  }
  if (eventName === "Export") {
    const value = eventProperty(properties, "type");
    return value != null && String(value).trim().toLowerCase() === "gst_reconciliation"
      ? "gst"
      : "other";
  }
  if ((LEDGER_EVENTS as readonly string[]).includes(eventName)) return "txn";
  if (["Invoice Created", "Invoice Bulk Edited", "Download-Inv", "Preview"].includes(eventName)) {
    return "ap";
  }
  if (eventName === "Entity Created") {
    const value = eventProperty(properties, "entityType");
    return value != null && String(value).trim().toLowerCase() === "bill" ? "ap" : "other";
  }
  return (ACTION_EVENTS as readonly string[]).includes(eventName) ? "other" : null;
}

function chainRole(eventName: string): string {
  if (eventName === "Sign Up") return "entry";
  if (eventName === INTEGRATION_EVENT) return "setup";
  if (eventName === "Upload") return "entry";
  if ((READY_EVENTS as readonly string[]).includes(eventName)) return "ready";
  if (eventName === "Accounting Sync") return "activation";
  if (eventName === "Recon Processed") return "value";
  return "supporting";
}

function chainEventNode(eventName: string, inputRows: ChainRow[], role?: string) {
  const rows = [...inputRows].sort((left, right) => {
    const leftTime = asDate(left.event_time)?.getTime() ?? Number.POSITIVE_INFINITY;
    const rightTime = asDate(right.event_time)?.getTime() ?? Number.POSITIVE_INFINITY;
    return leftTime - rightTime;
  });
  const propertyCounts = new Map<string, Map<string, number>>();
  for (const key of CHAIN_PROPERTY_KEYS) propertyCounts.set(key, new Map());
  for (const row of rows) {
    for (const key of CHAIN_PROPERTY_KEYS) {
      const value = chainPropertyValue(eventProperty(row.properties, key));
      if (!value) continue;
      const counts = propertyCounts.get(key)!;
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }
  const properties = CHAIN_PROPERTY_KEYS.flatMap((key) => {
    const counts = propertyCounts.get(key)!;
    if (!counts.size) return [];
    return [{
      key,
      values: Array.from(counts.entries())
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
        .map(([value, count]) => ({ value, count })),
    }];
  });
  return {
    event_name: eventName,
    role: role || chainRole(eventName),
    count: rows.length,
    first_at: rows.length ? isoStamp(rows[0].event_time) : null,
    last_at: rows.length ? isoStamp(rows[rows.length - 1].event_time) : null,
    properties,
  };
}

function buildEventChain(rows: ChainRow[], scope: "lifetime" | "that_week") {
  const setup = new Map<string, ChainRow[]>();
  const branches = new Map<string, Map<string, ChainRow[]>>();
  const sync: ChainRow[] = [];
  const postSync = new Map<string, ChainRow[]>();
  for (const row of rows) {
    if (row.event_name === "Sign Up" || row.event_name === INTEGRATION_EVENT) {
      const current = setup.get(row.event_name) ?? [];
      current.push(row);
      setup.set(row.event_name, current);
    } else if (row.event_name === "Accounting Sync") {
      sync.push(row);
    } else if (row.event_name === "Recon Processed") {
      const current = postSync.get(row.event_name) ?? [];
      current.push(row);
      postSync.set(row.event_name, current);
    } else {
      const branch = chainBranch(row.event_name, row.properties);
      if (!branch) continue;
      const events = branches.get(branch) ?? new Map<string, ChainRow[]>();
      const current = events.get(row.event_name) ?? [];
      current.push(row);
      events.set(row.event_name, current);
      branches.set(branch, events);
    }
  }
  const setupRows = ["Sign Up", INTEGRATION_EVENT].flatMap((eventName) => {
    const eventRows = setup.get(eventName) ?? [];
    return eventRows.length ? [chainEventNode(eventName, eventRows)] : [];
  });
  const orderIndex = new Map(CHAIN_EVENT_ORDER.map((name, index) => [name, index]));
  const branchRows = CHAIN_BRANCH_ORDER.flatMap((key) => {
    const eventMap = branches.get(key);
    if (!eventMap) return [];
    const events = Array.from(eventMap.keys())
      .sort((left, right) => (orderIndex.get(left) ?? CHAIN_EVENT_ORDER.length) - (orderIndex.get(right) ?? CHAIN_EVENT_ORDER.length) || left.localeCompare(right))
      .map((eventName) => chainEventNode(eventName, eventMap.get(eventName)!));
    const readyEvent = CHAIN_READY_EVENTS[key];
    return [{
      key,
      label: CHAIN_BRANCH_LABELS[key],
      entry_event: eventMap.has("Upload") ? "Upload" : null,
      entry_count: eventMap.get("Upload")?.length ?? 0,
      ready_event: readyEvent || null,
      ready_count: readyEvent ? eventMap.get(readyEvent)?.length ?? 0 : 0,
      events,
    }];
  });
  return {
    scope,
    setup: setupRows,
    branches: branchRows,
    sync: sync.length ? chainEventNode("Accounting Sync", sync) : null,
    post_sync: (postSync.get("Recon Processed") ?? []).length
      ? [chainEventNode("Recon Processed", postSync.get("Recon Processed")!)]
      : [],
  };
}

export async function pageSummary(bounds: WeekBounds) {
  const db = sql();
  const [clients] = await db`SELECT COUNT(*)::int AS n FROM client_company`;
  const [acts] = await db`SELECT COUNT(*)::int AS n FROM company_activation`;
  const [ttv] = await db`
    SELECT percentile_cont(0.5) WITHIN GROUP (
      ORDER BY EXTRACT(EPOCH FROM (first_sync_at - signed_up_at)) / 3600.0
    ) AS median_ttv
    FROM company_profile
    WHERE first_sync_at IS NOT NULL AND signed_up_at IS NOT NULL
  `;
  const [recon] = await db`
    SELECT COUNT(*)::int AS n
    FROM company_activation a
    JOIN company_profile p ON p.company_id = a.company_id
    WHERE p.path_had_recon
  `;
  const cohortRows = await db`
    SELECT DISTINCT cohort_week
    FROM retention_cells
    WHERE rel_week = 0
      AND cohort_week <= (date_trunc('week', (CURRENT_TIMESTAMP AT TIME ZONE ${TIMEZONE}))::date)
    ORDER BY cohort_week
  `;
  const week8Rows = await db`
    SELECT cohort_week, cohort_size, retained_count
    FROM retention_cells
    WHERE rel_week = 8
      AND cohort_week <= (
        date_trunc('week', (CURRENT_TIMESTAMP AT TIME ZONE ${TIMEZONE}))::date - 63
      )
      AND (${bounds.fromWeek}::date IS NULL OR cohort_week >= ${bounds.fromWeek}::date)
      AND (${bounds.toWeek}::date IS NULL OR cohort_week <= ${bounds.toWeek}::date)
    ORDER BY cohort_week DESC
    LIMIT 1
  `;
  const clientCompanies = asNumber(clients?.n);
  const activated = asNumber(acts?.n);
  const reconCount = asNumber(recon?.n);
  const week8 = week8Rows[0];
  return {
    client_companies: clientCompanies,
    activated,
    activation_rate: clientCompanies ? activated / clientCompanies : 0,
    median_ttv_hours:
      ttv?.median_ttv == null ? null : Math.round(Number(ttv.median_ttv) * 10) / 10,
    week8_cohort_week: week8 ? isoDate(week8.cohort_week) : null,
    week8_cohort_size: week8 ? asNumber(week8.cohort_size) : 0,
    week8_retained: week8 ? asNumber(week8.retained_count) : 0,
    week8_retention: week8
      ? asNumber(week8.cohort_size)
        ? asNumber(week8.retained_count) / asNumber(week8.cohort_size)
        : 0
      : null,
    recon_count: reconCount,
    recon_among_activated: activated ? reconCount / activated : 0,
    cohort_weeks: cohortRows.map((row) => isoDate(row.cohort_week)).filter(
      (value): value is string => Boolean(value),
    ),
  };
}

export async function heatmap(bounds: WeekBounds) {
  const db = sql();
  const rows = await db`
    SELECT cohort_week, rel_week, cohort_size, retained_count
    FROM retention_cells
    WHERE (
      (rel_week = 0 AND cohort_week <=
        date_trunc('week', (CURRENT_TIMESTAMP AT TIME ZONE ${TIMEZONE}))::date)
      OR (rel_week BETWEEN 1 AND 8
        AND cohort_week + (rel_week * 7) + 7 <=
        date_trunc('week', (CURRENT_TIMESTAMP AT TIME ZONE ${TIMEZONE}))::date)
    )
      AND (${bounds.fromWeek}::date IS NULL OR cohort_week >= ${bounds.fromWeek}::date)
      AND (${bounds.toWeek}::date IS NULL OR cohort_week <= ${bounds.toWeek}::date)
    ORDER BY cohort_week, rel_week
  `;
  return rows.map((row) => {
    const cohortSize = asNumber(row.cohort_size);
    const retained = asNumber(row.retained_count);
    return {
      cohort_week: isoDate(row.cohort_week),
      rel_week: asNumber(row.rel_week),
      cohort_size: cohortSize,
      retained_count: retained,
      rate: cohortSize ? retained / cohortSize : 0,
    };
  });
}

type CellRow = {
  company_id: string;
  activated_at: Date | null;
  activation_week: Date | string | null;
  company_name: string | null;
  signed_up_at: Date | null;
  first_sync_at: Date | null;
  last_action_at: Date | null;
  action_count: number;
  active_weeks: number;
  path_had_upload: boolean;
  path_had_ready: boolean;
  path_had_sync: boolean;
  path_had_recon: boolean;
  atw: number;
  upw: number;
  txw: number;
  syw: number;
  rcw: number;
  had_bill_upload: boolean | null;
  had_invoice_upload: boolean | null;
  had_statement_upload: boolean | null;
  had_ap_active: boolean | null;
  had_txn_active: boolean | null;
  had_gst_recon: boolean | null;
  had_created_bill_or_txn: boolean | null;
  value_events: string[] | null;
  distinct_id: string | null;
  email: string | null;
  user_id: string | null;
  signup_ev: Date | null;
  first_ev: Date | null;
};

export async function heatmapCell(cohortWeek: string, relWeek: number) {
  const target = addDays(cohortWeek, relWeek * 7);
  const db = sql();
  const valueEvents = [...VALUE_EVENTS];
  const rows = await db<CellRow[]>`
    WITH members AS (
      SELECT a.company_id, a.activated_at, a.activation_week,
             p.company_name, p.signed_up_at, p.first_sync_at,
             p.last_action_at, p.action_count, p.active_weeks,
             p.path_had_upload, p.path_had_ready,
             p.path_had_sync, p.path_had_recon,
             COALESCE(w.action_count, 0) AS atw,
             COALESCE(w.upload_count, 0) AS upw,
             COALESCE(w.txn_count, 0) AS txw,
             COALESCE(w.sync_count, 0) AS syw,
             COALESCE(w.recon_count, 0) AS rcw,
             COALESCE(pr.had_bill_upload, false) AS had_bill_upload,
             COALESCE(pr.had_invoice_upload, false) AS had_invoice_upload,
             COALESCE(pr.had_statement_upload, false) AS had_statement_upload,
             COALESCE(pr.had_ap_active, false) AS had_ap_active,
             COALESCE(pr.had_txn_active, false) AS had_txn_active,
             COALESCE(pr.had_gst_recon, false) AS had_gst_recon,
             COALESCE(pr.had_created_bill_or_txn, false) AS had_created_bill_or_txn
      FROM company_activation AS a
      JOIN company_week_value AS v
        ON v.company_id = a.company_id
       AND v.week_start = ${target}::date
       AND v.had_value
      JOIN company_profile AS p ON p.company_id = a.company_id
      LEFT JOIN company_week_action AS w
        ON w.company_id = a.company_id
       AND w.week_start = ${target}::date
      LEFT JOIN company_week_product AS pr
        ON pr.company_id = a.company_id
       AND pr.week_start = ${target}::date
      WHERE a.activation_week = ${cohortWeek}::date
      ORDER BY a.company_id
      LIMIT ${CELL_COMPANY_LIMIT}
    ),
    per AS (
      SELECT e.company_id, e.distinct_id,
             max(e.email) FILTER (
               WHERE e.email IS NOT NULL AND e.email <> '') AS email,
             max(e.user_id) FILTER (
               WHERE e.user_id IS NOT NULL AND e.user_id <> '') AS user_id,
             MIN(e.event_time) FILTER (
               WHERE e.event_name = 'Sign Up') AS signup_ev,
             MIN(e.event_time) AS first_ev
      FROM public.events AS e
      WHERE e.company_id IN (SELECT company_id FROM members)
      GROUP BY e.company_id, e.distinct_id
    )
    SELECT m.company_id, m.activated_at, m.activation_week, m.company_name,
           m.signed_up_at, m.first_sync_at, m.last_action_at,
           m.action_count, m.active_weeks,
           m.path_had_upload, m.path_had_ready,
           m.path_had_sync, m.path_had_recon,
           m.atw, m.upw, m.txw, m.syw, m.rcw,
           m.had_bill_upload, m.had_invoice_upload, m.had_statement_upload,
           m.had_ap_active, m.had_txn_active, m.had_gst_recon,
           m.had_created_bill_or_txn,
           (SELECT COALESCE(
              array_agg(DISTINCT e2.event_name ORDER BY e2.event_name), '{}')
            FROM public.events AS e2
            WHERE e2.company_id = m.company_id
              AND e2.event_name = ANY(${valueEvents})
              AND (date_trunc('week', e2.event_time AT TIME ZONE ${TIMEZONE}))::date
                  = ${target}::date) AS value_events,
           per.distinct_id, per.email, per.user_id,
           per.signup_ev, per.first_ev
    FROM members AS m
    LEFT JOIN per ON per.company_id = m.company_id
    ORDER BY m.company_id, per.email NULLS LAST, per.distinct_id
  `;
  const companyIds = Array.from(new Set(rows.map((row) => row.company_id)));
  const chainRows = companyIds.length
    ? await db<ChainRow[]>`
        SELECT company_id, event_name, event_time, properties
        FROM public.events
        WHERE company_id = ANY(${companyIds})
          AND event_name = ANY(${CHAIN_EVENT_NAMES})
          AND date_trunc('week', event_time AT TIME ZONE ${TIMEZONE})::date = ${target}::date
        ORDER BY company_id, event_time ASC, insert_id ASC
      `
    : [];
  const chainsByCompany = new Map<string, ChainRow[]>();
  for (const row of chainRows) {
    const current = chainsByCompany.get(row.company_id!) ?? [];
    current.push(row);
    chainsByCompany.set(row.company_id!, current);
  }

  const companies = new Map<string, Record<string, unknown>>();
  const order: string[] = [];
  const people: CellRow[] = [];
  for (const row of rows) {
    if (!companies.has(row.company_id)) {
      companies.set(row.company_id, {
        company_id: row.company_id,
        company_name: row.company_name,
        signed_up_at: isoStamp(row.signed_up_at),
        activated_at: isoStamp(row.activated_at),
        last_action_at: isoStamp(row.last_action_at),
        lifetime_actions: asNumber(row.action_count),
        active_weeks: asNumber(row.active_weeks),
        actions_per_active_week: perWeek(asNumber(row.action_count), asNumber(row.active_weeks)),
        actions_that_week: asNumber(row.atw),
        upload_that_week: asNumber(row.upw),
        txn_that_week: asNumber(row.txw),
        sync_that_week: asNumber(row.syw),
        recon_that_week: asNumber(row.rcw),
        path_had_upload: Boolean(row.path_had_upload),
        path_had_ready: Boolean(row.path_had_ready),
        path_had_sync: Boolean(row.path_had_sync),
        path_had_recon: Boolean(row.path_had_recon),
        had_bill_upload: Boolean(row.had_bill_upload),
        had_invoice_upload: Boolean(row.had_invoice_upload),
        had_statement_upload: Boolean(row.had_statement_upload),
        had_ap_active: Boolean(row.had_ap_active),
        had_txn_active: Boolean(row.had_txn_active),
        had_gst_recon: Boolean(row.had_gst_recon),
        had_created_bill_or_txn: Boolean(row.had_created_bill_or_txn),
        ttv_hours: durationHours(asDate(row.signed_up_at), asDate(row.first_sync_at)),
        value_events: Array.isArray(row.value_events) ? row.value_events : [],
        event_chain_that_week: buildEventChain(
          chainsByCompany.get(row.company_id) ?? [],
          "that_week",
        ),
        _last_action_dt: asDate(row.last_action_at),
      });
      order.push(row.company_id);
    }
    if (row.distinct_id != null) people.push(row);
  }

  const users = new Map<string, Record<string, unknown> & {
    companies: Record<string, unknown>[];
    _company_ids: Set<string>;
    _signup_dt: Date | null;
    _last_dt: Date | null;
  }>();
  for (const person of people) {
    if (isInternalEmail(person.email)) continue;
    const key = person.email ? person.email.toLowerCase() : (person.distinct_id || person.company_id);
    let user = users.get(key);
    if (!user) {
      user = {
        email: person.email,
        distinct_id: person.distinct_id,
        user_id: person.user_id,
        signed_up_at: null,
        last_action_at: null,
        lifetime_actions: 0,
        active_weeks: 0,
        actions_that_week: 0,
        companies: [],
        _company_ids: new Set(),
        _signup_dt: null,
        _last_dt: null,
      };
      users.set(key, user);
    }
    const signupDt = asDate(person.signup_ev) || asDate(person.first_ev);
    if (signupDt && (!user._signup_dt || signupDt < user._signup_dt)) {
      user._signup_dt = signupDt;
      user.signed_up_at = isoStamp(signupDt);
    }
    const company = companies.get(person.company_id)!;
    const lastDt = company._last_action_dt as Date | null;
    if (lastDt && (!user._last_dt || lastDt > user._last_dt)) {
      user._last_dt = lastDt;
      user.last_action_at = isoStamp(lastDt);
    }
    user.lifetime_actions = asNumber(user.lifetime_actions) + asNumber(company.lifetime_actions);
    user.active_weeks = Math.max(asNumber(user.active_weeks), asNumber(company.active_weeks));
    user.actions_that_week = asNumber(user.actions_that_week) + asNumber(company.actions_that_week);
    if (!user._company_ids.has(person.company_id)) {
      user._company_ids.add(person.company_id);
      user.companies.push(company);
    }
  }

  const userList = [...users.values()].map((user) => {
    user.actions_per_active_week = perWeek(
      asNumber(user.lifetime_actions),
      asNumber(user.active_weeks),
    );
    user.companies.sort((a, b) =>
      String(a.company_name || a.company_id).toLowerCase().localeCompare(
        String(b.company_name || b.company_id).toLowerCase(),
      ),
    );
    for (const company of user.companies) delete company._last_action_dt;
    const { _company_ids: _c, _signup_dt: _s, _last_dt: _l, ...rest } = user;
    return rest;
  });
  userList.sort((a, b) => {
    const diff = asNumber(b.actions_that_week) - asNumber(a.actions_that_week);
    if (diff) return diff;
    return String(a.email || a.distinct_id || "").localeCompare(
      String(b.email || b.distinct_id || ""),
    );
  });

  const thatWeek = order.map((id) => asNumber(companies.get(id)?.actions_that_week));
  const n = order.length;
  return {
    cohort_week: cohortWeek,
    rel_week: relWeek,
    people_count: userList.length,
    company_count: n,
    median_actions_that_week: median(thatWeek),
    share_with_upload: n
      ? order.filter((id) => asNumber(companies.get(id)?.upload_that_week) > 0).length / n
      : 0,
    share_with_sync: n
      ? order.filter((id) => asNumber(companies.get(id)?.sync_that_week) > 0).length / n
      : 0,
    share_with_recon: n
      ? order.filter((id) => asNumber(companies.get(id)?.recon_that_week) > 0).length / n
      : 0,
    share_with_bill: n
      ? order.filter((id) => Boolean(companies.get(id)?.had_bill_upload)).length / n
      : 0,
    share_with_invoice: n
      ? order.filter((id) => Boolean(companies.get(id)?.had_invoice_upload)).length / n
      : 0,
    share_with_statement: n
      ? order.filter((id) => Boolean(companies.get(id)?.had_statement_upload)).length / n
      : 0,
    share_with_ap: n
      ? order.filter((id) => Boolean(companies.get(id)?.had_ap_active)).length / n
      : 0,
    share_with_txn: n
      ? order.filter((id) => Boolean(companies.get(id)?.had_txn_active)).length / n
      : 0,
    share_with_gst: n
      ? order.filter((id) => Boolean(companies.get(id)?.had_gst_recon)).length / n
      : 0,
    users: userList,
  };
}

export async function companySummary(companyId: string) {
  const db = sql();
  const profiles = await db`
    SELECT company_id, company_name, signed_up_at, activated_at, activation_week,
           first_upload_at, first_ready_at, first_sync_at, first_recon_at,
           last_action_at, action_count, active_weeks,
           path_had_upload, path_had_ready, path_had_sync, path_had_recon
    FROM company_profile WHERE company_id = ${companyId}
  `;
  const profile = profiles[0];
  if (!profile) return null;
  const weeks = await db`
    SELECT w.week_start, w.action_count, w.upload_count, w.txn_count, w.ap_count,
           w.sync_count, w.recon_count,
           COALESCE(p.had_bill_upload, false) AS had_bill_upload,
           COALESCE(p.had_invoice_upload, false) AS had_invoice_upload,
           COALESCE(p.had_statement_upload, false) AS had_statement_upload,
           COALESCE(p.had_ap_active, false) AS had_ap_active,
           COALESCE(p.had_txn_active, false) AS had_txn_active,
           COALESCE(p.had_gst_recon, false) AS had_gst_recon,
           COALESCE(p.had_created_bill_or_txn, false) AS had_created_bill_or_txn
    FROM company_week_action w
    LEFT JOIN company_week_product p
      ON p.company_id = w.company_id AND p.week_start = w.week_start
    WHERE w.company_id = ${companyId}
    ORDER BY w.week_start ASC
  `;
  const [lasts] = await db`
    SELECT MAX(event_time) FILTER (WHERE event_name = 'Accounting Sync') AS last_sync_at,
           MAX(event_time) FILTER (WHERE event_name = 'Recon Processed') AS last_recon_at
    FROM public.events WHERE company_id = ${companyId}
  `;
  const activationWeek = isoDate(profile.activation_week);
  const week8Start = activationWeek ? addDays(activationWeek, 56) : null;
  const [valueRow] = await db`
    SELECT MAX(week_start) FILTER (WHERE had_value) AS last_value_week_start,
           BOOL_OR(had_value) FILTER (WHERE week_start = ${week8Start}::date) AS week8_had_value
    FROM company_week_value WHERE company_id = ${companyId}
  `;
  const detailEventNames = CHAIN_EVENT_NAMES;
  const detailEvents = await db`
    SELECT event_name, event_time, properties
    FROM public.events
    WHERE company_id = ${companyId} AND event_name = ANY(${detailEventNames})
    ORDER BY event_time ASC, insert_id ASC
  `;
  const actionNames = [...ACTION_EVENTS];
  const events = await db`
    SELECT event_name, COUNT(*)::int AS count
    FROM public.events
    WHERE company_id = ${companyId} AND event_name = ANY(${actionNames})
    GROUP BY event_name
    ORDER BY COUNT(*) DESC, event_name ASC
    LIMIT ${BY_EVENT_LIMIT}
  `;
  const apTotal = weeks.reduce((sum, row) => sum + asNumber(row.ap_count), 0);
  const txnTotal = weeks.reduce((sum, row) => sum + asNumber(row.txn_count), 0);
  const pathType = apTotal && txnTotal ? "both" : apTotal ? "ap" : txnTotal ? "txn" : "neither";
  const lastValueWeek = isoDate(valueRow?.last_value_week_start);
  let lastValueRel: number | null = null;
  if (lastValueWeek && activationWeek) {
    const a = new Date(`${activationWeek}T00:00:00Z`);
    const b = new Date(`${lastValueWeek}T00:00:00Z`);
    lastValueRel = Math.floor((b.getTime() - a.getTime()) / 86400000 / 7);
  }
  const currentMonday = isoDate(istMonday());
  let week8Counted: boolean | null = null;
  if (activationWeek && currentMonday && addDays(activationWeek, 63) <= currentMonday) {
    week8Counted = Boolean(valueRow?.week8_had_value);
  }
  const signedUp = asDate(profile.signed_up_at);
  const firstUpload = asDate(profile.first_upload_at);
  const firstReady = asDate(profile.first_ready_at);
  const firstSync = asDate(profile.first_sync_at);
  const firstRecon = asDate(profile.first_recon_at);
  const lastSync = asDate(lasts?.last_sync_at);
  const lastRecon = asDate(lasts?.last_recon_at);
  const eventsByName = new Map<string, Array<{ eventTime: unknown; properties: unknown }>>();
  for (const row of detailEvents) {
    const eventName = String(row.event_name ?? "");
    const current = eventsByName.get(eventName) ?? [];
    current.push({ eventTime: row.event_time, properties: row.properties });
    eventsByName.set(eventName, current);
  }
  const eventChain = buildEventChain(detailEvents as unknown as ChainRow[], "lifetime");
  const eventDetails = (eventName: string) => {
    const rows = eventsByName.get(eventName) ?? [];
    return {
      event_name: eventName,
      count: rows.length,
      first_at: rows.length ? isoStamp(rows[0].eventTime) : null,
      last_at: rows.length ? isoStamp(rows[rows.length - 1].eventTime) : null,
    };
  };
  const uploadTypeGroups = new Map<string, Array<{ eventTime: unknown; failed: boolean }>>();
  for (const row of eventsByName.get("Upload") ?? []) {
    const key = uploadType(row.properties);
    const current = uploadTypeGroups.get(key) ?? [];
    current.push({ eventTime: row.eventTime, failed: failedUpload(row.properties) });
    uploadTypeGroups.set(key, current);
  }
  const uploadTypeKeys = [
    ...UPLOAD_TYPE_ORDER.filter((key) => uploadTypeGroups.has(key)),
    ...Array.from(uploadTypeGroups.keys()).filter((key) => !UPLOAD_TYPE_ORDER.includes(key as typeof UPLOAD_TYPE_ORDER[number])).sort(),
  ];
  const uploadTypes = uploadTypeKeys.map((key) => {
    const rows = uploadTypeGroups.get(key) ?? [];
    return {
      key,
      label: uploadTypeLabel(key),
      count: rows.length,
      first_at: rows.length ? isoStamp(rows[0].eventTime) : null,
      last_at: rows.length ? isoStamp(rows[rows.length - 1].eventTime) : null,
      failed_count: rows.filter((row) => row.failed).length,
    };
  });
  const readyActivities = READY_EVENTS.map((eventName) => eventDetails(eventName));
  const ledgerEvents = LEDGER_EVENTS
    .filter((eventName) => (eventsByName.get(eventName) ?? []).length > 0)
    .map((eventName) => eventDetails(eventName));
  const transactionTypeGroups = new Map<string, unknown[]>();
  for (const eventName of LEDGER_EVENTS) {
    for (const row of eventsByName.get(eventName) ?? []) {
      if (!row.properties || typeof row.properties !== "object" || Array.isArray(row.properties)) continue;
      if (!("transactionType" in row.properties)) continue;
      const rawType = eventProperty(row.properties, "transactionType");
      if (rawType == null || String(rawType).trim() === "") continue;
      let transactionType = String(rawType).trim().toLowerCase();
      if (uuidLike(transactionType)) transactionType = "other";
      const current = transactionTypeGroups.get(transactionType) ?? [];
      current.push(row.eventTime);
      transactionTypeGroups.set(transactionType, current);
    }
  }
  const ledgerTransactionTypes = Array.from(transactionTypeGroups.keys()).sort().map((transactionType) => {
    const rows = transactionTypeGroups.get(transactionType) ?? [];
    return {
      transaction_type: transactionType,
      count: rows.length,
      first_at: rows.length ? isoStamp(rows[0]) : null,
      last_at: rows.length ? isoStamp(rows[rows.length - 1]) : null,
    };
  });
  const firstIntegration = asDate((eventsByName.get(INTEGRATION_EVENT) ?? [])[0]?.eventTime);
  const readyCount = READY_EVENTS.reduce((total, eventName) => total + (eventsByName.get(eventName) ?? []).length, 0);
  const funnelStages = [
    { key: "signup", label: "Signup", firstAt: signedUp, count: signedUp ? 1 : 0, breakdown: [] },
    { key: "integration", label: "Integration status", firstAt: firstIntegration, count: (eventsByName.get(INTEGRATION_EVENT) ?? []).length, breakdown: [] },
    {
      key: "upload",
      label: "Upload",
      firstAt: firstUpload,
      count: (eventsByName.get("Upload") ?? []).length,
      breakdown: uploadTypes.map((row) => ({ key: row.key, label: row.label, count: row.count })),
    },
    {
      key: "ready",
      label: "Ready",
      firstAt: firstReady,
      count: readyCount,
      breakdown: READY_EVENTS.map((eventName) => ({
        key: eventName.toLowerCase().replaceAll(" ", "_"),
        label: eventName,
        count: (eventsByName.get(eventName) ?? []).length,
      })),
    },
    { key: "sync", label: "Accounting Sync", firstAt: firstSync, count: (eventsByName.get("Accounting Sync") ?? []).length, breakdown: [] },
  ];
  let previousFunnelAt: Date | null = null;
  const funnel = funnelStages.map((stage) => {
    const row = {
      key: stage.key,
      label: stage.label,
      reached: stage.firstAt != null,
      first_at: isoStamp(stage.firstAt),
      count: stage.count,
      gap_hours_from_prev: durationHours(previousFunnelAt, stage.firstAt),
      breakdown: stage.breakdown,
    };
    previousFunnelAt = stage.firstAt;
    return row;
  });
  const uploadTotal = weeks.reduce((sum, row) => sum + asNumber(row.upload_count), 0);
  const syncTotal = weeks.reduce((sum, row) => sum + asNumber(row.sync_count), 0);
  const reconTotal = weeks.reduce((sum, row) => sum + asNumber(row.recon_count), 0);
  const now = new Date();
  return {
    company_id: profile.company_id,
    company_name: profile.company_name,
    signed_up_at: isoStamp(profile.signed_up_at),
    activated_at: isoStamp(profile.activated_at),
    activation_week: activationWeek,
    first_upload_at: isoStamp(profile.first_upload_at),
    first_ready_at: isoStamp(profile.first_ready_at),
    first_sync_at: isoStamp(profile.first_sync_at),
    first_recon_at: isoStamp(profile.first_recon_at),
    last_action_at: isoStamp(profile.last_action_at),
    lifetime_actions: asNumber(profile.action_count),
    active_weeks: asNumber(profile.active_weeks),
    actions_per_active_week: perWeek(asNumber(profile.action_count), asNumber(profile.active_weeks)),
    ttv_hours: durationHours(signedUp, firstSync),
    hours_signup_to_upload: durationHours(signedUp, firstUpload),
    hours_upload_to_ready: durationHours(firstUpload, firstReady),
    hours_ready_to_sync: durationHours(firstReady, firstSync),
    hours_sync_to_recon: durationHours(firstSync, firstRecon),
    last_sync_at: isoStamp(lastSync),
    last_recon_at: isoStamp(lastRecon),
    hours_since_last_sync: durationHours(lastSync, now),
    hours_since_last_recon: durationHours(lastRecon, now),
    path_type: pathType,
    last_value_week_start: lastValueWeek,
    last_value_rel_week: lastValueRel,
    week8_counted: week8Counted,
    path_had_upload: Boolean(profile.path_had_upload),
    path_had_ready: Boolean(profile.path_had_ready),
    path_had_sync: Boolean(profile.path_had_sync),
    path_had_recon: Boolean(profile.path_had_recon),
    funnel,
    work_mix: {
      scope: "lifetime",
      upload: uploadTotal,
      upload_failed: (eventsByName.get("Upload") ?? []).filter((row) => failedUpload(row.properties)).length,
      ap: apTotal,
      txn: txnTotal,
      sync: syncTotal,
      recon: reconTotal,
    },
    upload_types: uploadTypes,
    ready_activities: readyActivities,
    ledger_events: ledgerEvents,
    ledger_transaction_types: ledgerTransactionTypes,
    event_chain: eventChain,
    by_week: weeks.map((row) => ({
      week_start: isoDate(row.week_start),
      action_count: asNumber(row.action_count),
      upload_count: asNumber(row.upload_count),
      txn_count: asNumber(row.txn_count),
      ap_count: asNumber(row.ap_count),
      sync_count: asNumber(row.sync_count),
      recon_count: asNumber(row.recon_count),
      had_bill_upload: Boolean(row.had_bill_upload),
      had_invoice_upload: Boolean(row.had_invoice_upload),
      had_statement_upload: Boolean(row.had_statement_upload),
      had_ap_active: Boolean(row.had_ap_active),
      had_txn_active: Boolean(row.had_txn_active),
      had_gst_recon: Boolean(row.had_gst_recon),
      had_created_bill_or_txn: Boolean(row.had_created_bill_or_txn),
    })),
    by_event: events.map((row) => ({
      event_name: row.event_name,
      count: asNumber(row.count),
    })),
  };
}

export async function companyTimeline(
  companyId: string,
  limit: number,
  offset: number,
) {
  const db = sql();
  const [countRow] = await db`
    SELECT COUNT(*)::int AS n FROM public.events WHERE company_id = ${companyId}
  `;
  const rows = await db`
    SELECT event_time, event_name
    FROM public.events
    WHERE company_id = ${companyId}
    ORDER BY event_time DESC, insert_id DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
  return {
    total: asNumber(countRow?.n),
    limit,
    offset,
    events: rows.map((row) => ({
      event_time: isoStamp(row.event_time),
      event_name: row.event_name,
    })),
  };
}

export async function overview() {
  const db = sql();
  const actionNames = [...ACTION_EVENTS];
  const [asOf] = await db`
    SELECT
      (CURRENT_TIMESTAMP AT TIME ZONE ${TIMEZONE})::date AS as_of_date,
      date_trunc('week', CURRENT_TIMESTAMP AT TIME ZONE ${TIMEZONE})::date AS week_start,
      date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE ${TIMEZONE})::date AS month_start
  `;
  const [active] = await db`
    SELECT
      COUNT(DISTINCT e.distinct_id) FILTER (
        WHERE (e.event_time AT TIME ZONE ${TIMEZONE})::date
          = (CURRENT_TIMESTAMP AT TIME ZONE ${TIMEZONE})::date
      )::int AS dau,
      COUNT(DISTINCT e.distinct_id) FILTER (
        WHERE date_trunc('week', e.event_time AT TIME ZONE ${TIMEZONE})
          = date_trunc('week', CURRENT_TIMESTAMP AT TIME ZONE ${TIMEZONE})
      )::int AS wau,
      COUNT(DISTINCT e.distinct_id) FILTER (
        WHERE date_trunc('month', e.event_time AT TIME ZONE ${TIMEZONE})
          = date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE ${TIMEZONE})
      )::int AS mau,
      COUNT(DISTINCT e.company_id) FILTER (
        WHERE date_trunc('week', e.event_time AT TIME ZONE ${TIMEZONE})
          = date_trunc('week', CURRENT_TIMESTAMP AT TIME ZONE ${TIMEZONE})
      )::int AS wau_companies,
      COUNT(DISTINCT e.company_id) FILTER (
        WHERE date_trunc('month', e.event_time AT TIME ZONE ${TIMEZONE})
          = date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE ${TIMEZONE})
      )::int AS mau_companies
    FROM events e
    WHERE e.event_name = ANY(${actionNames})
      AND EXISTS (
        SELECT 1 FROM client_company c WHERE c.company_id = e.company_id
      )
      AND NOT public.is_internal_email(e.email)
      AND e.event_time >= LEAST(
        date_trunc('week', CURRENT_TIMESTAMP AT TIME ZONE ${TIMEZONE})
          AT TIME ZONE ${TIMEZONE},
        date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE ${TIMEZONE})
          AT TIME ZONE ${TIMEZONE}
      )
  `;
  const [clients] = await db`SELECT COUNT(*)::int AS n FROM client_company`;
  const [acts] = await db`SELECT COUNT(*)::int AS n FROM company_activation`;
  const week8Rows = await db`
    SELECT cohort_week, cohort_size, retained_count
    FROM retention_cells
    WHERE rel_week = 8
      AND cohort_week <= (
        date_trunc('week', (CURRENT_TIMESTAMP AT TIME ZONE ${TIMEZONE}))::date - 63
      )
    ORDER BY cohort_week DESC
    LIMIT 1
  `;
  const [growth] = await db`
    WITH first_seen AS (
      SELECT
        date_trunc('week', first_event.event_time AT TIME ZONE ${TIMEZONE})::date AS first_week,
        date_trunc('month', first_event.event_time AT TIME ZONE ${TIMEZONE})::date AS first_month
      FROM client_company c
      JOIN LATERAL (
        SELECT e.event_time FROM public.events e
        WHERE e.company_id = c.company_id
        ORDER BY e.event_time ASC LIMIT 1
      ) first_event ON true
    )
    SELECT
      COUNT(*) FILTER (WHERE first_week = ${asOf?.week_start}::date)::int AS new_week,
      COUNT(*) FILTER (WHERE first_month = ${asOf?.month_start}::date)::int AS new_month
    FROM first_seen
  `;
  const clientCompanies = asNumber(clients?.n);
  const activated = asNumber(acts?.n);
  const dau = asNumber(active?.dau);
  const wau = asNumber(active?.wau);
  const mau = asNumber(active?.mau);
  const week8 = week8Rows[0];
  return {
    timezone: TIMEZONE,
    as_of_date: isoDate(asOf?.as_of_date),
    week_start: isoDate(asOf?.week_start),
    month_start: isoDate(asOf?.month_start),
    dau,
    wau,
    mau,
    wau_companies: asNumber(active?.wau_companies),
    mau_companies: asNumber(active?.mau_companies),
    new_companies_week: asNumber(growth?.new_week),
    new_companies_month: asNumber(growth?.new_month),
    dau_mau_ratio: mau ? dau / mau : null,
    client_companies: clientCompanies,
    activated,
    adoption_rate: clientCompanies ? activated / clientCompanies : 0,
    week8_cohort_week: week8 ? isoDate(week8.cohort_week) : null,
    week8_cohort_size: week8 ? asNumber(week8.cohort_size) : 0,
    week8_retained: week8 ? asNumber(week8.retained_count) : 0,
    customer_retention_rate: week8
      ? asNumber(week8.cohort_size)
        ? asNumber(week8.retained_count) / asNumber(week8.cohort_size)
        : 0
      : null,
  };
}

function addMonths(iso: string, months: number): string {
  const [year, month] = iso.split("-").map(Number);
  const ordinal = year * 12 + (month - 1) + months;
  const nextYear = Math.floor(ordinal / 12);
  const nextMonth = (ordinal % 12) + 1;
  return `${nextYear}-${String(nextMonth).padStart(2, "0")}-01`;
}

async function overviewStamps() {
  const db = sql();
  const [row] = await db`
    SELECT
      (CURRENT_TIMESTAMP AT TIME ZONE ${TIMEZONE})::date AS as_of_date,
      date_trunc('week', CURRENT_TIMESTAMP AT TIME ZONE ${TIMEZONE})::date AS week_start,
      date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE ${TIMEZONE})::date AS month_start,
      (date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE ${TIMEZONE}) - INTERVAL '1 month')::date
        AS prior_month_start
  `;
  return {
    asOfDate: isoDate(row?.as_of_date)!,
    weekStart: isoDate(row?.week_start)!,
    monthStart: isoDate(row?.month_start)!,
    priorMonthStart: isoDate(row?.prior_month_start)!,
  };
}

async function activePeopleInWindow(start: string, end: string): Promise<number> {
  const db = sql();
  const actionNames = [...ACTION_EVENTS];
  const [row] = await db`
    SELECT COUNT(DISTINCT e.distinct_id)::int AS n
    FROM public.events e
    WHERE e.event_name = ANY(${actionNames})
      AND NOT public.is_internal_email(e.email)
      AND EXISTS (SELECT 1 FROM client_company c WHERE c.company_id = e.company_id)
      AND e.event_time >= (${start}::date AT TIME ZONE ${TIMEZONE})
      AND e.event_time < (${end}::date AT TIME ZONE ${TIMEZONE})
  `;
  return asNumber(row?.n);
}

async function activeCompaniesInWindow(start: string, end: string): Promise<number> {
  const db = sql();
  const actionNames = [...ACTION_EVENTS];
  const [row] = await db`
    SELECT COUNT(DISTINCT e.company_id)::int AS n
    FROM public.events e
    WHERE e.event_name = ANY(${actionNames})
      AND EXISTS (SELECT 1 FROM client_company c WHERE c.company_id = e.company_id)
      AND e.event_time >= (${start}::date::timestamp AT TIME ZONE ${TIMEZONE})
      AND e.event_time < (${end}::date::timestamp AT TIME ZONE ${TIMEZONE})
  `;
  return asNumber(row?.n);
}

export async function overviewCharts() {
  const db = sql();
  const actionNames = [...ACTION_EVENTS];
  const readyNames = ["Invoice Created", "Transaction Ledger Updated"];
  const stamps = await overviewStamps();
  const nextMonthStart = addMonths(stamps.monthStart, 1);
  const [funnel] = await db`
    WITH flags AS (
      SELECT c.company_id,
             BOOL_OR(e.event_name = 'Upload') AS had_upload,
             BOOL_OR(e.event_name = ANY(${readyNames})) AS had_ready,
             EXISTS (SELECT 1 FROM company_activation a WHERE a.company_id = c.company_id) AS had_sync
      FROM client_company c
      LEFT JOIN public.events e
        ON e.company_id = c.company_id
       AND e.event_name = ANY(${["Upload", "Invoice Created", "Transaction Ledger Updated"]})
      GROUP BY c.company_id
    )
    SELECT COUNT(*)::int AS clients,
           COUNT(*) FILTER (WHERE had_upload)::int AS upload,
           COUNT(*) FILTER (WHERE had_ready)::int AS ready,
           COUNT(*) FILTER (WHERE had_sync)::int AS sync
    FROM flags
  `;
  const weeklyRows = await db`
    WITH weeks AS (
      SELECT (${stamps.weekStart}::date - 77 + (s.n * 7))::date AS week_start
      FROM generate_series(0, 11) AS s(n)
    ), activity AS (
      SELECT (date_trunc('week', e.event_time AT TIME ZONE ${TIMEZONE}))::date AS week_start,
             COUNT(DISTINCT e.distinct_id) FILTER (
               WHERE NOT public.is_internal_email(e.email)
             )::int AS people,
             COUNT(DISTINCT e.company_id)::int AS companies
      FROM public.events e
      WHERE e.event_name = ANY(${actionNames})
        AND e.event_time >= ((${stamps.weekStart}::date - 77) AT TIME ZONE ${TIMEZONE})
        AND e.event_time < ((${stamps.weekStart}::date + 7) AT TIME ZONE ${TIMEZONE})
        AND EXISTS (SELECT 1 FROM client_company c WHERE c.company_id = e.company_id)
      GROUP BY 1
    )
    SELECT w.week_start, COALESCE(a.people, 0)::int AS people,
           COALESCE(a.companies, 0)::int AS companies
    FROM weeks w LEFT JOIN activity a ON a.week_start = w.week_start
    ORDER BY w.week_start
  `;
  const [priorDailyRow] = await db`
    WITH days AS (
      SELECT day::date
      FROM generate_series(${stamps.priorMonthStart}::date, ${stamps.monthStart}::date - 1, INTERVAL '1 day') AS day
    ), counts AS (
      SELECT (e.event_time AT TIME ZONE ${TIMEZONE})::date AS day,
             COUNT(DISTINCT e.distinct_id)::int AS people
      FROM public.events e
      WHERE e.event_name = ANY(${actionNames})
        AND NOT public.is_internal_email(e.email)
        AND EXISTS (SELECT 1 FROM client_company c WHERE c.company_id = e.company_id)
        AND e.event_time >= (${stamps.priorMonthStart}::date AT TIME ZONE ${TIMEZONE})
        AND e.event_time < (${stamps.monthStart}::date AT TIME ZONE ${TIMEZONE})
      GROUP BY 1
    )
    SELECT COALESCE(AVG(COALESCE(counts.people, 0)), 0) AS n
    FROM days LEFT JOIN counts ON counts.day = days.day
  `;
  const priorWeekStart = addDays(stamps.weekStart, -28);
  const [currentDau, currentWau, currentMau, priorWau, priorMau, currentWauCompanies, currentMauCompanies] = await Promise.all([
    activePeopleInWindow(stamps.asOfDate, addDays(stamps.asOfDate, 1)),
    activePeopleInWindow(stamps.weekStart, addDays(stamps.weekStart, 7)),
    activePeopleInWindow(stamps.monthStart, nextMonthStart),
    activePeopleInWindow(priorWeekStart, addDays(priorWeekStart, 7)),
    activePeopleInWindow(stamps.priorMonthStart, stamps.monthStart),
    activeCompaniesInWindow(stamps.weekStart, addDays(stamps.weekStart, 7)),
    activeCompaniesInWindow(stamps.monthStart, nextMonthStart),
  ]);
  const vintageRows = await db`
    WITH months AS (
      SELECT (${stamps.monthStart}::date - INTERVAL '7 months' + (s.n * INTERVAL '1 month'))::date AS month
      FROM generate_series(0, 7) AS s(n)
    ), first_seen AS (
      SELECT c.company_id,
             date_trunc('month', first_event.event_time AT TIME ZONE ${TIMEZONE})::date AS first_month
      FROM client_company c
      JOIN LATERAL (
        SELECT e.event_time FROM public.events e
        WHERE e.company_id = c.company_id
        ORDER BY e.event_time ASC LIMIT 1
      ) first_event ON true
    )
    SELECT m.month,
           COUNT(f.company_id) FILTER (WHERE a.company_id IS NOT NULL)::int AS activated,
           COUNT(f.company_id) FILTER (WHERE a.company_id IS NULL)::int AS not_activated
    FROM months m
    LEFT JOIN first_seen f ON f.first_month = m.month
    LEFT JOIN company_activation a ON a.company_id = f.company_id
    GROUP BY m.month ORDER BY m.month
  `;
  const compositionRows = await db`
    WITH months AS (
      SELECT (${stamps.monthStart}::date - INTERVAL '5 months' + (s.n * INTERVAL '1 month'))::date AS month
      FROM generate_series(0, 5) AS s(n)
    ), action_months AS (
      SELECT DISTINCT e.distinct_id,
             date_trunc('month', e.event_time AT TIME ZONE ${TIMEZONE})::date AS month
      FROM public.events e
      JOIN (
        SELECT DISTINCT e.distinct_id
        FROM public.events e
        WHERE e.event_name = ANY(${actionNames})
          AND NOT public.is_internal_email(e.email)
          AND EXISTS (SELECT 1 FROM client_company c WHERE c.company_id = e.company_id)
          AND e.event_time >= ((${stamps.monthStart}::date - INTERVAL '5 months') AT TIME ZONE ${TIMEZONE})
          AND e.event_time < ((${stamps.monthStart}::date + INTERVAL '1 month') AT TIME ZONE ${TIMEZONE})
      ) recent ON recent.distinct_id = e.distinct_id
      WHERE e.event_name = ANY(${actionNames})
        AND NOT public.is_internal_email(e.email)
        AND EXISTS (SELECT 1 FROM client_company c WHERE c.company_id = e.company_id)
    ), first_action AS (
      SELECT distinct_id, MIN(month) AS first_month FROM action_months GROUP BY distinct_id
    )
    SELECT m.month,
           COUNT(a.distinct_id) FILTER (WHERE f.first_month = m.month)::int AS new_people,
           COUNT(a.distinct_id) FILTER (
             WHERE f.first_month < m.month AND EXISTS (
               SELECT 1 FROM action_months prev
               WHERE prev.distinct_id = a.distinct_id
                 AND prev.month = (m.month - INTERVAL '1 month')::date
             )
           )::int AS returning_people,
           COUNT(a.distinct_id) FILTER (
             WHERE f.first_month < m.month AND NOT EXISTS (
               SELECT 1 FROM action_months prev
               WHERE prev.distinct_id = a.distinct_id
                 AND prev.month = (m.month - INTERVAL '1 month')::date
             )
           )::int AS resurrected_people
    FROM months m
    LEFT JOIN action_months a ON a.month = m.month
    LEFT JOIN first_action f ON f.distinct_id = a.distinct_id
    GROUP BY m.month ORDER BY m.month
  `;
  const week8Rows = await db`
    SELECT cohort_week, cohort_size, retained_count
    FROM retention_cells
    WHERE rel_week = 8 AND cohort_week <= (${stamps.weekStart}::date - 63)
    ORDER BY cohort_week DESC LIMIT 8
  `;
  const activationRows = await db`
    SELECT activation_week, COUNT(*)::int AS n
    FROM company_activation
    WHERE activation_week >= (${stamps.weekStart}::date - 77)
      AND activation_week <= ${stamps.weekStart}::date
    GROUP BY activation_week
  `;
  const tableWeek8Rows = await db`
    SELECT cohort_week, cohort_size, retained_count
    FROM retention_cells
    WHERE rel_week = 8
      AND cohort_week >= (${stamps.weekStart}::date - 77)
      AND cohort_week <= ${stamps.weekStart}::date
  `;
  const activations = new Map(activationRows.map((row) => [isoDate(row.activation_week), asNumber(row.n)]));
  const tableWeek8 = new Map(tableWeek8Rows.map((row) => [
    isoDate(row.cohort_week), { size: asNumber(row.cohort_size), retained: asNumber(row.retained_count) },
  ]));
  const matureCutoff = addDays(stamps.weekStart, -63);
  const completeWeek = addDays(stamps.weekStart, -7);
  const [productRow] = await db`
    SELECT
      COUNT(*) FILTER (WHERE had_bill_upload)::int AS had_bill_upload,
      COUNT(*) FILTER (WHERE had_invoice_upload)::int AS had_invoice_upload,
      COUNT(*) FILTER (WHERE had_statement_upload)::int AS had_statement_upload,
      COUNT(*) FILTER (WHERE had_ap_active)::int AS had_ap_active,
      COUNT(*) FILTER (WHERE had_txn_active)::int AS had_txn_active,
      COUNT(*) FILTER (WHERE had_gst_recon)::int AS had_gst_recon
    FROM company_week_product
    WHERE week_start = ${completeWeek}::date
  `;
  const feature_usage = await featureUsage(completeWeek);
  const growthRows = await db`
    WITH weeks AS (
      SELECT (${stamps.weekStart}::date - 77 + (s.n * 7))::date AS week_start
      FROM generate_series(0, 11) AS s(n)
    ), first_seen AS (
      SELECT date_trunc('week', first_event.event_time AT TIME ZONE ${TIMEZONE})::date AS first_week
      FROM client_company c
      JOIN LATERAL (
        SELECT e.event_time FROM public.events e
        WHERE e.company_id = c.company_id
        ORDER BY e.event_time ASC LIMIT 1
      ) first_event ON true
    )
    SELECT w.week_start, COUNT(f.first_week)::int AS companies
    FROM weeks w
    LEFT JOIN first_seen f ON f.first_week = w.week_start
    GROUP BY w.week_start
    ORDER BY w.week_start
  `;
  const monthlyRows = await db`
    WITH months AS (
      SELECT (${stamps.monthStart}::date - INTERVAL '5 months' + (s.n * INTERVAL '1 month'))::date AS month
      FROM generate_series(0, 5) AS s(n)
    ), activity AS (
      SELECT date_trunc('month', e.event_time AT TIME ZONE ${TIMEZONE})::date AS month,
             COUNT(DISTINCT e.distinct_id) FILTER (WHERE NOT public.is_internal_email(e.email))::int AS people,
             COUNT(DISTINCT e.company_id)::int AS companies
      FROM public.events e
      WHERE e.event_name = ANY(${actionNames})
        AND EXISTS (SELECT 1 FROM client_company c WHERE c.company_id = e.company_id)
        AND e.event_time >= ((${stamps.monthStart}::date - INTERVAL '5 months') AT TIME ZONE ${TIMEZONE})
        AND e.event_time < ((${stamps.monthStart}::date + INTERVAL '1 month') AT TIME ZONE ${TIMEZONE})
      GROUP BY 1
    )
    SELECT m.month, COALESCE(a.people, 0)::int AS people, COALESCE(a.companies, 0)::int AS companies
    FROM months m LEFT JOIN activity a ON a.month = m.month
    ORDER BY m.month
  `;
  let adoption: Awaited<ReturnType<typeof adoptionPayload>> | null = null;
  let module_usage: (Awaited<ReturnType<typeof moduleUsage>> & {
    default_period: "week";
    windows: OverviewWindow[];
    week: Awaited<ReturnType<typeof moduleUsage>>;
    month: Awaited<ReturnType<typeof moduleUsage>>;
    periods: {
      week: Awaited<ReturnType<typeof moduleUsage>>;
      month: Awaited<ReturnType<typeof moduleUsage>>;
    };
  }) | null = null;
  try {
    adoption = await adoptionPayload(stamps);
    const [weekUsage, monthUsage] = await Promise.all([
      moduleUsage(completeWeek, stamps.weekStart, "week"),
      moduleUsage(stamps.monthStart, nextMonthStart, "month"),
    ]);
    module_usage = {
      default_period: "week",
      window_start: weekUsage.window_start,
      window_end: weekUsage.window_end,
      granularity: weekUsage.granularity,
      modules: weekUsage.modules,
      windows: [
        { key: "week", label: "Latest complete week", granularity: "week", start: weekUsage.window_start, end: weekUsage.window_end, current: false, complete: true },
        { key: "month", label: "Current month", granularity: "month", start: monthUsage.window_start, end: monthUsage.window_end, current: true, complete: false },
      ],
      week: weekUsage,
      month: monthUsage,
      periods: { week: weekUsage, month: monthUsage },
    };
  } catch {
    // The additive fallback fields must never take down the established Overview payload.
  }
  const period = [
    {
      key: "dau" as const,
      label: "DAU",
      current: currentDau,
      prior: Math.round(asNumber(priorDailyRow?.n) * 10) / 10,
      prior_kind: "average_daily" as const,
      current_start: stamps.asOfDate,
      current_end: addDays(stamps.asOfDate, 1),
      prior_start: stamps.priorMonthStart,
      prior_end: stamps.monthStart,
    },
    {
      key: "wau" as const,
      label: "WAU",
      current: currentWau,
      prior: priorWau,
      prior_kind: "week" as const,
      current_start: stamps.weekStart,
      current_end: addDays(stamps.weekStart, 7),
      prior_start: priorWeekStart,
      prior_end: addDays(priorWeekStart, 7),
    },
    {
      key: "mau" as const,
      label: "MAU",
      current: currentMau,
      prior: priorMau,
      prior_kind: "month" as const,
      current_start: stamps.monthStart,
      current_end: nextMonthStart,
      prior_start: stamps.priorMonthStart,
      prior_end: stamps.monthStart,
    },
  ];
  const engagement = {
    week: {
      people: currentWau,
      companies: currentWauCompanies,
      start: stamps.weekStart,
      end: addDays(stamps.weekStart, 7),
      granularity: "week",
      current: true,
      complete: false,
    },
    month: {
      people: currentMau,
      companies: currentMauCompanies,
      start: stamps.monthStart,
      end: nextMonthStart,
      granularity: "month",
      current: true,
      complete: false,
    },
    windows: [
      { key: "week", label: "Weekly", granularity: "week", start: stamps.weekStart, end: addDays(stamps.weekStart, 7), current: true, complete: false },
      { key: "month", label: "Monthly", granularity: "month", start: stamps.monthStart, end: nextMonthStart, current: true, complete: false },
      { key: "prior_month", label: "Prior month", granularity: "month", start: stamps.priorMonthStart, end: stamps.monthStart, current: false, complete: true },
    ],
    weekly: weeklyRows.map((row) => ({
      week_start: isoDate(row.week_start)!,
      window_start: isoDate(row.week_start)!,
      window_end: addDays(isoDate(row.week_start)!, 7),
      people: asNumber(row.people),
      companies: asNumber(row.companies),
      current: isoDate(row.week_start) === stamps.weekStart,
    })),
    monthly: monthlyRows.map((row) => ({
      month: isoDate(row.month)!,
      window_start: isoDate(row.month)!,
      window_end: addMonths(isoDate(row.month)!, 1),
      people: asNumber(row.people),
      companies: asNumber(row.companies),
      current: isoDate(row.month) === stamps.monthStart,
    })),
    period,
  };
  return {
    timezone: TIMEZONE,
    as_of_date: stamps.asOfDate,
    week_start: stamps.weekStart,
    month_start: stamps.monthStart,
    prior_month_start: stamps.priorMonthStart,
    funnel: [
      { key: "clients", label: "Client companies", remaining: asNumber(funnel?.clients) },
      { key: "upload", label: "Upload", remaining: asNumber(funnel?.upload) },
      { key: "ready", label: "Ready", remaining: asNumber(funnel?.ready) },
      { key: "sync", label: "Activated", remaining: asNumber(funnel?.sync) },
    ],
    weekly: weeklyRows.map((row) => ({
      week_start: isoDate(row.week_start)!, people: asNumber(row.people), companies: asNumber(row.companies),
      current: isoDate(row.week_start) === stamps.weekStart,
    })),
    period,
    vintage: vintageRows.map((row) => ({
      month: isoDate(row.month)!, activated: asNumber(row.activated), not_activated: asNumber(row.not_activated),
      current: isoDate(row.month) === stamps.monthStart,
    })),
    composition: compositionRows.map((row) => ({
      month: isoDate(row.month)!, new: asNumber(row.new_people), returning: asNumber(row.returning_people),
      resurrected: asNumber(row.resurrected_people), current: isoDate(row.month) === stamps.monthStart,
    })),
    week8: [...week8Rows].reverse().map((row) => {
      const cohortSize = asNumber(row.cohort_size);
      const retained = asNumber(row.retained_count);
      return { cohort_week: isoDate(row.cohort_week)!, cohort_size: cohortSize, retained, dropped: Math.max(cohortSize - retained, 0) };
    }),
    weekly_table: weeklyRows.map((row) => {
      const week = isoDate(row.week_start)!;
      const retention = week <= matureCutoff ? tableWeek8.get(week) : undefined;
      return {
        week_start: week, people: asNumber(row.people), companies: asNumber(row.companies),
        activations: activations.get(week) || 0,
        week8_cohort_size: retention?.size ?? null,
        week8_retained: retention?.retained ?? null,
      };
    }),
    growth: growthRows.map((row) => ({
      week_start: isoDate(row.week_start)!,
      companies: asNumber(row.companies),
      current: isoDate(row.week_start) === stamps.weekStart,
    })),
    monthly: monthlyRows.map((row) => ({
      month: isoDate(row.month)!,
      people: asNumber(row.people),
      companies: asNumber(row.companies),
      current: isoDate(row.month) === stamps.monthStart,
    })),
    feature_usage,
    adoption,
    engagement,
    modules: module_usage?.modules ?? [],
    module_usage,
    product: PRODUCT_SPLIT_FLAGS.map((item) => ({
      key: item.key,
      label: item.label,
      companies: asNumber(productRow?.[item.key]),
      week_start: completeWeek,
    })),
  };
}

function requiredDate(value: string | null, name: string, options: { monday?: boolean; monthStart?: boolean } = {}) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${name} must be YYYY-MM-DD`);
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`${name} must be YYYY-MM-DD`);
  }
  if (options.monday && parsed.getUTCDay() !== 1) throw new Error(`${name} must be a Monday`);
  if (options.monthStart && parsed.getUTCDate() !== 1) throw new Error(`${name} must be YYYY-MM-01`);
  return value;
}

async function overviewSlicePayload(companyIds: string[], pairs?: Array<[string, string]>) {
  const ids = [...new Set(companyIds)].slice(0, CELL_COMPANY_LIMIT);
  if (!ids.length) return { people_count: 0, company_count: 0, users: [] };
  const db = sql();
  const actionNames = [...ACTION_EVENTS];
  const rows = await db`
    SELECT e.company_id, e.distinct_id,
           MAX(e.email) FILTER (WHERE e.email IS NOT NULL AND e.email <> '') AS email,
           MAX(e.user_id) FILTER (WHERE e.user_id IS NOT NULL AND e.user_id <> '') AS user_id,
           MIN(e.event_time) FILTER (WHERE e.event_name = 'Sign Up') AS signup_ev,
           MIN(e.event_time) AS first_ev,
           COALESCE(p.company_name, MAX(e.properties->>'companyName')) AS company_name,
           COALESCE(p.signed_up_at, MIN(e.event_time) FILTER (WHERE e.event_name = 'Company Created'), MIN(e.event_time)) AS signed_up_at,
           p.activated_at,
           COALESCE(p.first_sync_at, MIN(e.event_time) FILTER (WHERE e.event_name = 'Accounting Sync')) AS first_sync_at,
           COALESCE(p.last_action_at, MAX(e.event_time) FILTER (WHERE e.event_name = ANY(${actionNames}))) AS last_action_at,
           COALESCE(p.action_count, COUNT(*) FILTER (WHERE e.event_name = ANY(${actionNames})), 0)::int AS action_count,
           COALESCE(p.active_weeks, COUNT(DISTINCT date_trunc('week', e.event_time AT TIME ZONE ${TIMEZONE})) FILTER (WHERE e.event_name = ANY(${actionNames})), 0)::int AS active_weeks,
           COALESCE(p.path_had_upload, false) AS path_had_upload,
           COALESCE(p.path_had_ready, false) AS path_had_ready,
           COALESCE(p.path_had_sync, false) AS path_had_sync,
           COALESCE(p.path_had_recon, false) AS path_had_recon
    FROM public.events e
    LEFT JOIN company_profile p ON p.company_id = e.company_id
    WHERE e.company_id = ANY(${ids})
      AND e.distinct_id IS NOT NULL
      AND NOT public.is_internal_email(e.email)
    GROUP BY e.company_id, e.distinct_id, p.company_name, p.signed_up_at, p.activated_at,
             p.first_sync_at, p.last_action_at, p.action_count, p.active_weeks,
             p.path_had_upload, p.path_had_ready, p.path_had_sync, p.path_had_recon
    ORDER BY e.company_id, email NULLS LAST, e.distinct_id
  `;
  const allowedPairs = pairs ? new Set(pairs.map(([companyId, distinctId]) => `${companyId}\u0000${distinctId}`)) : null;
  const companies = new Map<string, Record<string, unknown>>();
  const users = new Map<string, Record<string, unknown> & { companies: Record<string, unknown>[]; ids: Set<string> }>();
  for (const row of rows) {
    const pairKey = `${String(row.company_id)}\u0000${String(row.distinct_id)}`;
    if (allowedPairs && !allowedPairs.has(pairKey)) continue;
    let company = companies.get(String(row.company_id));
    if (!company) {
      const signedUp = asDate(row.signed_up_at);
      const firstSync = asDate(row.first_sync_at);
      company = {
        company_id: row.company_id,
        company_name: row.company_name,
        signed_up_at: isoStamp(row.signed_up_at),
        activated_at: isoStamp(row.activated_at),
        first_sync_at: isoStamp(row.first_sync_at),
        last_action_at: isoStamp(row.last_action_at),
        lifetime_actions: asNumber(row.action_count),
        active_weeks: asNumber(row.active_weeks),
        actions_per_active_week: perWeek(asNumber(row.action_count), asNumber(row.active_weeks)),
        actions_that_week: 0,
        upload_that_week: 0,
        txn_that_week: 0,
        sync_that_week: 0,
        recon_that_week: 0,
        path_had_upload: Boolean(row.path_had_upload),
        path_had_ready: Boolean(row.path_had_ready),
        path_had_sync: Boolean(row.path_had_sync),
        path_had_recon: Boolean(row.path_had_recon),
        had_bill_upload: false,
        had_invoice_upload: false,
        had_statement_upload: false,
        had_ap_active: false,
        had_txn_active: false,
        had_gst_recon: false,
        had_created_bill_or_txn: false,
        ttv_hours: durationHours(signedUp, firstSync),
        value_events: [],
      };
      companies.set(String(row.company_id), company);
    }
    const userKey = row.email ? String(row.email).toLowerCase() : String(row.distinct_id);
    let user = users.get(userKey);
    if (!user) {
      user = {
        email: row.email,
        distinct_id: row.distinct_id,
        user_id: row.user_id,
        signed_up_at: isoStamp(row.signup_ev || row.first_ev),
        last_action_at: isoStamp(row.last_action_at),
        lifetime_actions: asNumber(row.action_count),
        active_weeks: asNumber(row.active_weeks),
        actions_per_active_week: perWeek(asNumber(row.action_count), asNumber(row.active_weeks)),
        actions_that_week: 0,
        companies: [],
        ids: new Set(),
      };
      users.set(userKey, user);
    }
    if (!user.ids.has(String(row.company_id))) {
      user.ids.add(String(row.company_id));
      user.companies.push(company);
    }
  }
  const userList = [...users.values()].map(({ ids: _ids, ...user }) => user);
  return { people_count: userList.length, company_count: ids.length, users: userList };
}

async function slicePairsForWindow(start: string, end: string, eventNames: string[] = [...ACTION_EVENTS]) {
  const db = sql();
  return db`
    SELECT DISTINCT e.company_id, e.distinct_id
    FROM public.events e
    WHERE e.event_name = ANY(${eventNames})
      AND NOT public.is_internal_email(e.email)
      AND e.distinct_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM client_company c WHERE c.company_id = e.company_id)
      AND e.event_time >= (${start}::date AT TIME ZONE ${TIMEZONE})
      AND e.event_time < (${end}::date AT TIME ZONE ${TIMEZONE})
    ORDER BY e.company_id, e.distinct_id
  `;
}

export async function overviewSlice(params: URLSearchParams) {
  const chart = params.get("chart");
  const key = params.get("key");
  if (!chart || !key) throw new Error("chart and key are required");
  const db = sql();
  const actionNames = [...ACTION_EVENTS];
  if (chart === "adoption") {
    return overviewAdoptionSlice(params);
  }
  if (chart === "funnel") {
    const mode = params.get("mode") || "reached";
    if (!["clients", "upload", "ready", "sync"].includes(key) || !["reached", "dropped"].includes(mode)) {
      throw new Error("invalid funnel slice");
    }
    if (key === "clients" && mode === "dropped") throw new Error("invalid funnel slice");
    const conditions: Record<string, string> = {
      clients: "TRUE",
      upload: "EXISTS (SELECT 1 FROM public.events e WHERE e.company_id = c.company_id AND e.event_name = 'Upload')",
      ready: "EXISTS (SELECT 1 FROM public.events e WHERE e.company_id = c.company_id AND e.event_name IN ('Invoice Created', 'Transaction Ledger Updated'))",
      sync: "EXISTS (SELECT 1 FROM company_activation a WHERE a.company_id = c.company_id)",
    };
    const ordered = ["clients", "upload", "ready", "sync"];
    const where = mode === "reached" ? conditions[key] : `(${conditions[ordered[ordered.indexOf(key) - 1]]}) AND NOT (${conditions[key]})`;
    const rows = await db.unsafe(`SELECT c.company_id FROM client_company c WHERE ${where} ORDER BY c.company_id`);
    return overviewSlicePayload(rows.map((row) => String(row.company_id)));
  }
  if (chart === "weekly") {
    if (!["people", "companies"].includes(key)) throw new Error("invalid weekly slice");
    const week = requiredDate(params.get("week"), "week", { monday: true });
    const pairs = await db`
      SELECT DISTINCT e.company_id, e.distinct_id FROM public.events e
      WHERE e.event_name = ANY(${actionNames})
        AND NOT public.is_internal_email(e.email)
        AND e.distinct_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM client_company c WHERE c.company_id = e.company_id)
        AND date_trunc('week', e.event_time AT TIME ZONE ${TIMEZONE})::date = ${week}::date
      ORDER BY e.company_id, e.distinct_id
    `;
    const companyRows = key === "companies" ? await db`
      SELECT DISTINCT e.company_id FROM public.events e
      WHERE e.event_name = ANY(${actionNames})
        AND EXISTS (SELECT 1 FROM client_company c WHERE c.company_id = e.company_id)
        AND date_trunc('week', e.event_time AT TIME ZONE ${TIMEZONE})::date = ${week}::date
      ORDER BY e.company_id
    ` : pairs;
    return overviewSlicePayload(
      companyRows.map((row) => String(row.company_id)),
      pairs.map((row) => [String(row.company_id), String(row.distinct_id)]),
    );
  }
  if (chart === "period") {
    if (!["dau", "wau", "mau"].includes(key) || !["current", "prior"].includes(params.get("which") || "")) {
      throw new Error("invalid period slice");
    }
    const stamps = await overviewStamps();
    const which = params.get("which")!;
    const nextMonth = addMonths(stamps.monthStart, 1);
    const priorWeek = addDays(stamps.weekStart, -28);
    const windows: Record<string, [string, string]> = which === "current" ? {
      dau: [stamps.asOfDate, addDays(stamps.asOfDate, 1)],
      wau: [stamps.weekStart, addDays(stamps.weekStart, 7)],
      mau: [stamps.monthStart, nextMonth],
    } : {
      dau: [stamps.priorMonthStart, stamps.monthStart],
      wau: [priorWeek, addDays(priorWeek, 7)],
      mau: [stamps.priorMonthStart, stamps.monthStart],
    };
    const pairs = await slicePairsForWindow(...windows[key]);
    return overviewSlicePayload(pairs.map((row) => String(row.company_id)), pairs.map((row) => [String(row.company_id), String(row.distinct_id)]));
  }
  if (chart === "vintage") {
    if (!["activated", "not_activated"].includes(key)) throw new Error("invalid vintage slice");
    const month = requiredDate(params.get("month"), "month", { monthStart: true });
    const rows = key === "activated" ? await db`
      WITH first_seen AS (
        SELECT c.company_id, date_trunc('month', first_event.event_time AT TIME ZONE ${TIMEZONE})::date AS first_month
        FROM client_company c JOIN LATERAL (
          SELECT e.event_time FROM public.events e WHERE e.company_id = c.company_id ORDER BY e.event_time ASC LIMIT 1
        ) first_event ON true
      )
      SELECT f.company_id FROM first_seen f JOIN company_activation a ON a.company_id = f.company_id
      WHERE f.first_month = ${month}::date ORDER BY f.company_id
    ` : await db`
      WITH first_seen AS (
        SELECT c.company_id, date_trunc('month', first_event.event_time AT TIME ZONE ${TIMEZONE})::date AS first_month
        FROM client_company c JOIN LATERAL (
          SELECT e.event_time FROM public.events e WHERE e.company_id = c.company_id ORDER BY e.event_time ASC LIMIT 1
        ) first_event ON true
      )
      SELECT f.company_id FROM first_seen f LEFT JOIN company_activation a ON a.company_id = f.company_id
      WHERE f.first_month = ${month}::date AND a.company_id IS NULL ORDER BY f.company_id
    `;
    return overviewSlicePayload(rows.map((row) => String(row.company_id)));
  }
  if (chart === "composition") {
    if (!["new", "returning", "resurrected"].includes(key)) throw new Error("invalid composition slice");
    const month = requiredDate(params.get("month"), "month", { monthStart: true });
    const qualifier = key === "new" ? "f.first_month = $1::date" : key === "returning"
      ? "f.first_month < $1::date AND EXISTS (SELECT 1 FROM action_months prev WHERE prev.distinct_id = active.distinct_id AND prev.month = ($1::date - INTERVAL '1 month')::date)"
      : "f.first_month < $1::date AND NOT EXISTS (SELECT 1 FROM action_months prev WHERE prev.distinct_id = active.distinct_id AND prev.month = ($1::date - INTERVAL '1 month')::date)";
    const rows = await db.unsafe(`
      WITH action_months AS (
        SELECT DISTINCT e.distinct_id, date_trunc('month', e.event_time AT TIME ZONE '${TIMEZONE}')::date AS month
        FROM public.events e
        WHERE e.event_name = ANY($2::text[]) AND NOT public.is_internal_email(e.email)
          AND EXISTS (SELECT 1 FROM client_company c WHERE c.company_id = e.company_id)
      ), first_action AS (
        SELECT distinct_id, MIN(month) AS first_month FROM action_months GROUP BY distinct_id
      ), active AS (
        SELECT DISTINCT e.company_id, e.distinct_id FROM public.events e
        WHERE e.event_name = ANY($2::text[]) AND NOT public.is_internal_email(e.email) AND e.distinct_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM client_company c WHERE c.company_id = e.company_id)
          AND date_trunc('month', e.event_time AT TIME ZONE '${TIMEZONE}')::date = $1::date
      )
      SELECT active.company_id, active.distinct_id FROM active JOIN first_action f ON f.distinct_id = active.distinct_id
      WHERE ${qualifier} ORDER BY active.company_id, active.distinct_id
    `, [month, actionNames]);
    return overviewSlicePayload(rows.map((row) => String(row.company_id)), rows.map((row) => [String(row.company_id), String(row.distinct_id)]));
  }
  if (chart === "week8") {
    if (!["retained", "dropped"].includes(key)) throw new Error("invalid week8 slice");
    const cohort = requiredDate(params.get("cohort_week"), "cohort_week", { monday: true });
    if (key === "retained") {
      const cell = await heatmapCell(cohort, 8);
      return { people_count: cell.people_count, company_count: cell.company_count, users: cell.users };
    }
    const target = addDays(cohort, 56);
    const rows = await db`
      SELECT a.company_id FROM company_activation a
      WHERE a.activation_week = ${cohort}::date
        AND NOT EXISTS (
          SELECT 1 FROM company_week_value v
          WHERE v.company_id = a.company_id AND v.week_start = ${target}::date AND v.had_value
        )
      ORDER BY a.company_id
    `;
    return overviewSlicePayload(rows.map((row) => String(row.company_id)));
  }
  if (chart === "family") {
    const familyEvents: Record<string, string[]> = {
      upload: ["Upload", "Mapping Completed", "Saved Template Loaded"],
      ap: ["Invoice Created", "Invoice Bulk Edited", "Download-Inv", "Preview"],
      txn: ["Transaction Ledger Updated", "Transaction Status", "Transaction Type Updated", "Transaction Configuration Edited", "Vendor Mismatch Resolved"],
      sync: ["Accounting Sync"], recon: ["Recon Processed"], other: ["Entity Created", "Delete", "Download", "Export"],
    };
    if (!familyEvents[key]) throw new Error("invalid family slice");
    const stamps = await overviewStamps();
    const pairs = await slicePairsForWindow(stamps.monthStart, addMonths(stamps.monthStart, 1), familyEvents[key]);
    return overviewSlicePayload(pairs.map((row) => String(row.company_id)), pairs.map((row) => [String(row.company_id), String(row.distinct_id)]));
  }
  if (chart === "product") {
    if (![...PRODUCT_SPLIT_KEYS].includes(key as typeof PRODUCT_SPLIT_FLAGS[number]["key"])) {
      throw new Error("invalid product slice");
    }
    const week = requiredDate(params.get("week"), "week", { monday: true });
    const rows = await db.unsafe(
      `SELECT company_id FROM company_week_product WHERE week_start = $1::date AND ${key} ORDER BY company_id`,
      [week],
    );
    return overviewSlicePayload(rows.map((row) => String(row.company_id)));
  }
  if (chart === "growth") {
    if (key !== "companies") throw new Error("invalid growth slice");
    const week = requiredDate(params.get("week"), "week", { monday: true });
    const rows = await db`
      SELECT c.company_id FROM client_company c
      JOIN LATERAL (
        SELECT e.event_time FROM public.events e
        WHERE e.company_id = c.company_id
        ORDER BY e.event_time ASC LIMIT 1
      ) first_event ON true
      WHERE date_trunc('week', first_event.event_time AT TIME ZONE ${TIMEZONE})::date = ${week}::date
      ORDER BY c.company_id
    `;
    return overviewSlicePayload(rows.map((row) => String(row.company_id)));
  }
  if (chart === "monthly") {
    if (!["people", "companies"].includes(key)) throw new Error("invalid monthly slice");
    const month = requiredDate(params.get("month"), "month", { monthStart: true });
    const end = addMonths(month, 1);
    const pairs = await slicePairsForWindow(month, end);
    if (key === "people") {
      return overviewSlicePayload(
        pairs.map((row) => String(row.company_id)),
        pairs.map((row) => [String(row.company_id), String(row.distinct_id)]),
      );
    }
    const companyRows = await db`
      SELECT DISTINCT e.company_id FROM public.events e
      WHERE e.event_name = ANY(${actionNames})
        AND EXISTS (SELECT 1 FROM client_company c WHERE c.company_id = e.company_id)
        AND e.event_time >= (${month}::date AT TIME ZONE ${TIMEZONE})
        AND e.event_time < (${end}::date AT TIME ZONE ${TIMEZONE})
      ORDER BY e.company_id
    `;
    return overviewSlicePayload(
      companyRows.map((row) => String(row.company_id)),
      pairs.map((row) => [String(row.company_id), String(row.distinct_id)]),
    );
  }
  if (chart === "module" || chart === "module_usage") {
    return overviewModuleSlice(params);
  }
  if (chart === "feature") {
    const week = requiredDate(params.get("week"), "week", { monday: true });
    const usage = await featureUsage(week);
    const moduleKey = key.split(".")[0];
    const featureModule = usage.modules.find((item) => item.key === moduleKey);
    if (!featureModule) throw new Error("invalid feature slice");
    const weekEnd = addDays(week, 7);
    const eventRows = await db`
      SELECT e.company_id, e.event_name,
             e.properties->>'type' AS type,
             e.properties->>'status' AS status,
             e.properties->>'entityType' AS entity_type
      FROM public.events e
      WHERE EXISTS (SELECT 1 FROM client_company c WHERE c.company_id = e.company_id)
        AND e.event_time >= (${week}::date AT TIME ZONE ${TIMEZONE})
        AND e.event_time < (${weekEnd}::date AT TIME ZONE ${TIMEZONE})
    `;
    const pathIds: Record<string, Set<string>> = { txn: new Set(), ap: new Set(), ar: new Set(), gst: new Set() };
    const syncIds = new Set<string>();
    for (const row of eventRows) {
      const nodeKey = featureNodeKey(String(row.event_name), normEventType(row.type), row.status, row.entity_type);
      if (!nodeKey) continue;
      if (nodeKey === "sync.raw") {
        syncIds.add(String(row.company_id));
        continue;
      }
      pathIds[nodeKey.split(".")[0]]?.add(String(row.company_id));
    }
    const companyIds = [...new Set(eventRows.filter((row) => featureMatches(
      key,
      String(row.event_name),
      normEventType(row.type),
      row.status,
      row.entity_type,
      String(row.company_id),
      pathIds,
      syncIds,
    )).map((row) => String(row.company_id)))];
    const payload = await overviewSlicePayload(companyIds);
    return { ...payload, feature: featureModule, feature_node: key.includes(".") ? key : null };
  }
  throw new Error("invalid chart");
}

export { TIMELINE_MAX_LIMIT };
