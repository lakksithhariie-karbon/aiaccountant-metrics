/* Offline fixtures. Keys match docs/briefs/heatmap-interface.md */
window.FIXTURES = (function () {
  var HEATMAP = [
    // 01 Jun 2026, n=52
    { cohort_week: "2026-06-01", rel_week: 0, cohort_size: 52, retained_count: 52, rate: 1 },
    { cohort_week: "2026-06-01", rel_week: 1, cohort_size: 52, retained_count: 31, rate: 31 / 52 },
    { cohort_week: "2026-06-01", rel_week: 2, cohort_size: 52, retained_count: 27, rate: 27 / 52 },
    { cohort_week: "2026-06-01", rel_week: 3, cohort_size: 52, retained_count: 24, rate: 24 / 52 },
    { cohort_week: "2026-06-01", rel_week: 4, cohort_size: 52, retained_count: 22, rate: 22 / 52 },
    { cohort_week: "2026-06-01", rel_week: 5, cohort_size: 52, retained_count: 19, rate: 19 / 52 },
    { cohort_week: "2026-06-01", rel_week: 6, cohort_size: 52, retained_count: 17, rate: 17 / 52 },
    { cohort_week: "2026-06-01", rel_week: 7, cohort_size: 52, retained_count: 15, rate: 15 / 52 },
    { cohort_week: "2026-06-01", rel_week: 8, cohort_size: 52, retained_count: 13, rate: 13 / 52 },
    // 08 Jun 2026, n=61
    { cohort_week: "2026-06-08", rel_week: 0, cohort_size: 61, retained_count: 61, rate: 1 },
    { cohort_week: "2026-06-08", rel_week: 1, cohort_size: 61, retained_count: 36, rate: 36 / 61 },
    { cohort_week: "2026-06-08", rel_week: 2, cohort_size: 61, retained_count: 32, rate: 32 / 61 },
    { cohort_week: "2026-06-08", rel_week: 3, cohort_size: 61, retained_count: 28, rate: 28 / 61 },
    { cohort_week: "2026-06-08", rel_week: 4, cohort_size: 61, retained_count: 25, rate: 25 / 61 },
    { cohort_week: "2026-06-08", rel_week: 5, cohort_size: 61, retained_count: 22, rate: 22 / 61 },
    { cohort_week: "2026-06-08", rel_week: 6, cohort_size: 61, retained_count: 20, rate: 20 / 61 },
    { cohort_week: "2026-06-08", rel_week: 7, cohort_size: 61, retained_count: 18, rate: 18 / 61 },
    { cohort_week: "2026-06-08", rel_week: 8, cohort_size: 61, retained_count: 16, rate: 16 / 61 },
    // 15 Jun 2026, n=44
    { cohort_week: "2026-06-15", rel_week: 0, cohort_size: 44, retained_count: 44, rate: 1 },
    { cohort_week: "2026-06-15", rel_week: 1, cohort_size: 44, retained_count: 26, rate: 26 / 44 },
    { cohort_week: "2026-06-15", rel_week: 2, cohort_size: 44, retained_count: 22, rate: 22 / 44 },
    { cohort_week: "2026-06-15", rel_week: 3, cohort_size: 44, retained_count: 19, rate: 19 / 44 },
    { cohort_week: "2026-06-15", rel_week: 4, cohort_size: 44, retained_count: 17, rate: 17 / 44 },
    { cohort_week: "2026-06-15", rel_week: 5, cohort_size: 44, retained_count: 15, rate: 15 / 44 },
    { cohort_week: "2026-06-15", rel_week: 6, cohort_size: 44, retained_count: 13, rate: 13 / 44 },
    { cohort_week: "2026-06-15", rel_week: 7, cohort_size: 44, retained_count: 12, rate: 12 / 44 },
    { cohort_week: "2026-06-15", rel_week: 8, cohort_size: 44, retained_count: 10, rate: 10 / 44 },
    // 22 Jun 2026, n=67
    { cohort_week: "2026-06-22", rel_week: 0, cohort_size: 67, retained_count: 67, rate: 1 },
    { cohort_week: "2026-06-22", rel_week: 1, cohort_size: 67, retained_count: 40, rate: 40 / 67 },
    { cohort_week: "2026-06-22", rel_week: 2, cohort_size: 67, retained_count: 34, rate: 34 / 67 },
    { cohort_week: "2026-06-22", rel_week: 3, cohort_size: 67, retained_count: 30, rate: 30 / 67 },
    { cohort_week: "2026-06-22", rel_week: 4, cohort_size: 67, retained_count: 27, rate: 27 / 67 },
    { cohort_week: "2026-06-22", rel_week: 5, cohort_size: 67, retained_count: 24, rate: 24 / 67 },
    { cohort_week: "2026-06-22", rel_week: 6, cohort_size: 67, retained_count: 21, rate: 21 / 67 },
    { cohort_week: "2026-06-22", rel_week: 7, cohort_size: 67, retained_count: 19, rate: 19 / 67 },
    { cohort_week: "2026-06-22", rel_week: 8, cohort_size: 67, retained_count: 17, rate: 17 / 67 },
    // 29 Jun 2026, n=48 — default demo, +8 = 11 of 48
    { cohort_week: "2026-06-29", rel_week: 0, cohort_size: 48, retained_count: 48, rate: 1 },
    { cohort_week: "2026-06-29", rel_week: 1, cohort_size: 48, retained_count: 29, rate: 29 / 48 },
    { cohort_week: "2026-06-29", rel_week: 2, cohort_size: 48, retained_count: 24, rate: 24 / 48 },
    { cohort_week: "2026-06-29", rel_week: 3, cohort_size: 48, retained_count: 21, rate: 21 / 48 },
    { cohort_week: "2026-06-29", rel_week: 4, cohort_size: 48, retained_count: 18, rate: 18 / 48 },
    { cohort_week: "2026-06-29", rel_week: 5, cohort_size: 48, retained_count: 16, rate: 16 / 48 },
    { cohort_week: "2026-06-29", rel_week: 6, cohort_size: 48, retained_count: 14, rate: 14 / 48 },
    { cohort_week: "2026-06-29", rel_week: 7, cohort_size: 48, retained_count: 12, rate: 12 / 48 },
    { cohort_week: "2026-06-29", rel_week: 8, cohort_size: 48, retained_count: 11, rate: 11 / 48 }
  ];

  function co(id, name, extra) {
    var base = {
      company_id: id,
      company_name: name,
      signed_up_at: "2026-04-12",
      activated_at: "2026-06-29",
      last_action_at: "2026-06-29",
      lifetime_actions: 84,
      active_weeks: 9,
      actions_per_active_week: 9.3,
      actions_that_week: 6,
      upload_that_week: 2,
      txn_that_week: 2,
      sync_that_week: 1,
      recon_that_week: 1,
      path_had_upload: true,
      path_had_ready: true,
      path_had_sync: true,
      path_had_recon: true,
      l4w_activity: { upload_count: 8, txn_count: 8, sync_count: 4, recon_count: 4 },
      ttv_hours: 4.2,
      value_events: ["Accounting Sync", "Recon Processed"]
    };
    for (var k in extra) base[k] = extra[k];
    return base;
  }

  var CELL_2026_06_29_P8 = {
    cohort_week: "2026-06-29",
    rel_week: 8,
    people_count: 12,
    company_count: 11,
    median_actions_that_week: 6,
    share_with_upload: 0.82,
    share_with_sync: 0.73,
    share_with_recon: 0.45,
    users: [
      {
        email: "ops@northwind.example", distinct_id: "u-northwind-01", user_id: "u-northwind-01",
        signed_up_at: "2026-04-12", last_action_at: "2026-06-29",
        lifetime_actions: 142, active_weeks: 11, actions_per_active_week: 12.9, actions_that_week: 9,
        companies: [co("11111111-1111-4111-8111-111111111111", "Northwind Traders", { lifetime_actions: 142, active_weeks: 11, actions_that_week: 9, upload_that_week: 3, txn_that_week: 3, sync_that_week: 2, recon_that_week: 1 })]
      },
      {
        email: "finance@glacier.example", distinct_id: "u-glacier-01", user_id: "u-glacier-01",
        signed_up_at: "2026-04-12", last_action_at: "2026-06-29",
        lifetime_actions: 118, active_weeks: 10, actions_per_active_week: 11.8, actions_that_week: 8,
        companies: [co("22222222-2222-4222-8222-222222222222", "Glacier Labs", { lifetime_actions: 118, active_weeks: 10, actions_that_week: 8, upload_that_week: 2, txn_that_week: 3, sync_that_week: 2, recon_that_week: 1 })]
      },
      {
        email: "accounts@acme.example", distinct_id: "u-acme-01", user_id: "u-acme-01",
        signed_up_at: "2026-05-02", last_action_at: "2026-06-29",
        lifetime_actions: 96, active_weeks: 8, actions_per_active_week: 12, actions_that_week: 7,
        companies: [co("33333333-3333-4333-8333-333333333333", "Acme Foods", { lifetime_actions: 96, actions_that_week: 7 })]
      },
      {
        email: "billing@beacon.example", distinct_id: "u-beacon-01", user_id: "u-beacon-01",
        signed_up_at: "2026-05-09", last_action_at: "2026-06-29",
        lifetime_actions: 77, active_weeks: 7, actions_per_active_week: 11, actions_that_week: 6,
        companies: [co("44444444-4444-4444-8444-444444444444", "Beacon and Co", { lifetime_actions: 77, actions_that_week: 6 })]
      },
      {
        email: "ledger@crest.example", distinct_id: "u-crest-01", user_id: "u-crest-01",
        signed_up_at: "2026-05-11", last_action_at: "2026-06-29",
        lifetime_actions: 64, active_weeks: 7, actions_per_active_week: 9.1, actions_that_week: 6,
        companies: [co("55555555-5555-4555-8555-555555555555", "Crestline Studio", { lifetime_actions: 64, actions_that_week: 6 })]
      },
      {
        email: "payables@harbor.example", distinct_id: "u-harbor-01", user_id: "u-harbor-01",
        signed_up_at: "2026-05-18", last_action_at: "2026-06-29",
        lifetime_actions: 58, active_weeks: 6, actions_per_active_week: 9.7, actions_that_week: 5,
        companies: [co("66666666-6666-4666-8666-666666666666", "Harbor Supply", { lifetime_actions: 58, actions_that_week: 5, recon_that_week: 0, path_had_recon: false })]
      },
      {
        email: "books@ivory.example", distinct_id: "u-ivory-01", user_id: "u-ivory-01",
        signed_up_at: "2026-05-20", last_action_at: "2026-06-29",
        lifetime_actions: 91, active_weeks: 8, actions_per_active_week: 11.4, actions_that_week: 6,
        companies: [
          co("77777777-7777-4777-8777-777777777777", "Ivory Office", { lifetime_actions: 61, actions_that_week: 6 }),
          co("88888888-8888-4888-8888-888888888888", "Ivory Logistics", { lifetime_actions: 30, actions_that_week: 4, recon_that_week: 0, path_had_recon: false })
        ]
      },
      {
        email: "tax@juniper.example", distinct_id: "u-juniper-01", user_id: "u-juniper-01",
        signed_up_at: "2026-05-22", last_action_at: "2026-06-29",
        lifetime_actions: 73, active_weeks: 6, actions_per_active_week: 12.2, actions_that_week: 5,
        companies: [
          co("99999999-9999-4999-8999-999999999999", "Juniper Goods", { lifetime_actions: 40, actions_that_week: 5 }),
          co("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "Juniper Retail", { lifetime_actions: 21, actions_that_week: 3, recon_that_week: 0, path_had_recon: false }),
          co("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "Juniper Wholesale", { lifetime_actions: 12, actions_that_week: 2, sync_that_week: 1, recon_that_week: 0, path_had_recon: false })
        ]
      },
      {
        email: "ops@northwind.example", distinct_id: "u-northwind-02", user_id: "u-northwind-02",
        signed_up_at: "2026-06-02", last_action_at: "2026-06-29",
        lifetime_actions: 22, active_weeks: 4, actions_per_active_week: 5.5, actions_that_week: 4,
        companies: [co("11111111-1111-4111-8111-111111111111", "Northwind Traders", { lifetime_actions: 142, actions_that_week: 9 })]
      },
      {
        email: "assistant@glacier.example", distinct_id: "u-glacier-02", user_id: "u-glacier-02",
        signed_up_at: "2026-06-09", last_action_at: "2026-06-29",
        lifetime_actions: 18, active_weeks: 3, actions_per_active_week: 6, actions_that_week: 3,
        companies: [co("22222222-2222-4222-8222-222222222222", "Glacier Labs", { lifetime_actions: 118, actions_that_week: 8 })]
      },
      {
        email: "clerk@beacon.example", distinct_id: "u-beacon-02", user_id: "u-beacon-02",
        signed_up_at: "2026-06-10", last_action_at: "2026-06-28",
        lifetime_actions: 15, active_weeks: 3, actions_per_active_week: 5, actions_that_week: 2,
        companies: [co("44444444-4444-4444-8444-444444444444", "Beacon and Co", { lifetime_actions: 77, actions_that_week: 6 })]
      },
      {
        email: "intern@crest.example", distinct_id: "u-crest-02", user_id: "u-crest-02",
        signed_up_at: "2026-06-15", last_action_at: "2026-06-27",
        lifetime_actions: 9, active_weeks: 2, actions_per_active_week: 4.5, actions_that_week: 1,
        companies: [co("55555555-5555-4555-8555-555555555555", "Crestline Studio", { lifetime_actions: 64, actions_that_week: 6 })]
      }
    ]
  };

  var COMPANY_NORTHWIND = {
    company_id: "11111111-1111-4111-8111-111111111111",
    company_name: "Northwind Traders",
    signed_up_at: "2026-04-12",
    activated_at: "2026-04-12",
    activation_week: "2026-04-13",
    first_upload_at: "2026-04-12",
    first_ready_at: "2026-04-12",
    first_sync_at: "2026-04-12",
    first_recon_at: "2026-06-29",
    last_action_at: "2026-06-29",
    action_count: 142,
    lifetime_actions: 142,
    active_weeks: 11,
    actions_per_active_week: 12.9,
    ttv_hours: 4.2,
    path_had_upload: true,
    path_had_ready: true,
    path_had_sync: true,
    path_had_recon: true,
    by_week: [
      { week_start: "2026-06-01", action_count: 14, upload_count: 3, txn_count: 6, ap_count: 1, sync_count: 3, recon_count: 0 },
      { week_start: "2026-06-08", action_count: 11, upload_count: 2, txn_count: 5, ap_count: 0, sync_count: 4, recon_count: 0 },
      { week_start: "2026-06-15", action_count: 9, upload_count: 2, txn_count: 4, ap_count: 1, sync_count: 2, recon_count: 0 },
      { week_start: "2026-06-22", action_count: 12, upload_count: 4, txn_count: 5, ap_count: 0, sync_count: 3, recon_count: 0 },
      { week_start: "2026-06-29", action_count: 9, upload_count: 3, txn_count: 3, ap_count: 1, sync_count: 2, recon_count: 1 }
    ],
    by_event: [
      { event_name: "Transaction Ledger Updated", count: 38 },
      { event_name: "Upload", count: 27 },
      { event_name: "Transaction Status", count: 22 },
      { event_name: "Accounting Sync", count: 18 },
      { event_name: "Transaction Type Updated", count: 14 },
      { event_name: "Invoice Created", count: 9 },
      { event_name: "Mapping Completed", count: 5 },
      { event_name: "Recon Processed", count: 4 },
      { event_name: "Export", count: 3 },
      { event_name: "Delete", count: 2 }
    ]
  };

  var COMPANY_GLACIER = {
    company_id: "22222222-2222-4222-8222-222222222222",
    company_name: "Glacier Labs",
    signed_up_at: "2026-04-12",
    activated_at: "2026-04-14",
    activation_week: "2026-04-13",
    first_upload_at: "2026-04-12",
    first_ready_at: "2026-04-13",
    first_sync_at: "2026-04-14",
    first_recon_at: "2026-06-29",
    last_action_at: "2026-06-29",
    action_count: 118,
    lifetime_actions: 118,
    active_weeks: 10,
    actions_per_active_week: 11.8,
    ttv_hours: 49.6,
    path_had_upload: true,
    path_had_ready: true,
    path_had_sync: true,
    path_had_recon: true,
    by_week: [
      { week_start: "2026-06-08", action_count: 10, upload_count: 2, txn_count: 4, ap_count: 0, sync_count: 3, recon_count: 0 },
      { week_start: "2026-06-29", action_count: 8, upload_count: 2, txn_count: 3, ap_count: 0, sync_count: 2, recon_count: 1 }
    ],
    by_event: [
      { event_name: "Transaction Ledger Updated", count: 31 },
      { event_name: "Upload", count: 20 },
      { event_name: "Accounting Sync", count: 15 },
      { event_name: "Transaction Status", count: 12 },
      { event_name: "Recon Processed", count: 3 }
    ]
  };

  var TIMELINE_NORTHWIND_P0 = {
    total: 108, limit: 100, offset: 0,
    events: [
      { event_time: "2026-06-29 18:41", event_name: "Recon Processed" },
      { event_time: "2026-06-29 18:12", event_name: "Accounting Sync" },
      { event_time: "2026-06-29 17:04", event_name: "Invoice Created" },
      { event_time: "2026-06-29 16:51", event_name: "Upload" },
      { event_time: "2026-06-29 15:20", event_name: "Transaction Ledger Updated" },
      { event_time: "2026-06-29 14:02", event_name: "Transaction Status" },
      { event_time: "2026-06-28 18:10", event_name: "Accounting Sync" },
      { event_time: "2026-06-28 11:44", event_name: "Upload" },
      { event_time: "2026-06-22 16:00", event_name: "Dashboard Viewed" },
      { event_time: "2026-06-22 15:58", event_name: "Login" }
    ]
  };
  var TIMELINE_NORTHWIND_P1 = {
    total: 108, limit: 100, offset: 100,
    events: [
      { event_time: "2026-04-12 14:20", event_name: "Accounting Sync" },
      { event_time: "2026-04-12 11:55", event_name: "Invoice Created" },
      { event_time: "2026-04-12 10:14", event_name: "Upload" },
      { event_time: "2026-04-12 09:58", event_name: "Login" }
    ]
  };

  return {
    HEALTH: { ok: true },
    SUMMARY: {
      client_companies: 2159,
      activated: 775,
      activation_rate: "35.9%",
      median_ttv_hours: "18.6",
      week8_cohort_week: "2026-06-29",
      week8_cohort_size: 48,
      week8_retained: 11,
      week8_retention: "23%",
      recon_among_activated: "18.4%"
    },
    HEATMAP: HEATMAP,
    CELL_DEFAULT_KEY: "2026-06-29|8",
    CELLS: { "2026-06-29|8": CELL_2026_06_29_P8 },
    COMPANIES: {
      "11111111-1111-4111-8111-111111111111": COMPANY_NORTHWIND,
      "22222222-2222-4222-8222-222222222222": COMPANY_GLACIER
    },
    TIMELINES: {
      "11111111-1111-4111-8111-111111111111|0": TIMELINE_NORTHWIND_P0,
      "11111111-1111-4111-8111-111111111111|100": TIMELINE_NORTHWIND_P1
    }
  };
})();
