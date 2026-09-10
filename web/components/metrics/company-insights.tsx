import { Badge } from "@/components/ui/badge";
import type {
  CompanyActivity,
  CompanyChainEvent,
  CompanyEventChain,
  CompanyFunnelStage,
  CompanySummary,
  CompanyTransactionType,
  CompanyUploadType,
} from "@/lib/types";

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

function formatTimestamp(value?: string | null) {
  if (!value) return "—";
  return String(value).replace("T", " ").replace(/Z$/, "").slice(0, 16);
}

function formatHours(value: number) {
  const hours = Math.max(0, value);
  if (hours < 1 / 60) return "< 1 min";
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min`;
  if (hours < 48) return `${hours.toFixed(1)} h`;
  const days = hours / 24;
  return `${days >= 10 ? days.toFixed(0) : days.toFixed(1)} d`;
}

function formatGap(value?: number | null) {
  if (value == null || !Number.isFinite(Number(value)) || Number(value) < 0) return "—";
  return formatHours(Number(value));
}

function formatRecency(value?: number | null) {
  if (value == null || !Number.isFinite(Number(value)) || value < 0) return "Never";
  return `${formatHours(value)} ago`;
}

function formatInteger(value?: number | null) {
  if (value == null || !Number.isFinite(Number(value))) return "—";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(Number(value));
}

function formatDecimal(value?: number | string | null) {
  if (value == null || value === "" || !Number.isFinite(Number(value))) return "—";
  return Number(value).toFixed(1);
}

function pathBadge(type?: CompanySummary["path_type"]) {
  if (type === "ap") return "Invoices";
  if (type === "txn") return "Ledger";
  if (type === "both") return "Invoices + ledger";
  return "No ready path";
}

function week8Copy(value?: boolean | null) {
  if (value == null) return { label: "Not closed", detail: "Week 8 is still open" };
  if (value) return { label: "Yes", detail: "Sync or recon in week 8" };
  return { label: "No", detail: "No sync or recon in week 8" };
}

function activityEmptyLabel(rows: CompanyActivity[] | undefined, label: string) {
  return rows?.length ? null : `No ${label.toLowerCase()} recorded.`;
}

function ActivityTable({
  title,
  rows,
  emptyLabel,
}: {
  title: string;
  rows?: CompanyActivity[];
  emptyLabel: string;
}) {
  return (
    <section className="metrics-insight-block metrics-company-detail-block">
      <h3 className="metrics-insight-block-title">{title}</h3>
      <div className="metrics-table-wrap metrics-table-wrap-slim">
        <table className="metrics-detail-table metrics-company-detail-table">
          <thead>
            <tr>
              <th scope="col">Event</th>
              <th scope="col">Events</th>
              <th scope="col">First seen</th>
              <th scope="col">Last seen</th>
            </tr>
          </thead>
          <tbody>
            {rows?.length ? rows.map((row) => (
              <tr key={row.event_name}>
                <td className="metrics-event-name">{row.event_name || "—"}</td>
                <td>{formatInteger(row.count)}</td>
                <td>{formatTimestamp(row.first_at)}</td>
                <td>{formatTimestamp(row.last_at)}</td>
              </tr>
            )) : (
              <tr><td colSpan={4}>{emptyLabel}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function FunnelTimeline({ stages }: { stages?: CompanyFunnelStage[] }) {
  return (
    <section className="metrics-insight-block metrics-company-detail-block">
      <h3 className="metrics-insight-block-title">Funnel to Accounting Sync</h3>
      {stages?.length ? (
        <ol className="metrics-company-funnel">
          {stages.map((stage, index) => {
            const breakdown = stage.breakdown ?? [];
            const count = Number(stage.count ?? 0);
            return (
              <li className="metrics-company-funnel-step" key={stage.key || index}>
                <div className="metrics-company-funnel-rail" aria-hidden="true">
                  <span className="metrics-company-funnel-node">{stage.reached ? "✓" : "—"}</span>
                  {index < stages.length - 1 ? <span className="metrics-company-funnel-line" /> : null}
                </div>
                <div className="metrics-company-funnel-content">
                  <div className="metrics-company-funnel-head">
                    <strong>{stage.label || stage.key || "Milestone"}</strong>
                    <span>{stage.reached ? "Reached" : "Not reached"}</span>
                  </div>
                  <div className="metrics-company-funnel-meta">
                    <span>{formatTimestamp(stage.first_at)}</span>
                    <span>{formatInteger(count)} {count === 1 ? "event" : "events"}</span>
                    {index > 0 ? <span>Gap {formatGap(stage.gap_hours_from_prev)}</span> : null}
                  </div>
                  {breakdown.length ? (
                    <ul className="metrics-company-funnel-breakdown">
                      {breakdown.map((item) => (
                        <li key={item.key || item.label}>
                          <span>{item.label || item.key || "Other"}</span>
                          <span>{formatInteger(item.count)}</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
      ) : <p className="metrics-status">No funnel milestones.</p>}
      <p className="metrics-company-detail-note">Recon is post-sync value activity, not an activation step.</p>
    </section>
  );
}

function ChainProperties({ event }: { event: CompanyChainEvent }) {
  const properties = event.properties ?? [];
  if (!properties.length) return null;
  return (
    <ul className="metrics-event-chain-properties" aria-label={`${event.event_name || "Event"} properties`}>
      {properties.map((property) => (
        <li key={property.key}>
          <span>{property.key}</span>
          <span>
            {(property.values ?? []).map((value) => (
              <span className="metrics-event-chain-property-value" key={`${value.value}-${value.count}`}>
                {value.value || "—"}{Number(value.count) > 1 ? ` ×${value.count}` : ""}
              </span>
            ))}
          </span>
        </li>
      ))}
    </ul>
  );
}

function ChainNode({ event }: { event: CompanyChainEvent }) {
  const count = Number(event.count ?? 0);
  return (
    <li className="metrics-event-chain-node">
      <div className="metrics-event-chain-node-rail" aria-hidden="true">
        <span className="metrics-event-chain-node-mark">{event.role === "ready" || event.role === "activation" ? "✓" : "·"}</span>
      </div>
      <div className="metrics-event-chain-node-body">
        <div className="metrics-event-chain-node-head">
          <strong>{event.event_name || "Event"}</strong>
          <span>{formatInteger(count)} {count === 1 ? "event" : "events"}</span>
        </div>
        <div className="metrics-event-chain-node-meta">
          <span>{formatTimestamp(event.first_at)}</span>
          {event.last_at && event.last_at !== event.first_at ? <span>Last {formatTimestamp(event.last_at)}</span> : null}
          <span className="metrics-event-chain-role">{event.role || "supporting"}</span>
        </div>
        <ChainProperties event={event} />
      </div>
    </li>
  );
}

function EventChainTree({ chain, company }: { chain: CompanyEventChain; company: CompanySummary }) {
  const setup = chain.setup ?? [];
  const hasRawSignup = setup.some((event) => event.event_name === "Sign Up");
  const signupClock = company.funnel?.find((stage) => stage.key === "signup");
  const branches = chain.branches ?? [];
  return (
    <section className="metrics-insight-block metrics-company-detail-block metrics-event-chain">
      <div className="metrics-company-detail-heading">
        <div>
          <h3 className="metrics-insight-block-title">Event path to Accounting Sync</h3>
          <p className="metrics-event-chain-subtitle">Branches stay tied to the event properties received for this company.</p>
        </div>
        <span>{chain.scope || "lifetime"}</span>
      </div>

      {setup.length || signupClock ? (
        <ol className="metrics-event-chain-setup">
          {!hasRawSignup && signupClock ? (
            <ChainNode event={{
              event_name: "Signup clock",
              role: "clock",
              count: signupClock.count,
              first_at: signupClock.first_at,
              last_at: signupClock.first_at,
            }} />
          ) : null}
          {setup.map((event) => <ChainNode event={event} key={event.event_name} />)}
        </ol>
      ) : null}

      {branches.length ? (
        <div className="metrics-event-chain-branches">
          {branches.map((branch) => (
            <section className="metrics-event-chain-branch" key={branch.key}>
              <div className="metrics-event-chain-branch-head">
                <strong>{branch.label || branch.key || "Product"}</strong>
                <span>
                  {branch.entry_count != null ? `Upload ${formatInteger(branch.entry_count)}` : null}
                  {branch.ready_event ? ` · Ready ${formatInteger(branch.ready_count)}` : null}
                </span>
              </div>
              <ol className="metrics-event-chain-list">
                {(branch.events ?? []).map((event) => <ChainNode event={event} key={`${branch.key}-${event.event_name}`} />)}
              </ol>
            </section>
          ))}
        </div>
      ) : <p className="metrics-status">No classified product branch events.</p>}

      {chain.sync ? (
        <div className="metrics-event-chain-convergence">
          <p className="metrics-event-chain-convergence-label">Converges at activation</p>
          <ol className="metrics-event-chain-list"><ChainNode event={chain.sync} /></ol>
        </div>
      ) : null}
      {(chain.post_sync ?? []).length ? (
        <div className="metrics-event-chain-post">
          <p className="metrics-event-chain-convergence-label">Post-sync value</p>
          <ol className="metrics-event-chain-list">
            {(chain.post_sync ?? []).map((event) => <ChainNode event={event} key={event.event_name} />)}
          </ol>
        </div>
      ) : null}
      <p className="metrics-company-detail-note">Recon remains post-sync value activity, not an activation step.</p>
    </section>
  );
}

function WorkMixTable({ company }: { company: CompanySummary }) {
  const mix = company.work_mix;
  const rows = [
    { key: "upload", label: "Upload", count: mix?.upload, failed: mix?.upload_failed },
    { key: "ap", label: "AP", count: mix?.ap, failed: null },
    { key: "txn", label: "Ledger / txn", count: mix?.txn, failed: null },
    { key: "sync", label: "Accounting Sync", count: mix?.sync, failed: null },
    { key: "recon", label: "Recon", count: mix?.recon, failed: null },
  ];
  return (
    <section className="metrics-insight-block metrics-company-detail-block">
      <div className="metrics-company-detail-heading">
        <h3 className="metrics-insight-block-title">Work mix</h3>
        <span>{mix?.scope || "lifetime"}</span>
      </div>
      <div className="metrics-table-wrap metrics-table-wrap-slim">
        <table className="metrics-detail-table metrics-company-detail-table">
          <thead><tr><th scope="col">Family</th><th scope="col">Events</th><th scope="col">Failed</th></tr></thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key}>
                <td className="metrics-event-name">{row.label}</td>
                <td>{formatInteger(row.count)}</td>
                <td>{row.failed == null ? "—" : formatInteger(row.failed)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function UploadTypesTable({ rows }: { rows?: CompanyUploadType[] }) {
  return (
    <section className="metrics-insight-block metrics-company-detail-block">
      <h3 className="metrics-insight-block-title">Upload types · lifetime</h3>
      <div className="metrics-table-wrap metrics-table-wrap-slim">
        <table className="metrics-detail-table metrics-company-detail-table">
          <thead><tr><th scope="col">Type</th><th scope="col">Events</th><th scope="col">Failed</th><th scope="col">First seen</th><th scope="col">Last seen</th></tr></thead>
          <tbody>
            {rows?.length ? rows.map((row) => (
              <tr key={row.key}>
                <td className="metrics-event-name">{row.label || row.key || "Unknown"}</td>
                <td>{formatInteger(row.count)}</td>
                <td>{formatInteger(row.failed_count)}</td>
                <td>{formatTimestamp(row.first_at)}</td>
                <td>{formatTimestamp(row.last_at)}</td>
              </tr>
            )) : <tr><td colSpan={5}>No Upload events.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function TransactionTypesTable({ rows }: { rows?: CompanyTransactionType[] }) {
  return (
    <section className="metrics-insight-block metrics-company-detail-block">
      <h3 className="metrics-insight-block-title">Transaction types · lifetime</h3>
      <div className="metrics-table-wrap metrics-table-wrap-slim">
        <table className="metrics-detail-table metrics-company-detail-table">
          <thead><tr><th scope="col">Type</th><th scope="col">Events</th><th scope="col">First seen</th><th scope="col">Last seen</th></tr></thead>
          <tbody>
            {rows?.length ? rows.map((row) => (
              <tr key={row.transaction_type}>
                <td className="metrics-event-name">{row.transaction_type || "Other"}</td>
                <td>{formatInteger(row.count)}</td>
                <td>{formatTimestamp(row.first_at)}</td>
                <td>{formatTimestamp(row.last_at)}</td>
              </tr>
            )) : <tr><td colSpan={4}>No transaction types recorded.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function CompanyInsights({ company }: { company: CompanySummary }) {
  const week8 = week8Copy(company.week8_counted);
  const ttv = company.ttv_hours;
  const lastValue = company.last_value_rel_week;
  const hasLedgerEvents = (company.ledger_events ?? []).length > 0;
  const emptyLedgerLabel = activityEmptyLabel(company.ledger_events, "ledger activity") || "No ledger activity recorded.";

  return (
    <div className="metrics-insight" aria-label="Company insights">
      <div className="metrics-insight-head">
        <p className="metrics-insight-kicker">Path</p>
        <div className="metrics-insight-badges">
          <Badge>{pathBadge(company.path_type)}</Badge>
          <Badge variant="subtle">{company.path_had_sync ? "Activated" : "Not activated"}</Badge>
        </div>
      </div>

      <dl className="metrics-insight-stats">
        <div className="metrics-insight-stat">
          <dt>Time to first sync</dt>
          <dd>{ttv == null || !Number.isFinite(Number(ttv)) ? "Never" : formatHours(Number(ttv))}</dd>
        </div>
        <div className="metrics-insight-stat">
          <dt>Last Accounting Sync</dt>
          <dd>{formatRecency(company.hours_since_last_sync)}</dd>
        </div>
        <div className="metrics-insight-stat">
          <dt>Last value week</dt>
          <dd>
            {lastValue == null ? "—" : `Week ${lastValue}`}
            {company.last_value_week_start ? <span className="metrics-insight-sub">{shortDate(company.last_value_week_start)}</span> : null}
          </dd>
        </div>
        <div className="metrics-insight-stat">
          <dt>Counted in week 8?</dt>
          <dd>
            {week8.label}
            <span className="metrics-insight-sub">{week8.detail}</span>
          </dd>
        </div>
      </dl>

      <dl className="metrics-insight-stats">
        <div className="metrics-insight-stat">
          <dt>Lifetime actions</dt>
          <dd>{formatInteger(company.lifetime_actions)}</dd>
        </div>
        <div className="metrics-insight-stat">
          <dt>Active weeks</dt>
          <dd>{formatInteger(company.active_weeks)}</dd>
        </div>
        <div className="metrics-insight-stat">
          <dt>Per active week</dt>
          <dd>{formatDecimal(company.actions_per_active_week)}</dd>
        </div>
        <div className="metrics-insight-stat">
          <dt>Last action</dt>
          <dd>{shortDate(company.last_action_at)}</dd>
        </div>
      </dl>

      {company.event_chain ? <EventChainTree chain={company.event_chain} company={company} /> : <FunnelTimeline stages={company.funnel} />}
      <WorkMixTable company={company} />
      <UploadTypesTable rows={company.upload_types} />
      <ActivityTable title="Ready activities · lifetime" rows={company.ready_activities} emptyLabel="No Ready activities recorded." />
      <ActivityTable title="Ledger / txn · lifetime" rows={company.ledger_events} emptyLabel={emptyLedgerLabel} />
      {hasLedgerEvents || (company.ledger_transaction_types ?? []).length ? <TransactionTypesTable rows={company.ledger_transaction_types} /> : null}
    </div>
  );
}
