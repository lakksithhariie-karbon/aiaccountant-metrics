"use client";

import type {
  OverviewCompositionPoint,
  OverviewFeatureModule,
  OverviewFeatureUsage,
  OverviewFunnelPoint,
  OverviewGrowthPoint,
  OverviewMonthlyPoint,
  OverviewPeriodPoint,
  OverviewProductPoint,
  OverviewVintagePoint,
  OverviewWeek8Point,
  OverviewWeeklyPoint,
} from "@/lib/types";

export type OverviewDrill = {
  chart: "funnel" | "adoption" | "weekly" | "period" | "vintage" | "composition" | "week8" | "product" | "feature" | "module" | "growth" | "monthly";
  key: string;
  mode?: "reached" | "dropped";
  week?: string;
  which?: "current" | "prior";
  month?: string;
  cohort_week?: string;
  period?: "week" | "month";
  module?: string;
  stage?: string;
  property?: string;
  value?: string;
  window_start?: string;
  window_end?: string;
  granularity?: "week" | "month" | string;
  label: string;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function monthLabel(value: string) {
  const match = /^(\d{4})-(\d{2})/.exec(value);
  return match ? `${MONTHS[Number(match[2]) - 1]} ${match[1].slice(2)}` : value;
}

function weekLabel(value: string) {
  const match = /^\d{4}-(\d{2})-(\d{2})/.exec(value);
  return match ? `${MONTHS[Number(match[1]) - 1]} ${Number(match[2])}` : value;
}

function activate(event: React.KeyboardEvent<SVGGElement>, action: () => void) {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    action();
  }
}

function bounded(value: number, max: number, size: number) {
  return max > 0 ? Math.max(0, (value / max) * size) : 0;
}

export function WaterfallChart({ data, onDrill }: { data: OverviewFunnelPoint[]; onDrill: (drill: OverviewDrill) => void }) {
  const width = 600;
  const height = 250;
  const chartTop = 28;
  const chartHeight = 158;
  const barWidth = 86;
  const gap = 56;
  const max = Math.max(...data.map((item) => item.remaining), 1);
  return (
    <svg className="overview-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby="overview-funnel-title">
      <title id="overview-funnel-title">Client companies through activation</title>
      <line className="overview-chart-axis" x1="20" x2="580" y1={chartTop + chartHeight} y2={chartTop + chartHeight} />
      {data.map((item, index) => {
        const barHeight = bounded(item.remaining, max, chartHeight);
        const x = 28 + index * (barWidth + gap);
        const y = chartTop + chartHeight - barHeight;
        const previous = data[index - 1];
        const dropped = previous ? Math.max(previous.remaining - item.remaining, 0) : 0;
        const drill = { chart: "funnel" as const, key: item.key, mode: "reached" as const, label: `${item.label} · ${item.remaining} companies` };
        return (
          <g key={item.key}>
            {previous ? <line className="overview-chart-connector" x1={x - gap + barWidth} x2={x} y1={chartTop + chartHeight - bounded(previous.remaining, max, chartHeight)} y2={y} /> : null}
            <g role="button" tabIndex={0} className="overview-chart-target" aria-label={`Open ${item.remaining} companies at ${item.label}`} onClick={() => onDrill(drill)} onKeyDown={(event) => activate(event, () => onDrill(drill))}>
              <rect className={item.key === "sync" ? "overview-bar overview-bar-total" : "overview-bar"} x={x} y={y} width={barWidth} height={barHeight} />
              <text className="overview-chart-value" x={x + barWidth / 2} y={Math.max(y - 7, 16)} textAnchor="middle">{item.remaining}</text>
              <text className="overview-chart-label" x={x + barWidth / 2} y={chartTop + chartHeight + 22} textAnchor="middle">{item.label}</text>
            </g>
            {previous && dropped > 0 ? (
              <g role="button" tabIndex={0} className="overview-chart-target" aria-label={`Open ${dropped} companies dropped before ${item.label}`} onClick={() => onDrill({ chart: "funnel", key: item.key, mode: "dropped", label: `Dropped before ${item.label} · ${dropped} companies` })} onKeyDown={(event) => activate(event, () => onDrill({ chart: "funnel", key: item.key, mode: "dropped", label: `Dropped before ${item.label} · ${dropped} companies` }))}>
                <text className="overview-chart-drop" x={x - gap / 2 + barWidth / 2} y={Math.max(chartTop + 14, Math.min(y - 12, chartTop + chartHeight - 12))} textAnchor="middle">−{dropped}</text>
              </g>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

export function WeeklyActivesChart({ data, onDrill }: { data: OverviewWeeklyPoint[]; onDrill: (drill: OverviewDrill) => void }) {
  const width = 640;
  const height = 250;
  const top = 28;
  const chartHeight = 158;
  const left = 28;
  const max = Math.max(...data.flatMap((item) => [item.people, item.companies]), 1);
  const slot = (width - left - 12) / Math.max(data.length, 1);
  const barWidth = Math.min(14, Math.max(6, slot / 3));
  return (
    <svg className="overview-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby="overview-weekly-title">
      <title id="overview-weekly-title">Weekly active people and companies</title>
      <line className="overview-chart-axis" x1={left} x2={width - 12} y1={top + chartHeight} y2={top + chartHeight} />
      {data.map((item, index) => {
        const center = left + slot * index + slot / 2;
        const peopleHeight = bounded(item.people, max, chartHeight);
        const companyHeight = bounded(item.companies, max, chartHeight);
        const people = { chart: "weekly" as const, key: "people", week: item.week_start, label: `${weekLabel(item.week_start)} · ${item.people} people` };
        const companies = { chart: "weekly" as const, key: "companies", week: item.week_start, label: `${weekLabel(item.week_start)} · ${item.companies} companies` };
        return (
          <g key={item.week_start}>
            <g role="button" tabIndex={0} className="overview-chart-target" aria-label={`Open ${item.people} people active week of ${item.week_start}`} onClick={() => onDrill(people)} onKeyDown={(event) => activate(event, () => onDrill(people))}>
              <rect className="overview-bar overview-bar-people" x={center - barWidth - 2} y={top + chartHeight - peopleHeight} width={barWidth} height={peopleHeight} />
              {peopleHeight > 22 ? <text className="overview-chart-value-small" x={center - barWidth / 2 - 2} y={top + chartHeight - peopleHeight - 5} textAnchor="middle">{item.people}</text> : null}
            </g>
            <g role="button" tabIndex={0} className="overview-chart-target" aria-label={`Open ${item.companies} companies active week of ${item.week_start}`} onClick={() => onDrill(companies)} onKeyDown={(event) => activate(event, () => onDrill(companies))}>
              <rect className="overview-bar overview-bar-companies" x={center + 2} y={top + chartHeight - companyHeight} width={barWidth} height={companyHeight} />
              {companyHeight > 22 ? <text className="overview-chart-value-small" x={center + barWidth / 2 + 2} y={top + chartHeight - companyHeight - 5} textAnchor="middle">{item.companies}</text> : null}
            </g>
            <text className={item.current ? "overview-chart-label overview-chart-label-current" : "overview-chart-label"} x={center} y={top + chartHeight + 18} textAnchor="middle">{weekLabel(item.week_start)}</text>
          </g>
        );
      })}
    </svg>
  );
}

export function PeriodBarsChart({ data, onDrill }: { data: OverviewPeriodPoint[]; onDrill: (drill: OverviewDrill) => void }) {
  const width = 600;
  const height = 210;
  const max = Math.max(...data.flatMap((item) => [item.current, item.prior]), 1);
  return (
    <svg className="overview-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby="overview-period-title">
      <title id="overview-period-title">Current period compared with the prior period</title>
      {data.map((item, index) => {
        const y = 22 + index * 60;
        const currentWidth = bounded(item.current, max, 410);
        const priorWidth = bounded(item.prior, max, 410);
        const prior = { chart: "period" as const, key: item.key, which: "prior" as const, label: `${item.label} prior · ${item.prior} people` };
        const current = { chart: "period" as const, key: item.key, which: "current" as const, label: `${item.label} current · ${item.current} people` };
        return (
          <g key={item.key}>
            <text className="overview-chart-row-label" x="0" y={y + 16}>{item.label}</text>
            <g role="button" tabIndex={0} className="overview-chart-target" aria-label={`Open prior ${item.label} people`} onClick={() => onDrill(prior)} onKeyDown={(event) => activate(event, () => onDrill(prior))}>
              <rect className="overview-bar overview-bar-prior" x="100" y={y} width={priorWidth} height="18" />
              <text className="overview-chart-value-small" x={Math.min(100 + priorWidth + 6, 570)} y={y + 13}>{item.prior}</text>
            </g>
            <g role="button" tabIndex={0} className="overview-chart-target" aria-label={`Open current ${item.label} people`} onClick={() => onDrill(current)} onKeyDown={(event) => activate(event, () => onDrill(current))}>
              <rect className="overview-bar overview-bar-current" x="100" y={y + 25} width={currentWidth} height="18" />
              <text className="overview-chart-value-small" x={Math.min(100 + currentWidth + 6, 570)} y={y + 38}>{item.current}</text>
            </g>
          </g>
        );
      })}
    </svg>
  );
}

export function VintageChart({ data, onDrill }: { data: OverviewVintagePoint[]; onDrill: (drill: OverviewDrill) => void }) {
  const width = 640;
  const height = 260;
  const mid = 320;
  const centerGap = 72;
  const max = Math.max(...data.flatMap((item) => [item.activated, item.not_activated]), 1);
  return (
    <svg className="overview-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby="overview-vintage-title">
      <title id="overview-vintage-title">First-seen client companies split by activation</title>
      <line className="overview-chart-axis" x1={mid} x2={mid} y1="14" y2="244" />
      {data.map((item, index) => {
        const y = 16 + index * 28;
        const notWidth = bounded(item.not_activated, max, 250);
        const activatedWidth = bounded(item.activated, max, 250);
        const notX = mid - centerGap / 2 - notWidth;
        const activatedX = mid + centerGap / 2;
        const notActivated = { chart: "vintage" as const, key: "not_activated", month: item.month, label: `${monthLabel(item.month)} · ${item.not_activated} not activated` };
        const activated = { chart: "vintage" as const, key: "activated", month: item.month, label: `${monthLabel(item.month)} · ${item.activated} activated` };
        return (
          <g key={item.month}>
            <text className={item.current ? "overview-chart-label overview-chart-label-current" : "overview-chart-label"} x={mid} y={y + 13} textAnchor="middle">{monthLabel(item.month)}</text>
            <g role="button" tabIndex={0} className="overview-chart-target" aria-label={`Open ${item.not_activated} not activated companies first seen ${item.month}`} onClick={() => onDrill(notActivated)} onKeyDown={(event) => activate(event, () => onDrill(notActivated))}>
              <rect className="overview-bar overview-bar-not-activated" x={notX} y={y} width={notWidth} height="18" />
              {notWidth > 24 ? <text className="overview-chart-inbar" x={notX - 13} y={y + 13} textAnchor="end">{item.not_activated}</text> : null}
            </g>
            <g role="button" tabIndex={0} className="overview-chart-target" aria-label={`Open ${item.activated} activated companies first seen ${item.month}`} onClick={() => onDrill(activated)} onKeyDown={(event) => activate(event, () => onDrill(activated))}>
              <rect className="overview-bar overview-bar-activated" x={activatedX} y={y} width={activatedWidth} height="18" />
              {activatedWidth > 24 ? <text className="overview-chart-inbar" x={activatedX + activatedWidth + 13} y={y + 13}>{item.activated}</text> : null}
            </g>
          </g>
        );
      })}
    </svg>
  );
}

export function CompositionChart({ data, onDrill }: { data: OverviewCompositionPoint[]; onDrill: (drill: OverviewDrill) => void }) {
  const width = 600;
  const height = 250;
  const top = 20;
  const chartHeight = 166;
  const max = Math.max(...data.map((item) => item.new + item.returning + item.resurrected), 1);
  const slot = 540 / Math.max(data.length, 1);
  const barWidth = Math.min(48, slot - 14);
  const segments: Array<{ key: "new" | "returning" | "resurrected"; css: string; label: string }> = [
    { key: "new", css: "overview-bar-new", label: "New" },
    { key: "returning", css: "overview-bar-returning", label: "Returning" },
    { key: "resurrected", css: "overview-bar-resurrected", label: "Resurrected" },
  ];
  return (
    <svg className="overview-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby="overview-composition-title">
      <title id="overview-composition-title">Monthly active people composition</title>
      <line className="overview-chart-axis" x1="24" x2="578" y1={top + chartHeight} y2={top + chartHeight} />
      {data.map((item, index) => {
        const x = 32 + index * slot + (slot - barWidth) / 2;
        const total = item.new + item.returning + item.resurrected;
        const totalHeight = bounded(total, max, chartHeight);
        let y = top + chartHeight;
        return (
          <g key={item.month}>
            {segments.map((segment) => {
              const value = item[segment.key];
              const segmentHeight = bounded(value, max, chartHeight);
              y -= segmentHeight;
              const drill = { chart: "composition" as const, key: segment.key, month: item.month, label: `${monthLabel(item.month)} · ${segment.label} · ${value} people` };
              return (
                <g key={segment.key} role="button" tabIndex={0} className="overview-chart-target" aria-label={`Open ${value} ${segment.label.toLowerCase()} people in ${item.month}`} onClick={() => onDrill(drill)} onKeyDown={(event) => activate(event, () => onDrill(drill))}>
                  <rect className={`overview-bar ${segment.css}`} x={x} y={y} width={barWidth} height={segmentHeight} />
                </g>
              );
            })}
            {totalHeight > 20 ? <text className="overview-chart-value-small" x={x + barWidth / 2} y={Math.max(top + 12, top + chartHeight - totalHeight - 6)} textAnchor="middle">{total}</text> : null}
            <text className={item.current ? "overview-chart-label overview-chart-label-current" : "overview-chart-label"} x={x + barWidth / 2} y={top + chartHeight + 18} textAnchor="middle">{monthLabel(item.month)}</text>
          </g>
        );
      })}
    </svg>
  );
}

export function Week8Chart({ data, onDrill }: { data: OverviewWeek8Point[]; onDrill: (drill: OverviewDrill) => void }) {
  const width = 600;
  const height = 250;
  const top = 20;
  const chartHeight = 166;
  const slot = 540 / Math.max(data.length, 1);
  const barWidth = Math.min(48, slot - 16);
  return (
    <svg className="overview-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby="overview-week8-title">
      <title id="overview-week8-title">Mature Week 8 cohort retention</title>
      <line className="overview-chart-axis" x1="24" x2="578" y1={top + chartHeight} y2={top + chartHeight} />
      {data.map((item, index) => {
        const x = 32 + index * slot + (slot - barWidth) / 2;
        const retainedHeight = item.cohort_size ? (item.retained / item.cohort_size) * chartHeight : 0;
        const droppedHeight = chartHeight - retainedHeight;
        const retained = { chart: "week8" as const, key: "retained", cohort_week: item.cohort_week, label: `${weekLabel(item.cohort_week)} · ${item.retained} retained of ${item.cohort_size}` };
        const dropped = { chart: "week8" as const, key: "dropped", cohort_week: item.cohort_week, label: `${weekLabel(item.cohort_week)} · ${item.dropped} not retained of ${item.cohort_size}` };
        return (
          <g key={item.cohort_week}>
            <g role="button" tabIndex={0} className="overview-chart-target" aria-label={`Open ${item.dropped} companies not retained at Week 8 for ${item.cohort_week}`} onClick={() => onDrill(dropped)} onKeyDown={(event) => activate(event, () => onDrill(dropped))}>
              <rect className="overview-bar overview-bar-week8-drop" x={x} y={top} width={barWidth} height={droppedHeight} />
            </g>
            <g role="button" tabIndex={0} className="overview-chart-target" aria-label={`Open ${item.retained} retained companies at Week 8 for ${item.cohort_week}`} onClick={() => onDrill(retained)} onKeyDown={(event) => activate(event, () => onDrill(retained))}>
              <rect className="overview-bar overview-bar-week8-retained" x={x} y={top + droppedHeight} width={barWidth} height={retainedHeight} />
            </g>
            <text className="overview-chart-value-small" x={x + barWidth / 2} y={top + chartHeight + 34} textAnchor="middle">{item.retained}/{item.cohort_size}</text>
            <text className="overview-chart-label" x={x + barWidth / 2} y={top + chartHeight + 18} textAnchor="middle">{weekLabel(item.cohort_week)}</text>
          </g>
        );
      })}
    </svg>
  );
}

export function FeatureUsageChart({
  data,
  onDrill,
}: {
  data: OverviewFeatureUsage | null | undefined;
  onDrill: (drill: OverviewDrill) => void;
}) {
  const modules = data?.modules ?? [];
  const week = data?.week_start;
  if (!modules.length || !week) {
    return <p className="metrics-status">No feature usage in the latest complete week.</p>;
  }
  return (
    <div className="overview-feature">
      {modules.map((module) => {
        const moduleDrill = {
          chart: "feature" as const,
          key: module.key,
          week,
          label: `${module.label} · ${module.companies} companies`,
        };
        return (
          <section className="overview-feature-module" key={module.key} aria-label={`${module.label} feature usage`}>
            <button className="overview-feature-head" type="button" onClick={() => onDrill(moduleDrill)}>
              <span className="overview-feature-name">{module.label}</span>
              <span className="overview-feature-count">{module.companies}</span>
            </button>
            {module.note ? <p className="overview-feature-note">{module.note}</p> : null}
            <ol className="overview-feature-nodes">
              {module.nodes.map((node, index) => {
                const nodeKey = `${module.key}.${node.key}`;
                const types = node.types.slice(0, 4).map((item) => item.value).join(" · ");
                return (
                  <li key={node.key}>
                    {index > 0 ? <span className="overview-feature-join" aria-hidden="true">↓</span> : null}
                    <button
                      className="overview-feature-node"
                      type="button"
                      onClick={() => onDrill({
                        chart: "feature",
                        key: nodeKey,
                        week,
                        label: `${module.label} · ${node.label} · ${node.companies} companies`,
                      })}
                    >
                      <span className="overview-feature-node-label">{node.label}</span>
                      <span className="overview-feature-node-count">{node.companies}</span>
                      <span className="overview-feature-node-events">{node.events} events</span>
                      {types ? <span className="overview-feature-types">{types}</span> : null}
                    </button>
                  </li>
                );
              })}
            </ol>
          </section>
        );
      })}
    </div>
  );
}

export function FeatureChainTable({
  module,
  activeNode,
}: {
  module: OverviewFeatureModule;
  activeNode?: string | null;
}) {
  return (
    <div className="overview-feature-table-wrap">
      <table className="overview-table overview-feature-table">
        <thead>
          <tr>
            <th>Stage</th>
            <th>Companies</th>
            <th>Events</th>
            <th>Type</th>
          </tr>
        </thead>
        <tbody>
          {module.nodes.map((node) => {
            const nodeKey = `${module.key}.${node.key}`;
            const types = node.types.map((item) => `${item.value} ${item.events}`).join(", ");
            return (
              <tr key={node.key} className={activeNode === nodeKey ? "overview-feature-row-active" : undefined}>
                <td>{node.label}</td>
                <td>{node.companies}</td>
                <td>{node.events}</td>
                <td>{types || "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function GrowthChart({ data, onDrill }: { data: OverviewGrowthPoint[]; onDrill: (drill: OverviewDrill) => void }) {
  const width = 640;
  const height = 250;
  const top = 28;
  const chartHeight = 158;
  const left = 28;
  const max = Math.max(...data.map((item) => item.companies), 1);
  const slot = (width - left - 12) / Math.max(data.length, 1);
  const barWidth = Math.min(22, Math.max(8, slot / 2));
  return (
    <svg className="overview-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby="overview-growth-title">
      <title id="overview-growth-title">New client companies by first-seen week</title>
      <line className="overview-chart-axis" x1={left} x2={width - 12} y1={top + chartHeight} y2={top + chartHeight} />
      {data.map((item, index) => {
        const center = left + slot * index + slot / 2;
        const heightValue = bounded(item.companies, max, chartHeight);
        const drill = { chart: "growth" as const, key: "companies", week: item.week_start, label: `${weekLabel(item.week_start)} · ${item.companies} new companies` };
        return (
          <g key={item.week_start}>
            <g role="button" tabIndex={0} className="overview-chart-target" aria-label={`Open ${item.companies} new companies first seen week of ${item.week_start}`} onClick={() => onDrill(drill)} onKeyDown={(event) => activate(event, () => onDrill(drill))}>
              <rect className="overview-bar overview-bar-new" x={center - barWidth / 2} y={top + chartHeight - heightValue} width={barWidth} height={heightValue} />
              {heightValue > 18 ? <text className="overview-chart-value-small" x={center} y={top + chartHeight - heightValue - 5} textAnchor="middle">{item.companies}</text> : null}
            </g>
            <text className={item.current ? "overview-chart-label overview-chart-label-current" : "overview-chart-label"} x={center} y={top + chartHeight + 18} textAnchor="middle">{weekLabel(item.week_start)}</text>
          </g>
        );
      })}
    </svg>
  );
}

export function MonthlyActivesChart({ data, onDrill }: { data: OverviewMonthlyPoint[]; onDrill: (drill: OverviewDrill) => void }) {
  const width = 640;
  const height = 250;
  const top = 28;
  const chartHeight = 158;
  const left = 28;
  const max = Math.max(...data.flatMap((item) => [item.people, item.companies]), 1);
  const slot = (width - left - 12) / Math.max(data.length, 1);
  const barGap = 8;
  const barWidth = Math.min(20, Math.max(10, slot / 4));
  return (
    <svg className="overview-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby="overview-monthly-title">
      <title id="overview-monthly-title">Monthly active people and companies</title>
      <line className="overview-chart-axis" x1={left} x2={width - 12} y1={top + chartHeight} y2={top + chartHeight} />
      {data.map((item, index) => {
        const center = left + slot * index + slot / 2;
        const peopleHeight = bounded(item.people, max, chartHeight);
        const companyHeight = bounded(item.companies, max, chartHeight);
        const peopleY = top + chartHeight - peopleHeight;
        const companyY = top + chartHeight - companyHeight;
        const people = { chart: "monthly" as const, key: "people", month: item.month, label: `${monthLabel(item.month)} · ${item.people} people` };
        const companies = { chart: "monthly" as const, key: "companies", month: item.month, label: `${monthLabel(item.month)} · ${item.companies} companies` };
        return (
          <g key={item.month}>
            <g role="button" tabIndex={0} className="overview-chart-target" aria-label={`Open ${item.people} people active in ${item.month}`} onClick={() => onDrill(people)} onKeyDown={(event) => activate(event, () => onDrill(people))}>
              <rect className="overview-bar overview-bar-people" x={center - barWidth - barGap / 2} y={peopleY} width={barWidth} height={peopleHeight} />
              {peopleHeight > 20 ? <text className="overview-chart-value-small" x={center - barGap / 2 - barWidth / 2} y={Math.max(top + 12, peopleY - 6)} textAnchor="middle">{item.people}</text> : null}
            </g>
            <g role="button" tabIndex={0} className="overview-chart-target" aria-label={`Open ${item.companies} companies active in ${item.month}`} onClick={() => onDrill(companies)} onKeyDown={(event) => activate(event, () => onDrill(companies))}>
              <rect className="overview-bar overview-bar-companies" x={center + barGap / 2} y={companyY} width={barWidth} height={companyHeight} />
              {companyHeight > 20 ? <text className="overview-chart-value-small" x={center + barGap / 2 + barWidth / 2} y={Math.max(top + 12, companyY - 6)} textAnchor="middle">{item.companies}</text> : null}
            </g>
            <text className={item.current ? "overview-chart-label overview-chart-label-current" : "overview-chart-label"} x={center} y={top + chartHeight + 18} textAnchor="middle">{monthLabel(item.month)}</text>
          </g>
        );
      })}
    </svg>
  );
}

const PRODUCT_BAR_CLASS: Record<string, string> = {
  had_bill_upload: "overview-bar-bill",
  had_invoice_upload: "overview-bar-invoice",
  had_statement_upload: "overview-bar-statement",
  had_ap_active: "overview-bar-ap",
  had_txn_active: "overview-bar-txn",
  had_gst_recon: "overview-bar-gst",
};

export function ProductMixChart({ data, onDrill }: { data: OverviewProductPoint[]; onDrill: (drill: OverviewDrill) => void }) {
  const width = 600;
  const height = 250;
  const max = Math.max(...data.map((item) => item.companies), 1);
  return (
    <svg className="overview-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby="overview-product-title">
      <title id="overview-product-title">Client companies on each product path in the latest complete week</title>
      {data.map((item, index) => {
        const y = 16 + index * 36;
        const barWidth = bounded(item.companies, max, 430);
        const drill = {
          chart: "product" as const,
          key: item.key,
          week: item.week_start,
          label: `${item.label} · ${item.companies} companies`,
        };
        return (
          <g key={item.key}>
            <text className="overview-chart-row-label" x="0" y={y + 16}>{item.label}</text>
            <g role="button" tabIndex={0} className="overview-chart-target" aria-label={`Open ${item.companies} companies with ${item.label} in week ${item.week_start}`} onClick={() => onDrill(drill)} onKeyDown={(event) => activate(event, () => onDrill(drill))}>
              <rect className={`overview-bar ${PRODUCT_BAR_CLASS[item.key] ?? "overview-bar"}`} x="100" y={y} width={Math.max(barWidth, item.companies ? 2 : 0)} height="22" />
              <text className="overview-chart-value-small" x={Math.min(100 + barWidth + 6, 570)} y={y + 15}>{item.companies}</text>
            </g>
          </g>
        );
      })}
    </svg>
  );
}
