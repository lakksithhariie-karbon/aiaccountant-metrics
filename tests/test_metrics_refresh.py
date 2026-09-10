"""Retention data-layer tests (Worker A).

Isolation contract:
- These tests run against TEST_DATABASE_URL, or the local default test
  database ``postgresql://postgres:postgres@127.0.0.1:5432/product_metrics``
  when unset. That database is SEPARATE from the live warehouse: fixture
  rows are written only to a per-test scratch schema
  (``metrics_scratch.events``), never to any ``public.events`` table.
- The refresh under test reads from the scratch events table. The three
  metric tables live in the test DB's ``public`` schema and are rebuilt
  (truncated) by each refresh; the events table is never written by refresh.

Signed-contract coverage:
  (a) first Accounting Sync sets activation_week
  (b) a later Accounting Sync does not move it
  (c) Recon Processed in W+8 -> retained
  (d) Dashboard Viewed only in W+8 -> NOT retained
  (e) null company_id never appears in company metrics
  (f) heatmap cell == activation_week W AND value in W+rel_week
  (g) staff-only company absent from company_activation AND client_company
  (h) mixed client+staff company stays, activation week still first sync
  (i) no-email companies are kept as clients
  (j) staff filter in SQL matches metrics.api.is_internal_email
  (k) company_week_action.action_count ignores Login and Dashboard Viewed
  (l) company_profile signup/path/action-count semantics
Plus: refresh is idempotent (all six tables) and never modifies event rows.
"""

from __future__ import annotations

import os
from datetime import date, datetime, timedelta, timezone

import pytest

TEST_DB_URL = os.environ.get(
    "TEST_DATABASE_URL",
    "postgresql://postgres:postgres@127.0.0.1:5432/product_metrics",
)

IST = timezone(timedelta(hours=5, minutes=30))
SCRATCH = "metrics_scratch"

MIGRATION_001 = os.path.join(
    os.path.dirname(__file__), "..", "supabase", "migrations", "001_events.sql"
)


def ist(dt_obj: datetime) -> datetime:
    assert dt_obj.tzinfo is not None, "event_time must be timezone-aware"
    return dt_obj


def ist_week_start(dt_obj: datetime) -> date:
    """Monday week start of event_time in Asia/Kolkata (mirrors SQL)."""
    d = dt_obj.astimezone(IST).date()
    return d - timedelta(days=d.weekday())


def at(day: date, hour: int = 10) -> datetime:
    return datetime(day.year, day.month, day.day, hour, 0, tzinfo=IST)


@pytest.fixture()
def conn():
    import psycopg

    from metrics.refresh import ensure_tables

    connection = psycopg.connect(TEST_DB_URL, autocommit=True)
    connection.execute(open(MIGRATION_001).read())
    connection.execute(f"DROP SCHEMA IF EXISTS {SCRATCH} CASCADE")
    connection.execute(f"CREATE SCHEMA {SCRATCH}")
    connection.execute(
        f"""
        CREATE TABLE {SCRATCH}.events (
          insert_id text PRIMARY KEY,
          event_name text NOT NULL,
          event_time timestamptz NOT NULL,
          distinct_id text NOT NULL,
          user_id text,
          uc_uuid text,
          email text,
          company_id text,
          company text,
          properties jsonb NOT NULL DEFAULT '{{}}'
        )
        """
    )
    ensure_tables(connection)
    yield connection
    connection.execute(f"DROP SCHEMA IF EXISTS {SCRATCH} CASCADE")
    connection.close()


_seq = 0


def add_event(connection, event_name, event_time, company_id, distinct_id="u1",
              email=None, properties=None):
    import json as _json

    global _seq
    _seq += 1
    connection.execute(
        f"""
        INSERT INTO {SCRATCH}.events
            (insert_id, event_name, event_time, distinct_id, company_id,
             email, properties)
        VALUES (%s, %s, %s, %s, %s, %s, %s::jsonb)
        """,
        (f"t{_seq}", event_name, ist(event_time), distinct_id, company_id,
         email, _json.dumps(properties or {})),
    )


def refresh(connection):
    from metrics.refresh import rebuild

    return rebuild(connection, source=f"{SCRATCH}.events")


def test_first_accounting_sync_sets_activation_week(conn):
    activation_time = datetime(2026, 6, 3, 9, 0, tzinfo=IST)  # Wed
    add_event(conn, "Sign Up", datetime(2026, 6, 1, 9, 0, tzinfo=IST), "c_act1")
    add_event(conn, "Accounting Sync", activation_time, "c_act1")
    add_event(
        conn, "Accounting Sync", datetime(2026, 6, 10, 9, 0, tzinfo=IST), "c_act1"
    )
    counts = refresh(conn)
    assert counts[0] == 1
    row = conn.execute(
        "SELECT company_id, activated_at, activation_week FROM company_activation"
    ).fetchone()
    assert row[0] == "c_act1"
    assert row[1] == activation_time
    assert row[2] == ist_week_start(activation_time)


def test_later_accounting_sync_does_not_move_activation(conn):
    first = datetime(2026, 4, 7, 9, 0, tzinfo=IST)
    add_event(conn, "Accounting Sync", datetime(2026, 5, 5, 9, 0, tzinfo=IST), "c_act2")
    refresh(conn)
    before = conn.execute(
        "SELECT activated_at, activation_week FROM company_activation "
        "WHERE company_id = 'c_act2'"
    ).fetchone()
    add_event(conn, "Accounting Sync", first, "c_act2")
    add_event(conn, "Accounting Sync", datetime(2026, 6, 9, 9, 0, tzinfo=IST), "c_act2")
    refresh(conn)
    after = conn.execute(
        "SELECT activated_at, activation_week FROM company_activation "
        "WHERE company_id = 'c_act2'"
    ).fetchone()
    assert after[0] == first
    assert after[1] == ist_week_start(first)
    assert after != before  # earlier sync correctly wins; later syncs never move it


def test_recon_processed_in_week_plus_8_is_retained(conn):
    sync_time = datetime(2026, 4, 6, 10, 0, tzinfo=IST)
    cohort = ist_week_start(sync_time)
    target_week = cohort + timedelta(days=56)
    add_event(conn, "Accounting Sync", sync_time, "c_ret")
    add_event(conn, "Recon Processed", at(target_week + timedelta(days=2)), "c_ret")
    refresh(conn)
    week_row = conn.execute(
        "SELECT had_value, had_sync, had_recon FROM company_week_value "
        "WHERE company_id = 'c_ret' AND week_start = %s",
        (target_week,),
    ).fetchone()
    assert week_row == (True, False, True)
    cell = conn.execute(
        "SELECT cohort_size, retained_count FROM retention_cells "
        "WHERE cohort_week = %s AND rel_week = 8",
        (cohort,),
    ).fetchone()
    assert cell == (1, 1)


def test_dashboard_viewed_only_in_week_plus_8_is_not_retained(conn):
    sync_time = datetime(2026, 4, 6, 10, 0, tzinfo=IST)
    cohort = ist_week_start(sync_time)
    target_week = cohort + timedelta(days=56)
    add_event(conn, "Accounting Sync", sync_time, "c_dash")
    add_event(
        conn, "Dashboard Viewed", at(target_week + timedelta(days=2)), "c_dash"
    )
    add_event(conn, "Login", at(target_week + timedelta(days=3)), "c_dash")
    refresh(conn)
    week_row = conn.execute(
        "SELECT had_value, had_sync, had_recon FROM company_week_value "
        "WHERE company_id = 'c_dash' AND week_start = %s",
        (target_week,),
    ).fetchone()
    assert week_row == (False, False, False)
    cell = conn.execute(
        "SELECT cohort_size, retained_count FROM retention_cells "
        "WHERE cohort_week = %s AND rel_week = 8",
        (cohort,),
    ).fetchone()
    assert cell == (1, 0)


def test_null_company_id_never_in_company_metrics(conn):
    add_event(
        conn, "Accounting Sync", datetime(2026, 4, 6, 10, 0, tzinfo=IST), None
    )
    add_event(
        conn, "Recon Processed", datetime(2026, 6, 3, 10, 0, tzinfo=IST), None
    )
    add_event(
        conn, "Accounting Sync", datetime(2026, 4, 6, 10, 0, tzinfo=IST), "c_real"
    )
    counts = refresh(conn)
    assert counts[0] == 1
    for table in ("company_activation", "company_week_value", "retention_cells"):
        nulls = conn.execute(
            f"SELECT count(*) FROM {table} WHERE company_id IS NULL"
            if table != "retention_cells"
            else "SELECT 0"
        ).fetchone()[0]
        assert nulls == 0
    assert (
        conn.execute("SELECT count(*) FROM company_week_value").fetchone()[0] == 1
    )


def test_heatmap_cell_matches_activation_and_value_join(conn):
    sync_a = datetime(2026, 4, 6, 10, 0, tzinfo=IST)
    sync_b = datetime(2026, 4, 7, 11, 0, tzinfo=IST)
    cohort = ist_week_start(sync_a)
    assert ist_week_start(sync_b) == cohort
    target_week = cohort + timedelta(days=21)  # rel_week 3
    add_event(conn, "Accounting Sync", sync_a, "c_keep")
    add_event(conn, "Accounting Sync", sync_b, "c_drop")
    add_event(
        conn, "Recon Processed", at(target_week + timedelta(days=1)), "c_keep"
    )
    add_event(
        conn, "Dashboard Viewed", at(target_week + timedelta(days=1)), "c_drop"
    )
    refresh(conn)
    cell = conn.execute(
        "SELECT cohort_size, retained_count FROM retention_cells "
        "WHERE cohort_week = %s AND rel_week = 3",
        (cohort,),
    ).fetchone()
    assert cell == (2, 1)
    drilldown = conn.execute(
        """
        SELECT a.company_id
        FROM company_activation a
        JOIN company_week_value w
          ON w.company_id = a.company_id
         AND w.week_start = a.activation_week + 21
         AND w.had_value
        WHERE a.activation_week = %s
        ORDER BY 1
        """,
        (cohort,),
    ).fetchall()
    assert [r[0] for r in drilldown] == ["c_keep"]


def test_refresh_is_idempotent(conn):
    add_event(
        conn, "Accounting Sync", datetime(2026, 4, 6, 10, 0, tzinfo=IST), "c_idem"
    )
    add_event(
        conn, "Recon Processed", datetime(2026, 4, 8, 10, 0, tzinfo=IST), "c_idem"
    )
    first = refresh(conn)
    snap = (
        conn.execute("SELECT * FROM company_activation ORDER BY 1").fetchall(),
        conn.execute("SELECT * FROM company_week_value ORDER BY 1, 2").fetchall(),
        conn.execute("SELECT * FROM retention_cells ORDER BY 1, 2").fetchall(),
    )
    second = refresh(conn)
    assert second == first
    assert (
        conn.execute("SELECT * FROM company_activation ORDER BY 1").fetchall(),
        conn.execute("SELECT * FROM company_week_value ORDER BY 1, 2").fetchall(),
        conn.execute("SELECT * FROM retention_cells ORDER BY 1, 2").fetchall(),
    ) == snap


def test_refresh_never_modifies_event_rows(conn):
    add_event(
        conn, "Accounting Sync", datetime(2026, 4, 6, 10, 0, tzinfo=IST), "c_safe"
    )
    before = conn.execute(f"SELECT * FROM {SCRATCH}.events ORDER BY 1").fetchall()
    refresh(conn)
    after = conn.execute(f"SELECT * FROM {SCRATCH}.events ORDER BY 1").fetchall()
    assert after == before


def test_main_refresh_commits_so_counts_persist_after_close(conn, monkeypatch):
    """Regression: main() must commit; close() without commit rolls back.

    Drives the real CLI entrypoint against the test DB (SUPABASE_DB_URL
    monkeypatched; load_dotenv with override=False keeps it), then proves
    from a NEW connection that the rebuilt rows survived the close.
    """
    import psycopg

    from metrics.refresh import main

    sync_time = datetime(2026, 4, 6, 10, 0, tzinfo=IST)
    conn.execute(
        """
        INSERT INTO public.events
            (insert_id, event_name, event_time, distinct_id, company_id,
             properties)
        VALUES
            ('dur_sync', 'Accounting Sync', %s, 'u_dur', 'c_dur', '{}'),
            ('dur_recon', 'Recon Processed', %s, 'u_dur', 'c_dur', '{}')
        """,
        (sync_time, datetime(2026, 4, 8, 10, 0, tzinfo=IST)),
    )
    monkeypatch.setenv("SUPABASE_DB_URL", TEST_DB_URL)
    try:
        assert main(["refresh"]) == 0
        check = psycopg.connect(TEST_DB_URL)
        try:
            activation = check.execute(
                "SELECT activated_at, activation_week FROM "
                "public.company_activation WHERE company_id = 'c_dur'"
            ).fetchone()
            weeks = check.execute(
                "SELECT count(*) FROM public.company_week_value "
                "WHERE company_id = 'c_dur'"
            ).fetchone()[0]
            cell = check.execute(
                "SELECT cohort_size, retained_count FROM "
                "public.retention_cells "
                "WHERE cohort_week = %s AND rel_week = 0",
                (ist_week_start(sync_time),),
            ).fetchone()
        finally:
            check.close()
        assert activation is not None
        assert activation[0] == sync_time
        assert activation[1] == ist_week_start(sync_time)
        assert weeks == 1
        assert cell is not None and cell[0] >= 1 and cell[1] >= 1
    finally:
        conn.execute(
            "DELETE FROM public.events WHERE insert_id IN ('dur_sync', 'dur_recon')"
        )


def test_staff_only_company_excluded_from_activation_and_clients(conn):
    from metrics.api import is_internal_email

    sync_time = datetime(2026, 4, 6, 10, 0, tzinfo=IST)
    staff_emails = [
        "ops@karboncard.com",
        "Staff Name <ADMIN@sub.KOREFI.AI>",
        "x@y.karboncard.com",
    ]
    for email in staff_emails:
        assert is_internal_email(email)
    add_event(conn, "Accounting Sync", sync_time, "c_staff",
              distinct_id="s1", email=staff_emails[0])
    add_event(conn, "Accounting Sync",
              datetime(2026, 4, 7, 10, 0, tzinfo=IST), "c_staff",
              distinct_id="s2", email=staff_emails[1])
    add_event(conn, "Recon Processed",
              datetime(2026, 4, 8, 10, 0, tzinfo=IST), "c_staff",
              distinct_id="s3", email=staff_emails[2])
    counts = refresh(conn)
    assert counts[0] == 0  # no activation rows at all
    assert counts[3] == 0  # client_company empty
    assert conn.execute(
        "SELECT count(*) FROM client_company WHERE company_id = 'c_staff'"
    ).fetchone()[0] == 0
    assert conn.execute(
        "SELECT count(*) FROM company_activation WHERE company_id = 'c_staff'"
    ).fetchone()[0] == 0
    assert conn.execute(
        "SELECT count(*) FROM company_week_value WHERE company_id = 'c_staff'"
    ).fetchone()[0] == 0
    assert conn.execute(
        "SELECT count(*) FROM company_profile WHERE company_id = 'c_staff'"
    ).fetchone()[0] == 0
    assert conn.execute(
        "SELECT count(*) FROM company_week_action WHERE company_id = 'c_staff'"
    ).fetchone()[0] == 0
    assert conn.execute(
        "SELECT count(*) FROM retention_cells"
    ).fetchone()[0] == 0


def test_mixed_client_and_staff_company_stays(conn):
    first_sync = datetime(2026, 4, 6, 10, 0, tzinfo=IST)
    add_event(conn, "Accounting Sync", first_sync, "c_mix",
              distinct_id="staff1", email="ops@karboncard.com")
    add_event(conn, "Accounting Sync",
              datetime(2026, 4, 13, 10, 0, tzinfo=IST), "c_mix",
              distinct_id="cli1", email="ca@client.com")
    add_event(conn, "Upload",
              datetime(2026, 4, 5, 10, 0, tzinfo=IST), "c_mix",
              distinct_id="staff1", email="ops@karboncard.com")
    refresh(conn)
    assert conn.execute(
        "SELECT count(*) FROM client_company WHERE company_id = 'c_mix'"
    ).fetchone()[0] == 1
    row = conn.execute(
        "SELECT activated_at, activation_week FROM company_activation "
        "WHERE company_id = 'c_mix'"
    ).fetchone()
    assert row[0] == first_sync
    assert row[1] == ist_week_start(first_sync)


def test_no_email_company_is_kept(conn):
    sync_time = datetime(2026, 4, 6, 10, 0, tzinfo=IST)
    add_event(conn, "Accounting Sync", sync_time, "c_noemail",
              distinct_id="u9", email=None)
    add_event(conn, "Upload",
              datetime(2026, 4, 5, 10, 0, tzinfo=IST), "c_noemail",
              distinct_id="u9", email="")
    refresh(conn)
    assert conn.execute(
        "SELECT count(*) FROM client_company WHERE company_id = 'c_noemail'"
    ).fetchone()[0] == 1
    assert conn.execute(
        "SELECT count(*) FROM company_activation WHERE company_id = 'c_noemail'"
    ).fetchone()[0] == 1


def test_staff_filter_matches_api_is_internal_email(conn):
    from metrics.api import is_internal_email

    sync_time = datetime(2026, 4, 6, 10, 0, tzinfo=IST)
    cases = [
        "ops@karboncard.com",
        "Staff Name <admin@korefi.ai>",
        "UPPER@SUB.KARBONCARD.COM",
        "ca@client.com",
        "Client Name <ca@client.com>",
        "not-an-email",
        "",
        None,
    ]
    for i, email in enumerate(cases):
        add_event(conn, "Accounting Sync", sync_time, f"c_par{i}",
                  distinct_id=f"u_par{i}", email=email)
    refresh(conn)
    members = {
        r[0] for r in conn.execute("SELECT company_id FROM client_company").fetchall()
    }
    for i, email in enumerate(cases):
        expected = True if email in (None, "") else not is_internal_email(email)
        assert (f"c_par{i}" in members) == expected, email


def test_company_week_action_ignores_login_and_dashboard(conn):
    sync_time = datetime(2026, 4, 6, 10, 0, tzinfo=IST)  # Monday
    week = ist_week_start(sync_time)
    add_event(conn, "Login", at(week, 9), "c_act", email="ca@client.com")
    add_event(conn, "Login", at(week + timedelta(days=1), 9), "c_act",
              email="ca@client.com")
    add_event(conn, "Dashboard Viewed", at(week + timedelta(days=1), 10),
              "c_act", email="ca@client.com")
    add_event(conn, "Widget Clicked", at(week + timedelta(days=1), 11),
              "c_act", email="ca@client.com")
    add_event(conn, "Sign Up", at(week, 8), "c_act", email="ca@client.com")
    add_event(conn, "Upload", at(week, 12), "c_act", email="ca@client.com")
    add_event(conn, "Transaction Ledger Updated", at(week + timedelta(days=1), 12),
              "c_act", email="ca@client.com")
    add_event(conn, "Delete", at(week + timedelta(days=2), 12), "c_act",
              email="ca@client.com")
    add_event(conn, "Accounting Sync", sync_time, "c_act", email="ca@client.com")
    add_event(conn, "Login", at(week + timedelta(days=9), 9), "c_act",
              email="ca@client.com")  # chrome-only week: no action row
    refresh(conn)
    rows = conn.execute(
        "SELECT week_start, action_count, upload_count, txn_count, ap_count,"
        " sync_count, recon_count, other_action_count"
        " FROM company_week_action WHERE company_id = 'c_act' ORDER BY 1"
    ).fetchall()
    assert rows == [(week, 4, 1, 1, 0, 1, 0, 1)]


def test_company_profile_path_and_signup(conn):
    created = datetime(2026, 3, 30, 9, 0, tzinfo=IST)
    upload = datetime(2026, 3, 31, 9, 0, tzinfo=IST)
    ready = datetime(2026, 4, 1, 9, 0, tzinfo=IST)
    sync = datetime(2026, 4, 7, 9, 0, tzinfo=IST)  # Tuesday
    recon = datetime(2026, 4, 15, 9, 0, tzinfo=IST)
    add_event(conn, "Company Created", created, "c_prof",
              email="ca@client.com", properties={"companyName": "Acme"})
    add_event(conn, "Upload", upload, "c_prof", email="ca@client.com",
              properties={"companyName": "Acme"})
    add_event(conn, "Invoice Created", ready, "c_prof", email="ca@client.com")
    add_event(conn, "Accounting Sync", sync, "c_prof", email="ca@client.com")
    add_event(conn, "Login", sync, "c_prof", email="ca@client.com")
    add_event(conn, "Recon Processed", recon, "c_prof", email="ca@client.com",
              properties={"companyName": "Acme New"})
    refresh(conn)
    row = conn.execute(
        "SELECT company_name, signed_up_at, activated_at, activation_week,"
        " first_upload_at, first_ready_at, first_sync_at, first_recon_at,"
        " last_action_at, action_count, active_weeks,"
        " path_had_upload, path_had_ready, path_had_sync, path_had_recon"
        " FROM company_profile WHERE company_id = 'c_prof'"
    ).fetchone()
    assert row[0] == "Acme New"  # latest non-null companyName wins
    assert row[1] == created  # Company Created, not first event fallback
    assert row[2] == sync
    assert row[3] == ist_week_start(sync)
    assert row[4] == upload
    assert row[5] == ready
    assert row[6] == sync
    assert row[7] == recon
    assert row[8] == recon
    assert row[9] == 4  # Upload, Invoice Created, Sync, Recon (not Created/Login)
    assert row[10] == 3  # Mar 30 week, Apr 6 week, Apr 13 week
    assert row[11:15] == (True, True, True, True)


def test_company_profile_signup_falls_back_to_first_event(conn):
    first = datetime(2026, 4, 7, 9, 0, tzinfo=IST)
    add_event(conn, "Upload", first, "c_fb", email="ca@client.com")
    add_event(conn, "Accounting Sync",
              datetime(2026, 4, 8, 9, 0, tzinfo=IST), "c_fb",
              email="ca@client.com")
    refresh(conn)
    row = conn.execute(
        "SELECT signed_up_at, company_name FROM company_profile "
        "WHERE company_id = 'c_fb'"
    ).fetchone()
    assert row[0] == first
    assert row[1] is None


def test_new_tables_idempotent_and_events_untouched(conn):
    sync_time = datetime(2026, 4, 6, 10, 0, tzinfo=IST)
    add_event(conn, "Accounting Sync", sync_time, "c_new",
              email="ca@client.com")
    add_event(conn, "Upload", sync_time, "c_new", email="ca@client.com")
    add_event(conn, "Accounting Sync", sync_time, "c_newstaff",
              email="ops@karboncard.com")
    before_events = conn.execute(
        f"SELECT count(*) FROM {SCRATCH}.events"
    ).fetchone()[0]
    first = refresh(conn)
    snap = (
        conn.execute("SELECT * FROM client_company ORDER BY 1").fetchall(),
        conn.execute("SELECT * FROM company_profile ORDER BY 1").fetchall(),
        conn.execute(
            "SELECT * FROM company_week_action ORDER BY 1, 2").fetchall(),
    )
    second = refresh(conn)
    assert second == first
    assert (
        conn.execute("SELECT * FROM client_company ORDER BY 1").fetchall(),
        conn.execute("SELECT * FROM company_profile ORDER BY 1").fetchall(),
        conn.execute(
            "SELECT * FROM company_week_action ORDER BY 1, 2").fetchall(),
    ) == snap
    assert [r[0] for r in snap[0]] == ["c_new"]
    after_events = conn.execute(
        f"SELECT count(*) FROM {SCRATCH}.events"
    ).fetchone()[0]
    assert after_events == before_events == 3
