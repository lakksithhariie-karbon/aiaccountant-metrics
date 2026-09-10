"""Warehouse RPCs used by the Supabase Edge Function sync-incremental."""

from __future__ import annotations

import json
import os
from datetime import date, datetime, timedelta, timezone

import pytest

from metrics.api import is_internal_email
from metrics.refresh import ensure_tables

TEST_DB_URL = os.environ.get(
    "TEST_DATABASE_URL",
    "postgresql://postgres:postgres@127.0.0.1:5432/product_metrics",
)

MIGRATION_001 = os.path.join(
    os.path.dirname(__file__), "..", "supabase", "migrations", "001_events.sql"
)
MIGRATION_010 = os.path.join(
    os.path.dirname(__file__), "..", "supabase", "migrations", "010_property_enrichment_ingest.sql"
)
MIGRATION_011 = os.path.join(
    os.path.dirname(__file__), "..", "supabase", "migrations", "011_property_subtype_missing.sql"
)

IST = timezone(timedelta(hours=5, minutes=30))


@pytest.fixture()
def conn():
    import psycopg

    connection = psycopg.connect(TEST_DB_URL, autocommit=True)
    connection.execute(open(MIGRATION_001).read())
    ensure_tables(connection)
    connection.execute(open(MIGRATION_010).read())
    connection.execute(open(MIGRATION_011).read())
    connection.execute(
        "DELETE FROM public.events WHERE insert_id LIKE 'rpc_%'"
    )
    connection.execute(
        "DELETE FROM public.export_watermarks WHERE job_name = 'incremental'"
    )
    yield connection
    connection.execute(
        "DELETE FROM public.events WHERE insert_id LIKE 'rpc_%'"
    )
    connection.execute(
        "DELETE FROM public.export_watermarks WHERE job_name = 'incremental'"
    )
    connection.close()


def test_sql_is_internal_email_matches_python(conn):
    cases = [
        "ops@karboncard.com",
        "Staff Name <admin@korefi.ai>",
        "UPPER@SUB.KARBONCARD.COM",
        "ca@client.com",
        "Client Name <ca@client.com>",
        "not-an-email",
        "",
        None,
        "x@y.karboncard.com",
        "Name <ADMIN@sub.KOREFI.AI>",
    ]
    for email in cases:
        sql = conn.execute(
            "SELECT public.is_internal_email(%s)", (email,)
        ).fetchone()[0]
        assert sql == is_internal_email(email), email


def test_upsert_mixpanel_events_inserts_then_is_idempotent(conn):
    payload = [
        {
            "insert_id": "rpc_a",
            "event_name": "Sign Up",
            "event_time": datetime(2026, 9, 5, 10, 0, tzinfo=IST).isoformat(),
            "distinct_id": "u1",
            "user_id": "user-1",
            "uc_uuid": "uc-1",
            "email": "ca@client.com",
            "company_id": "c_rpc",
            "company": "c_rpc",
            "properties": {"companyName": "Rpc Co", "time": 1},
        },
        {
            "insert_id": "rpc_a",
            "event_name": "Sign Up",
            "event_time": datetime(2026, 9, 5, 10, 0, tzinfo=IST).isoformat(),
            "distinct_id": "u1",
            "user_id": "user-1",
            "uc_uuid": "uc-1",
            "email": "ca@client.com",
            "company_id": "c_rpc",
            "company": "c_rpc",
            "properties": {"companyName": "Rpc Co", "time": 1},
        },
    ]
    first = conn.execute(
        "SELECT public.upsert_mixpanel_events(%s::jsonb)",
        (json.dumps(payload),),
    ).fetchone()[0]
    second = conn.execute(
        "SELECT public.upsert_mixpanel_events(%s::jsonb)",
        (json.dumps(payload),),
    ).fetchone()[0]
    assert first == 1
    assert second == 0
    row = conn.execute(
        "SELECT event_name, company_id, email FROM public.events "
        "WHERE insert_id = 'rpc_a'"
    ).fetchone()
    assert row == ("Sign Up", "c_rpc", "ca@client.com")


def test_property_allowlist_normalizes_and_drops_large_or_sensitive_keys(conn):
    payload = [{
        "insert_id": "rpc_props",
        "event_name": "Upload",
        "event_time": datetime(2026, 9, 5, 10, 0, tzinfo=IST).isoformat(),
        "distinct_id": "u_props",
        "company_id": "c_props",
        "properties": {
            "companyName": "Props Co",
            "type": "GST2B",
            "subType": "unexpected",
            "status": "success",
            "transactionType": "Payment",
            "isReactivation": True,
            "items_count": 12,
            "fileName": "secret.xlsx",
            "gstin": "sensitive",
            "sync_items": {"huge": True},
        },
    }]
    inserted = conn.execute(
        "SELECT public.upsert_mixpanel_events(%s::jsonb)",
        (json.dumps(payload),),
    ).fetchone()[0]
    assert inserted == 1
    properties = conn.execute(
        "SELECT properties FROM public.events WHERE insert_id = 'rpc_props'"
    ).fetchone()[0]
    assert properties == {
        "companyName": "Props Co",
        "type": "gstr2b",
        "subType": "bank",
        "status": "Success",
        "transactionType": "payment",
        "isReactivation": True,
        "items_count": 12,
    }


def test_missing_upload_subtype_is_not_invented(conn):
    payload = [{
        "insert_id": "rpc_missing_subtype",
        "event_name": "Upload",
        "event_time": datetime(2026, 9, 5, 10, 0, tzinfo=IST).isoformat(),
        "distinct_id": "u_missing_subtype",
        "company_id": "c_missing_subtype",
        "properties": {},
    }]
    inserted = conn.execute(
        "SELECT public.upsert_mixpanel_events(%s::jsonb)",
        (json.dumps(payload),),
    ).fetchone()[0]
    assert inserted == 1
    properties = conn.execute(
        "SELECT properties FROM public.events "
        "WHERE insert_id = 'rpc_missing_subtype'"
    ).fetchone()[0]
    assert properties == {}


def test_property_conflict_merges_without_rewriting_identity(conn):
    first = [{
        "insert_id": "rpc_merge",
        "event_name": "Upload",
        "event_time": datetime(2026, 9, 5, 10, 0, tzinfo=IST).isoformat(),
        "distinct_id": "u_merge",
        "company_id": "c_merge",
        "properties": {"companyName": "Keep Co", "type": "bill"},
    }]
    second = [{
        **first[0],
        "properties": {
            "companyName": "",
            "subType": "bulk",
            "fileName": "drop.xlsx",
        },
    }]
    assert conn.execute(
        "SELECT public.upsert_mixpanel_events(%s::jsonb)",
        (json.dumps(first),),
    ).fetchone()[0] == 1
    assert conn.execute(
        "SELECT public.upsert_mixpanel_events(%s::jsonb)",
        (json.dumps(second),),
    ).fetchone()[0] == 0
    row = conn.execute(
        "SELECT event_name, event_time, distinct_id, company_id, properties "
        "FROM public.events WHERE insert_id = 'rpc_merge'"
    ).fetchone()
    assert row[:4] == (
        "Upload",
        datetime(2026, 9, 5, 10, 0, tzinfo=IST),
        "u_merge",
        "c_merge",
    )
    assert row[4] == {
        "companyName": "Keep Co",
        "type": "bill",
        "subType": "bulk",
    }


def test_identity_mismatch_is_counted_and_skipped(conn):
    original = [{
        "insert_id": "rpc_identity",
        "event_name": "Upload",
        "event_time": datetime(2026, 9, 5, 10, 0, tzinfo=IST).isoformat(),
        "distinct_id": "u_identity",
        "company_id": "c_identity",
        "properties": {"type": "bill"},
    }]
    conn.execute(
        "SELECT public.upsert_mixpanel_events(%s::jsonb)",
        (json.dumps(original),),
    )
    mismatch = [{**original[0], "company_id": "wrong_company", "properties": {"type": "statement"}}]
    detail = conn.execute(
        "SELECT * FROM public.upsert_mixpanel_events_detail(%s::jsonb)",
        (json.dumps(mismatch),),
    ).fetchone()
    assert detail == (0, 0, 1)
    row = conn.execute(
        "SELECT company_id, properties FROM public.events WHERE insert_id = 'rpc_identity'"
    ).fetchone()
    assert row == ("c_identity", {"type": "bill"})


def test_identity_mismatch_aborts_above_ten(conn):
    rows = []
    for index in range(11):
        row = {
            "insert_id": f"rpc_identity_limit_{index}",
            "event_name": "Upload",
            "event_time": datetime(2026, 9, 5, 10, 0, tzinfo=IST).isoformat(),
            "distinct_id": f"u_identity_{index}",
            "company_id": f"c_identity_{index}",
            "properties": {"type": "bill"},
        }
        conn.execute(
            "SELECT public.upsert_mixpanel_events(%s::jsonb)",
            (json.dumps([row]),),
        )
        rows.append({**row, "company_id": f"wrong_{index}"})
    with pytest.raises(Exception, match="identity mismatches exceed 10"):
        conn.execute(
            "SELECT public.upsert_mixpanel_events_detail(%s::jsonb)",
            (json.dumps(rows),),
        )


def test_upsert_rejects_non_array(conn):
    with pytest.raises(Exception):
        conn.execute("SELECT public.upsert_mixpanel_events('{}'::jsonb)")


def test_refresh_retention_rejects_unknown_source(conn):
    with pytest.raises(Exception):
        conn.execute("SELECT * FROM public.refresh_retention('other.events')")


def test_incremental_lease_blocks_then_expires(conn):
    first = conn.execute(
        "SELECT public.try_begin_incremental(interval '15 minutes')"
    ).fetchone()[0]
    second = conn.execute(
        "SELECT public.try_begin_incremental(interval '15 minutes')"
    ).fetchone()[0]
    assert first is True
    assert second is False
    conn.execute(
        "SELECT public.finish_incremental(true, %s, 'ok')",
        (date(2026, 9, 5),),
    )
    third = conn.execute(
        "SELECT public.try_begin_incremental(interval '15 minutes')"
    ).fetchone()[0]
    assert third is True
    mark = conn.execute(
        "SELECT last_success_date, status FROM public.export_watermarks "
        "WHERE job_name = 'incremental'"
    ).fetchone()
    assert mark[0] == date(2026, 9, 5)
    assert mark[1] == "running"


def test_failed_finish_keeps_previous_success_date(conn):
    conn.execute(
        "SELECT public.try_begin_incremental(interval '15 minutes')"
    )
    conn.execute(
        "SELECT public.finish_incremental(true, %s, 'ok')",
        (date(2026, 9, 4),),
    )
    conn.execute(
        "SELECT public.try_begin_incremental(interval '15 minutes')"
    )
    conn.execute(
        "SELECT public.finish_incremental(false, %s, 'mixpanel 429')",
        (date(2026, 9, 5),),
    )
    mark = conn.execute(
        "SELECT last_success_date, status, detail FROM public.export_watermarks "
        "WHERE job_name = 'incremental'"
    ).fetchone()
    assert mark[0] == date(2026, 9, 4)
    assert mark[1] == "failed"
    assert mark[2] == "mixpanel 429"
