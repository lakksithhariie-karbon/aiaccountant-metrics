"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { metricsApi, MetricsApiError } from "@/lib/api";
import type {
  CellPayload,
  CompanyMembership,
  CompanySummary,
  OverviewChartsPayload,
  OverviewAdoptionWindow,
  OverviewModuleUsagePayloadPeriod,
  OverviewPayload,
  TimelineEvent,
  TimelinePayload,
} from "@/lib/types";
import {
  CompositionChart,
  GrowthChart,
  MonthlyActivesChart,
  PeriodBarsChart,
  VintageChart,
  WeeklyActivesChart,
  type OverviewDrill,
} from "@/components/metrics/charts/overview-charts";
import { ModuleMapChart } from "@/components/metrics/charts/module-map";
import { CompanyDrawer, PeopleDrawer, type DrillLoadStatus } from "@/components/metrics/metric-drill-drawers";
import { MetricsChrome } from "@/components/metrics/metrics-chrome";
import { LoadingStatus, Skeleton } from "@/components/metrics/skeletons";

type LoadStatus = DrillLoadStatus;
type OverviewPeriod = "week" | "month";

const TIMELINE_PAGE = 100;

function numberValue(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function formatInteger(value?: number | null) {
  if (value == null || !Number.isFinite(Number(value))) return "—";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(Number(value));
}

function formatPercent(value?: number | string | null, digits = 1) {
  if (value == null || value === "" || !Number.isFinite(Number(value))) return "—";
  const raw = String(value);
  const numeric = Number(value);
  const percentage = raw.includes("%") ? numeric : numeric <= 1 ? numeric * 100 : numeric;
  return `${percentage.toFixed(digits)}%`;
}

function normalizeTimelinePayload(raw: TimelinePayload | TimelineEvent[]): TimelinePayload {
  if (Array.isArray(raw)) return { events: raw, total: raw.length, limit: TIMELINE_PAGE, offset: 0 };
  return {
    events: Array.isArray(raw?.events) ? raw.events : [],
    total: raw?.total ?? null,
    limit: raw?.limit ?? TIMELINE_PAGE,
    offset: raw?.offset ?? 0,
  };
}

function ChartSkeleton() {
  return (
    <div className="overview-chart-skeleton" aria-hidden="true">
      <div className="overview-chart-skeleton-axis"><Skeleton className="overview-chart-skeleton-line" /></div>
      <div className="overview-chart-skeleton-bars">
        {Array.from({ length: 8 }, (_, index) => <Skeleton className={`overview-chart-skeleton-bar overview-chart-skeleton-bar-${index % 4}`} key={index} />)}
      </div>
      <div className="overview-chart-skeleton-labels">
        {Array.from({ length: 5 }, (_, index) => <Skeleton className="overview-chart-skeleton-label" key={index} />)}
      </div>
    </div>
  );
}

function ChartCard({
  title,
  caption,
  status,
  style,
  children,
}: {
  title: string;
  caption: string;
  status: LoadStatus;
  style?: React.CSSProperties;
  children: React.ReactNode;
}) {
  return (
    <section className="overview-chart-card" style={style} aria-label={title} aria-busy={status === "loading"}>
      <div className="overview-chart-head"><h2 className="overview-chart-title">{title}</h2></div>
      {status === "loading" ? <><LoadingStatus label={`Loading ${title}`} /><ChartSkeleton /></> : null}
      {status === "error" ? <p className="metrics-status metrics-status-error">Could not load this chart.</p> : null}
      {status === "ready" ? children : null}
      <p className="metrics-caption">{caption}</p>
    </section>
  );
}

function OverviewSection({
  id,
  title,
  description,
  cardMinWidth = 360,
  children,
}: {
  id: string;
  title: string;
  description: string;
  cardMinWidth?: number;
  children: React.ReactNode;
}) {
  return (
    <section
      className="overview-section"
      aria-labelledby={id}
      style={{
        display: "grid",
        gridColumn: "1 / -1",
        gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, ${cardMinWidth}px), 1fr))`,
        gap: 12,
      }}
    >
      <div className="metrics-section-head" style={{ gridColumn: "1 / -1", margin: "0 0 -2px" }}>
        <div>
          <h2 className="metrics-subhead" id={id}>{title}</h2>
          <p className="metrics-caption">{description}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

function PeriodToggle({ value, onChange }: { value: OverviewPeriod; onChange: (value: OverviewPeriod) => void }) {
  return (
    <div
      role="group"
      aria-label="Overview period"
      style={{
        display: "inline-flex",
        alignItems: "stretch",
        border: "1px solid var(--border)",
        background: "var(--muted)",
      }}
    >
      {(["week", "month"] as const).map((option) => {
        const active = value === option;
        return (
          <button
            key={option}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option)}
            style={{
              minWidth: 72,
              padding: "7px 12px",
              border: 0,
              borderRight: option === "week" ? "1px solid var(--border)" : 0,
              background: active ? "var(--foreground)" : "transparent",
              color: active ? "var(--background)" : "var(--muted-foreground)",
              fontSize: 12,
              fontWeight: active ? 650 : 500,
              letterSpacing: "0.01em",
            }}
          >
            {option === "week" ? "Week" : "Month"}
          </button>
        );
      })}
    </div>
  );
}

function AdoptionFunnelChart({
  window,
  period,
  onDrill,
}: {
  window?: OverviewAdoptionWindow | null;
  period: OverviewPeriod;
  onDrill: (drill: OverviewDrill) => void;
}) {
  const stages = window?.journey ?? window?.funnel ?? window?.stages ?? [];
  const cohortSize = numberValue(window?.cohort_size);
  if (!stages.length) return <p className="metrics-status">No cohort milestones for this period.</p>;
  return (
    <div className="overview-adoption-funnel" role="list" aria-label={`${period} adoption milestones`}>
      {stages.map((stage, index) => {
        const reached = numberValue(stage.companies ?? stage.reached);
        const share = cohortSize ? reached / cohortSize : 0;
        const conversion = index ? stage.conversion_rate : null;
        const drill: OverviewDrill = {
          chart: "adoption",
          key: stage.key,
          mode: "reached",
          period,
          granularity: period,
          week: period === "week" ? window?.start ?? window?.window_start : undefined,
          month: period === "month" ? window?.start ?? window?.window_start : undefined,
          window_start: window?.window_start ?? window?.start,
          window_end: window?.window_end ?? window?.end,
          label: `${stage.label} · ${formatInteger(reached)} companies`,
        };
        return (
          <div className="overview-adoption-funnel-step" role="listitem" key={stage.key}>
            <button
              type="button"
              className="overview-adoption-funnel-button"
              aria-label={`Open ${drill.label}`}
              onClick={() => onDrill(drill)}
            >
              <span className="overview-adoption-funnel-topline">
                <span className="overview-adoption-funnel-label">{stage.label}</span>
                <strong>{formatInteger(reached)}</strong>
              </span>
              <span className="overview-adoption-funnel-track" aria-hidden="true">
                <span style={{ width: `${Math.max(0, Math.min(100, share * 100))}%` }} />
              </span>
              <span className="overview-adoption-funnel-meta">
                <span>{formatPercent(share)} of cohort</span>
                {conversion != null ? <span>{formatPercent(conversion)} from prior</span> : <span>cohort entry</span>}
              </span>
            </button>
            {index < stages.length - 1 ? <span className="overview-adoption-funnel-connector" aria-hidden="true">↓</span> : null}
          </div>
        );
      })}
    </div>
  );
}

function moduleMapForPeriod(charts: OverviewChartsPayload | null, period: OverviewPeriod) {
  const source: OverviewModuleUsagePayloadPeriod | undefined = charts?.module_usage?.periods?.[period];
  if (!source) return null;
  const order = ["ap", "ar", "txn", "gst"];
  return {
    period: source.window_start ?? source.period_start ?? null,
    scope: source.granularity ?? period,
    modules: [...(source.modules ?? [])]
      .sort((left, right) => order.indexOf(left.key) - order.indexOf(right.key))
      .map((module) => ({
        key: module.key,
        label: module.label,
        companies: numberValue(module.companies),
        note: module.note,
        stages: (module.stages ?? []).map((stage) => ({
          key: stage.key,
          label: stage.label,
          companies: numberValue(stage.companies ?? stage.reached),
          events: numberValue(stage.events),
          conversion: stage.conversion,
          types: (stage.types ?? []).map((type) => ({
            value: type.value,
            events: numberValue(type.events),
            companies: numberValue(type.companies),
          })),
          note: stage.failed_events ? `${formatInteger(stage.failed_events)} failed upload${stage.failed_events === 1 ? "" : "s"}` : null,
        })),
      })),
  };
}

export function OverviewExplorer() {
  const [payload, setPayload] = useState<OverviewPayload | null>(null);
  const [overviewStatus, setOverviewStatus] = useState<LoadStatus>("loading");
  const [charts, setCharts] = useState<OverviewChartsPayload | null>(null);
  const [chartsStatus, setChartsStatus] = useState<LoadStatus>("loading");
  const [period, setPeriod] = useState<OverviewPeriod>("month");
  const [apiDown, setApiDown] = useState(false);

  const [sliceLabel, setSliceLabel] = useState("");
  const [slicePayload, setSlicePayload] = useState<CellPayload | null>(null);
  const [sliceStatus, setSliceStatus] = useState<LoadStatus>("idle");
  const [sliceFilter, setSliceFilter] = useState("");
  const [sliceMounted, setSliceMounted] = useState(false);
  const [sliceOpen, setSliceOpen] = useState(false);
  const [selectedCompanyId, setSelectedCompanyId] = useState<string | null>(null);

  const [companySummary, setCompanySummary] = useState<CompanySummary | null>(null);
  const [companyStatus, setCompanyStatus] = useState<LoadStatus>("idle");
  const [companyError, setCompanyError] = useState("");
  const [companyLabel, setCompanyLabel] = useState("");
  const [companyMounted, setCompanyMounted] = useState(false);
  const [companyOpen, setCompanyOpen] = useState(false);
  const [timeline, setTimeline] = useState<TimelinePayload | null>(null);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [timelineError, setTimelineError] = useState("");

  const sliceRequest = useRef(0);
  const companyRequest = useRef(0);
  const sliceAbort = useRef<AbortController | null>(null);
  const companyAbort = useRef<AbortController | null>(null);
  const timelineAbort = useRef<AbortController | null>(null);
  const sliceCloseTimer = useRef<number | null>(null);
  const companyCloseTimer = useRef<number | null>(null);
  const sliceCloseRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const down = new URLSearchParams(window.location.search).get("down") === "1";
    if (down) {
      const timer = window.setTimeout(() => {
        if (controller.signal.aborted) return;
        setApiDown(true);
        setOverviewStatus("error");
        setChartsStatus("error");
      }, 0);
      return () => {
        controller.abort();
        window.clearTimeout(timer);
      };
    }
    void metricsApi.health(controller.signal).then(
      () => Promise.allSettled([
        metricsApi.overview(controller.signal),
        metricsApi.overviewCharts(controller.signal),
      ]),
      () => {
        if (controller.signal.aborted) return null;
        setApiDown(true);
        setOverviewStatus("error");
        setChartsStatus("error");
        return null;
      },
    ).then((results) => {
      if (!results || controller.signal.aborted) return;
      const [overviewResult, chartsResult] = results;
      if (overviewResult.status === "fulfilled") {
        setPayload(overviewResult.value);
        setOverviewStatus("ready");
      } else {
        setOverviewStatus("error");
      }
      if (chartsResult.status === "fulfilled") {
        setCharts(chartsResult.value);
        setChartsStatus("ready");
      } else {
        setChartsStatus("error");
      }
    });
    return () => controller.abort();
  }, []);

  const closeCompany = useCallback(() => {
    companyAbort.current?.abort();
    timelineAbort.current?.abort();
    companyRequest.current += 1;
    setCompanyOpen(false);
    if (companyCloseTimer.current) window.clearTimeout(companyCloseTimer.current);
    companyCloseTimer.current = window.setTimeout(() => {
      setCompanyMounted(false);
      setSelectedCompanyId(null);
      companyCloseTimer.current = null;
      sliceCloseRef.current?.focus();
    }, 190);
  }, []);

  const closeSlice = useCallback(() => {
    sliceAbort.current?.abort();
    sliceRequest.current += 1;
    closeCompany();
    setSliceOpen(false);
    if (sliceCloseTimer.current) window.clearTimeout(sliceCloseTimer.current);
    sliceCloseTimer.current = window.setTimeout(() => {
      setSliceMounted(false);
      setCompanyMounted(false);
      sliceCloseTimer.current = null;
    }, 190);
  }, [closeCompany]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || document.getElementById("sections-menu")) return;
      if (companyOpen) {
        event.preventDefault();
        closeCompany();
      } else if (sliceOpen) {
        event.preventDefault();
        closeSlice();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [closeCompany, closeSlice, companyOpen, sliceOpen]);

  const openSlice = useCallback(async (drill: OverviewDrill) => {
    sliceAbort.current?.abort();
    companyAbort.current?.abort();
    timelineAbort.current?.abort();
    companyRequest.current += 1;
    if (sliceCloseTimer.current) window.clearTimeout(sliceCloseTimer.current);
    if (companyCloseTimer.current) window.clearTimeout(companyCloseTimer.current);
    setCompanyMounted(false);
    setCompanyOpen(false);
    const controller = new AbortController();
    sliceAbort.current = controller;
    const requestId = ++sliceRequest.current;
    setSliceLabel(drill.label);
    setSlicePayload(null);
    setSliceFilter("");
    setSliceStatus("loading");
    setSelectedCompanyId(null);
    setCompanySummary(null);
    setTimeline(null);
    setTimelineError("");
    setSliceMounted(true);
    window.requestAnimationFrame(() => setSliceOpen(true));
    try {
      const result = await metricsApi.overviewSlice({
        chart: drill.chart,
        key: drill.key,
        mode: drill.mode,
        week: drill.week,
        which: drill.which,
        month: drill.month,
        cohort_week: drill.cohort_week,
        module: drill.module ?? (drill.chart === "module" ? drill.key.split(".")[0] : undefined),
        stage: drill.stage ?? (drill.chart === "module" && drill.key.includes(".") ? drill.key.split(".").slice(1).join(".") : undefined),
        property: drill.property,
        value: drill.value,
        window_start: drill.window_start,
        window_end: drill.window_end,
        granularity: drill.granularity ?? drill.period,
      }, controller.signal);
      if (requestId !== sliceRequest.current) return;
      setSlicePayload({ ...result, users: Array.isArray(result.users) ? result.users : [] });
      setSliceStatus("ready");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (requestId !== sliceRequest.current) return;
      setSlicePayload(null);
      setSliceStatus("error");
    }
  }, []);

  const loadTimeline = useCallback(async (companyId: string, offset: number) => {
    timelineAbort.current?.abort();
    const controller = new AbortController();
    timelineAbort.current = controller;
    const requestId = companyRequest.current;
    setTimelineLoading(true);
    setTimelineError("");
    try {
      const raw = await metricsApi.timeline(companyId, offset, TIMELINE_PAGE, controller.signal);
      if (controller.signal.aborted || requestId !== companyRequest.current) return;
      const result = normalizeTimelinePayload(raw);
      const events = Array.isArray(raw) ? [...result.events].sort((a, b) => String(b.event_time).localeCompare(String(a.event_time))) : result.events;
      setTimeline({ ...result, events });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (requestId !== companyRequest.current) return;
      setTimelineError(error instanceof MetricsApiError ? error.message : "Timeline could not be loaded.");
    } finally {
      if (!controller.signal.aborted && requestId === companyRequest.current) setTimelineLoading(false);
    }
  }, []);

  const openCompany = useCallback(async (company: CompanyMembership) => {
    companyAbort.current?.abort();
    timelineAbort.current?.abort();
    if (companyCloseTimer.current) window.clearTimeout(companyCloseTimer.current);
    const controller = new AbortController();
    companyAbort.current = controller;
    const requestId = ++companyRequest.current;
    const companyId = String(company.company_id);
    setSelectedCompanyId(companyId);
    setCompanyLabel(company.company_name || companyId);
    setCompanySummary(null);
    setCompanyError("");
    setCompanyStatus("loading");
    setTimeline(null);
    setTimelineLoading(true);
    setTimelineError("");
    setCompanyMounted(true);
    window.requestAnimationFrame(() => setCompanyOpen(true));
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
      const result = normalizeTimelinePayload(timelineResult.value);
      const events = Array.isArray(timelineResult.value) ? [...result.events].sort((a, b) => String(b.event_time).localeCompare(String(a.event_time))) : result.events;
      setTimeline({ ...result, events });
      setTimelineError("");
    } else {
      setTimelineError(timelineResult.reason instanceof MetricsApiError ? timelineResult.reason.message : "Timeline could not be loaded.");
    }
    if (!controller.signal.aborted && requestId === companyRequest.current) setTimelineLoading(false);
  }, []);

  const activated = numberValue(payload?.activated);
  const clients = numberValue(payload?.client_companies);
  const cards = [
    { label: "New companies", value: `${formatInteger(payload?.new_companies_week)} / ${formatInteger(payload?.new_companies_month)}`, subline: "First-seen client companies this IST week / month." },
    { label: "Weekly / monthly people", value: `${formatInteger(payload?.wau)} / ${formatInteger(payload?.mau)}`, subline: "WAU / MAU. Distinct people with an action. Staff emails out." },
    { label: "Weekly / monthly companies", value: `${formatInteger(payload?.wau_companies)} / ${formatInteger(payload?.mau_companies)}`, subline: "Client companies with an action this IST week / month." },
    { label: "Adoption rate", value: formatPercent(payload?.adoption_rate), subline: `${formatInteger(activated)} of ${formatInteger(clients)} reached first Accounting Sync.` },
  ];
  const selectedModulePeriod = charts?.module_usage?.periods?.[period];

  return (
    <MetricsChrome active="overview" extraLockScroll={sliceOpen || companyOpen}>
      <div className="metrics-card">
        <div className="metrics-title-row">
          <div>
            <h1 className="metrics-page-title">Overview</h1>
            <p className="metrics-hint">Adoption, engagement, and module usage for the client book.</p>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span className="metrics-hint">Decision view</span>
            <PeriodToggle value={period} onChange={setPeriod} />
          </div>
        </div>
        <section className="metrics-kpis metrics-kpis-4" aria-label="Overview summary" aria-busy={overviewStatus === "loading"}>
          {overviewStatus === "loading" ? <LoadingStatus label="Loading overview" /> : null}
          {cards.map((card) => <div className="metrics-kpi" key={card.label}><div className="metrics-kpi-label">{card.label}</div><div className="metrics-kpi-value metrics-kpi-trio">{overviewStatus === "loading" ? <Skeleton className="metrics-skeleton-kpi" /> : null}{overviewStatus === "error" ? <span className="metrics-kpi-error">Could not load</span> : null}{overviewStatus === "ready" ? card.value : null}</div><div className="metrics-kpi-subline">{card.subline}</div></div>)}
        </section>
        <main className="metrics-main" id="main">
          {apiDown ? <p className="metrics-api-error">API down. Overview unavailable. Check the service and reload.</p> : null}
          <div className="overview-chart-grid">
            <OverviewSection id="overview-adoption" title="Adoption" description="New client companies and their current lifetime milestones. Click a mark to open the company slice." cardMinWidth={560}>
              <ChartCard title={period === "week" ? "New companies · weekly" : "New companies · monthly"} status={chartsStatus} caption={period === "week" ? "First-seen client companies by Asia/Kolkata week. The current week is in progress." : "First-seen client companies by Asia/Kolkata month, split by activation status."}>
                {period === "week" ? <GrowthChart data={charts?.growth ?? []} onDrill={openSlice} /> : <><div className="overview-chart-legend"><span className="overview-legend-not-activated">Not activated</span><span className="overview-legend-activated">Activated</span></div><VintageChart data={charts?.vintage ?? []} onDrill={openSlice} /></>}
              </ChartCard>
              <ChartCard title={`${period === "week" ? "Weekly" : "Monthly"} adoption journey`} status={chartsStatus} caption="Selected cohort companies that reached each milestone. Click a stage to open its company list.">
                <AdoptionFunnelChart window={charts?.adoption?.periods?.[period] ?? charts?.adoption?.[period]} period={period} onDrill={openSlice} />
              </ChartCard>
            </OverviewSection>
            <OverviewSection id="overview-engagement" title="Engagement" description="People and client companies with a signed action. Use Week or Month to change the primary activity view.">
              <ChartCard title={period === "week" ? "Weekly active users" : "Monthly active users"} status={chartsStatus} caption={period === "week" ? "Last 12 Asia/Kolkata weeks. Current week is in progress." : "Last 6 Asia/Kolkata months, including the current month."}>
                <div className="overview-chart-legend"><span className="overview-legend-people">People</span><span className="overview-legend-companies">Companies</span></div>
                {period === "week" ? <WeeklyActivesChart data={charts?.weekly ?? []} onDrill={openSlice} /> : <MonthlyActivesChart data={charts?.monthly ?? []} onDrill={openSlice} />}
              </ChartCard>
              <ChartCard title="Current vs prior activity" status={chartsStatus} caption={charts ? `Asia/Kolkata. Current ends ${charts.as_of_date}; prior DAU is average daily uniques from ${charts.prior_month_start} to ${charts.month_start}.` : "Asia/Kolkata current and prior activity."}>
                <div className="overview-chart-legend"><span className="overview-legend-prior">Prior</span><span className="overview-legend-current">Current</span></div>
                <PeriodBarsChart data={charts?.period ?? []} onDrill={openSlice} />
              </ChartCard>
              <ChartCard title="Monthly people composition" status={chartsStatus} caption="Last 6 Asia/Kolkata months, including the current month. Segments sum to monthly active people.">
                <div className="overview-chart-legend"><span className="overview-legend-new">New</span><span className="overview-legend-returning">Returning</span><span className="overview-legend-resurrected">Resurrected</span></div>
                <CompositionChart data={charts?.composition ?? []} onDrill={openSlice} />
              </ChartCard>
            </OverviewSection>
            <OverviewSection id="overview-feature-usage" title="Feature usage" description="AP, AR, Txn, and GST paths for the selected period. Stage counts are independent company reach, and paths can overlap.">
              <ChartCard title="Product module maps" status={chartsStatus} style={{ gridColumn: "1 / -1" }} caption={charts?.module_usage?.periods?.[period]?.window_start ? `${period === "week" ? "Asia/Kolkata week" : "Asia/Kolkata month"} ${charts.module_usage.periods[period].window_start}. Click a module or stage to open the company slice.` : "Select a period to inspect module usage."}>
                <ModuleMapChart data={moduleMapForPeriod(charts, period)} period={period} onDrill={(drill) => openSlice({
                  chart: "module",
                  key: drill.stageKey ? `${drill.moduleKey}.${drill.stageKey}` : drill.moduleKey,
                  module: drill.moduleKey,
                  stage: drill.stageKey ?? undefined,
                  period,
                  granularity: period,
                  week: period === "week" ? selectedModulePeriod?.window_start ?? selectedModulePeriod?.period_start ?? undefined : undefined,
                  month: period === "month" ? selectedModulePeriod?.window_start ?? selectedModulePeriod?.period_start ?? undefined : undefined,
                  label: drill.label,
                })} />
              </ChartCard>
            </OverviewSection>
          </div>
        </main>
      </div>
      {sliceMounted || companyMounted ? <button className="metrics-scrim" type="button" aria-label="Close open panels" onClick={closeSlice} /> : null}
      <PeopleDrawer mounted={sliceMounted} open={sliceOpen} status={sliceStatus} label={sliceLabel} payload={slicePayload} filter={sliceFilter} onFilterChange={setSliceFilter} selectedCompanyId={selectedCompanyId} onOpenCompany={(company) => void openCompany(company)} onClose={closeSlice} closeButtonRef={sliceCloseRef} />
      <CompanyDrawer mounted={companyMounted} open={companyOpen} status={companyStatus} summary={companySummary} error={companyError} label={companyLabel} timeline={timeline} timelineLoading={timelineLoading} timelineError={timelineError} onClose={closeCompany} onTimelinePage={(offset) => selectedCompanyId ? void loadTimeline(selectedCompanyId, offset) : undefined} />
    </MetricsChrome>
  );
}
