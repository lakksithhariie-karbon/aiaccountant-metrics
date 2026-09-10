"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, X } from "lucide-react";

import { metricsApi, MetricsApiError } from "@/lib/api";
import type {
  CellPayload,
  CompanyEvent,
  CompanyMembership,
  CompanySummary,
  CompanyWeek,
  ActivationWeekFilter,
  HeatmapCell,
  SummaryPayload,
  WeekActivity,
  TimelineEvent,
  TimelinePayload,
  User,
} from "@/lib/types";
import { productPathLabels } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { CompanyInsights } from "@/components/metrics/company-insights";
import { CompanyMembershipCard } from "@/components/metrics/company-membership-card";
import { MetricsChrome } from "@/components/metrics/metrics-chrome";
import {
  CellDrawerSkeleton,
  CompanyDrawerSkeleton,
  HeatmapSkeleton,
  LoadingStatus,
  Skeleton,
  TimelineSkeleton,
} from "@/components/metrics/skeletons";

const REL_MIN = 0;
const REL_MAX = 8;
const TIMELINE_PAGE = 100;
const TIMELINE_DOM_CAP = 200;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

type LoadStatus = "idle" | "loading" | "ready" | "error";

function isoDate(value?: string | null) {
  if (!value) return null;
  const match = String(value).match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : String(value);
}

function cohortLabel(value?: string | null) {
  const iso = isoDate(value);
  const match = iso && /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return iso ?? "—";
  return `${Number(match[3])} ${MONTHS[Number(match[2]) - 1]} ${match[1]}`;
}

function shortDate(value?: string | null) {
  const iso = isoDate(value);
  const match = iso && /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return iso ?? "—";
  return `${Number(match[3])} ${MONTHS[Number(match[2]) - 1]}`;
}

function numberValue(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function formatInteger(value?: number | null) {
  if (value == null || !Number.isFinite(Number(value))) return "—";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(Number(value));
}

function formatDecimal(value?: number | string | null, digits = 1) {
  if (value == null || value === "" || !Number.isFinite(Number(value))) return "—";
  return Number(value).toFixed(digits);
}

function formatPercent(value?: number | string | null, digits = 1) {
  if (value == null || value === "" || !Number.isFinite(Number(value))) return "—";
  const raw = String(value);
  const numeric = Number(value);
  const percentage = raw.includes("%") ? numeric : numeric <= 1 ? numeric * 100 : numeric;
  return `${percentage.toFixed(digits)}%`;
}

function cellRate(cell: HeatmapCell) {
  if (cell.rate != null && Number.isFinite(Number(cell.rate))) return Number(cell.rate);
  const cohortSize = numberValue(cell.cohort_size);
  return cohortSize ? numberValue(cell.retained_count) / cohortSize : 0;
}

function levelFor(rate: number) {
  if (rate >= 0.8) return "level-5";
  if (rate >= 0.5) return "level-4";
  if (rate >= 0.35) return "level-3";
  if (rate >= 0.2) return "level-2";
  return "level-1";
}

function normalizeCellPayload(raw: CellPayload | User[]): CellPayload {
  if (Array.isArray(raw)) {
    return {
      users: raw,
      people_count: raw.length,
      company_count: null,
      median_actions_that_week: null,
      share_with_upload: null,
      share_with_sync: null,
      share_with_recon: null,
    };
  }
  return {
    ...raw,
    users: Array.isArray(raw?.users) ? raw.users : [],
  };
}

function companyCountFor(users: User[]) {
  const ids = new Set<string>();
  users.forEach((user) => {
    (user.companies ?? []).forEach((company) => {
      if (company.company_id) ids.add(String(company.company_id));
    });
  });
  return ids.size;
}

function cellInsightText(payload: CellPayload) {
  const parts: string[] = [];
  if (payload.median_actions_that_week != null) {
    parts.push(`Median ${formatDecimal(payload.median_actions_that_week, 0)} actions`);
  }
  const shares: string[] = [];
  if (payload.share_with_upload != null) shares.push(`Upload ${Math.round(numberValue(payload.share_with_upload) * 100)}%`);
  if (payload.share_with_bill != null) shares.push(`Bill ${Math.round(numberValue(payload.share_with_bill) * 100)}%`);
  if (payload.share_with_invoice != null) shares.push(`Invoice ${Math.round(numberValue(payload.share_with_invoice) * 100)}%`);
  if (payload.share_with_statement != null) shares.push(`Statement ${Math.round(numberValue(payload.share_with_statement) * 100)}%`);
  if (payload.share_with_ap != null) shares.push(`AP ${Math.round(numberValue(payload.share_with_ap) * 100)}%`);
  if (payload.share_with_txn != null) shares.push(`Txn ${Math.round(numberValue(payload.share_with_txn) * 100)}%`);
  if (payload.share_with_gst != null) shares.push(`GST ${Math.round(numberValue(payload.share_with_gst) * 100)}%`);
  if (payload.share_with_sync != null) shares.push(`Sync ${Math.round(numberValue(payload.share_with_sync) * 100)}%`);
  if (payload.share_with_recon != null) shares.push(`Recon ${Math.round(numberValue(payload.share_with_recon) * 100)}%`);
  if (shares.length) parts.push(`${shares.join(" · ")} of companies`);
  return parts.join(" · ");
}

function normalizeTimelinePayload(raw: TimelinePayload | TimelineEvent[]): TimelinePayload {
  if (Array.isArray(raw)) {
    return { events: raw, total: raw.length, limit: TIMELINE_PAGE, offset: 0 };
  }
  return {
    events: Array.isArray(raw?.events) ? raw.events : [],
    total: raw?.total ?? null,
    limit: raw?.limit ?? TIMELINE_PAGE,
    offset: raw?.offset ?? 0,
  };
}

const EMPTY_WEEK_FILTER: ActivationWeekFilter = { from_week: null, to_week: null };

function snapWeek(value?: string | null) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  const daysSinceMonday = (parsed.getUTCDay() + 6) % 7;
  parsed.setUTCDate(parsed.getUTCDate() - daysSinceMonday);
  return parsed.toISOString().slice(0, 10);
}

function readWeekFilter() {
  const params = new URLSearchParams(window.location.search);
  const from_week = snapWeek(params.get("from_week"));
  const to_week = snapWeek(params.get("to_week"));
  if (from_week && to_week && from_week > to_week) return { ...EMPTY_WEEK_FILTER };
  return { from_week, to_week };
}

function sameWeekFilter(left: ActivationWeekFilter, right: ActivationWeekFilter) {
  return left.from_week === right.from_week && left.to_week === right.to_week;
}

function catalogRange(cohortWeeks: string[] | null | undefined, count: number): ActivationWeekFilter {
  const weeks = Array.from(new Set(
    (cohortWeeks ?? [])
      .map((week) => snapWeek(week))
      .filter((week): week is string => Boolean(week)),
  )).sort();
  const selected = weeks.slice(-count);
  if (!selected.length) return { ...EMPTY_WEEK_FILTER };
  return { from_week: selected[0], to_week: selected[selected.length - 1] };
}

function weekPreset(
  filter: ActivationWeekFilter,
  last8: ActivationWeekFilter,
  last12: ActivationWeekFilter,
): "all" | "last8" | "last12" {
  if (last8.from_week && sameWeekFilter(filter, last8)) return "last8";
  if (last12.from_week && sameWeekFilter(filter, last12)) return "last12";
  return "all";
}

function includesCohort(filter: ActivationWeekFilter, cohortWeek: string) {
  return (!filter.from_week || cohortWeek >= filter.from_week)
    && (!filter.to_week || cohortWeek <= filter.to_week);
}


export function RetentionExplorer() {
  const [heatmap, setHeatmap] = useState<HeatmapCell[]>([]);
  const [heatmapStatus, setHeatmapStatus] = useState<LoadStatus>("loading");
  const [summary, setSummary] = useState<SummaryPayload | null>(null);
  const [summaryStatus, setSummaryStatus] = useState<LoadStatus>("loading");
  const [apiDown, setApiDown] = useState(false);
  const [filterError, setFilterError] = useState("");
  const [weekFilter, setWeekFilter] = useState<ActivationWeekFilter>({ ...EMPTY_WEEK_FILTER });
  const [filterReady, setFilterReady] = useState(false);

  const [selectedCellKey, setSelectedCellKey] = useState<string | null>(null);
  const [cellLabel, setCellLabel] = useState("");
  const [cellPayload, setCellPayload] = useState<CellPayload | null>(null);
  const [cellStatus, setCellStatus] = useState<LoadStatus>("idle");
  const [cellFilter, setCellFilter] = useState("");
  const [cellDrawerMounted, setCellDrawerMounted] = useState(false);
  const [cellDrawerOpen, setCellDrawerOpen] = useState(false);

  const [selectedCompanyId, setSelectedCompanyId] = useState<string | null>(null);
  const [selectedCompanyLabel, setSelectedCompanyLabel] = useState("");
  const [companySummary, setCompanySummary] = useState<CompanySummary | null>(null);
  const [companyStatus, setCompanyStatus] = useState<LoadStatus>("idle");
  const [companyError, setCompanyError] = useState("");
  const [companyDrawerMounted, setCompanyDrawerMounted] = useState(false);
  const [companyDrawerOpen, setCompanyDrawerOpen] = useState(false);
  const [timeline, setTimeline] = useState<TimelinePayload | null>(null);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [timelineError, setTimelineError] = useState("");

  const cellRequest = useRef(0);
  const companyRequest = useRef(0);
  const cellAbort = useRef<AbortController | null>(null);
  const companyAbort = useRef<AbortController | null>(null);
  const timelineAbort = useRef<AbortController | null>(null);
  const cellCloseTimer = useRef<number | null>(null);
  const companyCloseTimer = useRef<number | null>(null);
  const cellButtonRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const cellCloseRef = useRef<HTMLButtonElement | null>(null);

  const rows = useMemo(() => {
    const grouped = new Map<string, Map<number, HeatmapCell>>();
    heatmap.forEach((cell) => {
      const cohort = isoDate(cell.cohort_week);
      const rel = Number(cell.rel_week);
      if (!cohort || rel < REL_MIN || rel > REL_MAX) return;
      if (!grouped.has(cohort)) grouped.set(cohort, new Map());
      grouped.get(cohort)?.set(rel, cell);
    });
    return [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [heatmap]);

  const filteredUsers = useMemo(() => {
    const users = cellPayload?.users ?? [];
    const query = cellFilter.trim().toLowerCase();
    if (!query) return users;
    return users.filter((user) => {
      if (String(user.email ?? "").toLowerCase().includes(query)) return true;
      return (user.companies ?? []).some((company) => String(company.company_name ?? "").toLowerCase().includes(query));
    });
  }, [cellFilter, cellPayload]);


  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setWeekFilter(readWeekFilter());
      setFilterReady(true);
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (!filterReady) return;
    const controller = new AbortController();
    const down = new URLSearchParams(window.location.search).get("down") === "1";
    const loadingTimer = window.setTimeout(() => {
      if (controller.signal.aborted) return;
      setHeatmapStatus("loading");
      setSummaryStatus("loading");
      setApiDown(false);
      setFilterError("");
    }, 0);
    if (down) {
      const previewTimer = window.setTimeout(() => {
        if (controller.signal.aborted) return;
        setApiDown(true);
        setHeatmapStatus("error");
        setSummaryStatus("error");
      }, 0);
      return () => {
        controller.abort();
        window.clearTimeout(loadingTimer);
        window.clearTimeout(previewTimer);
      };
    }

    void metricsApi.health(controller.signal).then(
      () => Promise.allSettled([
        metricsApi.heatmap(weekFilter, controller.signal),
        metricsApi.summary(weekFilter, controller.signal),
      ]),
      () => {
        if (controller.signal.aborted) return;
        setApiDown(true);
        setHeatmapStatus("error");
        setSummaryStatus("error");
        return null;
      },
    ).then((results) => {
      if (!results || controller.signal.aborted) return;
      const [heatmapResult, summaryResult] = results;
      if (heatmapResult.status === "fulfilled") {
        setHeatmap(heatmapResult.value);
        setHeatmapStatus("ready");
      } else {
        setHeatmapStatus("error");
        if (heatmapResult.reason instanceof MetricsApiError && heatmapResult.reason.status === 400) {
          setFilterError("Activation week range is invalid.");
        } else {
          setApiDown(true);
        }
      }
      if (summaryResult.status === "fulfilled") {
        setSummary(summaryResult.value);
        setSummaryStatus("ready");
      } else {
        setSummaryStatus("error");
        if (summaryResult.reason instanceof MetricsApiError && summaryResult.reason.status === 400) {
          setFilterError("Activation week range is invalid.");
        }
      }
    });
    return () => {
      controller.abort();
      window.clearTimeout(loadingTimer);
    };
  }, [filterReady, weekFilter]);

  useEffect(() => {
    if (!filterReady) return;
    const url = new URL(window.location.href);
    if (weekFilter.from_week) url.searchParams.set("from_week", weekFilter.from_week);
    else url.searchParams.delete("from_week");
    if (weekFilter.to_week) url.searchParams.set("to_week", weekFilter.to_week);
    else url.searchParams.delete("to_week");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }, [filterReady, weekFilter]);

  const closeCompanyDrawer = useCallback((returnFocus = true) => {
    companyAbort.current?.abort();
    timelineAbort.current?.abort();
    companyRequest.current += 1;
    setCompanyDrawerOpen(false);
    if (companyCloseTimer.current) window.clearTimeout(companyCloseTimer.current);
    companyCloseTimer.current = window.setTimeout(() => {
      setCompanyDrawerMounted(false);
      setSelectedCompanyId(null);
      companyCloseTimer.current = null;
      if (returnFocus) cellCloseRef.current?.focus();
    }, 190);
  }, []);

  const closeCellDrawer = useCallback((returnFocus = true) => {
    cellAbort.current?.abort();
    cellRequest.current += 1;
    closeCompanyDrawer(false);
    setCellDrawerOpen(false);
    if (cellCloseTimer.current) window.clearTimeout(cellCloseTimer.current);
    cellCloseTimer.current = window.setTimeout(() => {
      setCellDrawerMounted(false);
      setCompanyDrawerMounted(false);
      cellCloseTimer.current = null;
      if (returnFocus && selectedCellKey) cellButtonRefs.current[selectedCellKey]?.focus();
    }, 190);
  }, [closeCompanyDrawer, selectedCellKey]);

  const changeWeekFilter = useCallback((next: ActivationWeekFilter) => {
    const cohortWeek = selectedCellKey?.split("|")[0];
    if (cohortWeek && !includesCohort(next, cohortWeek)) closeCellDrawer(false);
    setWeekFilter(next);
  }, [closeCellDrawer, selectedCellKey]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (document.getElementById("sections-menu")) return;
      if (companyDrawerOpen) {
        event.preventDefault();
        closeCompanyDrawer();
      } else if (cellDrawerOpen) {
        event.preventDefault();
        closeCellDrawer();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [cellDrawerOpen, closeCellDrawer, closeCompanyDrawer, companyDrawerOpen]);

  const loadCell = useCallback(async (cohortWeek: string, relWeek: number) => {
    cellAbort.current?.abort();
    companyAbort.current?.abort();
    timelineAbort.current?.abort();
    companyRequest.current += 1;
    if (cellCloseTimer.current) window.clearTimeout(cellCloseTimer.current);
    if (companyCloseTimer.current) window.clearTimeout(companyCloseTimer.current);
    setCompanyDrawerMounted(false);
    setCompanyDrawerOpen(false);
    const controller = new AbortController();
    cellAbort.current = controller;
    const requestId = ++cellRequest.current;
    const label = `${cohortLabel(cohortWeek)} · Week ${relWeek}`;
    setSelectedCellKey(`${cohortWeek}|${relWeek}`);
    setCellLabel(label);
    setCellPayload(null);
    setCellFilter("");
    setCellStatus("loading");
    setSelectedCompanyId(null);
    setCompanySummary(null);
    setTimeline(null);
    setTimelineError("");
    setCellDrawerMounted(true);
    window.requestAnimationFrame(() => setCellDrawerOpen(true));

    try {
      const raw = await metricsApi.cell(cohortWeek, relWeek, controller.signal);
      if (requestId !== cellRequest.current) return;
      const payload = normalizeCellPayload(raw);
      setCellPayload(payload);
      setCellStatus("ready");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (requestId !== cellRequest.current) return;
      setCellStatus("error");
      setCellPayload(null);
    }
  }, []);

  const loadTimelinePage = useCallback(async (offset: number) => {
    if (!selectedCompanyId) return;
    timelineAbort.current?.abort();
    const controller = new AbortController();
    timelineAbort.current = controller;
    const requestId = companyRequest.current;
    setTimelineLoading(true);
    setTimelineError("");
    try {
      const raw = await metricsApi.timeline(selectedCompanyId, offset, TIMELINE_PAGE, controller.signal);
      if (controller.signal.aborted || requestId !== companyRequest.current) return;
      const payload = normalizeTimelinePayload(raw);
      const events = Array.isArray(raw) ? [...payload.events].sort((a, b) => String(b.event_time).localeCompare(String(a.event_time))) : payload.events;
      setTimeline({ ...payload, events });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (requestId !== companyRequest.current) return;
      setTimelineError(error instanceof MetricsApiError ? error.message : "Timeline could not be loaded.");
    } finally {
      if (!controller.signal.aborted && requestId === companyRequest.current) setTimelineLoading(false);
    }
  }, [selectedCompanyId]);

  const openCompany = useCallback(async (company: CompanyMembership) => {
    companyAbort.current?.abort();
    timelineAbort.current?.abort();
    if (companyCloseTimer.current) window.clearTimeout(companyCloseTimer.current);
    const controller = new AbortController();
    companyAbort.current = controller;
    const requestId = ++companyRequest.current;
    const companyId = String(company.company_id);
    const label = company.company_name || companyId;
    setSelectedCompanyId(companyId);
    setSelectedCompanyLabel(label);
    setCompanySummary(null);
    setCompanyError("");
    setCompanyStatus("loading");
    setTimeline(null);
    setTimelineError("");
    setTimelineLoading(true);
    setCompanyDrawerMounted(true);
    window.requestAnimationFrame(() => setCompanyDrawerOpen(true));

    try {
      const [summaryResult, timelineResult] = await Promise.allSettled([
        metricsApi.companySummary(companyId, controller.signal),
        metricsApi.timeline(companyId, 0, TIMELINE_PAGE, controller.signal),
      ]);
      if (controller.signal.aborted || requestId !== companyRequest.current) return;

      if (summaryResult.status === "fulfilled") {
        setCompanySummary(summaryResult.value);
        setCompanyStatus("ready");
      } else {
        setCompanyStatus("error");
        setCompanyError(summaryResult.reason instanceof MetricsApiError ? summaryResult.reason.message : "Company could not be loaded.");
      }

      if (timelineResult.status === "fulfilled") {
        const payload = normalizeTimelinePayload(timelineResult.value);
        const events = Array.isArray(timelineResult.value)
          ? [...payload.events].sort((a, b) => String(b.event_time).localeCompare(String(a.event_time)))
          : payload.events;
        setTimeline({ ...payload, events });
        setTimelineError("");
      } else {
        setTimelineError(timelineResult.reason instanceof MetricsApiError ? timelineResult.reason.message : "Timeline could not be loaded.");
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (requestId !== companyRequest.current) return;
      setCompanyStatus("error");
      setCompanyError(error instanceof MetricsApiError ? error.message : "Company could not be loaded.");
    } finally {
      if (!controller.signal.aborted && requestId === companyRequest.current) setTimelineLoading(false);
    }
  }, []);

  const last8Filter = useMemo(() => catalogRange(summary?.cohort_weeks, 8), [summary?.cohort_weeks]);
  const last12Filter = useMemo(() => catalogRange(summary?.cohort_weeks, 12), [summary?.cohort_weeks]);

  useEffect(() => {
    if (!summary?.cohort_weeks?.length) return;
    if (sameWeekFilter(weekFilter, EMPTY_WEEK_FILTER)) return;
    if (sameWeekFilter(weekFilter, last8Filter) || sameWeekFilter(weekFilter, last12Filter)) return;
    const timer = window.setTimeout(() => changeWeekFilter({ ...EMPTY_WEEK_FILTER }), 0);
    return () => window.clearTimeout(timer);
  }, [changeWeekFilter, last8Filter, last12Filter, summary?.cohort_weeks, weekFilter]);

  const week8Retained = summary?.week8_retained ?? summary?.week8_retained_count;
  const summaryCards = [
    {
      label: "Activated",
      value: formatInteger(summary?.activated),
      subline: summary?.client_companies != null ? `of ${formatInteger(summary.client_companies)} client companies.` : "client companies.",
    },
    {
      label: "Activation rate",
      value: formatPercent(summary?.activation_rate),
      subline: "first Accounting Sync / client companies (staff-only already out).",
    },
    {
      label: "Median TTV",
      value: summary?.median_ttv_hours != null ? `${formatDecimal(summary.median_ttv_hours)} h` : "—",
      subline: "Company Created → first Accounting Sync.",
    },
    {
      label: "Week-8 retention",
      value: formatPercent(summary?.week8_retention),
      subline:
        summary?.week8_cohort_week && week8Retained != null && summary.week8_cohort_size != null
          ? `latest mature cohort · ${cohortLabel(summary.week8_cohort_week)} · ${formatInteger(week8Retained)} of ${formatInteger(summary.week8_cohort_size)}.`
          : summaryStatus === "ready" && summary?.week8_retention == null
            ? "no mature week-8 cohort in this range."
            : "latest mature cohort with a week-8 cell.",
    },
    {
      label: "Recon among activated",
      value: formatPercent(summary?.recon_among_activated),
      subline: "at least one Recon Processed.",
    },
  ];

  const cellPeopleCount = cellPayload?.people_count ?? cellPayload?.users.length ?? 0;
  const cellCompanyCount = cellPayload?.company_count ?? companyCountFor(cellPayload?.users ?? []);
  const cellInsight = cellPayload ? cellInsightText(cellPayload) : "";
  const timelineEvents = timeline?.events.slice(0, TIMELINE_DOM_CAP) ?? [];
  const timelineOffset = numberValue(timeline?.offset);
  const timelineTotal = timeline?.total ?? null;
  const hasOlder = timelineTotal != null ? timelineOffset + timelineEvents.length < timelineTotal : timelineEvents.length >= TIMELINE_PAGE;

  return (
    <MetricsChrome active="retention" extraLockScroll={cellDrawerOpen || companyDrawerOpen}>
        <div className="metrics-card">
          <div className="metrics-title-row">
            <h1 className="metrics-page-title">Retention</h1>
            <div className="metrics-week-filter">
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button variant="outline" className="metrics-week-filter-trigger" />}>
                  Activation weeks
                  <ChevronDown data-icon="inline-end" aria-hidden="true" />
                </DropdownMenuTrigger>
                <DropdownMenuContent className="w-40" align="end">
                  <DropdownMenuGroup>
                    <DropdownMenuRadioGroup
                      value={weekPreset(weekFilter, last8Filter, last12Filter)}
                      onValueChange={(value) => {
                        if (value === "last8") changeWeekFilter({ ...last8Filter });
                        else if (value === "last12") changeWeekFilter({ ...last12Filter });
                        else changeWeekFilter({ ...EMPTY_WEEK_FILTER });
                      }}
                    >
                      <DropdownMenuRadioItem value="all">All</DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value="last8" disabled={!summary?.cohort_weeks?.length}>Last 8</DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value="last12" disabled={!summary?.cohort_weeks?.length}>Last 12</DropdownMenuRadioItem>
                    </DropdownMenuRadioGroup>
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          <section className="metrics-kpis" aria-label="Retention summary" aria-busy={summaryStatus === "loading"}>
            {summaryStatus === "loading" ? <LoadingStatus label="Loading summary" /> : null}
            {summaryCards.map((card) => (
              <div className="metrics-kpi" key={card.label}>
                <div className="metrics-kpi-label">{card.label}</div>
                <div className="metrics-kpi-value">
                  {summaryStatus === "loading" ? <Skeleton className="metrics-skeleton-kpi" /> : null}
                  {summaryStatus === "error" ? <span className="metrics-kpi-error">Could not load</span> : null}
                  {summaryStatus === "ready" ? card.value : null}
                </div>
                <div className="metrics-kpi-subline">{card.subline}</div>
              </div>
            ))}
          </section>

          <main className="metrics-main" id="main">
            {apiDown ? <p className="metrics-api-error">API down. Heatmap unavailable. Check the service and reload.</p> : null}
            {!apiDown ? (
              <section className="metrics-panel" aria-labelledby="heatmap-heading" aria-busy={heatmapStatus === "loading"}>
                <h2 id="heatmap-heading" className="metrics-panel-title">Retention heatmap</h2>
                {heatmapStatus === "loading" ? (
                  <>
                    <LoadingStatus label="Loading heatmap" />
                    <HeatmapSkeleton />
                  </>
                ) : null}
                {heatmapStatus === "error" ? (
                  <p className="metrics-status metrics-status-error" role="status">{filterError || "Could not load heatmap."}</p>
                ) : null}
                {heatmapStatus === "ready" && rows.length === 0 ? (
                  <p className="metrics-empty">No retention data yet. The heatmap is empty.</p>
                ) : null}
                {heatmapStatus === "ready" && rows.length > 0 ? (
                  <div className="metrics-table-wrap">
                    <table className="metrics-heatmap">
                      <thead>
                        <tr>
                          <th scope="col">Cohort week</th>
                          <th scope="col">n</th>
                          {Array.from({ length: REL_MAX - REL_MIN + 1 }, (_, index) => <th scope="col" key={index}>Week {index}</th>)}
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map(([cohortWeek, rowCells]) => {
                          const firstCell = rowCells.get(REL_MIN) ?? rowCells.values().next().value;
                          return (
                            <tr key={cohortWeek}>
                              <th scope="row" title={cohortWeek}>{cohortLabel(cohortWeek)}</th>
                              <td className="metrics-n-col">{firstCell ? firstCell.cohort_size : "—"}</td>
                              {Array.from({ length: REL_MAX - REL_MIN + 1 }, (_, index) => {
                                const relWeek = index + REL_MIN;
                                const cell = rowCells.get(relWeek);
                                const key = `${cohortWeek}|${relWeek}`;
                                if (!cell) return <td className="metrics-cell metrics-cell-missing" key={key}>—</td>;
                                const rate = cellRate(cell);
                                return (
                                  <td className="metrics-cell" key={key}>
                                    <button
                                      ref={(node) => { cellButtonRefs.current[key] = node; }}
                                      type="button"
                                      className={cn("metrics-cell-button", levelFor(rate), selectedCellKey === key && "selected")}
                                      aria-label={`Cohort ${cohortLabel(cohortWeek)} Week ${relWeek}: ${cell.retained_count} of ${cell.cohort_size}`}
                                      title={`Cohort ${cohortLabel(cohortWeek)} Week ${relWeek}: ${cell.retained_count} of ${cell.cohort_size} (${formatPercent(rate)})`}
                                      onClick={() => void loadCell(cohortWeek, relWeek)}
                                    >
                                      <span className="metrics-cell-count">{cell.retained_count}/{cell.cohort_size}</span>
                                      <span className="metrics-cell-rate">{formatPercent(rate)}</span>
                                    </button>
                                  </td>
                                );
                              })}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : null}
                <div className="metrics-captions">
                  <p className="metrics-caption">Rows are activation cohort weeks (oldest first). Columns are weeks since activation (0–8).</p>
                  <p className="metrics-caption">Click a heatmap cell to open the company list.</p>
                </div>
              </section>
            ) : null}
          </main>
        </div>

      {cellDrawerMounted || companyDrawerMounted ? (
        <button className="metrics-scrim" type="button" aria-label="Close open panels" onClick={() => { closeCompanyDrawer(false); closeCellDrawer(false); }} />
      ) : null}

      {cellDrawerMounted ? (
        <aside className={cn("metrics-drawer metrics-cell-drawer", cellDrawerOpen && "open")} role="dialog" aria-modal="true" aria-labelledby="cell-drawer-title" aria-hidden={!cellDrawerOpen} aria-busy={cellStatus === "loading"}>
          <div className="metrics-drawer-head">
            <div className="metrics-drawer-head-text">
              <h2 id="cell-drawer-title" className="metrics-drawer-title">Company list</h2>
              <p className="metrics-drawer-cell-label">{cellLabel}</p>
              <p className="metrics-drawer-counts">
                {cellStatus === "loading" ? <Skeleton className="metrics-skeleton-count" /> : cellPayload ? `${cellPeopleCount} users · ${cellCompanyCount} companies` : "Unable to load users"}
              </p>
            </div>
            <Button ref={cellCloseRef} variant="outline" size="icon" type="button" aria-label="Close company list" onClick={() => closeCellDrawer(true)}>
              <X aria-hidden="true" />
            </Button>
          </div>
          <div className="metrics-drawer-body">
            {cellStatus === "loading" ? <LoadingStatus label="Loading users" /> : null}
            <Input
              value={cellFilter}
              onChange={(event) => setCellFilter(event.target.value)}
              type="search"
              placeholder="email or company name…"
              autoComplete="off"
              aria-label="Filter users by email or company name"
            />
            {cellInsight ? <p className="metrics-drawer-insights">{cellInsight}</p> : null}
            {cellStatus === "loading" ? <CellDrawerSkeleton /> : null}
            {cellStatus === "error" ? <p className="metrics-status metrics-status-error">Could not load users. Check the service and reload.</p> : null}
            {cellStatus === "ready" && filteredUsers.length === 0 ? <p className="metrics-status">No users match this filter.</p> : null}
            {cellStatus === "ready" && filteredUsers.length > 0 ? (
              <ul className="metrics-user-list">
                {filteredUsers.map((user) => {
                  const companies = user.companies ?? [];
                  const userLabel = user.email || user.distinct_id || "(no user id)";
                  return (
                    <li className="metrics-user-block" key={user.distinct_id || user.user_id || userLabel}>
                      <div className="metrics-user-label">
                        <span>{userLabel}</span>
                        <Badge>{companies.length} {companies.length === 1 ? "company" : "companies"}</Badge>
                      </div>
                      <p className="metrics-user-meta">
                        Signed up {shortDate(user.signed_up_at)} · {formatInteger(user.lifetime_actions)} lifetime actions · {formatInteger(user.active_weeks)} active weeks
                      </p>
                      {companies.length > 1 ? <p className="metrics-company-group-label">Integrated companies</p> : null}
                      <ul className="metrics-company-list">
                        {companies.map((company, companyIndex) => {
                          const activity = activityFor(company);
                          return (
                            <li key={`${company.company_id}-${companyIndex}`}>
                              <CompanyMembershipCard
                                company={company}
                                companyIndex={companyIndex}
                                companyCount={companies.length}
                                userLabel={userLabel}
                                selected={selectedCompanyId === company.company_id}
                                integrationLabel={shortDate(company.first_sync_at || company.activated_at || company.signed_up_at)}
                                onOpen={() => void openCompany(company)}
                                showWeekActivity
                                activity={activity}
                              />
                            </li>
                          );
                        })}
                      </ul>
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </div>
        </aside>
      ) : null}

      {companyDrawerMounted ? (
        <aside className={cn("metrics-drawer metrics-company-drawer", companyDrawerOpen && "open")} role="dialog" aria-modal="true" aria-labelledby="company-drawer-title" aria-hidden={!companyDrawerOpen} aria-busy={companyStatus === "loading" || timelineLoading}>
          <div className="metrics-drawer-head">
            <div className="metrics-drawer-head-text">
              <h2 className="metrics-drawer-title">Company drill</h2>
              <p id="company-drawer-title" className="metrics-company-title">{companySummary?.company_name || selectedCompanyLabel}</p>
            </div>
            <Button variant="outline" size="icon" type="button" aria-label="Close company drill" onClick={() => closeCompanyDrawer(true)}>
              <X aria-hidden="true" />
            </Button>
          </div>
          <div className="metrics-drawer-body">
            {companyStatus === "loading" ? (
              <>
                <LoadingStatus label="Loading company" />
                <CompanyDrawerSkeleton />
              </>
            ) : null}
            {companyStatus === "error" ? <p className="metrics-status metrics-status-error" role="status">Could not load company: {companyError}</p> : null}
            {companyStatus === "ready" && companySummary ? (
              <>
                <CompanyInsights company={companySummary} />

                <h3 className="metrics-subhead">Actions by week</h3>
                <div className="metrics-table-wrap metrics-table-wrap-slim">
                  <table className="metrics-detail-table">
                    <thead><tr><th scope="col">Week</th><th scope="col">Actions</th><th scope="col">Upload</th><th scope="col">Txn</th><th scope="col">Sync</th><th scope="col">Recon</th><th scope="col">Path</th></tr></thead>
                    <tbody>
                      {(companySummary.by_week ?? []).length ? (companySummary.by_week ?? []).map((week: CompanyWeek, index) => (
                        <tr key={`${week.week_start}-${index}`}>
                          <td>{isoDate(week.week_start) || "—"}</td><td>{numberValue(week.action_count)}</td><td>{numberValue(week.upload_count)}</td><td>{numberValue(week.txn_count)}</td><td>{numberValue(week.sync_count)}</td><td>{numberValue(week.recon_count)}</td><td>{productPathLabels(week).join(" · ") || "—"}</td>
                        </tr>
                      )) : <tr><td colSpan={7}>No weekly action data.</td></tr>}
                    </tbody>
                  </table>
                </div>

                <h3 className="metrics-subhead">Actions by event</h3>
                <div className="metrics-table-wrap metrics-table-wrap-slim">
                  <table className="metrics-detail-table">
                    <thead><tr><th scope="col">Event</th><th scope="col">Count</th></tr></thead>
                    <tbody>
                      {(companySummary.by_event ?? []).length ? (companySummary.by_event ?? []).map((event: CompanyEvent, index) => (
                        <tr key={`${event.event_name}-${index}`}><td className="metrics-event-name">{event.event_name || "—"}</td><td>{numberValue(event.count)}</td></tr>
                      )) : <tr><td colSpan={2}>No action events.</td></tr>}
                    </tbody>
                  </table>
                </div>

                <div className="metrics-section-head">
                  <h3 className="metrics-subhead">Event timeline</h3>
                  <div className="metrics-section-meta">
                    <span>Newest first</span>
                    {!timelineLoading && !timelineError ? (
                      <span>
                        {timelineEvents.length
                          ? (timelineTotal != null
                            ? `${formatInteger(timelineEvents.length)} of ${formatInteger(timelineTotal)}`
                            : formatInteger(timelineEvents.length))
                          : "No events"}
                      </span>
                    ) : null}
                  </div>
                </div>
                {timelineLoading ? (
                  <div className="metrics-timeline-loading" aria-busy="true">
                    <LoadingStatus label="Loading timeline" />
                    <TimelineSkeleton />
                  </div>
                ) : null}
                {timelineError ? <p className="metrics-status metrics-status-error">{timelineError}</p> : null}
                {!timelineLoading && !timelineError && timelineEvents.length ? (
                  <>
                    <ol className="metrics-timeline">
                      {timelineEvents.map((event, index) => <li key={`${event.event_time}-${event.event_name}-${index}`}><span className="metrics-event-time">{formatEventTime(event.event_time)}</span><span className="metrics-event-name">{event.event_name || "—"}</span></li>)}
                    </ol>
                    <div className="metrics-timeline-nav">
                      <Button variant="outline" size="sm" type="button" disabled={timelineOffset === 0 || timelineLoading} onClick={() => void loadTimelinePage(0)}>Newest</Button>
                      <Button variant="outline" size="sm" type="button" disabled={!hasOlder || timelineLoading} onClick={() => void loadTimelinePage(timelineOffset + TIMELINE_PAGE)}>{hasOlder ? "Older" : "No older events"}</Button>
                    </div>
                  </>
                ) : null}
              </>
            ) : null}
          </div>
        </aside>
      ) : null}
    </MetricsChrome>
  );
}
function activityFor(company: CompanyMembership): WeekActivity {
  return {
    upload_count: company.upload_that_week,
    txn_count: company.txn_that_week,
    sync_count: company.sync_that_week,
    recon_count: company.recon_that_week,
  };
}

function formatEventTime(value?: string | null) {
  if (!value) return "—";
  return String(value).replace("T", " ").slice(0, 16);
}
