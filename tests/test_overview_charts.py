"""Overview chart and drill API contract tests.

The chart endpoint is deliberately tested against the local warehouse fixture.
It proves that current IST action rows count, staff and chrome do not, and that
the clickable Week-8 slice agrees with the Retention cell membership.
"""

from __future__ import annotations

from datetime import datetime, timedelta

import psycopg
from psycopg.types.json import Json

from test_api_heatmap import (
    COHORT,
    IST,
    TEST_DB_URL,
    _at,
    _get,
    _ist_monday,
    base_url,
)


def _insert_current_actions() -> None:
    """Seed current-window rows without changing the historical fixture."""
    today = datetime.now(IST).date()
    current_monday = _ist_monday()
    rows = [
        ("chart_current_upload", "Upload", _at(today, 11), "chart_person", "c_keep",
         "chart@example.com", {}),
        ("chart_current_staff", "Upload", _at(today, 11, 5), "chart_staff", "c_keep",
         "staff@karboncard.com", {}),
        ("chart_current_chrome", "Dashboard Viewed", _at(today, 11, 10), "chart_chrome", "c_keep",
         "chrome@example.com", {}),
    ]
    if today > current_monday:
        rows.append(
            ("chart_current_week", "Invoice Created", _at(current_monday, 10), "chart_week", "c_sib",
             "week@example.com", {}),
        )
    with psycopg.connect(TEST_DB_URL, autocommit=True) as conn:
        for insert_id, event_name, event_time, distinct_id, company_id, email, props in rows:
            conn.execute(
                "INSERT INTO events (insert_id, event_name, event_time,"
                " distinct_id, company_id, email, properties)"
                " VALUES (%s, %s, %s, %s, %s, %s, %s)",
                (insert_id, event_name, event_time, distinct_id, company_id, email, Json(props)),
            )


def test_overview_charts_series_and_signed_filters(base_url):
    _insert_current_actions()

    status, body = _get(base_url, "/api/overview/charts")
    assert status == 200
    assert set(body) == {
        "timezone", "as_of_date", "week_start", "month_start", "prior_month_start",
        "funnel", "weekly", "period", "vintage", "composition", "week8", "weekly_table",
        "product", "growth", "monthly", "feature_usage", "adoption", "engagement",
        "modules", "module_usage",
    }
    assert body["timezone"] == "Asia/Kolkata"
    assert len(body["weekly"]) == 12
    assert len(body["vintage"]) == 8
    assert len(body["composition"]) == 6
    assert len(body["week8"]) == 1
    assert len(body["weekly_table"]) == 12

    funnel = {row["key"]: row["remaining"] for row in body["funnel"]}
    assert funnel["clients"] == 4
    assert funnel["sync"] == 4

    this_week = next(row for row in body["weekly"] if row["week_start"] == body["week_start"])
    assert this_week["people"] >= 1
    assert this_week["companies"] >= 1

    current_composition = next(row for row in body["composition"] if row["month"] == body["month_start"])
    assert sum(current_composition[key] for key in ("new", "returning", "resurrected")) >= 1
    assert all(row["key"] in {"dau", "wau", "mau"} for row in body["period"])

    week8 = body["week8"][-1]
    assert week8["cohort_week"] == COHORT.isoformat()
    assert (week8["retained"], week8["cohort_size"]) == (2, 4)

    funnel_keys = [row["key"] for row in body["funnel"]]
    assert funnel_keys == ["clients", "upload", "ready", "sync"]
    assert "had_created_bill_or_txn" not in funnel_keys
    product = {row["key"]: row for row in body["product"]}
    assert set(product) == {
        "had_bill_upload", "had_invoice_upload", "had_statement_upload",
        "had_ap_active", "had_txn_active", "had_gst_recon",
    }
    assert "had_created_bill_or_txn" not in product
    complete_week = (_ist_monday() - timedelta(days=7)).isoformat()
    assert all(row["week_start"] == complete_week for row in body["product"])
    assert product["had_bill_upload"]["companies"] == 1
    assert product["had_invoice_upload"]["companies"] == 1
    assert product["had_statement_upload"]["companies"] == 1
    assert product["had_ap_active"]["companies"] == 1
    assert product["had_txn_active"]["companies"] == 1
    assert product["had_gst_recon"]["companies"] == 1

    assert len(body["growth"]) == 12
    assert len(body["monthly"]) == 6
    usage = body["feature_usage"]
    assert usage["week_start"] == complete_week
    modules = {row["key"]: row for row in usage["modules"]}
    assert set(modules) == {"txn", "ap", "ar", "gst"}
    assert [row["key"] for row in modules["txn"]["nodes"]] == [
        "upload_statement", "ledger", "type_updated", "status", "sync",
    ]
    assert [row["key"] for row in modules["ap"]["nodes"]][-1] == "sync"
    assert [row["key"] for row in modules["ar"]["nodes"]] == [
        "upload_invoice", "sync",
    ]
    assert modules["ar"]["note"]


def _insert_overview_restructure_events() -> None:
    """Seed current-period cohort and module events for the new contract."""
    from psycopg.types.json import Json

    week_start = _ist_monday()
    module_week = week_start - timedelta(days=7)
    rows = [
        ("ov_new_company", "Company Created", _at(week_start, 8), "new_user", "c_new_period",
         "new@example.com", {}),
        ("ov_new_integration", "Integration status", _at(week_start, 8, 5), "new_user",
         "c_new_period", "new@example.com", {}),
        ("ov_new_upload", "Upload", _at(week_start, 8, 10), "new_user", "c_new_period",
         "new@example.com", {"type": "bill", "status": "Success", "source": "whatsapp"}),
        ("ov_new_ready", "Invoice Created", _at(week_start, 8, 15), "new_user", "c_new_period",
         "new@example.com", {"action": "create"}),
        ("ov_new_sync", "Accounting Sync", _at(week_start, 8, 20), "new_user", "c_new_period",
         "new@example.com", {"items_count": 4}),
        ("ov_new_staff", "Upload", _at(week_start, 8, 25), "new_staff", "c_new_period",
         "staff@karboncard.com", {"type": "bill", "status": "Success"}),
        ("ov_unfinished_company", "Company Created", _at(week_start, 9), "unfinished_user",
         "c_unfinished_period", "unfinished@example.com", {}),
        ("ov_module_bill", "Upload", _at(module_week, 10), "module_user", "c_keep",
         "module@example.com", {"type": "bill", "status": "Success", "source": "whatsapp"}),
        ("ov_module_failed", "Upload", _at(module_week, 10, 1), "module_user", "c_keep",
         "module@example.com", {"type": "bill", "status": "Failed", "source": "whatsapp"}),
        ("ov_module_entity", "Entity Created", _at(module_week, 10, 2), "module_user", "c_keep",
         "module@example.com", {"entityType": "bill"}),
        ("ov_module_invoice", "Invoice Created", _at(module_week, 10, 3), "module_user", "c_keep",
         "module@example.com", {"action": "create"}),
        ("ov_module_statement", "Upload", _at(module_week, 10, 4), "module_user", "c_keep",
         "module@example.com", {"type": "statement", "status": "Success", "source": "csv"}),
        ("ov_module_ledger", "Transaction Ledger Updated", _at(module_week, 10, 5), "module_user",
         "c_keep", "module@example.com", {"transactionType": "payment"}),
        ("ov_module_type", "Transaction Type Updated", _at(module_week, 10, 6), "module_user",
         "c_keep", "module@example.com", {"transactionType": "payment", "action": "classify"}),
        ("ov_module_status", "Transaction Status", _at(module_week, 10, 7), "module_user",
         "c_keep", "module@example.com", {"transactionType": "payment", "status": "success"}),
        ("ov_module_invoice_upload", "Upload", _at(module_week, 10, 8), "module_user", "c_keep",
         "module@example.com", {"type": "invoice", "status": "Success"}),
        ("ov_module_gst_upload", "Upload", _at(module_week, 10, 9), "module_user", "c_keep",
         "module@example.com", {"type": "gst2b", "status": "Success"}),
        ("ov_module_recon", "Recon Processed", _at(module_week, 10, 10), "module_user", "c_keep",
         "module@example.com", {"source": "gst"}),
        ("ov_module_sync", "Accounting Sync", _at(module_week, 10, 11), "module_user", "c_keep",
         "module@example.com", {"items_count": 7, "source": "tally"}),
    ]
    with psycopg.connect(TEST_DB_URL, autocommit=True) as conn:
        conn.execute(
            "INSERT INTO client_company (company_id) VALUES ('c_new_period'), ('c_unfinished_period')"
        )
        conn.execute(
            "INSERT INTO company_activation (company_id, activated_at, activation_week)"
            " VALUES ('c_new_period', %s, %s)",
            (_at(week_start, 8, 20), week_start),
        )
        for insert_id, event_name, event_time, distinct_id, company_id, email, props in rows:
            conn.execute(
                "INSERT INTO events (insert_id, event_name, event_time,"
                " distinct_id, company_id, email, properties)"
                " VALUES (%s, %s, %s, %s, %s, %s, %s)",
                (insert_id, event_name, event_time, distinct_id, company_id, email, Json(props)),
            )


def test_overview_adoption_periods_and_active_entity_counts(base_url):
    _insert_overview_restructure_events()

    status, body = _get(base_url, "/api/overview/charts")
    assert status == 200
    adoption = body["adoption"]
    assert adoption["default_period"] == "month"
    assert set(adoption["periods"]) == {"week", "month"}
    month = adoption["periods"]["month"]
    assert month["start"] == body["month_start"]
    assert month["new_companies"] == 2
    assert month["active_people"] == 1
    assert month["active_companies"] == 1
    steps = {row["key"]: row["companies"] for row in month["funnel"]}
    assert steps == {
        "signup": 2,
        "integration": 1,
        "upload": 1,
        "ready": 1,
        "sync": 1,
        "active": 1,
    }

    status, sliced = _get(
        base_url,
        f"/api/overview/slice?chart=adoption&key=sync&granularity=month&month={body['month_start']}",
    )
    assert status == 200
    assert sliced["adoption"]["stage"]["key"] == "sync"
    assert sliced["company_count"] >= 1

    engagement = body["engagement"]
    period = {row["key"]: row for row in body["period"]}
    assert engagement["week"]["people"] == period["wau"]["current"]
    assert engagement["month"]["people"] == period["mau"]["current"]
    assert engagement["week"]["companies"] >= 1
    assert engagement["month"]["companies"] >= 1


def test_overview_module_usage_classifies_stages_and_properties(base_url):
    _insert_overview_restructure_events()

    status, body = _get(base_url, "/api/overview/charts")
    assert status == 200
    usage = body["module_usage"]
    assert usage["default_period"] == "week"
    assert set(usage["periods"]) == {"week", "month"}
    assert usage["modules"] == usage["periods"]["week"]["modules"]
    week = usage["periods"]["week"]
    modules = {row["key"]: row for row in week["modules"]}
    assert set(modules) == {"ap", "ar", "txn", "gst"}

    ap = {row["key"]: row for row in modules["ap"]["stages"]}
    assert modules["ap"]["companies"] >= 1
    assert ap["upload_bill"]["companies"] >= 1
    assert ap["upload_bill"]["failed_events"] == 1
    assert {row["event_name"] for row in ap["upload_bill"]["event_names"]} == {"Upload"}
    properties = {row["key"]: row for row in ap["upload_bill"]["properties"]}
    assert {row["value"] for row in properties["type"]["values"]} == {"bill"}
    assert {row["value"] for row in properties["source"]["values"]} == {"whatsapp"}

    txn = {row["key"]: row for row in modules["txn"]["stages"]}
    transaction_types = {row["value"] for row in txn["ledger"]["properties"]
                         if row["key"] == "transactionType" for row in row["values"]}
    assert "payment" in transaction_types

    gst = {row["key"]: row for row in modules["gst"]["stages"]}
    gst_types = {row["value"] for row in gst["upload_gst"]["properties"]
                 if row["key"] == "type" for row in row["values"]}
    assert gst_types == {"gstr2b"}


def test_overview_module_slice_accepts_month_window(base_url):
    _insert_overview_restructure_events()
    month = datetime.now(IST).date().replace(day=1).isoformat()
    status, body = _get(
        base_url,
        f"/api/overview/slice?chart=module&key=ap.upload_bill&period=month&month={month}"
        "&property=type&value=bill",
    )
    assert status == 200
    assert body["company_count"] >= 1
    assert body["module_slice"]["stage"]["key"] == "upload_bill"
    assert any(
        row["key"] == "type" and row["value"] == "bill"
        for row in body["module_slice"]["property_breakdown"]
    )


def test_overview_feature_usage_counts_branch_events(base_url):
    complete = _ist_monday() - timedelta(days=7)
    with psycopg.connect(TEST_DB_URL, autocommit=True) as conn:
        for insert_id, event_name, props in (
            ("feat_bill", "Upload", {"type": "bill", "status": "Success"}),
            ("feat_stmt", "Upload", {"type": "statement", "status": "Success"}),
            ("feat_inv", "Upload", {"type": "invoice", "status": "Success"}),
            ("feat_gst", "Upload", {"type": "gstr2b", "status": "Success"}),
            ("feat_ready", "Invoice Created", {}),
            ("feat_ledger", "Transaction Ledger Updated", {"type": "payment"}),
            ("feat_status", "Transaction Status", {"type": "single"}),
            ("feat_sync", "Accounting Sync", {"items_count": 4}),
            ("feat_recon", "Recon Processed", {}),
        ):
            conn.execute(
                "INSERT INTO events (insert_id, event_name, event_time,"
                " distinct_id, company_id, email, properties)"
                " VALUES (%s, %s, %s, %s, %s, %s, %s)",
                (insert_id, event_name, _at(complete, 11), "feat_person",
                 "c_keep", "feat@example.com", Json(props)),
            )

    status, body = _get(base_url, "/api/overview/charts")
    assert status == 200
    modules = {row["key"]: row for row in body["feature_usage"]["modules"]}
    assert modules["ap"]["companies"] >= 1
    assert modules["txn"]["companies"] >= 1
    assert modules["ar"]["companies"] >= 1
    assert modules["gst"]["companies"] >= 1
    ap_nodes = {row["key"]: row for row in modules["ap"]["nodes"]}
    txn_nodes = {row["key"]: row for row in modules["txn"]["nodes"]}
    assert ap_nodes["upload_bill"]["companies"] >= 1
    assert ap_nodes["invoice_created"]["companies"] >= 1
    assert ap_nodes["sync"]["companies"] >= 1
    assert txn_nodes["ledger"]["companies"] >= 1
    ledger_types = {row["value"] for row in txn_nodes["ledger"]["types"]}
    assert "payment" in ledger_types

    status, billed = _get(
        base_url,
        f"/api/overview/slice?chart=feature&key=ap.upload_bill&week={complete.isoformat()}",
    )
    assert status == 200
    assert billed["company_count"] >= 1
    assert billed["feature"]["key"] == "ap"
    assert billed["feature_node"] == "ap.upload_bill"
    billed_ids = {
        company["company_id"]
        for user in billed["users"]
        for company in user["companies"]
    }
    assert "c_keep" in billed_ids

    status, txn = _get(
        base_url,
        f"/api/overview/slice?chart=feature&key=txn&week={complete.isoformat()}",
    )
    assert status == 200
    assert txn["company_count"] >= 1
    assert txn["feature_node"] is None

    status, _ = _get(
        base_url,
        f"/api/overview/slice?chart=feature&key=nope&week={complete.isoformat()}",
    )
    assert status == 400


def test_overview_slices_match_retention_and_hide_staff(base_url):
    _insert_current_actions()
    status, charts = _get(base_url, "/api/overview/charts")
    assert status == 200

    status, weekly = _get(
        base_url,
        f"/api/overview/slice?chart=weekly&key=people&week={charts['week_start']}",
    )
    assert status == 200
    assert weekly["people_count"] >= 1
    rendered = str(weekly).lower()
    assert "@karboncard.com" not in rendered and "chart_chrome" not in rendered

    status, activated = _get(
        base_url,
        "/api/overview/slice?chart=funnel&key=sync&mode=reached",
    )
    assert status == 200
    assert activated["company_count"] == 4

    status, retained = _get(
        base_url,
        f"/api/overview/slice?chart=week8&key=retained&cohort_week={COHORT.isoformat()}",
    )
    assert status == 200
    status, heatmap_cell = _get(
        base_url,
        f"/api/heatmap/cell?cohort_week={COHORT.isoformat()}&rel_week=8",
    )
    assert status == 200
    assert retained["company_count"] == heatmap_cell["company_count"] == 2

    complete_week = (_ist_monday() - timedelta(days=7)).isoformat()
    status, billed = _get(
        base_url,
        f"/api/overview/slice?chart=product&key=had_bill_upload&week={complete_week}",
    )
    assert status == 200
    assert billed["company_count"] == 1
    billed_ids = {
        company["company_id"]
        for user in billed["users"]
        for company in user["companies"]
    }
    assert billed_ids == {"c_keep"}

    status, mixpanel_ready = _get(
        base_url,
        f"/api/overview/slice?chart=product&key=had_created_bill_or_txn&week={complete_week}",
    )
    assert status == 400

    for path in (
        "/api/overview/slice?chart=weekly&key=people&week=2026-04-07",
        "/api/overview/slice?chart=funnel&key=nope",
        "/api/overview/slice?chart=week8&key=retained",
        "/api/overview/slice?chart=family&key=nope",
        "/api/overview/slice?chart=product&key=nope",
    ):
        status, _ = _get(base_url, path)
        assert status == 400, path
