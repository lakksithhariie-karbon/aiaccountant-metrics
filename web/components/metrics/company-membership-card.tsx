import type { CompanyMembership, WeekActivity } from "@/lib/types";
import { productPathLabels } from "@/lib/types";
import { cn } from "@/lib/utils";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatDecimal(value?: number | string | null) {
  if (value == null || value === "" || !Number.isFinite(Number(value))) return "—";
  return Number(value).toFixed(1);
}

function numberValue(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function shortDate(value?: string | null) {
  const match = value && String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${Number(match[3])} ${MONTHS[Number(match[2]) - 1]}` : value || "—";
}

function chainSummary(chain: CompanyMembership["event_chain_that_week"]) {
  if (!chain) return [];
  const items = (chain.branches ?? []).filter((branch) => branch.key !== "other").map((branch) => {
    const label = branch.label || branch.key || "Other";
    const entry = branch.entry_count == null ? null : `Upload ${numberValue(branch.entry_count)}`;
    const ready = branch.ready_event ? `Ready ${numberValue(branch.ready_count)}` : null;
    return { label, detail: [entry, ready].filter(Boolean).join(" · ") || "No entry event" };
  });
  if (chain.sync) items.push({ label: "Sync", detail: String(numberValue(chain.sync.count)) });
  const recon = (chain.post_sync ?? []).find((event) => event.event_name === "Recon Processed");
  if (recon) items.push({ label: "Recon", detail: String(numberValue(recon.count)) });
  return items;
}

type CompanyMembershipCardProps = {
  company: CompanyMembership;
  companyIndex: number;
  companyCount: number;
  userLabel: string;
  selected: boolean;
  integrationLabel: string;
  onOpen: () => void;
  showWeekActivity?: boolean;
  activity?: WeekActivity;
};

export function CompanyMembershipCard({
  company,
  companyIndex,
  companyCount,
  userLabel,
  selected,
  integrationLabel,
  onOpen,
  showWeekActivity = false,
  activity,
}: CompanyMembershipCardProps) {
  const pathLabels = productPathLabels(company);
  const eventChain = company.event_chain_that_week;
  const chainItems = chainSummary(eventChain);
  const integrationEvent = eventChain?.setup?.find((event) => event.event_name === "Integration status");
  const actualIntegrationLabel = integrationEvent?.first_at
    ? shortDate(integrationEvent.first_at)
    : integrationLabel;
  const actualIntegrationLabelName = integrationEvent
    ? "Integration"
    : company.first_sync_at
      ? "First sync"
      : "Signup clock";
  const weekActivity = [
    { label: "Upload", value: activity?.upload_count ?? company.upload_that_week },
    { label: "Ledger / txn", value: activity?.txn_count ?? company.txn_that_week },
    { label: "Sync", value: activity?.sync_count ?? company.sync_that_week },
    { label: "Recon", value: activity?.recon_count ?? company.recon_that_week },
  ];

  return (
    <button
      type="button"
      className={cn("metrics-company-row", selected && "selected")}
      aria-label={`Open drill for ${company.company_name || company.company_id}, company ${companyIndex + 1} of ${companyCount} for ${userLabel}`}
      onClick={onOpen}
    >
      <span className="metrics-company-card-head">
        <span className="metrics-company-top">
          <span className="metrics-company-name">{company.company_name || company.company_id}</span>
          <span className="metrics-company-ttv">TTV {company.ttv_hours != null ? `${formatDecimal(company.ttv_hours)} h` : "—"}</span>
        </span>
        <span className="metrics-company-open-hint" aria-hidden="true">Open drill</span>
      </span>
      <span className="metrics-company-meta">
        <span>{actualIntegrationLabelName} {actualIntegrationLabel}</span>
        {showWeekActivity ? <><span className="metrics-company-meta-separator" aria-hidden="true">|</span><span>That week</span></> : null}
      </span>
      {showWeekActivity ? (
        <span className="metrics-company-card-mix" aria-label="That week event activity">
          {weekActivity.map((item) => (
            <span className="metrics-company-card-stat" key={item.label}>
              <span>{item.label}</span>
              <strong>{numberValue(item.value)}</strong>
            </span>
          ))}
        </span>
      ) : null}
      {showWeekActivity && chainItems.length ? (
        <span className="metrics-company-card-chain" aria-label="That week event path">
          <span className="metrics-company-card-path-label">Event path</span>
          <span className="metrics-company-card-path-items">
            {chainItems.map((item) => (
              <span key={item.label}><b>{item.label}</b> {item.detail}</span>
            ))}
          </span>
        </span>
      ) : null}
      {(!showWeekActivity || !chainItems.length) && pathLabels.length ? (
        <span className="metrics-company-card-path" aria-label="That week product path">
          <span className="metrics-company-card-path-label">Product path</span>
          <span className="metrics-company-card-path-items">
            {pathLabels.map((label) => <span key={label}>{label}</span>)}
          </span>
        </span>
      ) : null}
    </button>
  );
}
