"use client";

import type { RefObject } from "react";
import { X } from "lucide-react";

import type {
  CellPayload,
  CompanyChainEvent,
  CompanyEvent,
  CompanyMembership,
  CompanySummary,
  CompanyWeek,
  OverviewFeatureModule,
  OverviewModuleStage,
  TimelineEvent,
  TimelinePayload,
  User,
} from "@/lib/types";
import { productPathLabels } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CompanyMembershipCard } from "@/components/metrics/company-membership-card";
import { CompanyInsights } from "@/components/metrics/company-insights";
import {
  CellDrawerSkeleton,
  CompanyDrawerSkeleton,
  LoadingStatus,
  Skeleton,
  TimelineSkeleton,
} from "@/components/metrics/skeletons";

export type DrillLoadStatus = "idle" | "loading" | "ready" | "error";

const TIMELINE_PAGE = 100;
const TIMELINE_DOM_CAP = 200;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function isoDate(value?: string | null) {
  if (!value) return null;
  const match = String(value).match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : String(value);
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

function formatEventTime(value?: string | null) {
  if (!value) return "—";
  return String(value).replace("T", " ").slice(0, 16);
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

function selectedFeatureNode(module: OverviewFeatureModule, activeNode?: string | null) {
  if (!activeNode) return null;
  return module.nodes.find((node) => `${module.key}.${node.key}` === activeNode) ?? null;
}

function featureModuleFromPayload(payload: CellPayload | null): OverviewFeatureModule | null {
  if (payload?.feature) return payload.feature;
  const moduleData = payload?.module;
  if (!moduleData) return null;
  return {
    key: moduleData.key,
    label: moduleData.label,
    companies: numberValue(moduleData.companies),
    people: moduleData.people,
    window_start: moduleData.window_start,
    window_end: moduleData.window_end,
    granularity: moduleData.granularity,
    note: moduleData.note,
    property_breakdown: moduleData.property_breakdown,
    stages: moduleData.stages,
    nodes: (moduleData.stages ?? []).map((stage) => ({
      key: stage.key,
      label: stage.label,
      companies: numberValue(stage.companies ?? stage.reached),
      events: numberValue(stage.events),
      types: stage.types ?? [],
    })),
  };
}

function formatObservedTypes(node: OverviewFeatureModule["nodes"][number]) {
  const values = (node.types ?? [])
    .filter((item) => item.value)
    .map((item) => `${item.value} (${formatInteger(item.events)})`);
  return values.join(" · ") || "—";
}

function formatObservedEvents(stage?: OverviewModuleStage) {
  const values = (stage?.event_names ?? [])
    .map((item) => typeof item === "string" ? item : `${item.event_name} (${formatInteger(item.count)})`)
    .filter(Boolean);
  return values.join(" · ") || "—";
}

function formatChainProperties(event: CompanyChainEvent) {
  const values = (event.properties ?? []).flatMap((property) => (
    (property.values ?? []).map((value) => {
      const label = `${property.key || "property"}: ${value.value || "—"}`;
      return Number(value.count) > 1 ? `${label} ×${value.count}` : label;
    })
  ));
  return values.join(" · ") || "—";
}

function moduleStageForEvent(module: OverviewFeatureModule, eventName?: string | null) {
  if (!eventName) return null;
  return module.nodes.find((node) => {
    if (node.key.startsWith("upload_")) return eventName === "Upload";
    if (node.key === "download_recon") return eventName === "Download";
    if (node.key === "export") return eventName === "Export";
    return node.label === eventName;
  }) ?? null;
}

function ModuleDrillSummary({
  module,
  activeNode,
}: {
  module: OverviewFeatureModule;
  activeNode?: string | null;
}) {
  const selectedNode = selectedFeatureNode(module, activeNode);
  const stageByKey = new Map((module.stages ?? []).map((stage) => [stage.key, stage]));
  const propertyRows = module.stages?.length
    ? module.stages.flatMap((stage) => (stage.properties ?? []).flatMap((property) => (
      property.values.filter((item) => item.value).map((item) => ({
        stage,
        property: property.key,
        value: item.value,
        companies: item.companies,
        events: item.events,
      }))
    )))
    : module.nodes.flatMap((node) => (
      (node.types ?? []).filter((item) => item.value).map((item) => ({
        stage: stageByKey.get(node.key),
        property: "type",
        value: item.value,
        companies: item.companies,
        events: item.events,
      }))
    ));

  return (
    <section className="metrics-insight-block metrics-company-detail-block" aria-label={`${module.label} module summary`}>
      <div className="metrics-company-detail-heading">
        <div>
          <h3 className="metrics-insight-block-title">{module.label} module</h3>
          <p className="metrics-event-chain-subtitle">Selected complete week. Stages are classified event reach, not forced conversion.</p>
        </div>
        <span>{formatInteger(module.companies)} companies</span>
      </div>
      {module.note ? <p className="metrics-company-detail-note">{module.note}</p> : null}

      <h4 className="metrics-subhead">Stage summary</h4>
      <div className="metrics-table-wrap metrics-table-wrap-slim">
        <table className="metrics-detail-table metrics-company-detail-table">
          <thead>
            <tr>
              <th scope="col">Stage</th>
              <th scope="col">Companies</th>
              <th scope="col">Events</th>
              <th scope="col">Observed events</th>
              <th scope="col">Observed type</th>
            </tr>
          </thead>
          <tbody>
            {module.nodes.length ? module.nodes.map((node) => {
              const nodeKey = `${module.key}.${node.key}`;
              return (
                <tr key={nodeKey} className={activeNode === nodeKey ? "overview-feature-row-active" : undefined}>
                  <td className="metrics-event-name">{node.label}</td>
                  <td>{formatInteger(node.companies)}</td>
                  <td>{formatInteger(node.events)}</td>
                  <td>{formatObservedEvents(stageByKey.get(node.key))}</td>
                  <td>{formatObservedTypes(node)}</td>
                </tr>
              );
            }) : <tr><td colSpan={5}>No stages returned.</td></tr>}
          </tbody>
        </table>
      </div>

      <h4 className="metrics-subhead">Stage / property breakdown</h4>
      <div className="metrics-table-wrap metrics-table-wrap-slim">
        <table className="metrics-detail-table metrics-company-detail-table">
          <thead>
            <tr>
              <th scope="col">Stage</th>
              <th scope="col">Property</th>
              <th scope="col">Value</th>
              <th scope="col">Companies</th>
              <th scope="col">Events</th>
            </tr>
          </thead>
          <tbody>
            {propertyRows.length ? propertyRows.map((row) => (
              <tr key={`${row.stage?.key ?? "stage"}-${row.property}-${row.value}`}>
                <td className="metrics-event-name">{row.stage?.label || "—"}</td>
                <td>{row.property || "—"}</td>
                <td>{row.value}</td>
                <td>{formatInteger(row.companies)}</td>
                <td>{formatInteger(row.events)}</td>
              </tr>
            )) : <tr><td colSpan={5}>No non-empty property values returned.</td></tr>}
          </tbody>
        </table>
      </div>
      {selectedNode ? <p className="metrics-company-detail-note">Selected stage: {selectedNode.label}. Company rows below are limited to this module slice.</p> : null}
    </section>
  );
}

function ModuleCompanyJourney({
  company,
  module,
  activeNode,
}: {
  company: CompanyMembership;
  module: OverviewFeatureModule;
  activeNode?: string | null;
}) {
  const selectedNode = selectedFeatureNode(module, activeNode);
  const chain = company.event_chain_that_week;
  const branch = chain?.branches?.find((item) => item.key === module.key);
  const events = branch?.events ?? [];
  const rows = [...events];
  if (branch && chain?.sync && !rows.some((event) => event.event_name === chain.sync?.event_name)) {
    rows.push(chain.sync);
  }

  return (
    <div className="metrics-company-card-chain" aria-label={`${module.label} company journey context`}>
      <span className="metrics-company-card-path-label">{module.label}</span>
      <span className="metrics-company-card-path-items">
        <span>{selectedNode?.label || "Module path"}</span>
        {branch?.ready_event ? <span>Ready {formatInteger(branch.ready_count)}</span> : null}
        {chain?.sync ? <span>Sync {formatInteger(chain.sync.count)}</span> : null}
      </span>
      {branch ? (
        <div className="metrics-table-wrap metrics-table-wrap-slim" style={{ width: "100%" }}>
          <table className="metrics-detail-table metrics-company-detail-table">
            <thead>
              <tr>
                <th scope="col">Event</th>
                <th scope="col">Count</th>
                <th scope="col">First</th>
                <th scope="col">Properties</th>
              </tr>
            </thead>
            <tbody>
              {rows.length ? rows.map((event, index) => {
                const stage = moduleStageForEvent(module, event.event_name);
                const stageKey = stage ? `${module.key}.${stage.key}` : null;
                return (
                  <tr key={`${event.event_name}-${event.first_at}-${index}`} className={activeNode && activeNode === stageKey ? "overview-feature-row-active" : undefined}>
                    <td className="metrics-event-name">{event.event_name || "—"}</td>
                    <td>{formatInteger(event.count)}</td>
                    <td>{formatEventTime(event.first_at)}</td>
                    <td>{formatChainProperties(event)}</td>
                  </tr>
                );
              }) : <tr><td colSpan={4}>No classified events in this module.</td></tr>}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

export function PeopleDrawer({
  mounted,
  open,
  status,
  label,
  payload,
  filter,
  onFilterChange,
  insight,
  selectedCompanyId,
  onOpenCompany,
  onClose,
  closeButtonRef,
  showWeekActivity = false,
}: {
  mounted: boolean;
  open: boolean;
  status: DrillLoadStatus;
  label: string;
  payload: CellPayload | null;
  filter: string;
  onFilterChange: (value: string) => void;
  insight?: string;
  selectedCompanyId: string | null;
  onOpenCompany: (company: CompanyMembership) => void;
  onClose: () => void;
  closeButtonRef?: RefObject<HTMLButtonElement | null>;
  showWeekActivity?: boolean;
}) {
  if (!mounted) return null;
  const users = payload?.users ?? [];
  const query = filter.trim().toLowerCase();
  const filteredUsers = !query ? users : users.filter((user) => (
    String(user.email ?? "").toLowerCase().includes(query)
    || (user.companies ?? []).some((company) => String(company.company_name ?? "").toLowerCase().includes(query))
  ));
  const peopleCount = payload?.people_count ?? users.length;
  const companyCount = payload?.company_count ?? companyCountFor(users);
  const drillModule = featureModuleFromPayload(payload);
  const activeModuleNode = payload?.feature_node
    ?? (payload?.module_key && payload?.module_stage ? `${payload.module_key}.${payload.module_stage}` : null);
  return (
    <aside className={cn("metrics-drawer metrics-cell-drawer", open && "open")} role="dialog" aria-modal="true" aria-labelledby="cell-drawer-title" aria-hidden={!open} aria-busy={status === "loading"}>
      <div className="metrics-drawer-head">
        <div className="metrics-drawer-head-text">
          <h2 id="cell-drawer-title" className="metrics-drawer-title">Company list</h2>
          <p className="metrics-drawer-cell-label">{label}</p>
          <p className="metrics-drawer-counts">
            {status === "loading" ? <Skeleton className="metrics-skeleton-count" /> : payload ? `${peopleCount} users · ${companyCount} companies` : "Unable to load users"}
          </p>
        </div>
        <Button ref={closeButtonRef} variant="outline" size="icon" type="button" aria-label="Close company list" onClick={onClose}>
          <X aria-hidden="true" />
        </Button>
      </div>
      <div className="metrics-drawer-body">
        {status === "loading" ? <LoadingStatus label="Loading users" /> : null}
        <Input value={filter} onChange={(event) => onFilterChange(event.target.value)} type="search" placeholder="email or company name…" autoComplete="off" aria-label="Filter users by email or company name" />
        {insight ? <p className="metrics-drawer-insights">{insight}</p> : null}
        {status === "ready" && drillModule ? (
          <ModuleDrillSummary module={drillModule} activeNode={activeModuleNode} />
        ) : null}
        {status === "loading" ? <CellDrawerSkeleton /> : null}
        {status === "error" ? <p className="metrics-status metrics-status-error">Could not load users. Check the service and reload.</p> : null}
        {status === "ready" && filteredUsers.length === 0 ? <p className="metrics-status">No users match this filter.</p> : null}
        {status === "ready" && filteredUsers.length > 0 ? (
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
                  <p className="metrics-user-meta">Signed up {shortDate(user.signed_up_at)} · {formatInteger(user.lifetime_actions)} lifetime actions · {formatInteger(user.active_weeks)} active weeks</p>
                  {companies.length > 1 ? <p className="metrics-company-group-label">Integrated companies</p> : null}
                    <ul className="metrics-company-list">
                      {companies.map((company, companyIndex) => (
                        <li key={`${company.company_id}-${companyIndex}`}>
                          <CompanyMembershipCard
                          company={company}
                          companyIndex={companyIndex}
                          companyCount={companies.length}
                          userLabel={userLabel}
                          selected={selectedCompanyId === company.company_id}
                          integrationLabel={shortDate(company.first_sync_at || company.activated_at || company.signed_up_at)}
                          onOpen={() => onOpenCompany(company)}
                            showWeekActivity={showWeekActivity}
                          />
                          {status === "ready" && drillModule ? (
                            <ModuleCompanyJourney company={company} module={drillModule} activeNode={activeModuleNode} />
                          ) : null}
                        </li>
                      ))}
                    </ul>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
    </aside>
  );
}

export function CompanyDrawer({
  mounted,
  open,
  status,
  summary,
  error,
  label,
  timeline,
  timelineLoading,
  timelineError,
  onClose,
  onTimelinePage,
}: {
  mounted: boolean;
  open: boolean;
  status: DrillLoadStatus;
  summary: CompanySummary | null;
  error: string;
  label: string;
  timeline: TimelinePayload | null;
  timelineLoading: boolean;
  timelineError: string;
  onClose: () => void;
  onTimelinePage: (offset: number) => void;
}) {
  if (!mounted) return null;
  const timelineEvents = timeline?.events.slice(0, TIMELINE_DOM_CAP) ?? [];
  const timelineOffset = numberValue(timeline?.offset);
  const timelineTotal = timeline?.total ?? null;
  const hasOlder = timelineTotal != null ? timelineOffset + timelineEvents.length < timelineTotal : timelineEvents.length >= TIMELINE_PAGE;
  return (
    <aside className={cn("metrics-drawer metrics-company-drawer", open && "open")} role="dialog" aria-modal="true" aria-labelledby="company-drawer-title" aria-hidden={!open} aria-busy={status === "loading" || timelineLoading}>
      <div className="metrics-drawer-head">
        <div className="metrics-drawer-head-text">
          <h2 className="metrics-drawer-title">Company drill</h2>
          <p id="company-drawer-title" className="metrics-company-title">{summary?.company_name || label}</p>
        </div>
        <Button variant="outline" size="icon" type="button" aria-label="Close company drill" onClick={onClose}><X aria-hidden="true" /></Button>
      </div>
      <div className="metrics-drawer-body">
        {status === "loading" ? <><LoadingStatus label="Loading company" /><CompanyDrawerSkeleton /></> : null}
        {status === "error" ? <p className="metrics-status metrics-status-error" role="status">Could not load company: {error}</p> : null}
        {status === "ready" && summary ? (
          <>
            <CompanyInsights company={summary} />
            <h3 className="metrics-subhead">Actions by week</h3>
            <div className="metrics-table-wrap metrics-table-wrap-slim">
              <table className="metrics-detail-table">
                <thead><tr><th scope="col">Week</th><th scope="col">Actions</th><th scope="col">Upload</th><th scope="col">Txn</th><th scope="col">Sync</th><th scope="col">Recon</th><th scope="col">Path</th></tr></thead>
                <tbody>{(summary.by_week ?? []).length ? (summary.by_week ?? []).map((week: CompanyWeek, index) => <tr key={`${week.week_start}-${index}`}><td>{isoDate(week.week_start) || "—"}</td><td>{numberValue(week.action_count)}</td><td>{numberValue(week.upload_count)}</td><td>{numberValue(week.txn_count)}</td><td>{numberValue(week.sync_count)}</td><td>{numberValue(week.recon_count)}</td><td>{productPathLabels(week).join(" · ") || "—"}</td></tr>) : <tr><td colSpan={7}>No weekly action data.</td></tr>}</tbody>
              </table>
            </div>
            <h3 className="metrics-subhead">Actions by event</h3>
            <div className="metrics-table-wrap metrics-table-wrap-slim">
              <table className="metrics-detail-table">
                <thead><tr><th scope="col">Event</th><th scope="col">Count</th></tr></thead>
                <tbody>{(summary.by_event ?? []).length ? (summary.by_event ?? []).map((event: CompanyEvent, index) => <tr key={`${event.event_name}-${index}`}><td className="metrics-event-name">{event.event_name || "—"}</td><td>{numberValue(event.count)}</td></tr>) : <tr><td colSpan={2}>No action events.</td></tr>}</tbody>
              </table>
            </div>
            <div className="metrics-section-head">
              <h3 className="metrics-subhead">Event timeline</h3>
              <div className="metrics-section-meta"><span>Newest first</span>{!timelineLoading && !timelineError ? <span>{timelineEvents.length ? (timelineTotal != null ? `${formatInteger(timelineEvents.length)} of ${formatInteger(timelineTotal)}` : formatInteger(timelineEvents.length)) : "No events"}</span> : null}</div>
            </div>
            {timelineLoading ? <div className="metrics-timeline-loading" aria-busy="true"><LoadingStatus label="Loading timeline" /><TimelineSkeleton /></div> : null}
            {timelineError ? <p className="metrics-status metrics-status-error">{timelineError}</p> : null}
            {!timelineLoading && !timelineError && timelineEvents.length ? <><ol className="metrics-timeline">{timelineEvents.map((event: TimelineEvent, index) => <li key={`${event.event_time}-${event.event_name}-${index}`}><span className="metrics-event-time">{formatEventTime(event.event_time)}</span><span className="metrics-event-name">{event.event_name || "—"}</span></li>)}</ol><div className="metrics-timeline-nav"><Button variant="outline" size="sm" type="button" disabled={timelineOffset === 0 || timelineLoading} onClick={() => onTimelinePage(0)}>Newest</Button><Button variant="outline" size="sm" type="button" disabled={!hasOlder || timelineLoading} onClick={() => onTimelinePage(timelineOffset + TIMELINE_PAGE)}>{hasOlder ? "Older" : "No older events"}</Button></div></> : null}
          </>
        ) : null}
      </div>
    </aside>
  );
}
