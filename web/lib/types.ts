export type HeatmapCell = {
  cohort_week: string;
  rel_week: number;
  cohort_size: number;
  retained_count: number;
  rate?: number | null;
};

export type SummaryPayload = {
  activated?: number | null;
  client_companies?: number | null;
  activation_rate?: number | string | null;
  median_ttv_hours?: number | string | null;
  week8_retention?: number | string | null;
  week8_cohort_week?: string | null;
  week8_retained?: number | null;
  week8_retained_count?: number | null;
  week8_cohort_size?: number | null;
  recon_among_activated?: number | string | null;
  cohort_weeks?: string[] | null;
};

export type OverviewPayload = {
  timezone?: string | null;
  as_of_date?: string | null;
  week_start?: string | null;
  month_start?: string | null;
  dau?: number | null;
  wau?: number | null;
  mau?: number | null;
  wau_companies?: number | null;
  mau_companies?: number | null;
  new_companies_week?: number | null;
  new_companies_month?: number | null;
  dau_mau_ratio?: number | string | null;
  client_companies?: number | null;
  activated?: number | null;
  adoption_rate?: number | string | null;
  week8_cohort_week?: string | null;
  week8_cohort_size?: number | null;
  week8_retained?: number | null;
  customer_retention_rate?: number | string | null;
};

export type OverviewFunnelPoint = {
  key: "clients" | "upload" | "ready" | "sync";
  label: string;
  remaining: number;
  reached?: number | null;
  previous_reached?: number | null;
  dropped?: number | null;
  conversion_rate?: number | null;
};

export type OverviewWeeklyPoint = {
  week_start: string;
  people: number;
  companies: number;
  current?: boolean;
  window_start?: string | null;
  window_end?: string | null;
};

export type OverviewPeriodPoint = {
  key: "dau" | "wau" | "mau";
  label: string;
  current: number;
  prior: number;
  prior_kind: "average_daily" | "week" | "month";
  current_start: string;
  current_end: string;
  prior_start: string;
  prior_end: string;
};

export type OverviewVintagePoint = {
  month: string;
  activated: number;
  not_activated: number;
  current?: boolean;
};

export type OverviewCompositionPoint = {
  month: string;
  new: number;
  returning: number;
  resurrected: number;
  current?: boolean;
};

export type OverviewWeek8Point = {
  cohort_week: string;
  cohort_size: number;
  retained: number;
  dropped: number;
};

export type OverviewWeeklyTableRow = {
  week_start: string;
  people: number;
  companies: number;
  activations: number;
  week8_cohort_size: number | null;
  week8_retained: number | null;
};

export type OverviewProductPoint = {
  key: string;
  label: string;
  companies: number;
  week_start: string;
};

export type OverviewFeatureType = {
  value: string;
  events: number;
  companies: number;
};

export type OverviewFeatureNode = {
  key: string;
  label: string;
  companies: number;
  events: number;
  types: OverviewFeatureType[];
  reached?: number | null;
  people?: number | null;
  first_at?: string | null;
  last_at?: string | null;
  conversion_rate?: number | null;
  property_breakdown?: OverviewStageBreakdown[];
};

export type OverviewFeatureModule = {
  key: "txn" | "ap" | "ar" | "gst" | string;
  label: string;
  companies: number;
  people?: number | null;
  window_start?: string | null;
  window_end?: string | null;
  granularity?: "week" | "month" | string | null;
  note?: string | null;
  nodes: OverviewFeatureNode[];
  stages?: OverviewModuleStage[];
  property_breakdown?: OverviewStageBreakdown[];
};

export type OverviewFeatureUsage = {
  week_start: string;
  window_start?: string | null;
  window_end?: string | null;
  granularity?: "week" | "month" | string | null;
  modules: OverviewFeatureModule[];
};

export type OverviewWindow = {
  key?: string | null;
  label?: string | null;
  granularity?: "day" | "week" | "month" | string | null;
  start: string;
  end: string;
  current?: boolean;
  complete?: boolean;
};

export type OverviewStageBreakdown = {
  key?: string | null;
  label?: string | null;
  value?: string | null;
  count?: number | null;
  events?: number | null;
  companies?: number | null;
  people?: number | null;
};

export type OverviewAdoptionStage = {
  key: string;
  label: string;
  reached: number;
  reach?: number | null;
  companies?: number | null;
  previous_reached?: number | null;
  dropped?: number | null;
  conversion_rate?: number | null;
  conversion?: number | null;
  window_start?: string | null;
  window_end?: string | null;
};

export type OverviewAdoptionWindow = {
  key: "week" | "month" | string;
  label?: string | null;
  granularity: "week" | "month" | string;
  start?: string;
  end?: string;
  window_start: string;
  window_end: string;
  cohort_size: number;
  new_companies?: number;
  active_people?: number;
  active_companies?: number;
  funnel?: OverviewAdoptionStage[];
  journey?: OverviewAdoptionStage[];
  stages: OverviewAdoptionStage[];
};

export type OverviewAdoption = {
  default_period?: "week" | "month" | string;
  periods?: {
    week: OverviewAdoptionWindow;
    month: OverviewAdoptionWindow;
  };
  windows?: OverviewAdoptionWindow[];
  week?: OverviewAdoptionWindow | null;
  month?: OverviewAdoptionWindow | null;
};

export type OverviewEngagementPoint = {
  key?: string | null;
  label?: string | null;
  window_start?: string | null;
  window_end?: string | null;
  week_start?: string | null;
  month?: string | null;
  people: number;
  companies: number;
  current?: boolean;
};

export type OverviewEngagement = {
  week?: (OverviewWindow & { people: number; companies: number }) | null;
  month?: (OverviewWindow & { people: number; companies: number }) | null;
  windows?: OverviewWindow[];
  weekly: OverviewWeeklyPoint[];
  monthly: OverviewMonthlyPoint[];
  period: OverviewPeriodPoint[];
};

export type OverviewModuleStage = {
  key: string;
  label: string;
  event_names?: Array<string | { event_name: string; count?: number | null }>;
  reached?: number | null;
  reach?: number | null;
  companies?: number | null;
  people?: number | null;
  events?: number | null;
  first_at?: string | null;
  last_at?: string | null;
  conversion_rate?: number | null;
  conversion?: number | null;
  failed_events?: number | null;
  breakdown?: OverviewStageBreakdown[];
  property_breakdown?: OverviewStageBreakdown[];
  properties?: Array<{
    key: string;
    values: Array<{ value: string; events: number; companies: number }>;
  }>;
  types?: OverviewFeatureType[];
};

export type OverviewModuleUsage = {
  key: "ap" | "ar" | "txn" | "gst" | string;
  label: string;
  window_start: string;
  window_end: string;
  granularity?: "week" | "month" | string;
  companies?: number | null;
  people?: number | null;
  note?: string | null;
  stages: OverviewModuleStage[];
  property_breakdown?: OverviewStageBreakdown[];
  nodes?: OverviewFeatureNode[];
};

export type OverviewModuleUsagePayload = {
  default_period?: "week" | "month" | string;
  window_start?: string | null;
  window_end?: string | null;
  granularity?: "week" | "month" | string | null;
  modules?: OverviewModuleUsage[];
  windows?: OverviewWindow[];
  week?: OverviewModuleUsagePayloadPeriod;
  month?: OverviewModuleUsagePayloadPeriod;
  periods: {
    week: OverviewModuleUsagePayloadPeriod;
    month: OverviewModuleUsagePayloadPeriod;
  };
};

export type OverviewModuleUsagePayloadPeriod = {
  scope?: string | null;
  period_start?: string | null;
  period_end?: string | null;
  window_start?: string | null;
  window_end?: string | null;
  granularity?: "week" | "month" | string | null;
  active_companies?: number | null;
  active_people?: number | null;
  modules: OverviewModuleUsage[];
};

export type OverviewModuleSlice = {
  module_key: string;
  stage_key?: string | null;
  window_start?: string | null;
  window_end?: string | null;
  stage?: OverviewModuleStage | null;
  property_breakdown?: OverviewStageBreakdown[];
};

export type OverviewAdoptionSlice = {
  key: string;
  mode?: "reached" | "dropped" | string;
  granularity: "week" | "month" | string;
  window_start: string;
  window_end: string;
  stage?: OverviewAdoptionStage | null;
};

export type OverviewGrowthPoint = {
  week_start: string;
  companies: number;
  current?: boolean;
};

export type OverviewMonthlyPoint = {
  month: string;
  people: number;
  companies: number;
  current?: boolean;
};

export type OverviewChartsPayload = {
  timezone: string;
  as_of_date: string;
  week_start: string;
  month_start: string;
  prior_month_start: string;
  funnel: OverviewFunnelPoint[];
  weekly: OverviewWeeklyPoint[];
  period: OverviewPeriodPoint[];
  vintage: OverviewVintagePoint[];
  composition: OverviewCompositionPoint[];
  week8: OverviewWeek8Point[];
  weekly_table: OverviewWeeklyTableRow[];
  product: OverviewProductPoint[];
  growth?: OverviewGrowthPoint[];
  monthly?: OverviewMonthlyPoint[];
  feature_usage?: OverviewFeatureUsage | null;
  adoption?: OverviewAdoption | null;
  engagement?: OverviewEngagement | null;
  modules?: OverviewModuleUsage[];
  module_usage?: OverviewModuleUsagePayload | null;
};

export type OverviewSliceParams = {
  chart: "funnel" | "adoption" | "weekly" | "period" | "vintage" | "composition" | "week8" | "family" | "product" | "feature" | "module" | "module_usage" | "growth" | "monthly";
  key: string;
  mode?: "reached" | "dropped";
  week?: string;
  which?: "current" | "prior";
  month?: string;
  cohort_week?: string;
  module?: string;
  stage?: string;
  property?: string;
  value?: string;
  window_start?: string;
  window_end?: string;
  granularity?: "week" | "month" | string;
};

export type ActivationWeekFilter = {
  from_week: string | null;
  to_week: string | null;
};

export type WeekActivity = {
  upload_count?: number | null;
  txn_count?: number | null;
  sync_count?: number | null;
  recon_count?: number | null;
};

export type ProductWeekFlags = {
  had_bill_upload?: boolean | null;
  had_invoice_upload?: boolean | null;
  had_statement_upload?: boolean | null;
  had_ap_active?: boolean | null;
  had_txn_active?: boolean | null;
  had_gst_recon?: boolean | null;
  had_created_bill_or_txn?: boolean | null;
};

export const PRODUCT_PATH_FLAGS: Array<{ key: keyof ProductWeekFlags; label: string }> = [
  { key: "had_bill_upload", label: "Bill" },
  { key: "had_invoice_upload", label: "Invoice" },
  { key: "had_statement_upload", label: "Statement" },
  { key: "had_ap_active", label: "AP" },
  { key: "had_txn_active", label: "Txn" },
  { key: "had_gst_recon", label: "GST" },
  { key: "had_created_bill_or_txn", label: "Created bill/txn" },
];

export function productPathLabels(row?: ProductWeekFlags | null): string[] {
  if (!row) return [];
  return PRODUCT_PATH_FLAGS.filter((item) => row[item.key]).map((item) => item.label);
}

export type CompanyChainPropertyValue = {
  value?: string | null;
  count?: number | null;
};

export type CompanyChainProperty = {
  key?: string | null;
  values?: CompanyChainPropertyValue[];
};

export type CompanyChainEvent = {
  event_name?: string | null;
  role?: string | null;
  count?: number | null;
  first_at?: string | null;
  last_at?: string | null;
  properties?: CompanyChainProperty[];
};

export type CompanyChainBranch = {
  key?: string | null;
  label?: string | null;
  entry_event?: string | null;
  entry_count?: number | null;
  ready_event?: string | null;
  ready_count?: number | null;
  events?: CompanyChainEvent[];
};

export type CompanyEventChain = {
  scope?: "lifetime" | "that_week" | string | null;
  setup?: CompanyChainEvent[];
  branches?: CompanyChainBranch[];
  sync?: CompanyChainEvent | null;
  post_sync?: CompanyChainEvent[];
};

export type CompanyMembership = {
  company_id: string;
  company_name?: string | null;
  signed_up_at?: string | null;
  activated_at?: string | null;
  first_upload_at?: string | null;
  first_ready_at?: string | null;
  first_sync_at?: string | null;
  first_recon_at?: string | null;
  last_action_at?: string | null;
  lifetime_actions?: number | null;
  active_weeks?: number | null;
  actions_per_active_week?: number | null;
  actions_that_week?: number | null;
  upload_that_week?: number | null;
  txn_that_week?: number | null;
  sync_that_week?: number | null;
  recon_that_week?: number | null;
  path_had_upload?: boolean | null;
  path_had_ready?: boolean | null;
  path_had_sync?: boolean | null;
  path_had_recon?: boolean | null;
  had_bill_upload?: boolean | null;
  had_invoice_upload?: boolean | null;
  had_statement_upload?: boolean | null;
  had_ap_active?: boolean | null;
  had_txn_active?: boolean | null;
  had_gst_recon?: boolean | null;
  had_created_bill_or_txn?: boolean | null;
  ttv_hours?: number | null;
  value_events?: string[] | null;
  event_chain_that_week?: CompanyEventChain | null;
};

export type User = {
  email?: string | null;
  distinct_id?: string | null;
  user_id?: string | null;
  signed_up_at?: string | null;
  last_action_at?: string | null;
  lifetime_actions?: number | null;
  active_weeks?: number | null;
  actions_per_active_week?: number | null;
  actions_that_week?: number | null;
  companies: CompanyMembership[];
};

export type CellPayload = {
  users: User[];
  company_count?: number | null;
  people_count?: number | null;
  median_actions_that_week?: number | null;
  share_with_upload?: number | null;
  share_with_sync?: number | null;
  share_with_recon?: number | null;
  share_with_bill?: number | null;
  share_with_invoice?: number | null;
  share_with_statement?: number | null;
  share_with_ap?: number | null;
  share_with_txn?: number | null;
  share_with_gst?: number | null;
  feature?: OverviewFeatureModule | null;
  feature_node?: string | null;
  module?: OverviewModuleUsage | null;
  module_slice?: OverviewModuleSlice | null;
  module_key?: string | null;
  module_stage?: string | null;
  property_breakdown?: OverviewStageBreakdown[];
  adoption?: OverviewAdoptionSlice | null;
};

export type CompanyWeek = {
  week_start?: string | null;
  action_count?: number | null;
  upload_count?: number | null;
  txn_count?: number | null;
  ap_count?: number | null;
  sync_count?: number | null;
  recon_count?: number | null;
  had_bill_upload?: boolean | null;
  had_invoice_upload?: boolean | null;
  had_statement_upload?: boolean | null;
  had_ap_active?: boolean | null;
  had_txn_active?: boolean | null;
  had_gst_recon?: boolean | null;
  had_created_bill_or_txn?: boolean | null;
};

export type CompanyEvent = {
  event_name?: string | null;
  count?: number | null;
};

export type CompanyFunnelBreakdown = {
  key?: string | null;
  label?: string | null;
  count?: number | null;
};

export type CompanyFunnelStage = {
  key?: string | null;
  label?: string | null;
  reached?: boolean | null;
  first_at?: string | null;
  count?: number | null;
  gap_hours_from_prev?: number | null;
  breakdown?: CompanyFunnelBreakdown[];
};

export type CompanyWorkMix = {
  scope?: "lifetime" | string | null;
  upload?: number | null;
  upload_failed?: number | null;
  ap?: number | null;
  txn?: number | null;
  sync?: number | null;
  recon?: number | null;
};

export type CompanyUploadType = {
  key?: string | null;
  label?: string | null;
  count?: number | null;
  first_at?: string | null;
  last_at?: string | null;
  failed_count?: number | null;
};

export type CompanyActivity = {
  event_name?: string | null;
  count?: number | null;
  first_at?: string | null;
  last_at?: string | null;
};

export type CompanyTransactionType = {
  transaction_type?: string | null;
  count?: number | null;
  first_at?: string | null;
  last_at?: string | null;
};

export type CompanySummary = {
  company_id?: string | null;
  company_name?: string | null;
  signed_up_at?: string | null;
  activated_at?: string | null;
  activation_week?: string | null;
  first_upload_at?: string | null;
  first_ready_at?: string | null;
  first_sync_at?: string | null;
  first_recon_at?: string | null;
  last_action_at?: string | null;
  lifetime_actions?: number | null;
  active_weeks?: number | null;
  actions_per_active_week?: number | null;
  ttv_hours?: number | null;
  path_had_upload?: boolean | null;
  path_had_ready?: boolean | null;
  path_had_sync?: boolean | null;
  path_had_recon?: boolean | null;
  hours_signup_to_upload?: number | null;
  hours_upload_to_ready?: number | null;
  hours_ready_to_sync?: number | null;
  hours_sync_to_recon?: number | null;
  last_sync_at?: string | null;
  last_recon_at?: string | null;
  hours_since_last_sync?: number | null;
  hours_since_last_recon?: number | null;
  path_type?: "ap" | "txn" | "both" | "neither" | null;
  last_value_week_start?: string | null;
  last_value_rel_week?: number | null;
  week8_counted?: boolean | null;
  funnel?: CompanyFunnelStage[];
  work_mix?: CompanyWorkMix | null;
  upload_types?: CompanyUploadType[];
  ready_activities?: CompanyActivity[];
  ledger_events?: CompanyActivity[];
  ledger_transaction_types?: CompanyTransactionType[];
  event_chain?: CompanyEventChain | null;
  by_week?: CompanyWeek[];
  by_event?: CompanyEvent[];
};

export type TimelineEvent = {
  event_time?: string | null;
  event_name?: string | null;
};

export type TimelinePayload = {
  total?: number | null;
  limit?: number | null;
  offset?: number | null;
  events: TimelineEvent[];
};
