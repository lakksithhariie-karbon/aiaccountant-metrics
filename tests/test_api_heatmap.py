"""HTTP API tests (Worker B).

Isolation contract:
- These tests run against TEST_DATABASE_URL, or the local default
  scratch database (``product_metrics`` on 127.0.0.1:5432) when unset.
  That database is SEPARATE from the live warehouse: all seed rows go
  to the test DB's ``public`` tables, never to live public.events.
- Seeds mirror the production shape (activation/week/cell/profile/
  week-action/event rows) and the signed contract (IST Monday weeks,
  Accounting Sync activation, Accounting Sync / Recon Processed value
  only, null company_id excluded, staff filter, action set).

Covers: /health ok; /heatmap shape + rate math (unchanged); /cell NEW
shape (users with nested companies, company_count == retained_count,
median/shares sanity, staff absent, missing week_action -> 0);
GET /api/companies/:id/summary keys + by_event action-only + cap;
/timeline pagination (default 100, clamp 500, newest-first, no email);
400s on bad cell/timeline params; _db() connection reuse.
"""

from __future__ import annotations

import json
import os
import threading
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta, timezone
from http.server import ThreadingHTTPServer

import pytest

# Local scratch database default. Built from parts (never committed with
# a literal credential) so secret scrubbers cannot corrupt it; override
# with TEST_DATABASE_URL in CI.
_TEST_DB_USER = "postgres"
_TEST_DB_HOST = "127.0.0.1:5432"
_TEST_DB_NAME = "product_metrics"
TEST_DB_URL = os.environ.get(
    "TEST_DATABASE_URL",
    f"postgresql://{_TEST_DB_USER}:{_TEST_DB_USER}"
    f"@{_TEST_DB_HOST}/{_TEST_DB_NAME}",
)

IST = timezone(timedelta(hours=5, minutes=30))
COHORT = date(2026, 4, 6)  # a Monday
TARGET8 = COHORT + timedelta(days=56)  # W+8 Monday (2026-06-01)


def _ist_monday() -> date:
    now = datetime.now(IST)
    return now.date() - timedelta(days=now.weekday())

MIGRATION_001 = os.path.join(
    os.path.dirname(__file__), "..", "supabase", "migrations", "001_events.sql"
)
MIGRATION_004 = os.path.join(
    os.path.dirname(__file__), "..", "supabase", "migrations", "004_sync_rpcs.sql"
)
MIGRATION_012 = os.path.join(
    os.path.dirname(__file__), "..", "supabase", "migrations",
    "012_company_week_product.sql",
)


def _at(day: date, hour: int = 10, minute: int = 0) -> datetime:
    return datetime(day.year, day.month, day.day, hour, minute, tzinfo=IST)


def _inst(ts: str) -> datetime:
    """Parse an API timestamp. Aware datetimes compare by instant, so a
    UTC-rendered value still equals the IST fixture that produced it."""
    return datetime.fromisoformat(ts)


def _seed(conn) -> None:
    from metrics.refresh import ensure_tables

    conn.execute(open(MIGRATION_001).read())
    _004 = open(MIGRATION_004).read()
    start = _004.index("CREATE OR REPLACE FUNCTION public.is_internal_email")
    end = _004.index("CREATE OR REPLACE FUNCTION public.try_begin_incremental")
    conn.execute(_004[start:end])
    ensure_tables(conn)
    if conn.execute(
        "SELECT to_regclass('public.company_week_product')"
    ).fetchone()[0] is None:
        conn.execute(open(MIGRATION_012).read())
    conn.execute(
        "TRUNCATE TABLE client_company, company_profile,"
        " company_week_action, company_activation, company_week_value,"
        " retention_cells, events, company_week_product"
    )
    conn.execute(
        "INSERT INTO client_company (company_id) VALUES"
        " ('c_keep'), ('c_sib'), ('c_drop'), ('c_story')"
    )
    conn.execute(
        "INSERT INTO company_activation"
        " (company_id, activated_at, activation_week) VALUES"
        " ('c_keep', %s, %s),"
        " ('c_sib', %s, %s),"
        " ('c_drop', %s, %s),"
        " ('c_story', %s, %s)",
        (
            _at(COHORT), COHORT,
            _at(COHORT, 12), COHORT,
            _at(COHORT + timedelta(days=1), 11), COHORT,
            _at(COHORT, 9), COHORT,
        ),
    )
    conn.execute(
        "INSERT INTO company_week_value"
        " (company_id, week_start, had_value, had_sync, had_recon) VALUES"
        " ('c_keep', %s, true, true, false),"
        " ('c_sib', %s, true, true, false),"
        " ('c_drop', %s, true, true, false),"
        " ('c_story', %s, true, true, false),"
        " ('c_keep', %s, true, false, true),"
        " ('c_sib', %s, true, false, true),"
        " ('c_drop', %s, false, false, false)",
        (COHORT, COHORT, COHORT, COHORT, TARGET8, TARGET8, TARGET8),
    )
    conn.execute(
        "INSERT INTO retention_cells"
        " (cohort_week, rel_week, cohort_size, retained_count) VALUES"
        " (%s, 0, 4, 4),"
        " (%s, 8, 4, 2)",
        (COHORT, COHORT),
    )
    conn.execute(
        "INSERT INTO company_profile"
        " (company_id, company_name, signed_up_at, activated_at,"
        "  activation_week, first_upload_at, first_ready_at,"
        "  first_sync_at, first_recon_at, last_action_at,"
        "  action_count, active_weeks,"
        "  path_had_upload, path_had_ready,"
        "  path_had_sync, path_had_recon) VALUES"
        " ('c_keep', 'Keep Co', %s, %s, %s, %s, %s, %s, %s, %s,"
        "  80, 6, true, true, true, true),"
        " ('c_sib', 'Sibling Co', %s, %s, %s, NULL, %s, %s, %s, %s,"
        "  40, 4, false, true, true, true),"
        " ('c_drop', 'Drop Co', %s, %s, %s, NULL, NULL, %s, NULL, %s,"
        "  5, 1, false, false, true, false),"
        " ('c_story', 'Story Co', %s, %s, %s, %s, %s, %s, %s, %s,"
        "  7, 1, true, true, true, true)",
        (
            _at(COHORT, 8), _at(COHORT), COHORT,
            _at(COHORT, 9), _at(COHORT + timedelta(days=1)),
            _at(COHORT), _at(TARGET8 + timedelta(days=2)),
            _at(TARGET8 + timedelta(days=2)),
            _at(COHORT, 11), _at(COHORT, 12), COHORT,
            _at(COHORT + timedelta(days=2)), _at(COHORT, 12),
            _at(TARGET8 + timedelta(days=1)),
            _at(TARGET8 + timedelta(days=1)),
            _at(COHORT + timedelta(days=1)), _at(COHORT + timedelta(days=1), 11),
            COHORT, _at(COHORT + timedelta(days=1), 11),
            _at(COHORT + timedelta(days=1), 11),
            _at(COHORT, 8, 30), _at(COHORT, 9), COHORT,
            _at(COHORT + timedelta(days=2)), _at(COHORT + timedelta(days=3)),
            _at(COHORT, 9), _at(COHORT + timedelta(days=3), 11),
            _at(COHORT + timedelta(days=3), 11),
        ),
    )
    # c_sib deliberately has NO TARGET8 row: missing week -> 0.
    conn.execute(
        "INSERT INTO company_week_action"
        " (company_id, week_start, action_count, upload_count,"
        "  txn_count, ap_count, sync_count, recon_count,"
        "  other_action_count) VALUES"
        " ('c_keep', %s, 10, 2, 3, 1, 2, 2, 0),"
        " ('c_sib', %s, 6, 0, 2, 1, 1, 0, 2),"
        " ('c_drop', %s, 5, 0, 1, 0, 1, 0, 3),"
        " ('c_story', %s, 7, 3, 0, 2, 1, 1, 0),"
        " ('c_keep', %s, 4, 1, 2, 0, 1, 0, 0)",
        (COHORT, COHORT, COHORT, COHORT, TARGET8),
    )
    complete_week = _ist_monday() - timedelta(days=7)
    conn.execute(
        "INSERT INTO company_week_product"
        " (company_id, week_start, had_uploaded_excel, had_ap_active,"
        "  had_txn_active, had_gst_recon, had_created_bill_or_txn,"
        "  had_bill_upload, had_invoice_upload, had_statement_upload)"
        " VALUES"
        " ('c_keep', %s, false, false, false, true, true, true, false, false),"
        " ('c_sib', %s, false, false, true, false, false, false, false, true),"
        " ('c_story', %s, false, true, false, false, false, true, false, false),"
        " ('c_keep', %s, false, true, false, false, true, true, false, false),"
        " ('c_sib', %s, false, false, true, false, false, false, false, true),"
        " ('c_story', %s, true, false, false, false, false, false, true, false),"
        " ('c_drop', %s, false, false, false, true, false, false, false, false)",
        (TARGET8, TARGET8, COHORT,
         complete_week, complete_week, complete_week, complete_week),
    )
    events = [
        # c_keep + c_sib share keep@example.com (user with two companies).
        ("e0su", "Sign Up", _at(COHORT - timedelta(days=7)), "u1", "c_keep",
         "keep@example.com", {}),
        ("e1", "Accounting Sync", _at(COHORT), "u1", "c_keep",
         "keep@example.com", {"companyName": "Keep Co"}),
        ("e2", "Recon Processed", _at(TARGET8 + timedelta(days=2)), "u1",
         "c_keep", "keep@example.com", {"companyName": "Keep Co"}),
        ("e3", "Dashboard Viewed", _at(TARGET8 + timedelta(days=3)), "u1",
         "c_keep", "keep@example.com", {}),
        ("e1b", "Accounting Sync", _at(COHORT, 12), "u1", "c_sib",
         "keep@example.com", {"companyName": "Sibling Co"}),
        ("e2b", "Recon Processed", _at(TARGET8 + timedelta(days=1)), "u1",
         "c_sib", "keep@example.com", {"companyName": "Sibling Co"}),
        # Internal staff on c_keep must not appear in the people list.
        ("e1staff", "Login", _at(COHORT, 13), "u_staff", "c_keep",
         "dev@karboncard.com", {}),
        ("e1korefi", "Login", _at(COHORT, 14), "u_korefi", "c_keep",
         "ops@korefi.ai", {}),
        # c_drop: sync in W0, Dashboard-only in W+8 (not retained).
        # No Sign Up row: user signed_up_at falls back to first event.
        ("e4", "Accounting Sync", _at(COHORT + timedelta(days=1), 11), "u2",
         "c_drop", "drop@example.com", {"companyName": "Drop Co"}),
        ("d_txn", "Transaction Status", _at(COHORT + timedelta(days=1), 11, 5), "u2",
         "c_drop", "drop@example.com", {"transactionType": "payment"}),
        ("e5", "Dashboard Viewed", _at(TARGET8 + timedelta(days=2)), "u2",
         "c_drop", "drop@example.com", {}),
        # c_story: summary/timeline fixture with action + chrome mix.
        ("e7", "Accounting Sync", _at(COHORT, 9), "u3", "c_story",
         "story@example.com", {"companyName": "Story Co"}),
        ("s_int", "Integration status", _at(COHORT, 8, 45), "u3", "c_story",
         "story@example.com", {}),
        ("e8", "Login", _at(COHORT + timedelta(days=2), 9), "u3", "c_story",
         "story@example.com", {}),
        ("s_u1", "Upload", _at(COHORT + timedelta(days=2)), "u3", "c_story",
         "story@example.com", {"type": "bill", "status": "Success"}),
        ("s_u2", "Upload", _at(COHORT + timedelta(days=2), 10, 5), "u3",
         "c_story", "story@example.com", {"type": "invoice", "status": "Failed"}),
        ("s_u3", "Upload", _at(COHORT + timedelta(days=2), 10, 10), "u3",
         "c_story", "story@example.com", {}),
        ("s_i1", "Invoice Created", _at(COHORT + timedelta(days=3)), "u3",
         "c_story", "story@example.com", {}),
        ("s_i2", "Invoice Created", _at(COHORT + timedelta(days=3), 10, 30),
         "u3", "c_story", "story@example.com", {}),
        ("e6", "Recon Processed", _at(COHORT + timedelta(days=3), 11), "u3",
         "c_story", "story@example.com", {"companyName": "Story Co"}),
        ("s_d1", "Dashboard Viewed", _at(COHORT + timedelta(days=3), 12),
         "u3", "c_story", "story@example.com", {}),
    ]
    from psycopg.types.json import Json

    for row in events:
        insert_id, event_name, event_time, distinct_id, company_id, email, props = row
        conn.execute(
            "INSERT INTO events (insert_id, event_name, event_time,"
            " distinct_id, company_id, email, properties)"
            " VALUES (%s, %s, %s, %s, %s, %s, %s)",
            (insert_id, event_name, event_time, distinct_id, company_id,
             email, Json(props)),
        )
    # Cap fixture: 5100 events for one company (proves timeline clamp).
    cap_rows = [
        (f"cap{i:05d}", "Login", _at(COHORT + timedelta(days=i % 7), 8, i % 60),
         "ucap", "c_cap")
        for i in range(5100)
    ]
    with conn.cursor() as cur:
        cur.executemany(
            "INSERT INTO events (insert_id, event_name, event_time,"
            " distinct_id, company_id, properties)"
            " VALUES (%s, %s, %s, %s, %s, '{}')",
            cap_rows,
        )


@pytest.fixture()
def base_url():
    import psycopg

    from metrics.api import ApiHandler

    os.environ["TEST_DATABASE_URL"] = TEST_DB_URL
    connection = psycopg.connect(TEST_DB_URL, autocommit=True)
    _seed(connection)
    server = ThreadingHTTPServer(("127.0.0.1", 0), ApiHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_port}"
    server.shutdown()
    server.server_close()
    thread.join(timeout=5)
    connection.close()


def _get(base_url: str, path: str):
    try:
        with urllib.request.urlopen(base_url + path, timeout=10) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8")
        try:
            return exc.code, json.loads(body)
        except json.JSONDecodeError:
            return exc.code, {"raw": body}


def test_health_ok(base_url):
    status, body = _get(base_url, "/health")
    assert status == 200
    assert body == {"ok": True}


def test_page_summary_kpis(base_url):
    """Page-level Retention cards. Independent of cell click."""
    status, body = _get(base_url, "/api/summary")
    assert status == 200
    assert body["client_companies"] == 4
    assert body["activated"] == 4
    assert body["activation_rate"] == pytest.approx(1.0)
    # Seed TTVs: 2h, 1h, 1h, 0.5h → median 1.0
    assert body["median_ttv_hours"] == pytest.approx(1.0)
    assert body["week8_cohort_week"] == "2026-04-06"
    assert (body["week8_cohort_size"], body["week8_retained"]) == (4, 2)
    assert body["week8_retention"] == pytest.approx(0.5)
    assert body["recon_count"] == 3
    assert body["recon_among_activated"] == pytest.approx(0.75)


def test_page_summary_uses_mature_week8(base_url):
    """Week-8 card is latest cohort whose W+8 week has fully elapsed."""
    import psycopg

    in_progress = _ist_monday() - timedelta(days=56)
    with psycopg.connect(TEST_DB_URL, autocommit=True) as conn:
        conn.execute(
            "INSERT INTO retention_cells"
            " (cohort_week, rel_week, cohort_size, retained_count)"
            " VALUES (%s, 8, 99, 99)",
            (in_progress,),
        )
    status, body = _get(base_url, "/api/summary")
    assert status == 200
    assert body["week8_cohort_week"] == "2026-04-06"
    assert (body["week8_cohort_size"], body["week8_retained"]) == (4, 2)
    assert body["week8_retention"] == pytest.approx(0.5)


def test_activation_week_filter_exact_range_clips_heatmap_and_week8(base_url):
    status, heatmap = _get(
        base_url,
        "/api/heatmap?from_week=2026-04-06&to_week=2026-04-06",
    )
    assert status == 200
    assert {row["cohort_week"] for row in heatmap} == {"2026-04-06"}
    assert {row["rel_week"] for row in heatmap} == {0, 8}

    status, summary = _get(
        base_url,
        "/api/summary?from_week=2026-04-06&to_week=2026-04-06",
    )
    assert status == 200
    assert summary["week8_cohort_week"] == "2026-04-06"
    assert (summary["week8_cohort_size"], summary["week8_retained"]) == (4, 2)


def test_activation_week_filter_excludes_immature_week8_and_keeps_lifetime_kpis(base_url):
    import psycopg

    immature = _ist_monday() - timedelta(days=56)
    with psycopg.connect(TEST_DB_URL, autocommit=True) as conn:
        conn.execute(
            "INSERT INTO retention_cells"
            " (cohort_week, rel_week, cohort_size, retained_count) VALUES"
            " (%s, 0, 10, 10), (%s, 8, 99, 99)",
            (immature, immature),
        )

    status, heatmap = _get(
        base_url,
        f"/api/heatmap?from_week={immature.isoformat()}&to_week={immature.isoformat()}",
    )
    assert status == 200
    assert {(row["cohort_week"], row["rel_week"]) for row in heatmap} == {
        (immature.isoformat(), 0),
    }

    status, summary = _get(
        base_url,
        f"/api/summary?from_week={immature.isoformat()}&to_week={immature.isoformat()}",
    )
    assert status == 200
    assert summary["week8_cohort_week"] is None
    assert summary["week8_cohort_size"] == 0
    assert summary["week8_retained"] == 0
    assert summary["week8_retention"] is None
    assert summary["activated"] == 4
    assert summary["cohort_weeks"] == ["2026-04-06", immature.isoformat()]


def test_activation_week_filter_snaps_thursday_to_monday(base_url):
    status, heatmap = _get(
        base_url,
        "/api/heatmap?from_week=2026-04-09&to_week=2026-04-09",
    )
    assert status == 200
    assert {row["cohort_week"] for row in heatmap} == {"2026-04-06"}

    status, summary = _get(
        base_url,
        "/api/summary?from_week=2026-04-09&to_week=2026-04-09",
    )
    assert status == 200
    assert summary["week8_cohort_week"] == "2026-04-06"


def test_activation_week_filter_catalog_is_unclipped(base_url):
    import psycopg

    later = _ist_monday() - timedelta(days=56)
    with psycopg.connect(TEST_DB_URL, autocommit=True) as conn:
        conn.execute(
            "INSERT INTO retention_cells"
            " (cohort_week, rel_week, cohort_size, retained_count)"
            " VALUES (%s, 0, 10, 10)",
            (later,),
        )
    status, summary = _get(
        base_url,
        "/api/summary?from_week=2026-04-06&to_week=2026-04-06",
    )
    assert status == 200
    assert summary["cohort_weeks"] == ["2026-04-06", later.isoformat()]


def test_activation_week_filter_rejects_reversed_snapped_range(base_url):
    for endpoint in ("summary", "heatmap"):
        status, _ = _get(
            base_url,
            f"/api/{endpoint}?from_week=2026-04-16&to_week=2026-04-09",
        )
        assert status == 400


def test_activation_week_filter_rejects_malformed_dates(base_url):
    for endpoint in ("summary", "heatmap"):
        status, _ = _get(
            base_url,
            f"/api/{endpoint}?from_week=not-a-date",
        )
        assert status == 400


def test_activation_week_filter_does_not_change_lifetime_kpis(base_url):
    _, unfiltered = _get(base_url, "/api/summary")
    _, filtered = _get(
        base_url,
        "/api/summary?from_week=2026-04-06&to_week=2026-04-06",
    )
    for key in (
        "client_companies",
        "activated",
        "activation_rate",
        "median_ttv_hours",
        "recon_count",
        "recon_among_activated",
    ):
        assert filtered[key] == unfiltered[key]


def test_heatmap_omits_unstarted_rel_weeks(base_url):
    """Heatmap hides rel weeks whose calendar week has not started."""
    import psycopg

    monday = _ist_monday()
    with psycopg.connect(TEST_DB_URL, autocommit=True) as conn:
        conn.execute(
            "INSERT INTO retention_cells"
            " (cohort_week, rel_week, cohort_size, retained_count) VALUES"
            " (%s, 0, 10, 10),"
            " (%s, 1, 10, 0)",
            (monday, monday),
        )
    status, body = _get(base_url, "/api/heatmap")
    assert status == 200
    keys = {(r["cohort_week"], r["rel_week"]) for r in body}
    assert (monday.isoformat(), 0) in keys
    assert (monday.isoformat(), 1) not in keys


def test_heatmap_omits_in_progress_rel_week8_but_keeps_current_week0(base_url):
    """Heatmap hides an open Week 8 while keeping the current Week 0."""
    import psycopg

    monday = _ist_monday()
    in_progress = monday - timedelta(days=56)
    with psycopg.connect(TEST_DB_URL, autocommit=True) as conn:
        conn.execute(
            "INSERT INTO retention_cells"
            " (cohort_week, rel_week, cohort_size, retained_count) VALUES"
            " (%s, 0, 10, 10),"
            " (%s, 8, 45, 3)",
            (monday, in_progress),
        )
    status, body = _get(base_url, "/api/heatmap")
    assert status == 200
    keys = {(r["cohort_week"], r["rel_week"]) for r in body}
    assert (monday.isoformat(), 0) in keys
    assert (in_progress.isoformat(), 8) not in keys


def test_heatmap_shape_and_rate_math(base_url):
    status, body = _get(base_url, "/api/heatmap")
    assert status == 200
    assert isinstance(body, list) and len(body) == 2
    for row in body:
        assert set(row) == {
            "cohort_week", "rel_week", "cohort_size",
            "retained_count", "rate",
        }
    keys = [(r["cohort_week"], r["rel_week"]) for r in body]
    assert keys == sorted(keys)  # ordered by cohort_week, rel_week
    row8 = next(r for r in body if r["rel_week"] == 8)
    assert row8["cohort_week"] == "2026-04-06"
    assert (row8["cohort_size"], row8["retained_count"]) == (4, 2)
    assert row8["rate"] == pytest.approx(2 / 4)
    row0 = next(r for r in body if r["rel_week"] == 0)
    assert row0["rate"] == pytest.approx(1.0)


CELL_KEYS = {
    "cohort_week", "rel_week", "people_count", "company_count",
    "median_actions_that_week", "share_with_upload", "share_with_sync",
    "share_with_recon", "share_with_bill", "share_with_invoice",
    "share_with_statement", "share_with_ap", "share_with_txn",
    "share_with_gst", "users",
}
USER_KEYS = {
    "email", "distinct_id", "user_id", "signed_up_at", "last_action_at",
    "lifetime_actions", "active_weeks", "actions_per_active_week",
    "actions_that_week", "companies",
}
COMPANY_KEYS = {
    "company_id", "company_name", "signed_up_at", "activated_at",
    "last_action_at", "lifetime_actions", "active_weeks",
    "actions_per_active_week", "actions_that_week",
    "upload_that_week", "txn_that_week", "sync_that_week",
    "recon_that_week", "path_had_upload", "path_had_ready",
    "path_had_sync", "path_had_recon", "ttv_hours", "value_events",
    "had_bill_upload", "had_invoice_upload", "had_statement_upload",
    "had_ap_active", "had_txn_active", "had_gst_recon",
    "had_created_bill_or_txn", "event_chain_that_week",
}


def test_cell_week8_shape_and_counts(base_url):
    status, body = _get(
        base_url, "/api/heatmap/cell?cohort_week=2026-04-06&rel_week=8"
    )
    assert status == 200
    assert set(body) == CELL_KEYS
    assert body["cohort_week"] == "2026-04-06"
    assert body["rel_week"] == 8
    # company_count MUST equal the heatmap retained_count for this cell.
    _, heat = _get(base_url, "/api/heatmap")
    retained = next(
        r["retained_count"] for r in heat
        if r["cohort_week"] == "2026-04-06" and r["rel_week"] == 8
    )
    assert body["company_count"] == retained == 2
    assert body["people_count"] == 1
    # Recon-in-W+8 included; Dashboard-only c_drop excluded.
    assert [u["email"] for u in body["users"]] == ["keep@example.com"]
    raw = json.dumps(body).lower()
    assert "@karboncard.com" not in raw and "@korefi.ai" not in raw
    user = body["users"][0]
    assert set(user) == USER_KEYS
    assert user["distinct_id"] == "u1"
    # User signup prefers min Sign Up over first event.
    assert _inst(user["signed_up_at"]) == _at(COHORT - timedelta(days=7))
    # User stats are sum/max across that user's cell companies.
    assert user["lifetime_actions"] == 80 + 40
    assert user["active_weeks"] == 6
    assert user["actions_per_active_week"] == pytest.approx(120 / 6)
    assert user["actions_that_week"] == 4 + 0
    assert _inst(user["last_action_at"]) == _at(TARGET8 + timedelta(days=2))
    companies = {c["company_id"]: c for c in user["companies"]}
    assert set(companies) == {"c_keep", "c_sib"}
    for company in companies.values():
        assert set(company) == COMPANY_KEYS
    keep = companies["c_keep"]
    assert keep["company_name"] == "Keep Co"
    assert _inst(keep["signed_up_at"]) == _at(COHORT, 8)
    assert _inst(keep["activated_at"]) == _at(COHORT)
    assert keep["actions_that_week"] == 4
    assert (keep["upload_that_week"], keep["txn_that_week"],
            keep["sync_that_week"], keep["recon_that_week"]) == (1, 2, 1, 0)
    assert keep["lifetime_actions"] == 80
    assert keep["active_weeks"] == 6
    assert keep["actions_per_active_week"] == pytest.approx(80 / 6, abs=0.06)
    assert keep["ttv_hours"] == pytest.approx(2.0)
    assert keep["value_events"] == ["Recon Processed"]
    assert (keep["path_had_upload"] and keep["path_had_ready"]
            and keep["path_had_sync"] and keep["path_had_recon"])
    # c_sib has no TARGET8 week_action row: missing week -> 0.
    sib = companies["c_sib"]
    assert sib["actions_that_week"] == 0
    assert (sib["upload_that_week"], sib["txn_that_week"],
            sib["sync_that_week"], sib["recon_that_week"]) == (0, 0, 0, 0)
    assert sib["path_had_upload"] is False
    assert sib["ttv_hours"] == pytest.approx(1.0)
    assert sib["value_events"] == ["Recon Processed"]
    # Median/shares over the cell's companies: atw [4, 0].
    assert body["median_actions_that_week"] == pytest.approx(2.0)
    assert body["share_with_upload"] == pytest.approx(0.5)
    assert body["share_with_sync"] == pytest.approx(0.5)
    assert body["share_with_recon"] == pytest.approx(0.0)
    assert body["share_with_bill"] == pytest.approx(0.5)
    assert body["share_with_invoice"] == pytest.approx(0.0)
    assert body["share_with_statement"] == pytest.approx(0.5)
    assert body["share_with_ap"] == pytest.approx(0.0)
    assert body["share_with_txn"] == pytest.approx(0.5)
    assert body["share_with_gst"] == pytest.approx(0.5)
    assert keep["had_bill_upload"] is True
    assert keep["had_gst_recon"] is True
    assert keep["had_created_bill_or_txn"] is True
    assert keep["had_invoice_upload"] is False
    assert sib["had_statement_upload"] is True
    assert sib["had_txn_active"] is True
    assert sib["had_bill_upload"] is False
    for share in (body["share_with_upload"], body["share_with_sync"],
                  body["share_with_recon"], body["share_with_bill"],
                  body["share_with_invoice"], body["share_with_statement"],
                  body["share_with_ap"], body["share_with_txn"],
                  body["share_with_gst"]):
        assert 0.0 <= share <= 1.0


def test_cell_week0_agreement_and_sort(base_url):
    status, body = _get(
        base_url, "/api/heatmap/cell?cohort_week=2026-04-06&rel_week=0"
    )
    assert status == 200
    assert set(body) == CELL_KEYS
    _, heat = _get(base_url, "/api/heatmap")
    retained0 = next(
        r["retained_count"] for r in heat
        if r["cohort_week"] == "2026-04-06" and r["rel_week"] == 0
    )
    assert body["company_count"] == retained0 == 4
    assert body["people_count"] == 3
    emails = [u["email"] for u in body["users"]]
    # Sorted by actions_that_week desc: keep (10+6), story (7), drop (5).
    assert emails == ["keep@example.com", "story@example.com",
                      "drop@example.com"]
    by_email = {u["email"]: u for u in body["users"]}
    keep_ids = {c["company_id"] for c in by_email["keep@example.com"]["companies"]}
    assert keep_ids == {"c_keep", "c_sib"}
    assert by_email["keep@example.com"]["actions_that_week"] == 16
    # No Sign Up row for u2: fallback to first event.
    assert _inst(by_email["drop@example.com"]["signed_up_at"]) == \
        _at(COHORT + timedelta(days=1), 11)
    assert by_email["drop@example.com"]["actions_that_week"] == 5
    assert body["median_actions_that_week"] == pytest.approx(6.5)
    assert body["share_with_upload"] == pytest.approx(0.5)
    assert body["share_with_sync"] == pytest.approx(1.0)
    assert body["share_with_recon"] == pytest.approx(0.5)


def test_cell_empty_cohort(base_url):
    status, body = _get(
        base_url, "/api/heatmap/cell?cohort_week=2020-01-06&rel_week=8"
    )
    assert status == 200
    assert set(body) == CELL_KEYS
    assert body["company_count"] == 0
    assert body["people_count"] == 0
    assert body["users"] == []
    assert body["median_actions_that_week"] == 0
    assert body["share_with_upload"] == 0.0
    assert body["share_with_sync"] == 0.0
    assert body["share_with_recon"] == 0.0
    assert body["share_with_bill"] == 0.0
    assert body["share_with_invoice"] == 0.0
    assert body["share_with_statement"] == 0.0
    assert body["share_with_ap"] == 0.0
    assert body["share_with_txn"] == 0.0
    assert body["share_with_gst"] == 0.0


SUMMARY_KEYS = {
    "company_id", "company_name", "signed_up_at", "activated_at",
    "activation_week",
    "first_upload_at", "first_ready_at", "first_sync_at",
    "first_recon_at", "last_action_at", "lifetime_actions",
    "active_weeks", "actions_per_active_week", "ttv_hours",
    "path_had_upload", "path_had_ready", "path_had_sync",
    "path_had_recon", "hours_signup_to_upload", "hours_upload_to_ready",
    "hours_ready_to_sync", "hours_sync_to_recon", "last_sync_at",
    "last_recon_at", "hours_since_last_sync", "hours_since_last_recon",
    "path_type", "last_value_week_start", "last_value_rel_week",
    "week8_counted", "by_week", "by_event", "funnel", "work_mix",
    "upload_types", "ready_activities", "ledger_events",
    "ledger_transaction_types", "event_chain",
}
WEEK_KEYS = {
    "week_start", "action_count", "upload_count", "txn_count",
    "ap_count", "sync_count", "recon_count",
    "had_bill_upload", "had_invoice_upload", "had_statement_upload",
    "had_ap_active", "had_txn_active", "had_gst_recon",
    "had_created_bill_or_txn",
}


def test_company_summary(base_url):
    status, body = _get(base_url, "/api/companies/c_story/summary")
    assert status == 200
    assert set(body) == SUMMARY_KEYS
    assert body["company_id"] == "c_story"
    assert body["company_name"] == "Story Co"
    assert _inst(body["signed_up_at"]) == _at(COHORT, 8, 30)
    assert _inst(body["activated_at"]) == _at(COHORT, 9)
    assert _inst(body["first_upload_at"]) == _at(COHORT + timedelta(days=2))
    assert _inst(body["first_ready_at"]) == _at(COHORT + timedelta(days=3))
    assert _inst(body["first_sync_at"]) == _at(COHORT, 9)
    assert _inst(body["first_recon_at"]) == _at(COHORT + timedelta(days=3), 11)
    assert _inst(body["last_action_at"]) == _at(COHORT + timedelta(days=3), 11)
    assert body["lifetime_actions"] == 7
    assert body["active_weeks"] == 1
    assert body["actions_per_active_week"] == pytest.approx(7.0)
    assert body["ttv_hours"] == pytest.approx(0.5)
    assert body["activation_week"] == "2026-04-06"
    assert body["hours_signup_to_upload"] == pytest.approx(49.5)
    assert body["hours_upload_to_ready"] == pytest.approx(24.0)
    assert body["hours_ready_to_sync"] is None
    assert body["hours_sync_to_recon"] == pytest.approx(74.0)
    assert _inst(body["last_sync_at"]) == _at(COHORT, 9)
    assert _inst(body["last_recon_at"]) == _at(COHORT + timedelta(days=3), 11)
    assert body["hours_since_last_sync"] > 0
    assert body["hours_since_last_recon"] > 0
    assert body["path_type"] == "ap"
    assert body["last_value_week_start"] == "2026-04-06"
    assert body["last_value_rel_week"] == 0
    assert body["week8_counted"] is not None
    assert (body["path_had_upload"] and body["path_had_ready"]
            and body["path_had_sync"] and body["path_had_recon"])
    assert len(body["by_week"]) == 1
    week = body["by_week"][0]
    assert set(week) == WEEK_KEYS
    assert week["week_start"] == "2026-04-06"
    assert (week["action_count"], week["upload_count"], week["txn_count"],
            week["ap_count"], week["sync_count"],
            week["recon_count"]) == (7, 3, 0, 2, 1, 1)
    assert week["had_invoice_upload"] is False
    assert week["had_ap_active"] is True
    assert week["had_bill_upload"] is True
    assert week["had_txn_active"] is False
    assert week["had_gst_recon"] is False
    assert week["had_created_bill_or_txn"] is False
    # by_event: actions only, desc, cap 40. Login/Dashboard/Sign Up excluded.
    names = [r["event_name"] for r in body["by_event"]]
    assert names == ["Upload", "Invoice Created", "Accounting Sync",
                     "Recon Processed"]
    counts = {r["event_name"]: r["count"] for r in body["by_event"]}
    assert counts == {"Upload": 3, "Invoice Created": 2,
                      "Accounting Sync": 1, "Recon Processed": 1}
    assert all(set(r) == {"event_name", "count"} for r in body["by_event"])
    assert len(body["by_event"]) <= 40
    assert "Login" not in names and "Dashboard Viewed" not in names
    assert "Sign Up" not in names

    assert [row["key"] for row in body["funnel"]] == [
        "signup", "integration", "upload", "ready", "sync"
    ]
    funnel = {row["key"]: row for row in body["funnel"]}
    assert funnel["integration"]["reached"] is True
    assert funnel["integration"]["count"] == 1
    assert _inst(funnel["integration"]["first_at"]) == _at(COHORT, 8, 45)
    assert funnel["upload"]["count"] == 3
    assert funnel["ready"]["reached"] is True
    assert funnel["sync"]["reached"] is True
    assert all(row["key"] != "recon" for row in body["funnel"])

    assert body["work_mix"] == {
        "scope": "lifetime",
        "upload": 3,
        "upload_failed": 1,
        "ap": 2,
        "txn": 0,
        "sync": 1,
        "recon": 1,
    }
    upload_types = {row["key"]: row for row in body["upload_types"]}
    assert upload_types["bill"]["count"] == 1
    assert upload_types["bill"]["failed_count"] == 0
    assert upload_types["invoice"]["count"] == 1
    assert upload_types["invoice"]["failed_count"] == 1
    assert upload_types["unknown"]["count"] == 1
    assert [row["event_name"] for row in body["ready_activities"]] == [
        "Invoice Created", "Transaction Ledger Updated"
    ]
    assert {row["event_name"] for row in body["ledger_events"]} == set()
    assert body["ledger_transaction_types"] == []


def _insert_chain_events(rows):
    import psycopg
    from psycopg.types.json import Json

    with psycopg.connect(TEST_DB_URL) as conn:
        conn.autocommit = True
        for insert_id, event_name, event_time, props in rows:
            conn.execute(
                "INSERT INTO events (insert_id, event_name, event_time,"
                " distinct_id, company_id, email, properties)"
                " VALUES (%s, %s, %s, %s, %s, %s, %s)",
                (insert_id, event_name, event_time, "u3", "c_story",
                 "story@example.com", Json(props)),
            )


def _chain_event(chain, event_name):
    for group in [chain.get("setup", []), chain.get("post_sync", [])]:
        for row in group:
            if row.get("event_name") == event_name:
                return row
    if chain.get("sync", {}).get("event_name") == event_name:
        return chain["sync"]
    for branch in chain.get("branches", []):
        for row in branch.get("events", []):
            if row.get("event_name") == event_name:
                return row
    return None


def test_company_event_chain_has_branches_and_properties(base_url):
    _insert_chain_events([
        ("chain_u_txn", "Upload", _at(COHORT + timedelta(days=4)),
         {"type": "statement", "status": "Success", "source": "bank"}),
        ("chain_ttu", "Transaction Ledger Updated",
         _at(COHORT + timedelta(days=4), 10),
         {"type": "payment", "transactionType": "payment", "source": "bank"}),
        ("chain_ttype", "Transaction Type Updated",
         _at(COHORT + timedelta(days=4), 10, 5),
         {"transactionType": "receipt", "action": "categorize"}),
        ("chain_status", "Transaction Status",
         _at(COHORT + timedelta(days=4), 10, 10),
         {"type": "single", "status": "Accounting Ready"}),
        ("chain_sync", "Accounting Sync",
         _at(COHORT + timedelta(days=4), 11),
         {"items_count": 123, "source": "bank"}),
    ])
    status, body = _get(base_url, "/api/companies/c_story/summary")
    assert status == 200
    chain = body["event_chain"]
    assert chain["scope"] == "lifetime"
    # The seed has a company signup clock but no raw Sign Up event. The chain
    # must not manufacture one from the profile timestamp.
    assert [row["event_name"] for row in chain["setup"]] == [
        "Integration status"
    ]
    branches = {row["key"]: row for row in chain["branches"]}
    assert {"txn", "ap", "ar"}.issubset(branches)
    assert branches["txn"]["ready_event"] == "Transaction Ledger Updated"
    assert branches["txn"]["ready_count"] == 1
    assert {row["event_name"] for row in branches["txn"]["events"]} >= {
        "Upload", "Transaction Ledger Updated", "Transaction Type Updated",
        "Transaction Status",
    }
    ap_upload = next(row for row in branches["ap"]["events"] if row["event_name"] == "Upload")
    assert "subType" not in {row["key"] for row in ap_upload["properties"]}
    other_upload = next(row for row in branches["other"]["events"] if row["event_name"] == "Upload")
    assert "subType" not in {row["key"] for row in other_upload["properties"]}
    ledger = _chain_event(chain, "Transaction Ledger Updated")
    properties = {row["key"]: row for row in ledger["properties"]}
    assert {row["value"] for row in properties["type"]["values"]} == {"payment"}
    assert {row["value"] for row in properties["source"]["values"]} == {"bank"}
    assert {row["value"] for row in properties["transactionType"]["values"]} == {"payment"}
    sync = _chain_event(chain, "Accounting Sync")
    sync_properties = {row["key"]: row for row in sync["properties"]}
    assert sync_properties["items_count"]["values"] == [{"value": "123", "count": 1}]
    assert _chain_event(chain, "Recon Processed") in chain["post_sync"]


def test_cell_company_event_chain_is_that_week(base_url):
    _insert_chain_events([
        ("cell_u_txn", "Upload", _at(COHORT + timedelta(days=4), 12),
         {"type": "statement", "status": "Success"}),
        ("cell_status", "Transaction Status",
         _at(COHORT + timedelta(days=4), 12, 5), {"type": "single"}),
    ])
    status, body = _get(
        base_url, "/api/heatmap/cell?cohort_week=2026-04-06&rel_week=0"
    )
    assert status == 200
    story = next(
        company
        for user in body["users"]
        for company in user["companies"]
        if company["company_id"] == "c_story"
    )
    chain = story["event_chain_that_week"]
    assert chain["scope"] == "that_week"
    branches = {row["key"]: row for row in chain["branches"]}
    assert "txn" in branches
    assert any(row["event_name"] == "Upload" for row in branches["txn"]["events"])


def test_company_summary_unknown_404(base_url):
    status, body = _get(base_url, "/api/companies/nope/summary")
    assert status == 404


def test_company_summary_null_recon(base_url):
    status, body = _get(base_url, "/api/companies/c_drop/summary")
    assert status == 200
    assert body["first_recon_at"] is None
    assert body["path_had_recon"] is False
    assert body["path_had_upload"] is False
    assert body["ttv_hours"] == pytest.approx(1.0)
    assert body["last_recon_at"] is None
    assert body["hours_sync_to_recon"] is None
    assert body["path_type"] == "txn"
    assert [row["key"] for row in body["funnel"]] == [
        "signup", "integration", "upload", "ready", "sync"
    ]
    assert body["funnel"][-1]["reached"] is True
    assert body["funnel"][-1]["count"] == 1
    assert body["ledger_events"][0]["event_name"] == "Transaction Status"
    assert body["ledger_transaction_types"][0]["transaction_type"] == "payment"


def test_timeline_default_newest_first_no_email(base_url):
    status, body = _get(base_url, "/api/companies/c_story/timeline")
    assert status == 200
    assert set(body) == {"total", "limit", "offset", "events"}
    assert (body["total"], body["limit"], body["offset"]) == (10, 100, 0)
    assert len(body["events"]) == 10
    assert all(set(r) == {"event_time", "event_name"} for r in body["events"])
    times = [r["event_time"] for r in body["events"]]
    assert times == sorted(times, reverse=True)  # newest first
    assert body["events"][0]["event_name"] == "Dashboard Viewed"
    assert body["events"][-1]["event_name"] == "Integration status"
    # Login may appear in the log (it is not an action total).
    assert "Login" in [r["event_name"] for r in body["events"]]
    raw = json.dumps(body)
    assert "story@example.com" not in raw and "email" not in raw.lower()


def test_timeline_paging_and_clamp(base_url):
    # Explicit page through the 10-row log.
    status, body = _get(
        base_url, "/api/companies/c_story/timeline?limit=3&offset=2"
    )
    assert status == 200
    assert (body["total"], body["limit"], body["offset"]) == (10, 3, 2)
    assert len(body["events"]) == 3
    _, full = _get(base_url, "/api/companies/c_story/timeline")
    assert body["events"] == full["events"][2:5]
    # limit=5000 clamps to 500: 5100 seeded rows come back as 500 of 5100.
    status, body = _get(base_url, "/api/companies/c_cap/timeline?limit=5000")
    assert status == 200
    assert body["total"] == 5100
    assert body["limit"] == 500
    assert len(body["events"]) == 500
    # Unknown company: empty page, not an error.
    status, body = _get(base_url, "/api/companies/nope/timeline")
    assert status == 200
    assert body == {"total": 0, "limit": 100, "offset": 0, "events": []}


def test_timeline_bad_params_400(base_url):
    for path in (
        "/api/companies/c_story/timeline?limit=abc",
        "/api/companies/c_story/timeline?limit=0",
        "/api/companies/c_story/timeline?limit=-5",
        "/api/companies/c_story/timeline?offset=-1",
        "/api/companies/c_story/timeline?offset=abc",
    ):
        status, _ = _get(base_url, path)
        assert status == 400, path


def test_cell_bad_params_400(base_url):
    for path in (
        "/api/heatmap/cell?cohort_week=not-a-date&rel_week=8",
        "/api/heatmap/cell?cohort_week=2026-04-06&rel_week=9",
        "/api/heatmap/cell?cohort_week=2026-04-06&rel_week=-1",
        "/api/heatmap/cell?cohort_week=2026-04-06&rel_week=abc",
        "/api/heatmap/cell?cohort_week=2026-04-06",
        "/api/heatmap/cell?rel_week=8",
        "/api/heatmap/cell",
    ):
        status, _ = _get(base_url, path)
        assert status == 400, path


def test_db_reuses_connection():
    import metrics.api as api

    os.environ["TEST_DATABASE_URL"] = TEST_DB_URL
    api._conn = None
    with api._db() as first:
        first.execute("SELECT 1")
        ident = id(first)
        assert first.closed == 0
    with api._db() as second:
        assert id(second) == ident
        assert second.closed == 0
        second.execute("SELECT 1")


def test_overview_kpis_match_summary_and_ignore_old_events(base_url):
    status, body = _get(base_url, "/api/overview")
    assert status == 200
    _, summary = _get(base_url, "/api/summary")
    assert body["timezone"] == "Asia/Kolkata"
    assert body["adoption_rate"] == pytest.approx(summary["activation_rate"])
    assert body["activated"] == summary["activated"]
    assert body["client_companies"] == summary["client_companies"]
    assert body["customer_retention_rate"] == summary["week8_retention"]
    assert body["week8_cohort_week"] == summary["week8_cohort_week"]
    assert (body["week8_cohort_size"], body["week8_retained"]) == (
        summary["week8_cohort_size"], summary["week8_retained"],
    )
    # Seed events are April 2026; current IST windows should be empty.
    assert (body["dau"], body["wau"], body["mau"]) == (0, 0, 0)
    assert body["dau_mau_ratio"] is None


def test_overview_active_users_action_only_excludes_staff(base_url):
    import psycopg
    from psycopg.types.json import Json

    now = datetime.now(IST)
    today = now.date()
    week_start = today - timedelta(days=today.weekday())
    conn = psycopg.connect(TEST_DB_URL, autocommit=True)
    rows = [
        ("ov_dau", "Upload", _at(today, 11), "ov_dau", "c_keep",
         "dau@example.com", {}),
        ("ov_staff", "Upload", _at(today, 11, 5), "ov_staff", "c_keep",
         "dev@karboncard.com", {}),
        ("ov_chrome", "Dashboard Viewed", _at(today, 11, 10), "ov_chrome",
         "c_keep", "chrome@example.com", {}),
    ]
    if today > week_start:
        rows.append(
            ("ov_week", "Invoice Created", _at(week_start, 10), "ov_week",
             "c_keep", "week@example.com", {}),
        )
    for row in rows:
        insert_id, event_name, event_time, distinct_id, company_id, email, props = row
        conn.execute(
            "INSERT INTO events (insert_id, event_name, event_time,"
            " distinct_id, company_id, email, properties)"
            " VALUES (%s, %s, %s, %s, %s, %s, %s)",
            (insert_id, event_name, event_time, distinct_id, company_id,
             email, Json(props)),
        )
    conn.close()

    status, body = _get(base_url, "/api/overview")
    assert status == 200
    assert body["dau"] == 1
    expected_wau = 2 if today > week_start else 1
    assert body["wau"] == expected_wau
    expected_mau = 1
    if today > week_start and week_start.month == today.month:
        expected_mau = 2
    assert body["mau"] == expected_mau
    if body["mau"]:
        assert body["dau_mau_ratio"] == pytest.approx(body["dau"] / body["mau"])
    else:
        assert body["dau_mau_ratio"] is None


def test_is_internal_email_forms():
    from metrics.api import is_internal_email

    assert is_internal_email("dev@karboncard.com")
    assert is_internal_email("OPS@KOREFI.AI")
    assert is_internal_email("QA <qa@KarbonCard.COM>")
    assert is_internal_email("x@y.karboncard.com")
    assert not is_internal_email("ca@client.com")
    assert not is_internal_email(None)
    assert not is_internal_email("")
    assert not is_internal_email("not-an-email")
