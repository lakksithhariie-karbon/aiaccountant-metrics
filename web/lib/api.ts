import type {
  CellPayload,
  CompanySummary,
  ActivationWeekFilter,
  HeatmapCell,
  OverviewChartsPayload,
  OverviewPayload,
  OverviewSliceParams,
  SummaryPayload,
  TimelinePayload,
  User,
} from "@/lib/types";

export class MetricsApiError extends Error {
  status: number;

  constructor(message: string, status = 0) {
    super(message);
    this.name = "MetricsApiError";
    this.status = status;
  }
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new MetricsApiError("The metrics service could not be reached.");
  }

  if (!response.ok) {
    throw new MetricsApiError(`Request failed with status ${response.status}.`, response.status);
  }

  try {
    return (await response.json()) as T;
  } catch {
    throw new MetricsApiError("The metrics service returned invalid JSON.", response.status);
  }
}

function withWeekFilter(path: string, filter?: ActivationWeekFilter) {
  if (!filter) return path;
  const params = new URLSearchParams();
  if (filter.from_week) params.set("from_week", filter.from_week);
  if (filter.to_week) params.set("to_week", filter.to_week);
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

export const metricsApi = {
  health: (signal?: AbortSignal) => getJson<{ ok?: boolean }>("/health", signal),
  overview: (signal?: AbortSignal) => getJson<OverviewPayload>("/api/overview", signal),
  overviewCharts: (signal?: AbortSignal) => getJson<OverviewChartsPayload>("/api/overview/charts", signal),
  overviewSlice: (params: OverviewSliceParams, signal?: AbortSignal) => {
    const query = new URLSearchParams();
    query.set("chart", params.chart);
    query.set("key", params.key);
    if (params.mode) query.set("mode", params.mode);
    if (params.week) query.set("week", params.week);
    if (params.which) query.set("which", params.which);
    if (params.month) query.set("month", params.month);
    if (params.cohort_week) query.set("cohort_week", params.cohort_week);
    if (params.module) query.set("module", params.module);
    if (params.stage) query.set("stage", params.stage);
    if (params.property) query.set("property", params.property);
    if (params.value) query.set("value", params.value);
    if (params.window_start) query.set("window_start", params.window_start);
    if (params.window_end) query.set("window_end", params.window_end);
    if (params.granularity) query.set("granularity", params.granularity);
    return getJson<CellPayload>(`/api/overview/slice?${query.toString()}`, signal);
  },
  summary: (filter?: ActivationWeekFilter, signal?: AbortSignal) =>
    getJson<SummaryPayload>(withWeekFilter("/api/summary", filter), signal),
  heatmap: (filter?: ActivationWeekFilter, signal?: AbortSignal) =>
    getJson<HeatmapCell[]>(withWeekFilter("/api/heatmap", filter), signal),
  cell: (cohortWeek: string, relWeek: number | string, signal?: AbortSignal) =>
    getJson<CellPayload | User[]>(
      `/api/heatmap/cell?cohort_week=${encodeURIComponent(cohortWeek)}&rel_week=${encodeURIComponent(String(relWeek))}`,
      signal,
    ),
  companySummary: (companyId: string, signal?: AbortSignal) =>
    getJson<CompanySummary>(`/api/companies/${encodeURIComponent(companyId)}/summary`, signal),
  timeline: (companyId: string, offset: number, limit = 100, signal?: AbortSignal) =>
    getJson<TimelinePayload | TimelinePayload["events"]>(
      `/api/companies/${encodeURIComponent(companyId)}/timeline?limit=${limit}&offset=${offset}`,
      signal,
    ),
};
