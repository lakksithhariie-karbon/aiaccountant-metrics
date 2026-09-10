import type { ComponentPropsWithoutRef } from "react";

import { cn } from "@/lib/utils";

type SkeletonProps = ComponentPropsWithoutRef<"span">;

export function Skeleton({ className, ...props }: SkeletonProps) {
  return <span {...props} aria-hidden="true" className={cn("metrics-skeleton", className)} />;
}

export function LoadingStatus({ label }: { label: string }) {
  return <span className="metrics-sr-only" role="status" aria-live="polite">{label}</span>;
}

const HEATMAP_WEEKS = Array.from({ length: 9 }, (_, index) => index);
const HEATMAP_ROWS = Array.from({ length: 5 }, (_, index) => index);

export function HeatmapSkeleton() {
  return (
    <div className="metrics-table-wrap metrics-heatmap-skeleton" aria-hidden="true">
      <table className="metrics-heatmap">
        <thead>
          <tr>
            <th scope="col">Cohort week</th>
            <th scope="col">n</th>
            {HEATMAP_WEEKS.map((week) => <th scope="col" key={week}>Week {week}</th>)}
          </tr>
        </thead>
        <tbody>
          {HEATMAP_ROWS.map((row) => (
            <tr key={row}>
              <th scope="row"><Skeleton className="metrics-skeleton-cohort" /></th>
              <td className="metrics-n-col"><Skeleton className="metrics-skeleton-n" /></td>
              {HEATMAP_WEEKS.map((week) => (
                <td className="metrics-cell" key={week}><Skeleton className="metrics-skeleton-cell" /></td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function CellDrawerSkeleton() {
  return (
    <div className="metrics-skeleton-user-list" aria-hidden="true">
      {Array.from({ length: 3 }, (_, index) => (
        <div className="metrics-skeleton-user" key={index}>
          <div className="metrics-skeleton-user-label">
            <Skeleton className="metrics-skeleton-user-name" />
            <Skeleton className="metrics-skeleton-badge" />
          </div>
          <Skeleton className="metrics-skeleton-user-meta" />
          <div className="metrics-skeleton-company">
            <div className="metrics-skeleton-company-head">
              <Skeleton className="metrics-skeleton-company-name" />
              <Skeleton className="metrics-skeleton-company-ttv" />
            </div>
            <Skeleton className="metrics-skeleton-company-meta" />
            <div className="metrics-skeleton-company-mix">
              {Array.from({ length: 4 }, (_, stat) => <Skeleton className="metrics-skeleton-company-stat" key={stat} />)}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

type SkeletonTableProps = {
  headers: string[];
  rows?: number;
};

export function SkeletonTable({ headers, rows = 4 }: SkeletonTableProps) {
  return (
    <div className="metrics-table-wrap metrics-table-wrap-slim metrics-skeleton-table" aria-hidden="true">
      <table className="metrics-detail-table">
        <thead>
          <tr>{headers.map((header) => <th scope="col" key={header}>{header}</th>)}</tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }, (_, row) => (
            <tr key={row}>{headers.map((header) => <td key={header}><Skeleton className="metrics-skeleton-table-cell" /></td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function TimelineSkeleton() {
  return (
    <ol className="metrics-timeline metrics-timeline-skeleton" aria-hidden="true">
      {Array.from({ length: 8 }, (_, index) => (
        <li key={index}>
          <Skeleton className="metrics-skeleton-time" />
          <Skeleton className="metrics-skeleton-event" />
        </li>
      ))}
    </ol>
  );
}

function EventChainSkeleton() {
  return (
    <div className="metrics-insight-block metrics-company-detail-block metrics-event-chain-skeleton" aria-hidden="true">
      <div className="metrics-company-detail-heading">
        <div>
          <Skeleton className="metrics-skeleton-insight-line-short" />
          <Skeleton className="metrics-skeleton-chain-subtitle" />
        </div>
        <Skeleton className="metrics-skeleton-chain-scope" />
      </div>
      <div className="metrics-skeleton-chain-setup">
        {Array.from({ length: 2 }, (_, index) => <Skeleton className="metrics-skeleton-chain-setup-row" key={index} />)}
      </div>
      {Array.from({ length: 3 }, (_, branch) => (
        <div className="metrics-skeleton-chain-branch" key={branch}>
          <div className="metrics-skeleton-chain-branch-head"><Skeleton className="metrics-skeleton-chain-branch-title" /><Skeleton className="metrics-skeleton-chain-branch-meta" /></div>
          {Array.from({ length: 3 }, (_, event) => <Skeleton className="metrics-skeleton-chain-event" key={event} />)}
        </div>
      ))}
      <Skeleton className="metrics-skeleton-chain-convergence" />
    </div>
  );
}

export function CompanyDrawerSkeleton() {
  return (
    <div className="metrics-company-skeleton" aria-hidden="true">
      <div className="metrics-insight metrics-company-insight-skeleton">
        <div className="metrics-insight-head">
          <Skeleton className="metrics-skeleton-insight-line-short" />
        </div>
        <dl className="metrics-insight-stats">
          {Array.from({ length: 4 }, (_, index) => (
            <div className="metrics-insight-stat" key={`a-${index}`}>
              <Skeleton className="metrics-skeleton-row" />
              <Skeleton className="metrics-skeleton-stat" />
            </div>
          ))}
        </dl>
        <dl className="metrics-insight-stats">
          {Array.from({ length: 4 }, (_, index) => (
            <div className="metrics-insight-stat" key={`b-${index}`}>
              <Skeleton className="metrics-skeleton-row" />
              <Skeleton className="metrics-skeleton-stat" />
            </div>
          ))}
        </dl>
      </div>

      <EventChainSkeleton />

      <h3 className="metrics-subhead">Work mix · lifetime</h3>
      <SkeletonTable headers={["Family", "Events", "Failed"]} rows={5} />

      <h3 className="metrics-subhead">Upload types · lifetime</h3>
      <SkeletonTable headers={["Type", "Events", "Failed", "First seen", "Last seen"]} rows={4} />

      <h3 className="metrics-subhead">Ready activities · lifetime</h3>
      <SkeletonTable headers={["Event", "Events", "First seen", "Last seen"]} rows={2} />

      <h3 className="metrics-subhead">Ledger / txn · lifetime</h3>
      <SkeletonTable headers={["Event", "Events", "First seen", "Last seen"]} rows={3} />

      <h3 className="metrics-subhead">Actions by week</h3>
      <SkeletonTable headers={["Week", "Actions", "Upload", "Txn", "Sync", "Recon"]} />

      <h3 className="metrics-subhead">Actions by event</h3>
      <SkeletonTable headers={["Event", "Count"]} rows={5} />

      <div className="metrics-section-head">
        <h3 className="metrics-subhead">Timeline</h3>
        <div className="metrics-section-meta">
          <span>Newest first</span>
        </div>
      </div>
      <TimelineSkeleton />
    </div>
  );
}
