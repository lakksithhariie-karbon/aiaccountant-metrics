"use client";

import type { CSSProperties, ReactNode } from "react";
import type { OverviewFeatureUsage } from "@/lib/types";

export type ModuleMapKey = "ap" | "ar" | "txn" | "gst" | string;

export type ModuleMapType = {
  value: string;
  events: number;
  companies?: number | null;
};

export type ModuleMapStage = {
  key: string;
  label: string;
  companies: number;
  events: number;
  /** Percentage of the module's company reach, from 0 to 100. */
  reach?: number | null;
  /** Optional sequential conversion supplied by the server. Never inferred here. */
  conversion?: number | null;
  types?: ModuleMapType[];
  note?: string | null;
};

export type ModuleMapModule = {
  key: ModuleMapKey;
  label: string;
  companies: number;
  events?: number | null;
  stages: ModuleMapStage[];
  note?: string | null;
};

export type ModuleMapPayload = {
  period?: string | null;
  scope?: string | null;
  modules: ModuleMapModule[];
};

export type ModuleMapDrill = {
  target: "module" | "stage";
  moduleKey: string;
  stageKey: string | null;
  label: string;
  period?: string | null;
};

export type ModuleMapProps = {
  modules?: ModuleMapModule[] | null;
  data?: ModuleMapPayload | null;
  period?: string | null;
  onDrill?: (drill: ModuleMapDrill) => void;
  className?: string;
  title?: string;
  description?: string;
  emptyState?: ReactNode;
};

const MODULE_ACCENTS: Record<string, string> = {
  ap: "var(--chart-2)",
  ar: "var(--chart-1)",
  txn: "var(--chart-5)",
  gst: "var(--destructive)",
};

const MODULE_LABELS: Record<string, string> = {
  ap: "AP",
  ar: "AR",
  txn: "Txn",
  gst: "GST",
};

const numberFormat = new Intl.NumberFormat("en-IN");

function count(value: number | null | undefined) {
  return numberFormat.format(Math.max(0, value ?? 0));
}

function percent(value: number | null | undefined, fraction = false) {
  if (value == null || !Number.isFinite(value)) return null;
  const percentage = fraction ? value * 100 : value;
  return `${percentage.toFixed(percentage % 1 === 0 ? 0 : 1)}%`;
}

function accentFor(moduleKey: string) {
  return MODULE_ACCENTS[moduleKey] ?? "var(--chart-3)";
}

function joinClasses(...classes: Array<string | undefined | null | false>) {
  return classes.filter(Boolean).join(" ");
}

function normalizeModules(props: Pick<ModuleMapProps, "modules" | "data">) {
  return props.modules ?? props.data?.modules ?? [];
}

function moduleDrill(module: ModuleMapModule, period?: string | null): ModuleMapDrill {
  return {
    target: "module",
    moduleKey: module.key,
    stageKey: null,
    label: `${module.label} · ${count(module.companies)} companies`,
    period: period ?? null,
  };
}

function stageDrill(module: ModuleMapModule, stage: ModuleMapStage, period?: string | null): ModuleMapDrill {
  return {
    target: "stage",
    moduleKey: module.key,
    stageKey: stage.key,
    label: `${module.label} · ${stage.label} · ${count(stage.companies)} companies`,
    period: period ?? null,
  };
}

function derivedReach(module: ModuleMapModule, stage: ModuleMapStage) {
  if (module.companies <= 0) return null;
  return (stage.companies / module.companies) * 100;
}

function stageMetric(stage: ModuleMapStage, module: ModuleMapModule) {
  const reach = percent(derivedReach(module, stage));
  const conversion = percent(stage.conversion, true);
  return { reach, conversion };
}

function typeSummary(types: ModuleMapType[] | undefined) {
  return (types ?? [])
    .filter((item) => item.value.trim())
    .slice(0, 4)
    .map((item) => `${item.value} ${count(item.events)}`)
    .join(" · ");
}

function shellStyle(accent: string): CSSProperties {
  return {
    border: "1px solid var(--border)",
    borderLeft: `3px solid ${accent}`,
    borderRadius: 0,
    background: "var(--card)",
    color: "var(--card-foreground)",
  };
}

function buttonStyle(): CSSProperties {
  return {
    border: 0,
    borderRadius: 0,
    background: "transparent",
    color: "inherit",
    cursor: "pointer",
    textAlign: "left",
  };
}

export function ModuleMapStageCard({
  module,
  stage,
  index,
  period,
  onDrill,
}: {
  module: ModuleMapModule;
  stage: ModuleMapStage;
  index: number;
  period?: string | null;
  onDrill?: (drill: ModuleMapDrill) => void;
}) {
  const metrics = stageMetric(stage, module);
  const types = typeSummary(stage.types);
  const accent = accentFor(module.key);

  return (
    <div className="module-map-stage-row" role="listitem" style={{ position: "relative", display: "grid", gridTemplateColumns: "24px minmax(0, 1fr)", gap: 8, alignItems: "stretch" }}>
      <span aria-hidden="true" style={{ display: "flex", alignItems: "flex-start", justifyContent: "center", paddingTop: 12, position: "relative", zIndex: 1 }}>
        <span className="module-map-stage-marker" style={{ width: 17, height: 17, display: "inline-flex", alignItems: "center", justifyContent: "center", border: `1px solid ${accent}`, background: "var(--card)", color: accent, fontSize: 9, fontVariantNumeric: "tabular-nums", fontWeight: 700 }}>{String(index + 1).padStart(2, "0")}</span>
      </span>
      <button
        className="module-map-stage"
        type="button"
        style={{ ...buttonStyle(), width: "100%", padding: "9px 10px", border: "1px solid var(--border)", background: "color-mix(in oklch, var(--muted) 26%, var(--card))" }}
        aria-label={`Open ${module.label} ${stage.label}: ${count(stage.companies)} companies, ${count(stage.events)} events`}
        onClick={() => onDrill?.(stageDrill(module, stage, period))}
      >
        <span style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
          <span className="module-map-stage-label" style={{ minWidth: 0, overflow: "hidden", fontSize: 12, fontWeight: 650, textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{stage.label}</span>
          <span className="module-map-stage-companies" style={{ flex: "0 0 auto", fontSize: 14, fontVariantNumeric: "tabular-nums", fontWeight: 700 }}>{count(stage.companies)}</span>
        </span>
        <span style={{ display: "flex", flexWrap: "wrap", gap: "3px 12px", marginTop: 4, color: "var(--muted-foreground)", fontSize: 10, fontVariantNumeric: "tabular-nums" }}>
          <span>{count(stage.events)} events</span>
          {metrics.reach ? <span>{metrics.reach} module reach</span> : null}
          {metrics.conversion ? <span>{metrics.conversion} conversion</span> : null}
        </span>
        {types ? <span style={{ display: "block", marginTop: 5, overflow: "hidden", color: "var(--muted-foreground)", fontSize: 10, textOverflow: "ellipsis", whiteSpace: "nowrap" }}>Types · {types}</span> : null}
        {stage.note ? <span style={{ display: "block", marginTop: 5, color: "var(--muted-foreground)", fontSize: 10, lineHeight: 1.35 }}>{stage.note}</span> : null}
      </button>
    </div>
  );
}

export function ModuleMapCard({
  module,
  period,
  onDrill,
}: {
  module: ModuleMapModule;
  period?: string | null;
  onDrill?: (drill: ModuleMapDrill) => void;
}) {
  const accent = accentFor(module.key);
  const moduleLabel = MODULE_LABELS[module.key] ?? module.label;

  return (
    <article className={joinClasses("module-map-card", `module-map-card-${module.key}`)} style={{ ...shellStyle(accent), minWidth: 0, padding: 12 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10 }}>
        <button
          className="module-map-module-button"
          type="button"
          style={{ ...buttonStyle(), minWidth: 0, flex: 1 }}
          aria-label={`Open ${module.label}: ${count(module.companies)} companies`}
          onClick={() => onDrill?.(moduleDrill(module, period))}
        >
          <span style={{ display: "block", color: "var(--muted-foreground)", fontSize: 10, fontWeight: 650, letterSpacing: "0.08em", textTransform: "uppercase" }}>{moduleLabel}</span>
          <span className="module-map-module-title" style={{ display: "block", marginTop: 2, fontSize: 16, fontWeight: 700 }}>{module.label}</span>
        </button>
        <span style={{ flex: "0 0 auto", textAlign: "right" }}>
          <strong style={{ display: "block", fontSize: 20, fontVariantNumeric: "tabular-nums", lineHeight: 1 }}>{count(module.companies)}</strong>
          <span style={{ color: "var(--muted-foreground)", fontSize: 10 }}>companies</span>
        </span>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "3px 10px", marginTop: 8, color: "var(--muted-foreground)", fontSize: 10, fontVariantNumeric: "tabular-nums" }}>
        {module.events != null ? <span>{count(module.events)} events</span> : null}
        <span>{module.stages.length} observed stages</span>
      </div>
      {module.note ? <p style={{ margin: "7px 0 0", color: "var(--muted-foreground)", fontSize: 10, lineHeight: 1.35 }}>{module.note}</p> : null}
      <div className="module-map-stage-list" role="list" aria-label={`${module.label} observed stages`} style={{ position: "relative", display: "grid", gap: 6, marginTop: 12 }}>
        {module.stages.length > 1 ? <span aria-hidden="true" style={{ position: "absolute", top: 20, bottom: 20, left: 11, width: 1, background: "var(--border)" }} /> : null}
        {module.stages.map((stage, index) => <ModuleMapStageCard key={stage.key} module={module} stage={stage} index={index} period={period} onDrill={onDrill} />)}
      </div>
    </article>
  );
}

export function ModuleMapChart({
  modules,
  data,
  period,
  onDrill,
  className,
  title = "Product module reach",
  description = "Stage counts are independent company reach, not a sequential conversion funnel.",
  emptyState = <p className="metrics-status">No module usage for this period.</p>,
}: ModuleMapProps) {
  const resolvedModules = normalizeModules({ modules, data });
  const resolvedPeriod = period ?? data?.period ?? null;
  if (!resolvedModules.length) return emptyState;

  return (
    <section className={joinClasses("module-map", className)} aria-label={title}>
      <div className="module-map-header" style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 12, marginBottom: 10 }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700 }}>{title}</h3>
          <p style={{ margin: "4px 0 0", color: "var(--muted-foreground)", fontSize: 11, lineHeight: 1.35 }}>{description}</p>
        </div>
        {resolvedPeriod ? <span style={{ flex: "0 0 auto", color: "var(--muted-foreground)", fontSize: 10, fontVariantNumeric: "tabular-nums" }}>{resolvedPeriod}</span> : null}
      </div>
      <div className="module-map-grid" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(245px, 1fr))", gap: 10 }}>
        {resolvedModules.map((module) => <ModuleMapCard key={module.key} module={module} period={resolvedPeriod} onDrill={onDrill} />)}
      </div>
    </section>
  );
}

export function ModuleMapTable({
  modules,
  data,
  period,
  onDrill,
}: Pick<ModuleMapProps, "modules" | "data" | "period" | "onDrill">) {
  const resolvedModules = normalizeModules({ modules, data });
  const resolvedPeriod = period ?? data?.period ?? null;
  if (!resolvedModules.length) return <p className="metrics-status">No module usage for this period.</p>;

  return (
    <div className="module-map-table-wrap" style={{ overflowX: "auto", border: "1px solid var(--border)" }}>
      <table className="overview-table module-map-table" style={{ width: "100%", borderCollapse: "collapse", background: "var(--card)", color: "var(--card-foreground)", fontSize: 11, fontVariantNumeric: "tabular-nums" }}>
        <caption style={{ position: "absolute", width: 1, height: 1, padding: 0, margin: -1, overflow: "hidden", clip: "rect(0, 0, 0, 0)", whiteSpace: "nowrap", border: 0 }}>Module usage{resolvedPeriod ? ` for ${resolvedPeriod}` : ""}</caption>
        <thead>
          <tr>
            <th scope="col" style={{ padding: "6px 8px", border: "1px solid var(--border)", background: "var(--muted)", color: "var(--muted-foreground)", textAlign: "left" }}>Module</th>
            <th scope="col" style={{ padding: "6px 8px", border: "1px solid var(--border)", background: "var(--muted)", color: "var(--muted-foreground)", textAlign: "left" }}>Stage</th>
            <th scope="col" style={{ padding: "6px 8px", border: "1px solid var(--border)", background: "var(--muted)", color: "var(--muted-foreground)", textAlign: "right" }}>Companies</th>
            <th scope="col" style={{ padding: "6px 8px", border: "1px solid var(--border)", background: "var(--muted)", color: "var(--muted-foreground)", textAlign: "right" }}>Events</th>
            <th scope="col" style={{ padding: "6px 8px", border: "1px solid var(--border)", background: "var(--muted)", color: "var(--muted-foreground)", textAlign: "right" }}>Reach</th>
            <th scope="col" style={{ padding: "6px 8px", border: "1px solid var(--border)", background: "var(--muted)", color: "var(--muted-foreground)", textAlign: "right" }}>Conversion</th>
            <th scope="col" style={{ padding: "6px 8px", border: "1px solid var(--border)", background: "var(--muted)", color: "var(--muted-foreground)", textAlign: "left" }}>Types</th>
          </tr>
        </thead>
        <tbody>
          {resolvedModules.flatMap((module) => module.stages.map((stage, index) => {
            const metrics = stageMetric(stage, module);
            const accent = accentFor(module.key);
            return (
              <tr key={`${module.key}.${stage.key}`}>
                {index === 0 ? (
                  <td rowSpan={module.stages.length} style={{ padding: "7px 8px", border: "1px solid var(--border)", borderLeft: `3px solid ${accent}`, verticalAlign: "top" }}>
                    <button type="button" style={{ ...buttonStyle(), fontWeight: 700 }} aria-label={`Open ${module.label}: ${count(module.companies)} companies`} onClick={() => onDrill?.(moduleDrill(module, resolvedPeriod))}>{module.label}</button>
                    <span style={{ display: "block", marginTop: 3, color: "var(--muted-foreground)", fontSize: 10 }}>{count(module.companies)} companies</span>
                  </td>
                ) : null}
                <td style={{ padding: "7px 8px", border: "1px solid var(--border)" }}>
                  <button type="button" style={{ ...buttonStyle(), width: "100%", fontWeight: 600 }} aria-label={`Open ${module.label} ${stage.label}: ${count(stage.companies)} companies`} onClick={() => onDrill?.(stageDrill(module, stage, resolvedPeriod))}>{stage.label}</button>
                </td>
                <td style={{ padding: "7px 8px", border: "1px solid var(--border)", textAlign: "right" }}>{count(stage.companies)}</td>
                <td style={{ padding: "7px 8px", border: "1px solid var(--border)", textAlign: "right" }}>{count(stage.events)}</td>
                <td style={{ padding: "7px 8px", border: "1px solid var(--border)", color: "var(--muted-foreground)", textAlign: "right" }}>{metrics.reach ?? "—"}</td>
                <td style={{ padding: "7px 8px", border: "1px solid var(--border)", color: "var(--muted-foreground)", textAlign: "right" }}>{metrics.conversion ?? "—"}</td>
                <td style={{ padding: "7px 8px", border: "1px solid var(--border)", color: "var(--muted-foreground)" }}>{typeSummary(stage.types) || "—"}</td>
              </tr>
            );
          }))}
        </tbody>
      </table>
    </div>
  );
}

export function moduleMapFromFeatureUsage(data: OverviewFeatureUsage | null | undefined): ModuleMapPayload | null {
  if (!data) return null;
  return {
    period: data.week_start,
    scope: "latest complete week",
    modules: data.modules.map((module) => ({
      key: module.key,
      label: module.label,
      companies: module.companies,
      note: module.note,
      stages: module.nodes.map((node) => ({
        key: node.key,
        label: node.label,
        companies: node.companies,
        events: node.events,
        reach: module.companies > 0 ? (node.companies / module.companies) * 100 : null,
        types: node.types.map((type) => ({ value: type.value, events: type.events, companies: type.companies })),
      })),
    })),
  };
}
